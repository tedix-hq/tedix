/**
 * Pure per-turn abort helper — extracted so tests can import without pulling
 * in `@cloudflare/ai-chat` / `agents` (which use `cloudflare:` protocol
 * imports and cannot be loaded by `apps/api`'s plain-node vitest environment;
 * see `kernel-voice-do.test.ts`'s equivalent extraction of `voice-helpers.ts`).
 *
 * Backs `KernelDOv4.cancelTurn` (`kernel-do.ts`) — the DO owns the actual
 * runId-keyed `Map<string, AbortController>` instance (per-DO, single-
 * threaded, created in `runPlannerStep`); this function is the pure abort
 * logic against that map, with no DO-specific state of its own.
 */

/**
 * Abort the live controller for `runId` if one is registered, and report
 * whether it did. A missing entry (turn already settled, never ran on this
 * isolate, or ran on a since-evicted isolate) is a normal no-op — NEVER an
 * error; `cancelKernelRunCore` (`kernel-runtime.ts`) calls this RPC
 * best-effort AFTER durably marking the run row canceled, so correctness
 * never depends on finding a live controller here.
 */
export function abortKernelTurn(
	controllers: Map<string, AbortController>,
	runId: string,
): boolean {
	const controller = controllers.get(runId);
	if (!controller) return false;
	controller.abort(new Error(`kernel turn ${runId} canceled by operator`));
	return true;
}
