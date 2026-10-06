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
	OsBlueprintDefinitionSchema,
	OsBlueprintPreflightSchema,
	OsCollaborationProposalSchema,
	OsGadgetExecutionPolicyDecisionSchema,
	OsGadgetManifestSchema,
	OsWorkspaceBlueprintDecisionSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { getOsBlueprint } from "@tedix/db/queries/os-workspaces/blueprints";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import { getOsOutput } from "@tedix/db/queries/os-workspaces/outputs";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
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
	OsWorkspaceRow,
} from "@tedix/db/schema/os-workspaces";
import { parseBlueprintLineage } from "../../services/os-blueprint-portability";
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
		message: `${subject} revision compare-and-swap lost against a concurrent revision write`,
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
		definition: OsBlueprintDefinitionSchema.parse(JSON.parse(row.definition)),
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
		throw createError(ErrorCodes.NOT_FOUND, "OS gadget not found");
	}
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
	return output;
}
