import type { ToolConfig } from "@tedix/api-contract/schemas/tools";

/**
 * Deadlines for the trusted MCP -> API RPC hop. Most endpoints use the tool's
 * configured timeout (15 s by default); the endpoints below are known to run
 * longer and get a floor, and browser quick actions scale with their own waits.
 */

const DEFAULT_INTERNAL_TIMEOUT_MS = 15_000;
const BROWSER_QUICK_ACTION_ENDPOINTS = new Set([
	"browser/capturePage",
	"browser/extractMarkdown",
	"browser/extractContent",
	"browser/extractLinks",
	"browser/scrapeElements",
	"browser/extractJson",
]);

const INTERNAL_TIMEOUT_FLOORS_MS: Record<string, number> = {
	// Starting CMS cleanup is durable, but a cold API and workflow enqueue may
	// exceed the generic 15s transport deadline before returning the receipt.
	"sites/deprovision": 30_000,
	// A snapshot import runs its browser capture (page load and capture, each
	// bounded at 60s) before it returns the workflow receipt. Under 15s the
	// caller gave up mid-capture and its retries started duplicate captures.
	"catalog/importSnapshot": 150_000,
	// A synchronous filing pass allows 24s for classification, then fit scoring
	// and persistence. The generic deadline can lose its mutation receipt.
	"workAgentSessions/classifyRequests": 45_000,
	"tedis/getLogs": 45_000,
	"tedis/syncStorage": 125_000,
	"tedis/wake": 120_000,
	"tedis/triggerCronSync": 180_000,
	"tedis/restart": 60_000,
	"tedis/resetSandbox": 30_000,
	"tedis/getStatus": 30_000,
	"tedis/sendMessage": 145_000, // ACP: 130s wait + 15s headroom
	"mcpEval/run": 30_000,
	"mcpHealth/run": 30_000,
	// The graph steward performs several bounded D1 health scans before it
	// applies links or flags. Even the minimum scan takes longer than the
	// generic 15s RPC ceiling in production, so keep its execution window
	// durable here instead of relying on mutable per-tool config that schema
	// projection intentionally regenerates.
	"workItems/runWorkGraphSteward": 60_000,
	// Home/kernel surface (home__* tools): these aggregate durable run sets,
	// transcripts, and trace bundles, and enqueueMessage can answer a turn
	// inline (LLM route) — all routinely exceed the 15s default and were
	// surfacing exact 15000ms internal-transport timeouts. Floor them like the
	// tedi diagnostic reads so the synchronous lane has real headroom; clients
	// that opt into the Tasks extension still get the async-canary deferral path.
	"kernelRuntime/enqueueMessage": 60_000,
	"kernelRuntime/retryRun": 60_000,
	"kernelRuntime/readMessages": 45_000,
	"kernelRuntime/readRunSet": 45_000,
	"kernelRuntime/readRun": 45_000,
	"kernelRuntime/listConversations": 45_000,
	"kernelRuntime/approvePlanAssignments": 60_000,
	"kernelRuntime/respondApproval": 60_000,
	"kernelRuntime/cancelRun": 30_000,
	"kernelRuntime/steerRun": 30_000,
	"harness/listKernelTraceBundles": 45_000,
	"voice/synthesizeSpokenReply": 45_000,
};

export function resolveInternalTransportTimeout(
	endpoint: string,
	config: ToolConfig,
	input: Record<string, unknown> = {},
): number {
	const configTimeout = config.timeout ?? DEFAULT_INTERNAL_TIMEOUT_MS;
	const timeoutFloor = INTERNAL_TIMEOUT_FLOORS_MS[endpoint] ?? 0;
	if (BROWSER_QUICK_ACTION_ENDPOINTS.has(endpoint)) {
		const navigationMs =
			typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
				? Math.max(1_000, Math.min(input.timeoutMs, 60_000))
				: 30_000;
		const postLoadMs =
			typeof input.waitForTimeoutMs === "number" &&
			Number.isFinite(input.waitForTimeoutMs)
				? Math.max(0, Math.min(input.waitForTimeoutMs, 60_000))
				: 0;
		// The browser may spend its full navigation and post-load waits before
		// the API serializes the result. The generic 15s RPC timer cuts that off.
		return Math.max(configTimeout, navigationMs + postLoadMs + 15_000);
	}
	return Math.max(configTimeout, timeoutFloor);
}
