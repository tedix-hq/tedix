import { SESSION_ACTIVITY_RESOURCE } from "@tedix/api-contract/schemas/agent-session-requests";
import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	isWorkspaceSkillResource,
	type OsWorkspaceSchedule,
	WORKSPACE_SKILL_RESOURCE,
} from "@tedix/api-contract/schemas/os-workspace-schedules";
import {
	PERSONAL_ORGANISE_OPERATION,
	type PersonalAccessLevel,
	personalAccessLevel,
	personalAccessOperations,
	reviewedPersonalAccountName,
	reviewedPersonalResourceBinding,
	reviewedPersonalResourceReadScopes,
} from "@tedix/api-contract/utils/personal-resource-tool-binding";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { PersonalResourceToolBindingSchema } from "@tedix/api-contract/schemas/tools";
import { getAppBySlugForOrg } from "@tedix/db/queries/apps";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { listConnectionInstances } from "@tedix/db/queries/connection-instances";
import {
	createOsWorkspaceResource,
	findOsWorkspaceTenantResource,
	getOsWorkspaceResource,
	listOsWorkspaceResources,
	listOsWorkspaceSkillLinkCandidates,
	removeOsWorkspaceResource,
} from "@tedix/db/queries/os-workspaces/resources";
import {
	createPersonalResourceDelegation,
	listActiveOwnerSkillPersonalResourceDelegations,
	revokePersonalResourceDelegation,
} from "@tedix/db/queries/personal-resource-delegations";
import { getLatestReportedSkillRun } from "@tedix/db/queries/skill-runs";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { getSkillSchedule } from "@tedix/db/queries/skill-schedules";
import { getToolByAppAndToolIdForOrganization } from "@tedix/db/queries/tools";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	preparePersonalResourceDelegation,
	validatePersonalRunSources,
} from "../../services/personal-resource-delegation-authority";
import { scheduledPersonalResourceEnvelope } from "../../services/skill-scheduler";
import { callSkillRuntime } from "../../services/skill-runtime-client";
import {
	readRunsAt,
	reportedLastRun,
	SKIPPED_RUN_RESULT_STATUSES,
	schedulePurpose,
	scheduleRunTimes,
} from "../../services/workspace-schedules";
import {
	ensureWorkspaceSkillLink,
	requireWorkspace,
	resolveCreator,
} from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const authed = os.use(withAuth).use(osAudit(OS_WORKSPACES_AUDIT));
const readOs = authed.use(AUTHZ.osRead);
const authorOs = authed.use(AUTHZ.osAuthor);

/** A Workspace links at most this many scheduled skills in its Resources. */
const MAX_SCHEDULES = 20;
/** A read grant made from the schedule row lasts this long unless stopped. */
const GRANT_DAYS = 365;

type SkillEntry = NonNullable<Awaited<ReturnType<typeof getSkillEntry>>>;

function parseMetadata(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** The member who owns the Workspace, when the caller is that person signed in. */
function signedInOwner(
	context: BaseContext,
	workspace: OsWorkspaceRow,
): string | null {
	const sub =
		context.authType === "user" && !context.tediId ? context.user?.sub : null;
	if (!sub) return null;
	const owner =
		workspace.visibility === "private"
			? workspace.ownerUserId
			: workspace.createdByKind === "user"
				? workspace.createdById
				: null;
	return owner === sub ? sub : null;
}

interface PersonalAccessNeed {
	providerId: string;
	providerName: string;
	resourceType: string;
	/** Every declared tool with a reviewed binding, and its operation. */
	tools: { toolId: string; operation: string }[];
	requiredScopes: string[];
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function toolIdsFor(need: PersonalAccessNeed, operations: readonly string[]) {
	return need.tools
		.filter((tool) => operations.includes(tool.operation))
		.map((tool) => tool.toolId);
}

/**
 * What the skill declares it does with its owner's personal account: the
 * tools in its manifest whose installed tool uses a personal connection and
 * whose binding (the tool's own, else the server-reviewed one) acts on the
 * connected account, with the operation each one needs (read, or modify for
 * organising). An explicit provider selects that account in a multi-source skill.
 */
export async function personalAccessNeed(
	context: BaseContext,
	organizationId: string,
	skill: SkillEntry,
	requestedProviderId?: string,
): Promise<PersonalAccessNeed | null> {
	const manifest = parseCapabilityManifest(
		(skill.files as Record<string, string> | null)?.["SKILL.md"] ??
			skill.content ??
			"",
	);
	if (
		(!requestedProviderId ||
			requestedProviderId === SESSION_ACTIVITY_RESOURCE.providerId) &&
		Object.values(manifest.mcp)
			.flat()
			.includes(SESSION_ACTIVITY_RESOURCE.toolId)
	)
		return {
			providerId: SESSION_ACTIVITY_RESOURCE.providerId,
			providerName: "session activity",
			resourceType: SESSION_ACTIVITY_RESOURCE.resourceType,
			tools: [{ toolId: SESSION_ACTIVITY_RESOURCE.toolId, operation: "read" }],
			requiredScopes: [],
		};
	for (const [namespace, toolIds] of Object.entries(manifest.mcp)) {
		const app = await getAppBySlugForOrg(
			context.db,
			namespace.replace(/_/g, "-"),
			organizationId,
		);
		if (!app) continue;
		let need: PersonalAccessNeed | null = null;
		for (const toolId of toolIds) {
			const tool = await getToolByAppAndToolIdForOrganization(context.db, {
				organizationId,
				appId: app.id,
				toolId,
			});
			const config = (tool?.enabled ? tool.config : null) ?? {};
			const auth = config.auth as Record<string, unknown> | undefined;
			const providerId = auth?.connectionId;
			if (
				typeof providerId !== "string" ||
				(requestedProviderId !== undefined &&
					providerId !== requestedProviderId) ||
				(auth?.credentialScope ?? auth?.scope) !== "user"
			)
				continue;
			const parsed = PersonalResourceToolBindingSchema.safeParse(
				config.personalResourceBinding,
			);
			const binding = parsed.success
				? parsed.data
				: reviewedPersonalResourceBinding(providerId, config.mcpToolName);
			if (
				!binding ||
				!("target" in binding) ||
				(binding.operation !== "read" &&
					binding.operation !== PERSONAL_ORGANISE_OPERATION)
			)
				continue;
			if (need && need.providerId !== providerId) continue;
			need ??= {
				providerId,
				providerName: reviewedPersonalAccountName(providerId) ?? app.name,
				resourceType: binding.resourceType,
				tools: [],
				requiredScopes: [],
			};
			need.tools.push({ toolId, operation: binding.operation });
			need.requiredScopes = [
				...new Set([
					...need.requiredScopes,
					...(reviewedPersonalResourceReadScopes(
						providerId,
						config.mcpToolName,
					) ?? stringArray(auth?.scopes)),
				]),
			].sort();
		}
		if (need) return need;
	}
	return null;
}

/** The newest of the owner's active grants of this skill for this Workspace and provider. */
async function ownerSkillGrants(
	context: BaseContext,
	input: {
		organizationId: string;
		ownerUserId: string;
		skill: SkillEntry;
		workspaceId: string;
		providerId?: string;
	},
) {
	if (!input.skill.tediId) return [];
	return (
		await listActiveOwnerSkillPersonalResourceDelegations(context.db, {
			organizationId: input.organizationId,
			ownerUserId: input.ownerUserId,
			tediId: input.skill.tediId,
			skillId: input.skill.id,
			now: new Date().toISOString(),
		})
	).filter(
		(row) =>
			row.workspaceId === input.workspaceId &&
			(!input.providerId || row.providerId === input.providerId),
	);
}

const LEVEL_RANK = { none: 0, read: 1, organise: 2 } as const;

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && b.every((value) => a.includes(value));
}

/** The signed-in person themself, never a worker acting for them. */
function signedInPerson(context: BaseContext): string | null {
	return context.authType === "user" && !context.tediId
		? (context.user?.sub ?? null)
		: null;
}

const list = readOs.schedules.list.handler(async ({ input, context }) => {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const organizationId = workspace.organizationId;
	const owner = signedInOwner(context, workspace);
	const resources = (
		await listOsWorkspaceResources(createDbQueryClient(context.env.DB), {
			organizationId,
			workspaceId: workspace.id,
			status: "active",
			limit: 200,
		})
	)
		.filter(isWorkspaceSkillResource)
		.slice(0, MAX_SCHEDULES);
	const now = new Date();
	const items = await Promise.all(
		resources.map(async (resource): Promise<OsWorkspaceSchedule | null> => {
			const skillId = resource.providerResourceId;
			const [skill, schedule, run] = await Promise.all([
				getSkillEntry(context.db, skillId, organizationId),
				getSkillSchedule(context.db, skillId),
				getLatestReportedSkillRun(context.db, {
					organizationId,
					skillId,
					runtimeEnvironment: context.env.ENVIRONMENT,
					skippedResultStatuses: SKIPPED_RUN_RESULT_STATUSES,
				}),
			]);
			if (!skill) return null;
			const metadata = parseMetadata(resource.metadata);
			const own = schedule?.organizationId === organizationId ? schedule : null;
			const active = own?.enabled ? own : null;
			const times = active
				? scheduleRunTimes(
						active.cron,
						readRunsAt(metadata, skill.content),
						now,
					)
				: { dailyTimes: [], nextRunAt: null };
			const [need, worker] = await Promise.all([
				personalAccessNeed(context, organizationId, skill),
				skill.tediId
					? getTediByIdForOrganization(context.db, skill.tediId, organizationId)
					: undefined,
			]);
			const grant =
				need && owner
					? (
							await ownerSkillGrants(context, {
								organizationId,
								ownerUserId: owner,
								skill,
								workspaceId: workspace.id,
								providerId: need.providerId,
							})
						)[0]
					: undefined;
			return {
				resourceId: resource.id,
				skillId,
				name: resource.name,
				purpose: schedulePurpose(metadata, skill),
				enabled: active !== null,
				// A paused schedule keeps its cron; null means no schedule at all.
				cron: own?.cron ?? null,
				...times,
				lastRun: reportedLastRun(run),
				personalRead: need
					? {
							providerId: need.providerId,
							providerName: need.providerName,
							workerName:
								need.providerId === SESSION_ACTIVITY_RESOURCE.providerId
									? (worker?.displayName ?? worker?.name)
									: undefined,
							toolIds: need.tools.map((tool) => tool.toolId),
							grantId: grant?.id ?? null,
							level: grant ? personalAccessLevel(grant.operations) : "none",
							canAllow: owner !== null,
						}
					: null,
				tediName: worker ? (worker.displayName ?? worker.name) : null,
				hasWorkflow: Boolean(
					(skill.files as Record<string, string> | null)?.[
						"scripts/workflow.ts"
					],
				),
			};
		}),
	);
	return {
		items: items.filter((item): item is OsWorkspaceSchedule => item !== null),
	};
});

/**
 * "Let this read my Gmail (read-only)": as the signed-in Workspace owner,
 * attach their connected account and grant the skill's worker read access with
 * the declared read-only tools. The consent checks themselves stay in
 * preparePersonalResourceDelegation.
 */
const allowPersonalRead = authorOs.schedules.allowPersonalRead.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const organizationId = workspace.organizationId;
		const owner = signedInOwner(context, workspace);
		if (!owner)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the Workspace's owner, signed in, can let a skill read their account",
			);
		const db = createDbQueryClient(context.env.DB);
		const link = await getOsWorkspaceResource(db, {
			organizationId,
			workspaceId: workspace.id,
			resourceId: input.resourceId,
		});
		const skill =
			link?.status === "active" && isWorkspaceSkillResource(link)
				? await getSkillEntry(
						context.db,
						link.providerResourceId,
						organizationId,
					)
				: undefined;
		if (!link || !skill)
			throw createError(ErrorCodes.NOT_FOUND, "Scheduled skill not found");
		const need = await personalAccessNeed(
			context,
			organizationId,
			skill,
			input.providerId,
		);
		const readTools = need ? toolIdsFor(need, ["read"]) : [];
		if (!need || readTools.length === 0 || !skill.tediId || !skill.revision)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This skill does not declare a read of a personal account",
			);
		const localActivity =
			need.providerId === SESSION_ACTIVITY_RESOURCE.providerId;
		if (localActivity && !context.userId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Session activity requires the owner's canonical user identity",
			);
		const localResourceId = crypto.randomUUID();
		const account = localActivity
			? { id: localResourceId, label: context.userId! }
			: (await listConnectionInstances(db, { userId: owner })).find(
					(row) =>
						row.providerId === need.providerId &&
						row.tokenIds.length > 0 &&
						row.tokenSub,
				);
		if (!account)
			return { status: "not_connected" as const, providerId: need.providerId };
		const attached = (
			await listOsWorkspaceResources(db, {
				organizationId,
				workspaceId: workspace.id,
				status: "active",
				limit: 200,
			})
		).find(
			(row) =>
				row.connectionScope === "user" &&
				row.personalOwnerUserId === owner &&
				(localActivity || row.connectionInstanceId === account.id) &&
				row.providerId === need.providerId &&
				row.resourceType === need.resourceType,
		);
		const creator = resolveCreator(context);
		const timestamp = new Date().toISOString();
		const resource =
			attached ??
			(await createOsWorkspaceResource(db, {
				id: localActivity ? localResourceId : crypto.randomUUID(),
				organizationId,
				workspaceId: workspace.id,
				slot: null,
				providerId: need.providerId,
				connectionScope: "user",
				personalOwnerUserId: owner,
				connectionInstanceId: account.id,
				requiredScopes: JSON.stringify(need.requiredScopes),
				providerAccess: null,
				resourceType: need.resourceType,
				providerResourceId: account.label,
				name: localActivity
					? "My session activity"
					: `${need.providerName}: ${account.label}`.slice(0, 200),
				metadata: "{}",
				status: "active",
				createdByKind: creator.kind,
				createdById: creator.id,
				createdAt: timestamp,
				updatedAt: timestamp,
				removedAt: null,
			}));
		const grant = await createPersonalResourceDelegation(
			context.db,
			await preparePersonalResourceDelegation(context, {
				tediId: skill.tediId,
				skillId: skill.id,
				skillRevision: skill.revision,
				workspaceId: workspace.id,
				resourceId: resource.id,
				connectionInstanceId: resource.connectionInstanceId!,
				operations: ["read"],
				toolIds: readTools,
				expiresAt: new Date(Date.now() + GRANT_DAYS * 86_400_000).toISOString(),
			}),
		);
		return { status: "allowed" as const, grantId: grant.id };
	},
);

/**
 * The level chosen on an attached personal account's row: for each skill the
 * Workspace links that declares tools for this account, the owner's grant is
 * replaced by one covering exactly the declared tools of that level. An
 * unchanged grant is kept as it is. Only the account's owner, signed in.
 */
const setPersonalAccess = authorOs.schedules.setPersonalAccess.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const organizationId = workspace.organizationId;
		const caller = signedInPerson(context);
		const db = createDbQueryClient(context.env.DB);
		const resources = await listOsWorkspaceResources(db, {
			organizationId,
			workspaceId: workspace.id,
			status: "active",
			limit: 200,
		});
		const resource = resources.find((row) => row.id === input.resourceId);
		if (!resource || resource.connectionScope !== "user")
			throw createError(ErrorCodes.NOT_FOUND, "Personal account not found");
		if (!caller || resource.personalOwnerUserId !== caller)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the account's owner, signed in, can choose what skills may do with it",
			);
		const connectionInstanceId = resource.connectionInstanceId;
		if (!connectionInstanceId)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This account is not bound to a connected account",
			);
		const operations = personalAccessOperations(input.level);
		const skills: {
			skillId: string;
			grantId: string | null;
			toolIds: string[];
		}[] = [];
		for (const link of resources.filter(isWorkspaceSkillResource)) {
			const skill = await getSkillEntry(
				context.db,
				link.providerResourceId,
				organizationId,
			);
			if (!skill?.tediId || !skill.revision) continue;
			const need = await personalAccessNeed(
				context,
				organizationId,
				skill,
				resource.providerId,
			);
			if (
				!need ||
				need.providerId !== resource.providerId ||
				need.resourceType !== resource.resourceType
			)
				continue;
			const toolIds = toolIdsFor(need, operations).sort();
			const granted = [
				...new Set(
					need.tools
						.filter((tool) => toolIds.includes(tool.toolId))
						.map((tool) => tool.operation),
				),
			].sort();
			const current = (
				await ownerSkillGrants(context, {
					organizationId,
					ownerUserId: caller,
					skill,
					workspaceId: workspace.id,
					providerId: resource.providerId,
				})
			).filter((row) => row.resourceId === resource.id);
			const kept = current.find(
				(row) =>
					toolIds.length > 0 &&
					sameSet(row.toolIds, toolIds) &&
					sameSet(row.operations, granted),
			);
			const grant =
				kept ??
				(toolIds.length > 0
					? await createPersonalResourceDelegation(
							context.db,
							await preparePersonalResourceDelegation(context, {
								tediId: skill.tediId,
								skillId: skill.id,
								skillRevision: skill.revision,
								workspaceId: workspace.id,
								resourceId: resource.id,
								connectionInstanceId,
								operations: granted,
								toolIds,
								expiresAt: new Date(
									Date.now() + GRANT_DAYS * 86_400_000,
								).toISOString(),
							}),
						)
					: null);
			const revokedAt = new Date().toISOString();
			for (const row of current)
				if (row.id !== grant?.id)
					await revokePersonalResourceDelegation(context.db, {
						organizationId,
						ownerUserId: caller,
						id: row.id,
						revokedAt,
					});
			skills.push({ skillId: skill.id, grantId: grant?.id ?? null, toolIds });
		}
		return { level: input.level, skills };
	},
);

/**
 * Run a Workspace's linked skill now, for example a Card review Do it. The
 * run carries only the caller's own active grants for that skill and
 * Workspace, validated like a manual run's; with needs, a missing level stops
 * it before anything runs.
 */
const runNow = authorOs.schedules.runNow.handler(async ({ input, context }) => {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const organizationId = workspace.organizationId;
	const caller = signedInPerson(context);
	if (!caller)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only a signed-in person can run a Workspace skill now",
		);
	const resources = await listOsWorkspaceResources(
		createDbQueryClient(context.env.DB),
		{
			organizationId,
			workspaceId: workspace.id,
			status: "active",
			limit: 200,
		},
	);
	const linked = resources.some(
		(row) =>
			isWorkspaceSkillResource(row) && row.providerResourceId === input.skillId,
	);
	const skill = linked
		? await getSkillEntry(context.db, input.skillId, organizationId)
		: undefined;
	if (!skill?.tediId)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"This Workspace does not run that skill",
		);
	const files = skill.files as Record<string, string> | null;
	const workflowSource = files?.["scripts/workflow.ts"];
	if (!workflowSource)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"SKILL_NOT_EXECUTABLE: the skill has no scripts/workflow.ts",
		);
	const grants = await ownerSkillGrants(context, {
		organizationId,
		ownerUserId: caller,
		skill,
		workspaceId: workspace.id,
	});
	if (input.needs) {
		const level = grants.reduce<PersonalAccessLevel>((best, row) => {
			const next = personalAccessLevel(row.operations);
			return LEVEL_RANK[next] > LEVEL_RANK[best] ? next : best;
		}, "none");
		if (LEVEL_RANK[level] < LEVEL_RANK[input.needs]) {
			const need = await personalAccessNeed(context, organizationId, skill);
			const account = need
				? resources.find(
						(row) =>
							row.connectionScope === "user" &&
							row.personalOwnerUserId === caller &&
							row.providerId === need.providerId &&
							row.resourceType === need.resourceType,
					)
				: undefined;
			return {
				status: "needs_access" as const,
				level,
				providerName: need?.providerName ?? null,
				resourceId: account?.id ?? null,
			};
		}
	}
	const envelope = scheduledPersonalResourceEnvelope(grants);
	const resourceAccessEnvelope = envelope
		? await validatePersonalRunSources(context, {
				tediId: skill.tediId,
				skillId: skill.id,
				resourceAccessEnvelope: envelope,
			})
		: undefined;
	const skillDoc = files?.["SKILL.md"] ?? skill.content ?? "";
	const dispatched = await callSkillRuntime<{ runId: string }>(
		context,
		"/run",
		{
			createdBy: `user:${caller}`,
			idempotencyKey: input.idempotencyKey,
			skillId: skill.id,
			skillSlug: skill.slug,
			skillRevision: skill.revision ?? null,
			orgId: organizationId,
			tediId: skill.tediId,
			params: {
				...input.params,
				workspaceId: workspace.id,
				tediId: skill.tediId,
			},
			workflowSource,
			skillDoc,
			capabilityManifest: parseCapabilityManifest(skillDoc),
			...(resourceAccessEnvelope ? { resourceAccessEnvelope } : {}),
		},
	);
	return { status: "started" as const, runId: dispatched.runId };
});

/** Link one skill to the Workspace; repeating it changes nothing. */
const link = authorOs.schedules.link.handler(async ({ input, context }) => {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const skill = await getSkillEntry(
		context.db,
		input.skillId,
		workspace.organizationId,
	);
	if (!skill)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"No skill with that id in this organization",
		);
	const { created, resourceId } = await ensureWorkspaceSkillLink(context, {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
		skillId: skill.id,
		name: skill.title,
	});
	return { resourceId, created };
});

/** Remove the Workspace's link to a skill; the skill itself is untouched. */
const unlink = authorOs.schedules.unlink.handler(async ({ input, context }) => {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const db = createDbQueryClient(context.env.DB);
	const current = await findOsWorkspaceTenantResource(db, {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
		...WORKSPACE_SKILL_RESOURCE,
		providerResourceId: input.skillId,
	});
	if (current?.status !== "active") return { removed: false };
	const row = await removeOsWorkspaceResource(db, {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
		resourceId: current.id,
		expectedUpdatedAt: current.updatedAt,
		now: new Date().toISOString(),
	});
	if (!row)
		throw createError(
			ErrorCodes.CONFLICT,
			"The skill link changed; reload and try again",
		);
	return { removed: true };
});

/**
 * Link every skill the Workspace's own data says runs it: factory lanes bound
 * or linked to it, and skills whose runs wrote its Outputs. A dry run (the
 * default) only reports; a real run is idempotent.
 */
const linkFactorySkills = authorOs.schedules.linkFactorySkills.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const scope = {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
		};
		const db = createDbQueryClient(context.env.DB);
		const [candidates, resources] = await Promise.all([
			listOsWorkspaceSkillLinkCandidates(db, scope),
			listOsWorkspaceResources(db, { ...scope, status: "active", limit: 500 }),
		]);
		const linked = new Set(
			resources
				.filter(isWorkspaceSkillResource)
				.map((row) => row.providerResourceId),
		);
		const items = [];
		for (const candidate of candidates.slice(0, MAX_SCHEDULES)) {
			const base = {
				skillId: candidate.skillId,
				name: candidate.title,
				reason: candidate.reason,
			};
			if (linked.has(candidate.skillId)) {
				items.push({ ...base, status: "already_linked" as const });
				continue;
			}
			if (input.dryRun) {
				items.push({ ...base, status: "would_link" as const });
				continue;
			}
			const { created } = await ensureWorkspaceSkillLink(context, {
				...scope,
				skillId: candidate.skillId,
				name: candidate.title,
			});
			items.push({
				...base,
				status: created ? ("linked" as const) : ("already_linked" as const),
			});
		}
		return { dryRun: input.dryRun, items };
	},
);

export const osWorkspaceScheduleProcedures = {
	list,
	allowPersonalRead,
	setPersonalAccess,
	runNow,
	link,
	unlink,
	linkFactorySkills,
};
