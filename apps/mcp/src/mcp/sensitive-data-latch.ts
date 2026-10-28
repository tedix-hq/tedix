/**
 * Gateway side of the sensitive-data latch.
 *
 * The latch lives on the run row in D1 (`skill_runs` / `kernel_runtime_runs`)
 * and is read and written through `apps/api` (`mcpGovernance.*`), because this
 * Worker has no general database access. A caller without a run (a person
 * calling a tool directly) has nothing to latch.
 *
 * The gateway decides first whether a read is sensitive — a tool declared
 * `sensitive_data`, or a connection classified `restricted` — and only then
 * records the latch. An ordinary connected read (a web search, a CRM list)
 * never reaches the latch write, so an API or database failure cannot
 * withhold it. The decision data is cached per isolate: the connection
 * classification by organization and provider, and the runs already latched.
 */

import type {
	RunRef,
	SensitiveDataLatch,
} from "@tedix/api-contract/schemas/sensitive-data-latch";
import type { ConnectedCollectionRead } from "@tedix/mcp-shared/read-observation-receipt";
import { setBoundedExpiringCacheEntry } from "../lib/bounded-cache";
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

// ---------------------------------------------------------------------------
// Isolate-local caches. A Worker isolate serves many calls of the same run,
// so the classification of a connection and the fact that a run is already
// latched are looked up once, not on every read.
// ---------------------------------------------------------------------------

const CONNECTION_SENSITIVITY_TTL_MS = 5 * 60 * 1000;
const CONNECTION_SENSITIVITY_MAX_ENTRIES = 500;
/**
 * Short on purpose: a person may clear the latch, after which the next
 * sensitive read must latch the run again. The write itself is idempotent
 * (the first latch wins on the row), so the cache only saves round trips.
 */
const LATCHED_RUN_TTL_MS = 60 * 1000;
const LATCHED_RUNS_MAX_ENTRIES = 1000;

const connectionSensitivityCache = new Map<
	string,
	{ restricted: boolean; expiresAt: number }
>();
const latchedRuns = new Map<string, { expiresAt: number }>();

/** Test seam: forget cached classifications and latched runs. */
export function resetSensitiveDataLatchCaches(): void {
	connectionSensitivityCache.clear();
	latchedRuns.clear();
}

function runKey(organizationId: string, runRef: RunRef): string {
	return `${organizationId}:${runRef.kind}:${runRef.id}`;
}

/**
 * Whether the organization's connection for the provider is classified
 * `restricted`. Cached for five minutes. When the API cannot answer, a
 * previously cached answer is reused even if expired; `null` means the
 * classification is unknown and was never known in this isolate.
 */
async function resolveConnectionRestricted(
	agent: LatchContext,
	organizationId: string,
	connectionProviderId: string,
): Promise<boolean | null> {
	const key = `${organizationId}:${connectionProviderId}`;
	const cached = connectionSensitivityCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.restricted;
	const resolve = agent.apiClient?.mcpGovernance?.resolveConnectionSensitivity;
	if (!resolve) return cached?.restricted ?? null;
	try {
		const { restricted } = await resolve({
			organizationId,
			connectionProviderId,
		});
		setBoundedExpiringCacheEntry(
			connectionSensitivityCache,
			key,
			{ restricted, expiresAt: Date.now() + CONNECTION_SENSITIVITY_TTL_MS },
			CONNECTION_SENSITIVITY_MAX_ENTRIES,
		);
		return restricted;
	} catch (error) {
		console.warn("[governance] connection_sensitivity_lookup_failed", {
			organizationId,
			connectionProviderId,
			staleAnswer: cached?.restricted ?? null,
			error: error instanceof Error ? error.message : String(error),
		});
		return cached?.restricted ?? null;
	}
}

/**
 * After a successful call, record a sensitive read on the run. Declared
 * sensitive tools always latch; a connected read latches only when the
 * organization's connection is classified `restricted`. Any other read
 * returns true without touching the API.
 *
 * Returns false when a sensitive read could not be recorded (the write is
 * retried once first), so the caller withholds the result instead of handing
 * a sensitive payload to a run whose latch is unknown. A connected read whose
 * classification cannot be determined at all is treated the same way; once
 * the classification has been seen in this isolate it is reused on failure.
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
	if (!organizationId) return false;

	if (!toolDeclaredSensitive && connectionProviderId) {
		const restricted = await resolveConnectionRestricted(
			agent,
			organizationId,
			connectionProviderId,
		);
		if (restricted === false) return true;
		if (restricted === null) {
			console.warn("[governance] sensitive_data_latch_classification_unknown", {
				organizationId,
				runRef,
				toolId: tool.toolId,
				connectionProviderId,
			});
			return false;
		}
	}

	const key = runKey(organizationId, runRef);
	const latched = latchedRuns.get(key);
	if (latched && latched.expiresAt > Date.now()) return true;
	const latch = agent.apiClient?.mcpGovernance?.latchRunSensitiveData;
	if (!latch) return false;
	const input = {
		organizationId,
		runRef,
		source: {
			appSlug: collectionRead?.source.appSlug ?? agent.appSlug ?? "",
			toolId: tool.toolId,
			connectionProviderId,
			toolDeclaredSensitive,
		},
	};
	let lastError: unknown;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			const state = await latch(input);
			if (state.latch)
				setBoundedExpiringCacheEntry(
					latchedRuns,
					key,
					{ expiresAt: Date.now() + LATCHED_RUN_TTL_MS },
					LATCHED_RUNS_MAX_ENTRIES,
				);
			return true;
		} catch (error) {
			lastError = error;
		}
	}
	console.warn("[governance] sensitive_data_latch_record_failed", {
		organizationId,
		runRef,
		toolId: tool.toolId,
		connectionProviderId,
		error: lastError instanceof Error ? lastError.message : String(lastError),
	});
	return false;
}
