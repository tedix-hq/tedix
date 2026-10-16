import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	isWorkspaceSkillResource,
	type OsWorkspaceSchedule,
} from "@tedix/api-contract/schemas/os-workspace-schedules";
import {
	reviewedPersonalAccountName,
	reviewedPersonalResourceBinding,
} from "@tedix/api-contract/utils/personal-resource-tool-binding";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { PersonalResourceToolBindingSchema } from "@tedix/api-contract/schemas/tools";
import { getAppBySlugForOrg } from "@tedix/db/queries/apps";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { listConnectionInstances } from "@tedix/db/queries/connection-instances";
import {
	createOsWorkspaceResource,
	getOsWorkspaceResource,
	listOsWorkspaceResources,
} from "@tedix/db/queries/os-workspaces/resources";
import {
	createPersonalResourceDelegation,
	listActiveOwnerSkillPersonalResourceDelegations,
} from "@tedix/db/queries/personal-resource-delegations";
import { getLatestReportedSkillRun } from "@tedix/db/queries/skill-runs";
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
import { preparePersonalResourceDelegation } from "../../services/personal-resource-delegation-authority";
import {
	readRunsAt,
	reportedLastRun,
	SKIPPED_RUN_RESULT_STATUSES,
	schedulePurpose,
	scheduleRunTimes,
} from "../../services/workspace-schedules";
import { requireWorkspace, resolveCreator } from "./os-workspaces-shared";

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

interface PersonalReadNeed {
	providerId: string;
	providerName: string;
	resourceType: string;
	toolIds: string[];
	requiredScopes: string[];
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/**
 * What the skill declares it reads from its owner's personal account: the
 * tools in its manifest whose installed tool uses a personal connection and
 * whose binding (the tool's own, else the server-reviewed one) reads the
 * connected account. Only one provider is supported per skill.
 */
export async function personalReadNeed(
	context: BaseContext,
	organizationId: string,
	skill: SkillEntry,
): Promise<PersonalReadNeed | null> {
	const manifest = parseCapabilityManifest(
		(skill.files as Record<string, string> | null)?.["SKILL.md"] ??
			skill.content ??
			"",
	);
	for (const [namespace, toolIds] of Object.entries(manifest.mcp)) {
		const app = await getAppBySlugForOrg(
			context.db,
			namespace.replace(/_/g, "-"),
			organizationId,
		);
		if (!app) continue;
		let need: PersonalReadNeed | null = null;
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
				(auth?.credentialScope ?? auth?.scope) !== "user"
			)
				continue;
			const parsed = PersonalResourceToolBindingSchema.safeParse(
				config.personalResourceBinding,
			);
			const binding = parsed.success
				? parsed.data
				: reviewedPersonalResourceBinding(providerId, config.mcpToolName);
			if (!binding || binding.operation !== "read" || !("target" in binding))
				continue;
			if (need && need.providerId !== providerId) continue;
			need ??= {
				providerId,
				providerName: reviewedPersonalAccountName(providerId) ?? app.name,
				resourceType: binding.resourceType,
				toolIds: [],
				requiredScopes: [],
			};
			need.toolIds.push(toolId);
			need.requiredScopes = [
				...new Set([...need.requiredScopes, ...stringArray(auth?.scopes)]),
			].sort();
		}
		if (need) return need;
	}
	return null;
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
			const active =
				schedule?.organizationId === organizationId && schedule.enabled
					? schedule
					: null;
			const times = active
				? scheduleRunTimes(active.cron, readRunsAt(metadata), now)
				: { dailyTimes: [], nextRunAt: null };
			const need = await personalReadNeed(context, organizationId, skill);
			const grant =
				need && owner && skill.tediId
					? (
							await listActiveOwnerSkillPersonalResourceDelegations(
								context.db,
								{
									organizationId,
									ownerUserId: owner,
									tediId: skill.tediId,
									skillId,
									now: now.toISOString(),
								},
							)
						).find(
							(row) =>
								row.workspaceId === workspace.id &&
								row.providerId === need.providerId &&
								row.operations.includes("read") &&
								need.toolIds.every((tool) => row.toolIds.includes(tool)),
						)
					: undefined;
			return {
				resourceId: resource.id,
				skillId,
				name: resource.name,
				purpose: schedulePurpose(metadata, skill),
				enabled: active !== null,
				cron: active?.cron ?? null,
				...times,
				lastRun: reportedLastRun(run),
				personalRead: need
					? {
							providerId: need.providerId,
							providerName: need.providerName,
							toolIds: need.toolIds,
							grantId: grant?.id ?? null,
							canAllow: owner !== null,
						}
					: null,
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
		const need = await personalReadNeed(context, organizationId, skill);
		if (!need || !skill.tediId || !skill.revision)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This skill does not declare a read of a personal account",
			);
		const account = (await listConnectionInstances(db, { userId: owner })).find(
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
				row.connectionInstanceId === account.id &&
				row.providerId === need.providerId &&
				row.resourceType === need.resourceType,
		);
		const creator = resolveCreator(context);
		const timestamp = new Date().toISOString();
		const resource =
			attached ??
			(await createOsWorkspaceResource(db, {
				id: crypto.randomUUID(),
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
				name: `${need.providerName}: ${account.label}`.slice(0, 200),
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
				connectionInstanceId: account.id,
				operations: ["read"],
				toolIds: need.toolIds,
				expiresAt: new Date(Date.now() + GRANT_DAYS * 86_400_000).toISOString(),
			}),
		);
		return { status: "allowed" as const, grantId: grant.id };
	},
);

export const osWorkspaceScheduleProcedures = { list, allowPersonalRead };
