/**
 * Gateway side of the sensitive-data latch.
 *
 * The latch lives on the run row in D1 (`skill_runs` / `kernel_runtime_runs`)
 * and is read and written through `apps/api` (`mcpGovernance.*`), because this
 * Worker has no general database access. A caller without a run (a person
 * calling a tool directly) has nothing to latch.
 */

import type {
	RunRef,
	SensitiveDataLatch,
} from "@tedix/api-contract/schemas/sensitive-data-latch";
import type { ConnectedCollectionRead } from "@tedix/mcp-shared/read-observation-receipt";
import type { CallerIdentity } from "./caller-identity";
import type { AppTool, ServerContext } from "./server-context";

type LatchContext = Partial<
	Pick<ServerContext, "app" | "appSlug" | "apiClient" | "callerIdentity">
>;

/** The run a call belongs to: a skill workflow run, or a Home (kernel) run. */
export function callerRunRef(
	caller: Pick<CallerIdentity, "skillRunId" | "requestRunId"> | undefined,
): RunRef | null {
	if (!caller) return null;
	if (caller.skillRunId) return { kind: "skill_run", id: caller.skillRunId };
	if (caller.requestRunId)
		return { kind: "kernel_run", id: caller.requestRunId };
	return null;
}

export type LatchLookup =
	| { status: "clear" }
	| { status: "latched"; latch: SensitiveDataLatch }
	| { status: "unavailable" };

/** Read the run's latch. Never throws; an API failure reads as unavailable. */
export async function lookupSensitiveDataLatch(
	agent: LatchContext,
	runRef: RunRef,
): Promise<LatchLookup> {
	const organizationId = agent.app?.organizationId;
	const resolve = agent.apiClient?.mcpGovernance?.resolveRunSensitiveDataLatch;
	if (!organizationId || !resolve) return { status: "unavailable" };
	try {
		const state = await resolve({ organizationId, runRef });
		return state.latch
			? { status: "latched", latch: state.latch }
			: { status: "clear" };
	} catch (error) {
		console.warn("[governance] sensitive_data_latch_lookup_failed", {
			organizationId,
			runRef,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "unavailable" };
	}
}

/**
 * After a successful call, record a sensitive read on the run. Declared
 * sensitive tools always latch; a connected read latches when the API finds
 * the connection classified `restricted`. Returns false when the read could
 * not be recorded, so the caller withholds the result instead of handing a
 * possibly sensitive payload to a run whose latch is unknown.
 */
export async function recordSensitiveRead(
	agent: LatchContext,
	tool: Pick<AppTool, "toolId" | "sensitiveData">,
	collectionRead: ConnectedCollectionRead | null,
): Promise<boolean> {
	const runRef = callerRunRef(agent.callerIdentity);
	const toolDeclaredSensitive = tool.sensitiveData === true;
	const connectionProviderId =
		collectionRead?.source.connectionProviderId ?? null;
	if (!runRef || (!toolDeclaredSensitive && !connectionProviderId)) return true;
	const organizationId = agent.app?.organizationId;
	const latch = agent.apiClient?.mcpGovernance?.latchRunSensitiveData;
	if (!organizationId || !latch) return false;
	try {
		await latch({
			organizationId,
			runRef,
			source: {
				appSlug: collectionRead?.source.appSlug ?? agent.appSlug ?? "",
				toolId: tool.toolId,
				connectionProviderId,
				toolDeclaredSensitive,
			},
		});
		return true;
	} catch (error) {
		console.warn("[governance] sensitive_data_latch_record_failed", {
			organizationId,
			runRef,
			toolId: tool.toolId,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
