import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
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
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	type BrowserEgressDecision,
	browserToolEgressDecision,
	type PersistentBrowserEgress,
	persistentBrowserEgress,
} from "./browser-egress-policy";

/** Prefixed to the SDK notice so the model knows a login may be gone. */
export const BROWSER_RESTARTED_NOTE =
	"Browser was restarted; re-login may be needed (earlier tabs, cookies and logins are gone).";

/** Heading of the usage note prepended to browser_execute's description. */
export const BROWSER_EXECUTE_USAGE_HEADING =
	"## Tedix browser usage (verified calls: use them directly, without codemode.search, codemode.describe or cdp.spec())";

/**
 * The exact connector calls browser_execute supports, checked against the
 * agents/browser `cdp` connector, so the model does not guess CDP method
 * names or spend calls on discovery.
 */
export function browserExecuteUsage(mode: TediBrowserSession["mode"]): string {
	const persistent = mode === "persistent";
	return [
		BROWSER_EXECUTE_USAGE_HEADING,
		"- To read a page, prefer the one-shot tools: browser_markdown({ url }) for its text, browser_extract({ url, prompt, schema }) for structured fields, browser_links({ url }) for its links, browser_scrape({ url, selectors }) for elements by CSS selector. Use browser_execute only to click, type, follow a multi-step flow or keep a session.",
		"- browser_execute runs one async arrow function, async () => { ... }, that returns a small JSON value. Its only browser global is cdp, with exactly these calls: cdp.send({ method, params, sessionId }) and cdp.attachToTarget({ targetId }), which returns { sessionId }. Method names are standard CDP: Target.createTarget, Page.navigate, Runtime.evaluate. There is no cdp.navigate, cdp.click, page or document object: click, type and read inside the page with Runtime.evaluate and params { expression, returnByValue: true, awaitPromise: true }; the value is at result.value.",
		persistent
			? '- Do a whole flow (open, click, read) in one browser_execute run. The browser and your tab persist between runs; a later run can pass sessionId: "active" for that tab.'
			: "- Do a whole flow (open, click, read) in one browser_execute run: the browser closes when the run ends unless that run calls cdp.startSession().",
		`- For a page behind a sign-in, open its login page with browser_execute${persistent ? "" : " and call cdp.startSession() in that run"}, then call request_browser_takeover({ reason: "login", note }) and continue only after get_browser_takeover_status reports approved. Never type credentials.`,
		"- Call browser_session_close when the task is done.",
		"",
		"Example: open a page, click the first navigation link by CSS selector, read the new page's title and text.",
		"async () => {",
		'  const { targetId } = await cdp.send({ method: "Target.createTarget", params: { url: "about:blank" } });',
		"  const { sessionId } = await cdp.attachToTarget({ targetId });",
		"  const js = async (expression) => {",
		'    const r = await cdp.send({ method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true }, sessionId });',
		"    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);",
		"    return r.result.value;",
		"  };",
		"  const settle = async (fromUrl) => {",
		"    for (let i = 0; i < 60; i++) {",
		'      const s = await js("new Promise(r => setTimeout(() => r({ url: location.href, ready: document.readyState }), 250))").catch(() => null);',
		'      if (s?.ready === "complete" && (s.url !== fromUrl || i >= 12)) return s.url;',
		"    }",
		'    throw new Error("page did not finish loading");',
		"  };",
		'  const nav = await cdp.send({ method: "Page.navigate", params: { url: "https://example.com" }, sessionId });',
		"  if (nav.errorText) throw new Error(nav.errorText);",
		'  const home = await settle("about:blank");',
		"  const href = await js(\"(() => { const a = document.querySelector('nav a[href]'); if (!a) return null; a.click(); return a.href; })()\");",
		'  if (!href) throw new Error("no navigation link");',
		"  const url = await settle(home);",
		'  return { href, url, title: await js("document.title"), text: await js("document.body.innerText.slice(0, 2000)") };',
		"}",
	].join("\n");
}

/** Prepend the usage note to the SDK's browser_execute description. */
function withBrowserExecuteUsage(
	tools: ToolSet,
	mode: TediBrowserSession["mode"],
): ToolSet {
	const execute = tools.browser_execute;
	if (!execute) return tools;
	const usage = browserExecuteUsage(mode);
	const sdk = execute.description;
	return {
		...tools,
		browser_execute: {
			...execute,
			description:
				typeof sdk === "function"
					? (options: Parameters<typeof sdk>[0]) =>
							`${usage}\n\n${sdk(options)}`
					: `${usage}\n\n${sdk ?? ""}`,
		} as ToolSet[string],
	};
}

/** Why a persistent browser was closed. */
export type BrowserSessionCloseReason =
	| "tedi_request"
	| "takeover_closed"
	| "egress_changed";

/**
 * A persistent browser's lifecycle, for the run ledger. `sessionId` is the
 * Browser Run id: host-side only, never returned to the model.
 */
export type BrowserSessionLifecycleEvent =
	| {
			kind: "opened" | "reused" | "restarted";
			name: string;
			sessionId: string;
			allowedDomains: string[] | null;
	  }
	| {
			kind: "closed";
			name: string;
			reason: BrowserSessionCloseReason;
	  };

/**
 * The run-ledger row for a lifecycle event. Open, reuse and restart ids are
 * stable per run and session, so a browser reused by many calls in one run
 * records one `reused` row.
 */
export function browserSessionRuntimeEvent(
	event: BrowserSessionLifecycleEvent,
	turn: { tediId: string; runId: string; conversationId: string },
	now: Date = new Date(),
): TediRuntimeEvent {
	const { kind, ...payload } = event;
	return {
		id:
			kind === "closed"
				? `${turn.runId}:browser-session:closed:${event.name}:${now.getTime()}`
				: `${turn.runId}:browser-session:${kind}:${event.sessionId}`,
		tediId: turn.tediId,
		kind: `browser.session.${kind}`,
		conversationId: turn.conversationId,
		runId: turn.runId,
		payload,
		runtime: { backend: "cloudflare-agents" },
		createdAt: now.toISOString(),
	};
}

/** Durable key-value slot for the guardrails a browser was launched with. */
export interface BrowserLaunchMarkerStore {
	get(key: string): Promise<unknown> | unknown;
	put(key: string, value: string): Promise<void> | void;
}

/**
 * The tedi's browser, whichever session mode its tool policy selects. The
 * tools are ungoverned here; {@link governBrowserTools} applies the gates.
 */
export interface TediBrowserSession {
	readonly mode: "dynamic" | "persistent";
	/** Changes whenever the policy would build a different session. */
	readonly signature: string;
	readonly tools: ToolSet;
	/**
	 * The egress verdict for browser_execute, whose CDP code cannot be
	 * inspected per call. `null` allows it (persistent mode enforces the
	 * allowlist as Browser Run guardrails); `undefined` leaves the per-call
	 * policy in charge.
	 */
	readonly executeEgress?: Extract<
		BrowserEgressDecision,
		{ decision: "deny" }
	> | null;
	/** Persistent mode: the hostname guardrails every launch carries. */
	readonly allowedDomains?: string[];
	/** Live View for the durable session's tabs; host-side only. */
	liveView(): Promise<BrowserLiveView | undefined>;
	/** Id of the durable session, without creating one. */
	currentSessionId(): Promise<string | undefined>;
	/** Returns false when there was no browser to close. */
	close(reason: BrowserSessionCloseReason): Promise<boolean>;
}

export interface TediBrowserSessionOptions {
	ctx: DurableObjectState;
	browser: BrowserBinding & QuickActionBinding;
	loader: WorkerLoader;
	policy: BrowserSessionPolicy | undefined;
	/** Organization then tedi `browserEgress`. */
	hostnamePolicies?: readonly (BrowserHostnamePolicy | undefined)[];
	/** Defaults to the DO's own storage. */
	store?: ListableBrowserSessionStore;
	/** Defaults to the DO's own storage. */
	launchMarkers?: BrowserLaunchMarkerStore;
	/** Persistent mode: every open, reuse, restart and close. */
	onLifecycle?: (event: BrowserSessionLifecycleEvent) => Promise<void> | void;
	/** Test seam for the SDK's persistent browser tool. */
	persistentTool?: typeof browserTool;
}

function persistentEgressKey(egress: PersistentBrowserEgress): string {
	if (!egress.enforceable) return `refused-${egress.reason}`;
	return egress.allowedDomains
		? `allow=${egress.allowedDomains.join(",")}`
		: "open";
}

export function browserSessionSignature(
	policy: BrowserSessionPolicy | undefined,
	hostnamePolicies: readonly (BrowserHostnamePolicy | undefined)[] = [],
): string {
	if (policy?.mode !== "persistent") return "dynamic";
	const base = `persistent:${policy.name}:${policy.keepAliveMs}`;
	const egress = persistentBrowserEgress(hostnamePolicies);
	return egress.enforceable && !egress.allowedDomains
		? base
		: `${base}:${persistentEgressKey(egress)}`;
}

export function createTediBrowserSession(
	options: TediBrowserSessionOptions,
): TediBrowserSession {
	const { policy } = options;
	const hostnamePolicies = options.hostnamePolicies ?? [];
	const signature = browserSessionSignature(policy, hostnamePolicies);
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
			tools: withBrowserExecuteUsage(runtime.tools, "dynamic"),
			liveView: () => runtime.connector.liveView({ mode: "tab" }),
			currentSessionId: async () =>
				(await runtime.connector.sessionInfo())?.sessionId,
			close: async () => {
				await runtime.connector.closeSession();
				return true;
			},
		};
	}
	const egress = persistentBrowserEgress(hostnamePolicies);
	const allowedDomains = egress.enforceable ? egress.allowedDomains : undefined;
	const browser = new Browser({
		name: `tedi-${policy.name}`,
		provider: browserRun(options.browser, {
			keepAliveMs: policy.keepAliveMs,
			...(allowedDomains ? { guardrails: { allowedDomains } } : {}),
		}),
		store: options.store ?? new DurableBrowserSessionStore(options.ctx.storage),
	});
	const markers = options.launchMarkers ?? options.ctx.storage;
	const markerKey = `tedi-browser-launch:${policy.name}`;
	const lastSessionKey = `tedi-browser-last-session:${policy.name}`;
	const emit = async (event: BrowserSessionLifecycleEvent) => {
		try {
			await options.onLifecycle?.(event);
		} catch (error) {
			console.warn("[browser-session] lifecycle record failed", error);
		}
	};
	const close = async (reason: BrowserSessionCloseReason) => {
		const closed = await browser.close();
		if (closed) await emit({ kind: "closed", name: policy.name, reason });
		return closed;
	};
	// Guardrails are fixed when Browser Run launches a session, so a browser
	// launched under other guardrails must not be reattached.
	let launchChecked: Promise<void> | undefined;
	const ensureLaunchGuardrails = () => {
		launchChecked ??= (async () => {
			const key = persistentEgressKey(egress);
			const previous = await markers.get(markerKey);
			if (previous === key) return;
			if (previous !== undefined) await close("egress_changed");
			await markers.put(markerKey, key);
		})().catch((error: unknown) => {
			launchChecked = undefined;
			throw error;
		});
		return launchChecked;
	};
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
				await ensureLaunchGuardrails();
				const resolved = await browser.resolve();
				const kind = resolved.restarted
					? "restarted"
					: (await markers.get(lastSessionKey)) === resolved.sessionId
						? "reused"
						: "opened";
				await markers.put(lastSessionKey, resolved.sessionId);
				await emit({
					kind,
					name: policy.name,
					sessionId: resolved.sessionId,
					allowedDomains: allowedDomains ?? null,
				});
				const output = await execute.execute(input, toolOptions);
				if (!output.restarted) return output;
				if (kind !== "restarted") {
					const current = await browser.resolve();
					await emit({
						kind: "restarted",
						name: policy.name,
						sessionId: current.sessionId,
						allowedDomains: allowedDomains ?? null,
					});
				}
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
		tools: withBrowserExecuteUsage(tools, "persistent"),
		executeEgress: egress.enforceable
			? null
			: { decision: "deny", hostname: null, reason: egress.reason },
		...(allowedDomains ? { allowedDomains } : {}),
		liveView: () => browser.liveView({ mode: "tab" }),
		currentSessionId: async () => (await browser.liveView())?.sessionId,
		close,
	};
}

export interface BrowserToolGates {
	approvalRequired: boolean;
	hostnamePolicies: readonly (BrowserHostnamePolicy | undefined)[];
	/** {@link TediBrowserSession.executeEgress}. */
	executeEgress?: BrowserEgressDecision | null;
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
							const egress =
								name === "browser_execute" && gates.executeEgress !== undefined
									? gates.executeEgress
									: browserToolEgressDecision(
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

/**
 * Tools that read and end the tedi's browser session. Neither consumes
 * browser budget; neither returns Browser Run ids or Live View URLs.
 */
export function browserSessionTools(
	session: () => TediBrowserSession,
	policy: () => BrowserSessionPolicy | undefined,
	onClosed: () => Promise<void>,
): ToolSet {
	return {
		browser_session_status: tool({
			description:
				"Read this tedi's browser session: mode, persistent name and idle keep-alive, the hostname guardrails it launches with, and whether a browser is open now. Does not open a browser or consume budget.",
			inputSchema: z.object({}),
			execute: async () => {
				const current = session();
				const active = policy();
				return {
					mode: current.mode,
					...(active?.mode === "persistent"
						? { name: active.name, keepAliveMs: active.keepAliveMs }
						: {}),
					egress:
						current.executeEgress === undefined
							? "per_call"
							: current.executeEgress === null
								? current.allowedDomains
									? "guardrails"
									: "unrestricted"
								: `browser_execute_refused:${current.executeEgress.reason}`,
					allowedDomains: current.allowedDomains ?? null,
					open: (await current.currentSessionId()) !== undefined,
				};
			},
		}),
		browser_session_close: tool({
			description:
				"End this tedi's browser session: close its tabs and discard cookies and logins. The next browser_execute starts a fresh browser and reports a restart. Use when a task is done with a signed-in site or the session is in a bad state. Does not consume budget.",
			inputSchema: z.object({}),
			execute: async () => {
				const closed = await session().close("tedi_request");
				await onClosed();
				return { closed };
			},
		}),
	};
}
