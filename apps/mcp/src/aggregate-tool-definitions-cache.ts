import { hashAggregateCacheKey } from "./lib/cache-key-hash";
import {
	CACHE_TIER_BUDGET_MS,
	StepBudgetExceededError,
	withStepBudget,
} from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
const log = createMcpLogger("mcp.router");

// ── Durable per-app tool-definition cache (Workers Cache API) ──
// The snapshot tiers in `aggregate-surface-cache.ts` hold the composed surface,
// but every rebuild of it (one background revalidation per colo roughly every
// two minutes once the 120 s soft window passes, plus every nested graph of a
// consent-composed root) resolved each source app again through apps/api, which
// read every enabled `app_tools` row with its schemas from D1 (~1,270 rows for
// the largest gateway). On 2026-11-04 those reads were the top D1 statement by
// database time while D1 reported "too many resources consumed".
//
// This tier stores one source app's raw `apps.getBySlugsWithTools` entry under
// the same key as the per-isolate `internalToolCache` (activation epoch, source,
// selection), so every isolate in a colo reuses one D1 read. Tool-schema changes
// roll the activation epoch, which is part of the key, so they are never served
// stale. An un-fenced D1 write is seen within the soft TTL, which equals the
// aggregate L2 hard TTL — the staleness bound that already applied per colo.
// Between the soft and hard TTL the entry is served while one refresh runs.
// Fail-open: any Cache API error falls through to the upstream call.
export const TOOL_DEFINITIONS_SOFT_TTL_MS = 600_000;
export const TOOL_DEFINITIONS_HARD_TTL_MS = 3_600_000;
const TOOL_DEFINITIONS_HARD_TTL_SECONDS = TOOL_DEFINITIONS_HARD_TTL_MS / 1000;
const TOOL_DEFINITIONS_CACHED_AT_HEADER = "X-Tedix-Tool-Definitions-Cached-At";

export type ToolDefinitionsRead<T> = { payload: T; stale: boolean };

function toolDefinitionsRequest(cacheKey: string): Request {
	return new Request(
		`https://aggregate-cache.mcp.tedix.internal/v1/tool-definitions/${hashAggregateCacheKey(cacheKey)}`,
	);
}

// Releasing an unread body is best effort and never awaited.
function cancelBody(response: Response): void {
	void Promise.resolve()
		.then(() => response.body?.cancel())
		.catch(() => {});
}

export async function readToolDefinitionsL2<T>(
	cacheKey: string,
	resource?: string,
): Promise<ToolDefinitionsRead<T> | null> {
	try {
		if (typeof caches === "undefined" || !caches.default) return null;
		// Budgeted (match + body read together) like the snapshot tiers: a Cache
		// API hang here would sit inside the shared in-flight load.
		return await withStepBudget(
			"tool_definitions_l2_read",
			CACHE_TIER_BUDGET_MS,
			(async (): Promise<ToolDefinitionsRead<T> | null> => {
				const hit = await caches.default.match(
					toolDefinitionsRequest(cacheKey),
				);
				if (!hit) return null;
				const cachedAt = Number(
					hit.headers.get(TOOL_DEFINITIONS_CACHED_AT_HEADER),
				);
				const age = Date.now() - cachedAt;
				if (!Number.isFinite(cachedAt) || age >= TOOL_DEFINITIONS_HARD_TTL_MS) {
					cancelBody(hit);
					return null;
				}
				return {
					payload: (await hit.json()) as T,
					stale: age >= TOOL_DEFINITIONS_SOFT_TTL_MS,
				};
			})(),
			resource,
		);
	} catch (error) {
		// A budget trip already emitted its structured diagnosis line.
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Tool definitions cache read failed", {
				event: "aggregate.tool_definitions_read_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		return null;
	}
}

export async function writeToolDefinitionsL2(
	cacheKey: string,
	payload: unknown,
	ctx?: Pick<ExecutionContext, "waitUntil">,
	resource?: string,
): Promise<void> {
	try {
		if (typeof caches === "undefined" || !caches.default) return;
		const put = caches.default.put(
			toolDefinitionsRequest(cacheKey),
			new Response(JSON.stringify(payload), {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": `max-age=${TOOL_DEFINITIONS_HARD_TTL_SECONDS}`,
					[TOOL_DEFINITIONS_CACHED_AT_HEADER]: String(Date.now()),
				},
			}),
		);
		// The budget only stops the wait; keep the put alive past it, or the
		// Worker drops the I/O and the next isolate reads D1 again.
		ctx?.waitUntil(put.catch(() => {}));
		await withStepBudget(
			"tool_definitions_l2_write",
			CACHE_TIER_BUDGET_MS,
			put,
			resource,
		);
	} catch (error) {
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Tool definitions cache write failed", {
				event: "aggregate.tool_definitions_write_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
	}
}
