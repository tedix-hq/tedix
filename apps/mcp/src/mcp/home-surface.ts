/**
 * First-class "home" namespace MCP tools (docs/engineering/product/tedix-os.md).
 *
 * These tools let an org aggregate MCP surface DRIVE that org's kernel and
 * converse with it directly — without borrowing a tedi identity. Unlike the
 * per-tedi `cto__read_home_messages`
 * proof bridges (built by `buildAggregateTediTools`), these are surfaced under a
 * dedicated `home` namespace (`ask`, `home__read_home_messages`, …)
 * so calling them never implies that CTO (or any named tedi) owns Home.
 *
 * Identity / audit model (docs/engineering/product/tedix-os.md):
 *  - Org-scoped, not modeled under a tedi. Every tool sets
 *    `allowExplicitTediId: false` and `includeTediIdParam: false`, and never
 *    injects a `tediId` static param.
 *  - The caller's org rides the `X-Tedix-Org-Id` header set in
 *    `handler.ts` (`ctx.callerIdentity?.organizationId ?? ctx.app?.organizationId`).
 *    The `kernelRuntime` procedures resolve org server-side via
 *    `resolveOrganizationId(context, input.organizationId)`, which enforces the
 *    caller's own org and rejects cross-org access. No `organizationId` input is
 *    advertised on these tools and no ORG_INJECT_ROUTERS entry is required —
 *    that allowlist only governs REST tools that embed `{organizationId}` in the
 *    path; these are rpc-transport tools that carry org on the header.
 *
 * All tools use `transport: "rpc"` against `kernelRuntime/<procedure>` and proxy
 * straight to apps/api, so they are runtime-agnostic (no container required).
 */

import type { AppTool } from "./server-context";
import { PLATFORM_OPERATOR_APP_SLUG } from "./platform-operator-tools";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const HOME_CONVERSATION_LIFECYCLE_ENDPOINTS = new Set([
	"kernelRuntime/listConversations",
	"kernelRuntime/renameConversation",
	"kernelRuntime/pinConversation",
	"kernelRuntime/archiveConversation",
	"kernelRuntime/deleteConversation",
]);

/**
 * The app-tool projection derives a public namespace from an RPC endpoint's
 * router root, so kernelRuntime conversation rows otherwise appear as
 * `kernel.*` beside the first-class `home.*` contract. On surfaces that mount
 * Home, remove only those duplicate lifecycle rows. Internal oRPC callers and
 * unrelated kernel diagnostics keep their canonical kernelRuntime endpoints.
 */
export function removeProjectedKernelConversationLifecycleTools(
	tools: AppTool[],
): AppTool[] {
	return tools.filter((tool) => {
		const endpoint = tool.config?.endpoint;
		return (
			typeof endpoint !== "string" ||
			!HOME_CONVERSATION_LIFECYCLE_ENDPOINTS.has(endpoint)
		);
	});
}

/**
 * Home belongs on org aggregate surfaces: `tedix-unified` for platform
 * operators, and tenant-owned aggregators such as `acme-unified`.
 * Single-purpose MCP apps stay focused on their provider tools.
 */
export function shouldExposeHomeSurface(args: {
	appSlug: string;
	metadata?: unknown;
}): boolean {
	if (args.appSlug === PLATFORM_OPERATOR_APP_SLUG) return true;
	const metadata = isRecord(args.metadata) ? args.metadata : {};
	const mcpConfig = isRecord(metadata.mcpConfig) ? metadata.mcpConfig : {};
	const aggregateApps = mcpConfig.aggregateApps;
	const aggregateTedis = mcpConfig.aggregateTedis;
	return (
		(Array.isArray(aggregateApps) && aggregateApps.length > 0) ||
		(Array.isArray(aggregateTedis) && aggregateTedis.length > 0)
	);
}

/**
 * Honest ack text for the kernel-turn soft-deadline shape (presentation
 * layer only).
 *
 * Since the soft deadline shipped, `kernelRuntime/enqueueMessage` can return an
 * ACK instead of an answer: top-level `status: "queued"`, `run.status:
 * "running"`, and NO `assistantMessage` — the kernel do keeps running
 * the turn and later writes the real `${runId}:assistant` ledger message.
 * Without this, MCP callers of `ask` get bare JSON with no
 * human-readable text.
 *
 * We deliberately do not fabricate a ledger-shaped assistantMessage (the do
 * owns that message id); instead `tool-execution.ts` prepends this text as an
 * extra content block on the TOOL RESULT for `_emitTaskLinkage` tools. Every
 * other shape returns null so fast-turn output stays byte-identical.
 */
export function homeQueuedAckText(data: unknown): string | null {
	if (!isRecord(data)) return null;
	// A real kernel answer exists — nothing to synthesize.
	if (data.assistantMessage != null) return null;
	const run = data.run;
	if (!isRecord(run)) return null;
	const runId = typeof run.id === "string" ? run.id : "";
	if (!runId) return null;
	const isQueuedAck = data.status === "queued" || run.status === "running";
	if (!isQueuedAck) return null;
	return `Working on it — this turn continues in the background. Poll tasks/get with task id ${runId} or read_home_run for the result; the Home transcript receives the answer when ready.`;
}
