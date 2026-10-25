import { ORPCError } from "@orpc/server";
import type { OsBlueprintWithVisibility } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type OsBlueprintPreflight,
	type OsBlueprintRevision,
	type OsCollaborationProposal,
	type OsCreatedByKind,
	type OsGadget,
	type OsGadgetExecution,
	type OsGadgetRevision,
	type OsWorkspace,
	type OsWorkspaceBlueprintDecision,
	type OsWorkspaceRollbackReference,
	parseStoredOsBlueprintDefinition,
	OsBlueprintPreflightSchema,
	OsCollaborationProposalSchema,
	OsGadgetExecutionPolicyDecisionSchema,
	OsGadgetManifestSchema,
	OsWorkspaceBlueprintDecisionSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { getOsBlueprint } from "@tedix/db/queries/os-workspaces/blueprints";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import { getOsOutput } from "@tedix/db/queries/os-workspaces/outputs";
import {
	createOsWorkspaceProject,
	getOsWorkspaceProject,
	reactivateOsWorkspaceProject,
} from "@tedix/db/queries/os-workspaces/projects";
import {
	createOsWorkspaceResource,
	findOsWorkspaceTenantResource,
	restoreOsWorkspaceResource,
	updateOsWorkspaceResourceMetadata,
} from "@tedix/db/queries/os-workspaces/resources";
import {
	findOsWorkspaceIdForKernelRun,
	getOsWorkspace,
} from "@tedix/db/queries/os-workspaces/workspaces";
import {
	WORKSPACE_CONNECTION_RESOURCE,
	WORKSPACE_SKILL_RESOURCE,
	WORKSPACE_TEDI_RESOURCE,
	type WorkspaceSkillRunsAt,
} from "@tedix/api-contract/schemas/os-workspace-schedules";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { getAppBySlugForOrg } from "@tedix/db/queries/apps";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { createDbQueryClient } from "@tedix/db/query-client";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import type {
	OsBlueprintRevisionRow,
	OsBlueprintRow,
	OsCollaborationProposalRow,
	OsGadgetExecutionRow,
	OsGadgetRevisionRow,
	OsGadgetRow,
	OsOutputRow,
	OsWorkspaceProjectRow,
	OsWorkspaceRow,
} from "@tedix/db/schema/os-workspaces";
import { parseBlueprintLineage } from "../../services/os-blueprint-portability";
import {
	assertOsWorkspaceChildVisible,
	assertOsWorkspaceVisible,
} from "../../services/os-workspace-visibility";
import { requireOrgId } from "../org-scope";
import { type BaseContext, createError, ErrorCodes } from "../orpc";

/**
 * The accountable principal recorded on `created_by_kind` / `created_by_id`.
 * The domain persists four kinds; API-key and M2M principals are machine
 * automation and are recorded as `service` with their credential id.
 */
export function resolveCreator(context: BaseContext): {
	kind: OsCreatedByKind;
	id: string;
} {
	if (context.externalAgentPrincipalId) {
		return { kind: "external_agent", id: context.externalAgentPrincipalId };
	}
	if (context.tediId) return { kind: "tedi", id: context.tediId };
	if (context.authType === "user" && context.user?.sub) {
		return { kind: "user", id: context.user.sub };
	}
	if (context.authType === "apikey" && context.apiKey?.id) {
		return { kind: "service", id: context.apiKey.id };
	}
	if (context.serviceAccount?.clientId) {
		return { kind: "service", id: context.serviceAccount.clientId };
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"No accountable principal for a Tedix OS workspace write",
	);
}

/** A skill run id is a UUID; a skill id is a UUID or a slug. */
const SKILL_RUN_ID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SKILL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function forwardedHeader(
	context: BaseContext,
	name: string,
	pattern: RegExp,
): string | null {
	const value = context.headers?.get(name)?.trim();
	return value && pattern.test(value) ? value : null;
}

/**
 * Producer lineage for an output revision, read from the headers the workflow
 * bridge already forwards through the MCP edge. This is provenance, not
 * authority: it never grants access and is never inferred from the caller
 * principal, so a missing or malformed header records no producer rather than
 * failing the write or attributing the revision to whoever happened to call.
 */
export function resolveProducer(context: BaseContext): {
	skillRunId: string | null;
	skillId: string | null;
} {
	const claimedRun = context.headers?.get("X-Tedix-Skill-Run-Id")?.trim();
	const claimedSkill = context.headers?.get("X-Tedix-Skill-Id")?.trim();
	if ((claimedRun || claimedSkill) && !isServiceBinding(context.headers)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Producer lineage headers require a trusted service-binding hop",
		);
	}
	const skillRunId = forwardedHeader(
		context,
		"X-Tedix-Skill-Run-Id",
		SKILL_RUN_ID_PATTERN,
	);
	// A skill id without a run identifies no concrete authoring event, so it is
	// dropped rather than persisted as half a receipt.
	if (!skillRunId) return { skillRunId: null, skillId: null };
	return {
		skillRunId,
		skillId: forwardedHeader(context, "X-Tedix-Skill-Id", SKILL_ID_PATTERN),
	};
}

export function resolveCollaborationSource(context: BaseContext): {
	sourceKind: "run" | "agent_session";
	sourceId: string;
} {
	const producer = resolveProducer(context);
	if (producer.skillRunId) {
		return { sourceKind: "run", sourceId: producer.skillRunId };
	}
	if (context.externalAgentSessionId) {
		return {
			sourceKind: "agent_session",
			sourceId: context.externalAgentSessionId,
		};
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Collaboration proposals require an attested workflow run or external-agent session",
	);
}

export function queryDb(context: BaseContext) {
	return createDbQueryClient(context.env.DB);
}

/**
 * Detect a D1 unique-index violation. Drizzle wraps the driver error
 * (`UNIQUE constraint failed: ...`) in a `DrizzleQueryError` whose own message
 * is the SQL, so the cause chain is walked too.
 */
export function isUniqueConstraintError(error: unknown): boolean {
	for (let cursor = error; cursor instanceof Error; cursor = cursor.cause) {
		if (/unique constraint/i.test(cursor.message)) {
			return true;
		}
	}
	return false;
}

/**
 * The table whose unique index a D1/SQLite violation names
 * (`UNIQUE constraint failed: os_workspaces.organization_id, os_workspaces.name`).
 *
 * The gallery import writes its blueprint copy and its workspace in ONE batch,
 * so both names can lose the race in the same statement set; the retry loop
 * must renumber only for a blueprint-name collision. Returns null when the
 * driver message does not name a table — the caller then treats the failure as
 * retryable, which is the pre-existing behaviour.
 */
export function uniqueConstraintTable(error: unknown): string | null {
	for (let cursor = error; cursor instanceof Error; cursor = cursor.cause) {
		const match = /unique constraint failed:\s*([a-z0-9_]+)\./i.exec(
			cursor.message,
		);
		if (match?.[1]) return match[1];
	}
	return null;
}

/** Rethrow a D1 unique-index violation as a CONFLICT the caller can act on. */
export function rethrowNameConflict(error: unknown, message: string): never {
	if (isUniqueConstraintError(error)) {
		throw createError(ErrorCodes.CONFLICT, message, error);
	}
	throw error;
}

export function revisionConflict(
	subject: "Gadget" | "Blueprint" | "Output",
	expectedRevision: number,
	currentRevision: number | null,
): ORPCError<
	"CONFLICT",
	{ expectedRevision: number; currentRevision: number | null }
> {
	return new ORPCError("CONFLICT", {
		message: `${subject === "Gadget" ? "App" : subject} revision compare-and-swap lost against a concurrent revision write`,
		data: { expectedRevision, currentRevision },
	});
}

/**
 * Re-read the instantiation preflight from its JSON column. A row written by an
 * older deploy has no envelope, and a row that fails to parse is reported as
 * absent rather than reconstructed: this is audit evidence, so a partial or
 * invented shape would be worse than a null.
 */
export function parseInstantiationPreflight(
	value: string | null,
): OsBlueprintPreflight | null {
	if (!value) return null;
	try {
		const parsed = OsBlueprintPreflightSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Re-read the recorded upgrade review. Same rule as the preflight envelope: a
 * record that no longer parses is reported as absent, never reconstructed — a
 * half-read decision would claim a review that cannot be evidenced.
 */
function parseBlueprintDecision(
	value: string | null,
): OsWorkspaceBlueprintDecision | null {
	if (!value) return null;
	try {
		const parsed = OsWorkspaceBlueprintDecisionSchema.safeParse(
			JSON.parse(value),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * The revision an applied upgrade would return to. Both the id and its counter
 * must be present — a reference that cannot name the revision NUMBER is not a
 * rollback reference, so a half-written pair reports null.
 */
function mapRollbackReference(
	row: OsWorkspaceRow,
): OsWorkspaceRollbackReference | null {
	if (
		!row.previousBlueprintRevisionId ||
		row.previousBlueprintRevisionNumber === null
	) {
		return null;
	}
	return {
		revisionId: row.previousBlueprintRevisionId,
		revision: row.previousBlueprintRevisionNumber,
		preflight: parseInstantiationPreflight(row.previousInstantiationPreflight),
	};
}

export function mapWorkspace(row: OsWorkspaceRow): OsWorkspace {
	return {
		id: row.id,
		organizationId: row.organizationId,
		name: row.name,
		description: row.description,
		status: row.status,
		sourceBlueprintId: row.sourceBlueprintId,
		sourceBlueprintRevisionId: row.sourceBlueprintRevisionId,
		sourceBlueprintRevisionNumber: row.sourceBlueprintRevisionNumber,
		instantiationPreflight: parseInstantiationPreflight(
			row.instantiationPreflight,
		),
		rollbackReference: mapRollbackReference(row),
		blueprintDecision: parseBlueprintDecision(row.blueprintDecision),
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		visibility: row.visibility,
		ownerUserId: row.ownerUserId,
	};
}

export function mapGadget(row: OsGadgetRow): OsGadget {
	return {
		id: row.id,
		organizationId: row.organizationId,
		workspaceId: row.workspaceId,
		name: row.name,
		description: row.description,
		status: row.status,
		currentRevisionId: row.currentRevisionId,
		sourceBlueprintRevisionId: row.sourceBlueprintRevisionId,
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function mapGadgetRevision(row: OsGadgetRevisionRow): OsGadgetRevision {
	return {
		id: row.id,
		organizationId: row.organizationId,
		gadgetId: row.gadgetId,
		revision: row.revision,
		manifest: OsGadgetManifestSchema.parse(JSON.parse(row.manifest)),
		sourceArtifactRef: row.sourceArtifactRef,
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
	};
}

function parseJsonColumn(value: string | null): OsGadgetExecution["input"] {
	return value === null ? null : JSON.parse(value);
}

export function mapGadgetExecution(
	row: OsGadgetExecutionRow,
): OsGadgetExecution {
	return {
		id: row.id,
		organizationId: row.organizationId,
		workspaceId: row.workspaceId,
		gadgetId: row.gadgetId,
		revisionId: row.revisionId,
		revision: row.revision,
		status: row.status,
		grantedCapabilities: JSON.parse(row.grantedCapabilities),
		policyDecision: OsGadgetExecutionPolicyDecisionSchema.parse(
			JSON.parse(row.policyDecision),
		),
		input: parseJsonColumn(row.input),
		output: parseJsonColumn(row.output),
		error: row.error,
		costs: parseJsonColumn(row.costs),
		evidenceRefs:
			row.evidenceRefs === null ? null : JSON.parse(row.evidenceRefs),
		lineage: {
			runId: row.runId,
			workflowInstanceId: row.workflowInstanceId,
			tediId: row.tediId,
			workItemId: row.workItemId,
			traceBundleId: row.traceBundleId,
			billingReservationId: row.billingReservationId,
			approvalRequestId: row.approvalRequestId,
			runtimeEnvironment: row.runtimeEnvironment,
			agentSessionId: row.agentSessionId,
			executionEpoch: row.executionEpoch,
		},
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
		completedAt: row.completedAt,
	};
}

export function mapCollaborationProposal(
	row: OsCollaborationProposalRow,
): OsCollaborationProposal {
	return OsCollaborationProposalSchema.parse({
		...row,
		content: JSON.parse(row.content),
		decisionEvidenceRefs: JSON.parse(row.decisionEvidenceRefs),
		mergeEvidenceRefs: JSON.parse(row.mergeEvidenceRefs),
	});
}

export function mapBlueprint(row: OsBlueprintRow): OsBlueprintWithVisibility {
	return {
		id: row.id,
		organizationId: row.organizationId,
		name: row.name,
		description: row.description,
		status: row.status,
		visibility: row.visibility,
		currentRevisionId: row.currentRevisionId,
		lineage: parseBlueprintLineage(row.lineage),
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function mapBlueprintRevision(
	row: OsBlueprintRevisionRow,
): OsBlueprintRevision {
	return {
		id: row.id,
		organizationId: row.organizationId,
		blueprintId: row.blueprintId,
		revision: row.revision,
		definition: parseStoredOsBlueprintDefinition(row.definition),
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
		publishedAt: row.publishedAt,
	};
}

/** Fetch a workspace with the caller's organization bound into the predicate. */
export async function requireWorkspace(
	context: BaseContext,
	workspaceId: string,
): Promise<OsWorkspaceRow> {
	const organizationId = requireOrgId(context);
	const workspace = await getOsWorkspace(queryDb(context), {
		organizationId,
		workspaceId,
	});
	if (!workspace) {
		throw createError(ErrorCodes.NOT_FOUND, "OS workspace not found");
	}
	await assertOsWorkspaceVisible(context, workspace);
	return workspace;
}

/** Fetch a gadget org-scoped, then pin it to the workspace named in the path. */
export async function requireGadget(
	context: BaseContext,
	workspaceId: string,
	gadgetId: string,
): Promise<OsGadgetRow> {
	const organizationId = requireOrgId(context);
	const gadget = await getOsGadget(queryDb(context), {
		organizationId,
		gadgetId,
	});
	if (!gadget || gadget.workspaceId !== workspaceId) {
		throw createError(ErrorCodes.NOT_FOUND, "OS app not found");
	}
	await assertOsWorkspaceChildVisible(
		context,
		organizationId,
		gadget.workspaceId,
		"OS app not found",
	);
	return gadget;
}

export async function requireBlueprint(
	context: BaseContext,
	blueprintId: string,
): Promise<OsBlueprintRow> {
	const organizationId = requireOrgId(context);
	const blueprint = await getOsBlueprint(queryDb(context), {
		organizationId,
		blueprintId,
	});
	if (!blueprint) {
		throw createError(ErrorCodes.NOT_FOUND, "OS blueprint not found");
	}
	return blueprint;
}

/** Fetch an output with the caller's organization bound into the predicate. */
export async function requireOutput(
	context: BaseContext,
	outputId: string,
): Promise<OsOutputRow> {
	const organizationId = requireOrgId(context);
	const output = await getOsOutput(queryDb(context), {
		organizationId,
		outputId,
	});
	if (!output) {
		throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
	}
	await assertOsWorkspaceChildVisible(
		context,
		organizationId,
		output.workspaceId,
		"OS output not found",
	);
	return output;
}

/**
 * Link a Work project to a Workspace so the Workspace's Work view lists its
 * items. Idempotent: an active link is returned as is, a removed one is
 * restored. Callers check that the workspace and project belong to the org.
 */
export async function ensureWorkspaceProjectLink(
	context: BaseContext,
	params: { organizationId: string; workspaceId: string; projectId: string },
): Promise<{ link: OsWorkspaceProjectRow; created: boolean }> {
	const db = createDbQueryClient(context.env.DB);
	const existing = await getOsWorkspaceProject(db, params);
	if (existing?.status === "active") return { link: existing, created: false };
	const now = new Date().toISOString();
	if (existing) {
		const restored = await reactivateOsWorkspaceProject(db, {
			...params,
			now,
		});
		if (restored) return { link: restored, created: true };
	}
	const creator = resolveCreator(context);
	try {
		return {
			link: await createOsWorkspaceProject(db, {
				id: crypto.randomUUID(),
				...params,
				status: "active",
				createdByKind: creator.kind,
				createdById: creator.id,
				createdAt: now,
				updatedAt: now,
				removedAt: null,
			}),
			created: true,
		};
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Work project link changed; reload",
			);
		}
		throw error;
	}
}

/**
 * Link one reference (a `tedix` skill, tedi or connection) to a Workspace.
 * Reuses an active link and restores a removed one; created is false when it
 * was active. With runsAt, a link that has none gains it.
 */
async function ensureWorkspaceTenantLink(
	context: BaseContext,
	params: {
		organizationId: string;
		workspaceId: string;
		providerId: string;
		resourceType: string;
		providerResourceId: string;
		name: string;
		runsAt?: WorkspaceSkillRunsAt;
	},
): Promise<{ created: boolean; updated?: boolean; resourceId: string }> {
	const db = createDbQueryClient(context.env.DB);
	const scope = {
		organizationId: params.organizationId,
		workspaceId: params.workspaceId,
	};
	const identity = {
		...scope,
		providerId: params.providerId,
		resourceType: params.resourceType,
		providerResourceId: params.providerResourceId,
	};
	const existing = await findOsWorkspaceTenantResource(db, identity);
	const now = new Date().toISOString();
	let metadataUpdated = false;
	if (existing && params.runsAt) {
		const raw = parseJsonColumn(existing.metadata);
		const metadata =
			raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
		if (!metadata.runsAt) {
			const updated = await updateOsWorkspaceResourceMetadata(db, {
				...scope,
				resourceId: existing.id,
				expectedUpdatedAt: existing.updatedAt,
				metadata: JSON.stringify({ ...metadata, runsAt: params.runsAt }),
				now,
			});
			if (!updated)
				throw createError(
					ErrorCodes.CONFLICT,
					"Workspace resource changed; retry the factory build",
				);
			metadataUpdated = true;
		}
	}
	if (existing?.status === "active")
		return {
			created: false,
			updated: metadataUpdated,
			resourceId: existing.id,
		};
	if (existing) {
		const restored = await restoreOsWorkspaceResource(db, {
			...scope,
			resourceId: existing.id,
			now,
		});
		return { created: Boolean(restored), resourceId: existing.id };
	}
	const creator = resolveCreator(context);
	const resourceId = crypto.randomUUID();
	try {
		await createOsWorkspaceResource(db, {
			id: resourceId,
			...scope,
			slot: null,
			providerId: params.providerId,
			resourceType: params.resourceType,
			connectionScope: "tenant",
			personalOwnerUserId: null,
			connectionInstanceId: null,
			providerAccess: null,
			requiredScopes: "[]",
			providerResourceId: params.providerResourceId,
			name: params.name.slice(0, 200),
			metadata: JSON.stringify(params.runsAt ? { runsAt: params.runsAt } : {}),
			status: "active",
			createdByKind: creator.kind,
			createdById: creator.id,
			createdAt: now,
			updatedAt: now,
			removedAt: null,
		});
		return { created: true, resourceId };
	} catch (error) {
		if (!isUniqueConstraintError(error)) throw error;
		// A concurrent link won the race; report the row it wrote.
		const winner = await findOsWorkspaceTenantResource(db, identity);
		if (!winner) throw error;
		return { created: false, resourceId: winner.id };
	}
}

/**
 * Link a skill to a Workspace (a `tedix`/`skill` resource), so the Workspace
 * lists it among the skills that run it. Reuses an active link and restores a
 * removed one; created is false when it was active.
 */
export async function ensureWorkspaceSkillLink(
	context: BaseContext,
	params: {
		organizationId: string;
		workspaceId: string;
		skillId: string;
		name: string;
		runsAt?: WorkspaceSkillRunsAt;
	},
): Promise<{ created: boolean; updated?: boolean; resourceId: string }> {
	const { skillId, ...rest } = params;
	return ensureWorkspaceTenantLink(context, {
		...rest,
		...WORKSPACE_SKILL_RESOURCE,
		providerResourceId: skillId,
	});
}

/** App namespaces every skill reaches through the platform, never a connection. */
const PLATFORM_APP_SLUGS = new Set(["tedix", "tedix-unified"]);

/**
 * Link what a linked skill uses: the tedi that runs it (`tedix`/`tedi`) and
 * each organization app its manifest declares tools for (`tedix`/`connection`,
 * by app slug). Idempotent; returns the links this call created.
 */
export async function ensureWorkspaceSkillDependencyLinks(
	context: BaseContext,
	params: {
		organizationId: string;
		workspaceId: string;
		skill: {
			tediId: string | null;
			content: string | null;
			files: unknown;
		};
	},
): Promise<{ tedis: number; connections: number }> {
	const scope = {
		organizationId: params.organizationId,
		workspaceId: params.workspaceId,
	};
	let tedis = 0;
	let connections = 0;
	if (params.skill.tediId) {
		const tedi = await getTediByIdForOrganization(
			context.db,
			params.skill.tediId,
			params.organizationId,
		);
		if (tedi) {
			const link = await ensureWorkspaceTenantLink(context, {
				...scope,
				...WORKSPACE_TEDI_RESOURCE,
				providerResourceId: tedi.id,
				name: tedi.displayName ?? tedi.name,
			});
			if (link.created) tedis += 1;
		}
	}
	const files = params.skill.files as Record<string, string> | null;
	const manifest = parseCapabilityManifest(
		files?.["SKILL.md"] ?? params.skill.content ?? "",
	);
	const slugs = new Set(
		Object.keys(manifest.mcp).map((namespace) => namespace.replace(/_/g, "-")),
	);
	for (const slug of slugs) {
		if (PLATFORM_APP_SLUGS.has(slug)) continue;
		const app = await getAppBySlugForOrg(
			context.db,
			slug,
			params.organizationId,
		);
		if (!app) continue;
		const link = await ensureWorkspaceTenantLink(context, {
			...scope,
			...WORKSPACE_CONNECTION_RESOURCE,
			providerResourceId: app.slug,
			name: app.name,
		});
		if (link.created) connections += 1;
	}
	return { tedis, connections };
}

/**
 * The Workspace of the Home turn making this call. The MCP edge forwards the
 * turn's kernel run id only on its trusted Worker-to-Worker hop; the run's
 * conversation (or the run that delegated it) names the Workspace. Null for a
 * direct call, a turn outside a Workspace, or a Workspace the caller cannot
 * see.
 */
export async function callerTurnWorkspace(
	context: BaseContext,
): Promise<OsWorkspaceRow | null> {
	const runId = context.headers?.get("X-Tedix-Kernel-Run-Id");
	if (
		!runId ||
		!isServiceBinding(context.headers) ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			runId,
		)
	)
		return null;
	const organizationId = requireOrgId(context);
	const db = queryDb(context);
	const workspaceId = await findOsWorkspaceIdForKernelRun(db, {
		organizationId,
		runId,
	});
	if (!workspaceId) return null;
	const workspace = await getOsWorkspace(db, { organizationId, workspaceId });
	if (!workspace || workspace.status !== "active") return null;
	try {
		await assertOsWorkspaceVisible(context, workspace);
	} catch {
		return null;
	}
	return workspace;
}
