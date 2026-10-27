import { tool, type ToolSet } from "ai";
import * as z from "zod";
import {
	browserResultTools,
	retainBrowserResult,
	type BrowserResultFiles,
} from "./browser-results";
import {
	browserSessionTools,
	governBrowserTools,
	type TediBrowserSession,
	type BrowserToolGates,
} from "./browser-session";

interface BrowserToolDependencies {
	resultFiles: BrowserResultFiles;
	session: TediBrowserSession;
	getSession(): TediBrowserSession;
	getSessionPolicy: Parameters<typeof browserSessionTools>[1];
	onClosed(): Promise<void>;
	login(): Promise<unknown>;
	gates: Omit<BrowserToolGates, "retain">;
	budgetStatus(): unknown;
	requestTakeover(input: {
		reason: "login" | "mfa" | "captcha" | "consent" | "operator_takeover";
		note: string;
	}): Promise<unknown>;
	takeoverStatus(approvalRequestId: string): Promise<unknown>;
}

export function createBrowserTools(deps: BrowserToolDependencies): ToolSet {
	const governed: ToolSet = {
		...browserResultTools(deps.resultFiles),
		...browserSessionTools(
			deps.getSession,
			deps.getSessionPolicy,
			deps.onClosed,
			deps.login,
		),
		...governBrowserTools(deps.session.tools, {
			...deps.gates,
			retain: (result) => retainBrowserResult(result, deps.resultFiles),
		}),
	};
	governed.browser_budget_status = tool({
		description:
			"Read today's governed Cloudflare Browser Run usage and remaining per-tedi daily calls. Does not consume budget.",
		inputSchema: z.object({}),
		execute: async () => deps.budgetStatus(),
	});
	governed.request_browser_takeover = tool({
		description:
			"Request human control of the current promoted Browser Run session for login, MFA, CAPTCHA, consent, or another operator-only step. First open the page with browser_execute; unless the browser is persistent, call cdp.startSession() there so the session is durable. This creates a Tedix OS approval with a short-lived interactive Live View; credentials never enter the model. After the operator completes the step and approves, call get_browser_takeover_status and continue with browser_execute in the same session. Does not consume browser budget.",
		inputSchema: z.object({
			reason: z.enum([
				"login",
				"mfa",
				"captcha",
				"consent",
				"operator_takeover",
			]),
			note: z.string().min(1).max(500),
		}),
		execute: async (input) => deps.requestTakeover(input),
	});
	governed.get_browser_takeover_status = tool({
		description:
			"Read a Browser Live View approval status. Continue browser_execute only after status is approved; rejection, cancellation, or expiry closes the continuation. Returns the shared session's tab origins while it still exists — session ids and Live View URLs never reach the model. Does not consume browser budget.",
		inputSchema: z.object({ approvalRequestId: z.uuid() }),
		execute: async ({ approvalRequestId }) =>
			deps.takeoverStatus(approvalRequestId),
	});
	return governed;
}
