/**
 * The one instrumented AI SDK namespace for `apps/api`.
 *
 * Home/kernel model calls use `wrapAISDK` (`agents/observability/ai`) to emit
 * the `invoke_agent` / `chat` / `execute_tool` GenAI span tree. Import the
 * model calls from this namespace so routing, answers and synthesis carry
 * the configured attribution into Agents observability.
 *
 * Identity travels in the AI SDK v7 `runtimeContext`: `agentId` and
 * `conversationId` are read without an opt-in (they name the operation), while
 * the keys listed below are projected onto
 * `cloudflare.agents.runtime_context.*`. Build the bag with
 * `kernelSpanContext()` so span attribution matches the AI Gateway metadata
 * already attached to the same call.
 *
 * storeMessages/storeTools MUST stay false (the default): they write unredacted
 * prompts and tool results into org-unscoped CF span storage, bypassing
 * trace-safety.
 */

import { wrapAISDK } from "agents/observability/ai";
import * as aiSdk from "ai";

/**
 * The wrapped namespace, exported whole rather than as destructured functions.
 * `wrapAISDK` returns a proxy that throws on a key the underlying namespace
 * does not define, so pulling the functions out here would read every one of
 * them at module load and make importing this file depend on the entire `ai`
 * surface. Reading through the namespace defers each access to its own call.
 */
export const tracedAi = wrapAISDK(aiSdk, {
	includeRuntimeContext: ["orgId", "runId", "workItemId", "source"],
});

/**
 * Span identity for the OBJECT-shaped calls.
 *
 * `generateObject`/`streamObject` carry no `runtimeContext` parameter in AI SDK
 * v7 — only the text calls take the generic. v7 also dropped `metadata` from
 * the TelemetryOptions TYPE while the value is still read at runtime, and
 * `wrapAISDK` looks there FIRST for agent identity, so identity travels as
 * telemetry metadata for these two. The cast preserves runtime metadata
 * while satisfying the narrower v7 public type.
 */
export function objectSpanTelemetry(
	functionId: string,
	span: Record<string, string>,
): { functionId: string } {
	return { functionId, metadata: span } as unknown as { functionId: string };
}
