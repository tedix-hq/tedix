import {
	GADGET_STATE_READ,
	GADGET_STATE_WRITE,
	type OsGadgetStateExecution,
} from "@tedix/api-contract/schemas/os-gadget-state";
import {
	OsGadgetManifestSchema,
	OsDerivedAccessEnvelopeSchema,
	type OsDerivedAccessEnvelope,
} from "@tedix/api-contract/schemas/os-workspaces";
import { getOsGadgetExecutionByRunId } from "@tedix/db/queries/os-workspaces/executions";
import { getOsGadgetRevision } from "@tedix/db/queries/os-workspaces/gadgets";
import {
	hasLiveGadgetStateFence,
	type GadgetStateScope,
	type GadgetStateFence,
} from "@tedix/db/queries/os-workspaces/gadget-state";
import { createDbQueryClient } from "@tedix/db/query-client";
import { requireOrgId } from "../rpc/org-scope";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import {
	requireGadget,
	requireWorkspace,
} from "../rpc/routers/os-workspaces-shared";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "./os-derived-resource-access";

/** Identity, pinned revision and live execution authority for a durable application operation. */
export async function authorizeGadgetState(
	context: BaseContext,
	input: {
		workspaceId: string;
		gadgetId: string;
		execution?: OsGadgetStateExecution;
	},
	write: boolean,
): Promise<{
	scope: GadgetStateScope;
	fence: GadgetStateFence | null;
	accessEnvelope: OsDerivedAccessEnvelope;
}> {
	const organizationId = requireOrgId(context);
	const workspace = await requireWorkspace(context, input.workspaceId);
	const gadget = await requireGadget(
		context,
		input.workspaceId,
		input.gadgetId,
	);
	if (workspace.status !== "active" || gadget.status !== "active")
		throw createError(ErrorCodes.FORBIDDEN, "Gadget application is inactive");
	const scope = {
		organizationId,
		workspaceId: workspace.id,
		gadgetId: gadget.id,
	};
	if (
		!write &&
		context.authType === "user" &&
		context.user?.sub &&
		!context.tediId
	)
		return { scope, fence: null, accessEnvelope: { version: 1, sources: [] } };
	// The runtime bridge, not tenant code, supplies the run and restart epoch.
	const runId = context.headers.get("X-Tedix-Skill-Run-Id");
	const epochHeader = context.headers.get("X-Tedix-Workflow-Execution-Epoch");
	const epoch =
		epochHeader && /^(0|[1-9][0-9]*)$/.test(epochHeader)
			? Number(epochHeader)
			: NaN;
	if (
		context.authType !== "service-binding" ||
		!context.tediId ||
		!context.headers.get("X-Tedix-Mcp-Tool-Id") ||
		!runId ||
		!Number.isSafeInteger(epoch)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Gadget state requires authenticated runtime provenance",
		);
	const db = createDbQueryClient(context.env.DB);
	const execution = await getOsGadgetExecutionByRunId(db, {
		organizationId,
		tediId: context.tediId,
		runId,
	});
	if (
		!execution ||
		execution.workspaceId !== workspace.id ||
		execution.gadgetId !== gadget.id ||
		execution.tediId !== context.tediId ||
		!execution.revisionId ||
		execution.revisionId !== gadget.currentRevisionId ||
		execution.executionEpoch !== epoch ||
		(input.execution &&
			(input.execution.executionId !== execution.id ||
				input.execution.executionEpoch !== epoch))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Gadget state execution does not match the acting Tedi and pinned application",
		);
	const capability = write ? GADGET_STATE_WRITE : GADGET_STATE_READ;
	const revision = await getOsGadgetRevision(db, {
		organizationId,
		revisionId: execution.revisionId,
	});
	let manifest;
	try {
		manifest = OsGadgetManifestSchema.parse(
			JSON.parse(revision?.manifest ?? "null"),
		);
	} catch {
		throw createError(ErrorCodes.FORBIDDEN, "Gadget state revision is invalid");
	}
	if (
		revision?.gadgetId !== gadget.id ||
		!manifest.capabilities.includes(capability)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Pinned Gadget revision does not declare the state operation",
		);
	const fence = {
		...scope,
		executionId: execution.id,
		executionEpoch: epoch,
		tediId: context.tediId,
		revisionId: execution.revisionId,
		runtimeEnvironment: context.env.ENVIRONMENT,
		capability,
	};
	if (!(await hasLiveGadgetStateFence(db, fence)))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Gadget state execution is stale or not running",
		);
	const accessEnvelope = parseDerivedAccessEnvelope(
		execution.resourceAccessEnvelope,
	);
	if (
		!accessEnvelope ||
		!(await authorizeDerivedOutputSources(context, {
			organizationId,
			accessEnvelope,
		}))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Gadget source access is no longer available",
		);
	return { scope, fence, accessEnvelope };
}

/** Preserve source authority across rewrites and tombstones; never truncate source inventory. */
export function mergeGadgetStateSources(
	previous: string | null,
	admitted: OsDerivedAccessEnvelope,
): OsDerivedAccessEnvelope {
	const old =
		previous === null
			? { version: 1 as const, sources: [] }
			: parseDerivedAccessEnvelope(previous);
	if (!old)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Persisted Gadget state source declaration is invalid",
		);
	const sources = new Map(
		old.sources.map((source) => [JSON.stringify(source), source]),
	);
	for (const source of admitted.sources)
		sources.set(JSON.stringify(source), source);
	const merged = OsDerivedAccessEnvelopeSchema.safeParse({
		version: 1,
		sources: [...sources.values()],
	});
	if (!merged.success)
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"Gadget state source envelope is too broad",
		);
	return merged.data;
}

/** Source-derived state is disclosed only after canonical live source authorization. */
export async function authorizeGadgetStateSources(
	context: BaseContext,
	organizationId: string,
	envelope: string,
): Promise<void> {
	const parsed = parseDerivedAccessEnvelope(envelope);
	if (
		!parsed ||
		!(await authorizeDerivedOutputSources(context, {
			organizationId,
			accessEnvelope: parsed,
		}))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Gadget state source access is unavailable",
		);
}
