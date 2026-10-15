import type {
	BrowserHostnamePolicy,
	BrowserSessionPolicy,
} from "@tedix/api-contract/schemas/tedi";
import {
	Browser,
	type BrowserBinding,
	type BrowserLiveView,
	browserRun,
	DurableBrowserSessionStore,
	type ListableBrowserSessionStore,
	type QuickActionBinding,
} from "agents/browser";
import {
	createBrowserRuntime,
	createQuickActionTools,
} from "agents/browser/ai";
import { browserTool } from "agents/browser/ai-sdk";
import type { ToolSet } from "ai";
import {
	type BrowserEgressDecision,
	browserToolEgressDecision,
} from "./browser-egress-policy";

/** Prefixed to the SDK notice so the model knows a login may be gone. */
export const BROWSER_RESTARTED_NOTE =
	"Browser was restarted; re-login may be needed (earlier tabs, cookies and logins are gone).";

/**
 * The tedi's browser, whichever session mode its tool policy selects. The
 * tools are ungoverned here; {@link governBrowserTools} applies the gates.
 */
export interface TediBrowserSession {
	readonly mode: "dynamic" | "persistent";
	/** Changes whenever the policy would build a different session. */
	readonly signature: string;
	readonly tools: ToolSet;
	/** Live View for the durable session's tabs; host-side only. */
	liveView(): Promise<BrowserLiveView | undefined>;
	/** Id of the durable session, without creating one. */
	currentSessionId(): Promise<string | undefined>;
	close(): Promise<void>;
}

export interface TediBrowserSessionOptions {
	ctx: DurableObjectState;
	browser: BrowserBinding & QuickActionBinding;
	loader: WorkerLoader;
	policy: BrowserSessionPolicy | undefined;
	/** Defaults to the DO's own storage. */
	store?: ListableBrowserSessionStore;
	/** Called once per browser_execute result that reports a restart. */
	onRestarted?: () => void;
	/** Test seam for the SDK's persistent browser tool. */
	persistentTool?: typeof browserTool;
}

export function browserSessionSignature(
	policy: BrowserSessionPolicy | undefined,
): string {
	return policy?.mode === "persistent"
		? `persistent:${policy.name}:${policy.keepAliveMs}`
		: "dynamic";
}

export function createTediBrowserSession(
	options: TediBrowserSessionOptions,
): TediBrowserSession {
	const { policy } = options;
	const signature = browserSessionSignature(policy);
	if (policy?.mode !== "persistent") {
		const runtime = createBrowserRuntime({
			ctx: options.ctx,
			browser: options.browser,
			loader: options.loader,
			name: "tedi-native-browser",
			quickActions: { maxChars: 0 },
			session: { mode: "dynamic" },
		});
		return {
			mode: "dynamic",
			signature,
			tools: runtime.tools,
			liveView: () => runtime.connector.liveView({ mode: "tab" }),
			currentSessionId: async () =>
				(await runtime.connector.sessionInfo())?.sessionId,
			close: () => runtime.connector.closeSession(),
		};
	}
	const browser = new Browser({
		name: `tedi-${policy.name}`,
		provider: browserRun(options.browser, {
			keepAliveMs: policy.keepAliveMs,
		}),
		store: options.store ?? new DurableBrowserSessionStore(options.ctx.storage),
	});
	const execute = (options.persistentTool ?? browserTool)({
		browser,
		loader: options.loader,
		ctx: options.ctx,
	});
	const tools: ToolSet = {
		...createQuickActionTools({ browser: options.browser, maxChars: 0 }),
		browser_execute: {
			...execute,
			execute: async (input, toolOptions) => {
				const output = await execute.execute(input, toolOptions);
				if (!output.restarted) return output;
				options.onRestarted?.();
				return {
					...output,
					notice: output.notice
						? `${BROWSER_RESTARTED_NOTE} ${output.notice}`
						: BROWSER_RESTARTED_NOTE,
				};
			},
		} as ToolSet[string],
	};
	return {
		mode: "persistent",
		signature,
		tools,
		liveView: () => browser.liveView({ mode: "tab" }),
		currentSessionId: async () => (await browser.liveView())?.sessionId,
		close: async () => {
			await browser.close();
		},
	};
}

export interface BrowserToolGates {
	approvalRequired: boolean;
	hostnamePolicies: readonly (BrowserHostnamePolicy | undefined)[];
	enforceTakeover(toolName: string): Promise<void>;
	onEgressDenied(
		toolName: string,
		decision: Extract<BrowserEgressDecision, { decision: "deny" }>,
	): Promise<void>;
	/** Throws once the daily budget is spent. */
	consumeBudget(): void;
	/** Applied to every result except browser_execute's. */
	retain(result: unknown): Promise<unknown>;
}

/**
 * Wrap the SDK browser tools in the takeover, egress, budget and approval
 * gates, in that order, for either session mode.
 */
export function governBrowserTools(
	sdkTools: ToolSet,
	gates: BrowserToolGates,
): ToolSet {
	const governed: ToolSet = {};
	for (const [name, definition] of Object.entries(sdkTools)) {
		const execute = definition.execute;
		governed[name] = {
			...definition,
			...(gates.approvalRequired ? { needsApproval: true } : {}),
			...(execute
				? {
						execute: async (input: unknown, options: unknown) => {
							await gates.enforceTakeover(name);
							const egress = browserToolEgressDecision(
								name,
								input,
								gates.hostnamePolicies,
							);
							if (egress?.decision === "deny") {
								await gates.onEgressDenied(name, egress);
								throw new Error(
									`Browser egress denied (${egress.reason}${egress.hostname ? `: ${egress.hostname}` : ""})`,
								);
							}
							gates.consumeBudget();
							const result = await execute(input as never, options as never);
							return name === "browser_execute" ? result : gates.retain(result);
						},
					}
				: {}),
		} as ToolSet[string];
	}
	return governed;
}
