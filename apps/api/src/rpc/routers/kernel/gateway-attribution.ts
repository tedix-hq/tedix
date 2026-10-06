import type { ProviderTokenUsage } from "@tedix/db/utils/model-pricing";
import type { ProviderExecutionIdentity } from "@tedix/api-contract/schemas/provider-execution";
import {
	type AiGatewayAttribution,
	encodeAiGatewayAttribution,
} from "@tedix/api-contract/schemas/ai-gateway-attribution";
import { hashAnalyticsLabel } from "@tedix/api-contract/schemas/mcp-analytics";
import {
	cloudflareAutoRouterReceipt,
	type CloudflareAutoRouterReceipt,
} from "@tedix/workers-ai/model-select";

export interface KernelExecutionAttempt {
	identity: ProviderExecutionIdentity;
	occurredAt: string;
	executionId: string;
	usage?: ProviderTokenUsage;
	autoRouter?: CloudflareAutoRouterReceipt;
}

/** Capture provider usage before structured-output validation can reject the response. */
export function captureKernelAttemptUsage(
	attempts: KernelExecutionAttempt[],
	raw: unknown,
	providerMetadata?: unknown,
): void {
	const attempt = attempts.at(-1);
	if (!attempt) return;
	const autoRouter = cloudflareAutoRouterReceipt(providerMetadata);
	if (autoRouter) attempt.autoRouter = autoRouter;
	if (!raw || typeof raw !== "object") return;
	const u = raw as Record<string, unknown>;
	const count = (value: unknown): number | null =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0
			? value
			: null;
	const details = (value: unknown): Record<string, unknown> =>
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	const input = details(u.inputTokens);
	const output = details(u.outputTokens);
	const inputDetails = details(u.inputTokenDetails);
	const inputTokens =
		count(u.inputTokens) ?? count(input.total) ?? count(u.promptTokens);
	const outputTokens =
		count(u.outputTokens) ?? count(output.total) ?? count(u.completionTokens);
	if (inputTokens === null && outputTokens === null) return;
	attempt.usage = {
		inputTokens,
		outputTokens,
		cacheReadTokens:
			count(input.cacheRead) ??
			count(inputDetails.cacheReadTokens) ??
			count(u.cachedInputTokens) ??
			(inputTokens !== null ? 0 : null),
		cacheWriteTokens:
			count(input.cacheWrite) ??
			count(inputDetails.cacheWriteTokens) ??
			(inputTokens !== null ? 0 : null),
	};
}

/**
 * Immutable correlation attached to every paid Kernel inference.
 *
 * Cloudflare AI Gateway accepts at most five flat metadata entries. The Kernel
 * keeps its surface, org, purpose, and hashed session independently filterable
 * and packs run/work correlation into the shared versioned envelope.
 */
export interface KernelGatewayContext {
	tediId?: string;
	organizationId?: string;
	runId?: string;
	workItemId?: string;
	sessionKey?: string;
	source?: string;
	billingReservationId?: string;
	executionId?: string;
	executionAttempts?: KernelExecutionAttempt[];
}

/**
 * The agent identity Home's spans carry. Every kernel inference belongs to the
 * one org-scoped router, so it groups under a single `gen_ai.agent.id` in the
 * Agents dashboard rather than fragmenting per call site — the per-call
 * distinction is `functionId`, which the SDK maps to `gen_ai.agent.name`.
 */
export const KERNEL_SPAN_AGENT_ID = "home-kernel";

/**
 * The name the Agents dashboard lists Home under.
 *
 * It must be set explicitly. `wrapAISDK` resolves `gen_ai.agent.name` as
 * agentName -> "gen_ai.agent.name" -> `telemetry.functionId`, and the dashboard
 * groups by NAME, not by `gen_ai.agent.id`. Leaving it unset therefore lists
 * every call site as its own agent (a single Home turn would otherwise produce
 * an agent row named after its call site, such as `kernel.route_plan.stream`).
 * `functionId` still names the operation on the span itself, and AI Gateway
 * keeps the per-surface split through `source`.
 */
export const KERNEL_SPAN_AGENT_NAME = "home-kernel";

const MAX_AI_GATEWAY_METADATA_ENTRIES = 5;

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function kernelGatewayMetadata(
	context?: KernelGatewayContext | string,
): Record<string, string> {
	const normalized: KernelGatewayContext =
		typeof context === "string" ? { organizationId: context } : (context ?? {});
	const organizationId = nonEmpty(normalized.organizationId);
	const source = nonEmpty(normalized.source) ?? "kernel";
	const attribution: AiGatewayAttribution = {
		runId: nonEmpty(normalized.runId) ?? `system:kernel:${source}`,
		workItemId: nonEmpty(normalized.workItemId) ?? `system:kernel:${source}`,
		billingReservationId: nonEmpty(normalized.billingReservationId),
		executionId: nonEmpty(normalized.executionId),
	};
	const sessionKey =
		nonEmpty(normalized.sessionKey) ??
		nonEmpty(normalized.runId) ??
		`system:kernel:${source}`;
	const metadata: Record<string, string> = {
		surface: "kernel",
		...(organizationId ? { orgId: organizationId } : {}),
		sessionKeyHash: hashAnalyticsLabel(sessionKey),
		source,
		attribution: encodeAiGatewayAttribution(attribution),
	};
	if (Object.keys(metadata).length > MAX_AI_GATEWAY_METADATA_ENTRIES) {
		throw new Error(
			`Kernel AI Gateway metadata exceeds ${MAX_AI_GATEWAY_METADATA_ENTRIES} entries`,
		);
	}
	return metadata;
}

/**
 * The same correlation as {@link kernelGatewayMetadata}, shaped for the AI SDK
 * v7 `runtimeContext` that `apps/api/src/lib/traced-ai.ts` turns into GenAI
 * span attributes.
 *
 * Cost attribution and trace attribution are read in different tools and must
 * not drift, so both derive from one {@link KernelGatewayContext}. `agentId`
 * and `conversationId` land on the canonical `gen_ai.*` attributes; the rest is
 * projected onto `cloudflare.agents.runtime_context.*` by the wrapper's
 * allowlist. Unlike the gateway metadata this carries the RAW `sessionKey` as
 * the conversation id — spans are already org-scoped by the same identifiers,
 * and a hash would break the join back to the conversation.
 */
export function kernelSpanContext(
	context?: KernelGatewayContext | string,
): Record<string, string> {
	const normalized: KernelGatewayContext =
		typeof context === "string" ? { organizationId: context } : (context ?? {});
	const source = nonEmpty(normalized.source) ?? "kernel";
	const conversationId =
		nonEmpty(normalized.sessionKey) ?? nonEmpty(normalized.runId);
	const organizationId = nonEmpty(normalized.organizationId);
	const runId = nonEmpty(normalized.runId);
	const workItemId = nonEmpty(normalized.workItemId);
	return {
		agentId: KERNEL_SPAN_AGENT_ID,
		agentName: KERNEL_SPAN_AGENT_NAME,
		source,
		...(conversationId ? { conversationId } : {}),
		...(organizationId ? { orgId: organizationId } : {}),
		...(runId ? { runId } : {}),
		...(workItemId ? { workItemId } : {}),
	};
}
