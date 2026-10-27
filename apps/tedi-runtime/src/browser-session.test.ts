import { strict as assert } from "node:assert";
import type { BrowserHostnamePolicy } from "@tedix/api-contract/schemas/tedi";
import type {
	Browser,
	ListableBrowserSessionStore,
	StoredBrowserSession,
} from "agents/browser";
import { z } from "zod";
import {
	BROWSER_EXECUTE_USAGE_HEADING,
	BROWSER_RESTARTED_NOTE,
	type BrowserLaunchMarkerStore,
	type BrowserSessionLifecycleEvent,
	browserSessionRuntimeEvent,
	browserSessionSignature,
	browserSessionTools,
	createTediBrowserSession,
	governBrowserTools,
} from "./browser-session";

/**
 * Durable DO storage stand-in: survives a new session object. Holds both the
 * SDK's session records and the launch-guardrail marker.
 */
function memoryStore(): ListableBrowserSessionStore & BrowserLaunchMarkerStore {
	const rows = new Map<string, unknown>();
	return {
		acquireLock: () => ({ release: () => {} }),
		get: (key: string) => rows.get(key) as StoredBrowserSession | undefined,
		set: (key, value) => void rows.set(key, value),
		put: (key, value) => void rows.set(key, value),
		delete: (key) => void rows.delete(key),
		list: (prefix) =>
			new Map(
				[...rows].filter(([key]) => key.startsWith(prefix)) as [
					string,
					StoredBrowserSession,
				][],
			),
	};
}

/** Browser Run binding stand-in: creates sessions, reports dead ones as 410. */
function fakeBrowserRun() {
	const alive = new Set<string>();
	const launches: unknown[] = [];
	let created = 0;
	const binding = {
		async fetch(input: RequestInfo | URL, init?: RequestInit) {
			const url = new URL(String(input));
			if (init?.method === "POST" && url.pathname === "/v1/devtools/browser") {
				launches.push(JSON.parse(String(init.body)));
				const sessionId = `session-${++created}`;
				alive.add(sessionId);
				return Response.json({ sessionId });
			}
			const id = url.pathname.split("/")[4] ?? "";
			if (init?.method === "DELETE") {
				alive.delete(id);
				return new Response(null, { status: 204 });
			}
			return alive.has(id)
				? Response.json([])
				: new Response("gone", { status: 410 });
		},
		quickAction: async () => Response.json({ success: true, result: "" }),
	};
	return { binding, alive, launches, created: () => created };
}

const policy = {
	mode: "persistent" as const,
	name: "research",
	keepAliveMs: 300_000,
};

/**
 * The SDK tool, mocked down to what it does with the Browser: connect one
 * scope to it, which reports a restart when that scope last worked in an
 * earlier browser.
 */
const scopes = new Map<string, string>();
const mockBrowserTool = ((options: { browser: unknown }) => ({
	description: "browser",
	inputSchema: z.object({ code: z.string() }),
	execute: async () => {
		const browser = options.browser as Browser;
		const resolved = await browser.resolve();
		const previous = scopes.get(browser.name);
		scopes.set(browser.name, resolved.sessionId);
		return {
			result: resolved.sessionId,
			...(previous !== undefined && previous !== resolved.sessionId
				? { restarted: true as const }
				: {}),
		};
	},
	toModelOutput: () => ({ type: "text" as const, value: "" }),
})) as never;

function turn(
	store: ReturnType<typeof memoryStore>,
	run: ReturnType<typeof fakeBrowserRun>,
	options: {
		events?: BrowserSessionLifecycleEvent[];
		hostnamePolicies?: BrowserHostnamePolicy[];
	} = {},
) {
	return createTediBrowserSession({
		ctx: {} as DurableObjectState,
		browser: run.binding as never,
		loader: {} as WorkerLoader,
		policy,
		hostnamePolicies: options.hostnamePolicies,
		store,
		launchMarkers: store,
		onLifecycle: (event) => void options.events?.push(event),
		persistentTool: mockBrowserTool,
	});
}

const execute = async (session: ReturnType<typeof turn>) =>
	(await session.tools.browser_execute!.execute!(
		{ code: "1" } as never,
		{} as never,
	)) as { result: string; restarted?: true; notice?: string };

const kinds = (events: BrowserSessionLifecycleEvent[]) =>
	events.map((event) => event.kind);

// A persistent session survives across two turns, each with a fresh
// session object over the same durable store (DO hibernation between turns),
// and the ledger sees it opened then reused.
{
	scopes.clear();
	const store = memoryStore();
	const run = fakeBrowserRun();
	const events: BrowserSessionLifecycleEvent[] = [];
	const first = await execute(turn(store, run, { events }));
	const second = await execute(turn(store, run, { events }));
	assert.equal(first.result, "session-1");
	assert.equal(second.result, "session-1");
	assert.equal(second.restarted, undefined);
	assert.equal(second.notice, undefined);
	assert.equal(run.created(), 1);
	assert.deepEqual(kinds(events), ["opened", "reused"]);
	assert.deepEqual(events[0], {
		kind: "opened",
		name: "research",
		sessionId: "session-1",
		allowedDomains: null,
	});
	assert.deepEqual(run.launches, [{}]);
	assert.equal(await turn(store, run).currentSessionId(), "session-1");
}

// A lost browser is replaced, the restart reaches the model as a note, and
// the ledger records it.
{
	scopes.clear();
	const store = memoryStore();
	const run = fakeBrowserRun();
	const events: BrowserSessionLifecycleEvent[] = [];
	await execute(turn(store, run));
	run.alive.clear();
	const result = await execute(turn(store, run, { events }));
	assert.equal(result.result, "session-2");
	assert.equal(result.restarted, true);
	assert.ok(result.notice?.startsWith(BROWSER_RESTARTED_NOTE));
	assert.deepEqual(kinds(events), ["restarted"]);
}

// An allowlist launches the browser with Browser Run guardrails, again after
// a restart, and browser_execute is no longer refused for it.
const allowHttpbin = [
	{ allowedHostnames: ["httpbin.org", "*.example.com"], deniedHostnames: [] },
];
{
	scopes.clear();
	const store = memoryStore();
	const run = fakeBrowserRun();
	const events: BrowserSessionLifecycleEvent[] = [];
	const session = turn(store, run, { events, hostnamePolicies: allowHttpbin });
	assert.equal(session.executeEgress, null);
	assert.deepEqual(session.allowedDomains, ["*.example.com", "httpbin.org"]);
	await execute(session);
	run.alive.clear();
	await execute(turn(store, run, { hostnamePolicies: allowHttpbin }));
	const guardrails = {
		guardrails: { allowedDomains: ["*.example.com", "httpbin.org"] },
	};
	assert.deepEqual(run.launches, [guardrails, guardrails]);
	assert.deepEqual(
		(events[0] as { allowedDomains: string[] }).allowedDomains,
		guardrails.guardrails.allowedDomains,
	);

	// A different allowlist must not reattach the browser launched under the
	// old guardrails: it is closed and relaunched, reported as a restart.
	const narrowed = [{ allowedHostnames: ["httpbin.org"], deniedHostnames: [] }];
	const changed: BrowserSessionLifecycleEvent[] = [];
	const result = await execute(
		turn(store, run, { events: changed, hostnamePolicies: narrowed }),
	);
	assert.equal(result.result, "session-3");
	assert.equal(result.restarted, true);
	assert.deepEqual(run.launches.at(-1), {
		guardrails: { allowedDomains: ["httpbin.org"] },
	});
	assert.deepEqual(kinds(changed), ["closed", "restarted"]);
	assert.deepEqual(changed[0], {
		kind: "closed",
		name: "research",
		reason: "egress_changed",
	});
	// The same allowlist on a later turn reuses that browser.
	await execute(turn(store, run, { hostnamePolicies: narrowed }));
	assert.equal(run.created(), 3);
}

// A denylist cannot be a guardrail, so browser_execute stays refused when a
// denied host could otherwise be reached.
{
	const session = turn(memoryStore(), fakeBrowserRun(), {
		hostnamePolicies: [
			{ allowedHostnames: [], deniedHostnames: ["admin.example.com"] },
		],
	});
	assert.deepEqual(session.executeEgress, {
		decision: "deny",
		hostname: null,
		reason: "uninspectable_cdp",
	});
}

// The signature changes with the policy so a cached session is rebuilt.
assert.equal(browserSessionSignature(undefined), "dynamic");
assert.equal(browserSessionSignature({ mode: "dynamic" }), "dynamic");
assert.equal(browserSessionSignature(policy), "persistent:research:300000");
assert.equal(
	browserSessionSignature(policy, allowHttpbin),
	"persistent:research:300000:allow=*.example.com,httpbin.org",
);
assert.equal(
	browserSessionSignature({ mode: "dynamic" }, allowHttpbin),
	"dynamic",
);

// Every gate still applies to the persistent browser_execute tool.
{
	scopes.clear();
	const run = fakeBrowserRun();
	const tools = turn(memoryStore(), run).tools;
	const calls: string[] = [];
	const gates = {
		approvalRequired: false,
		hostnamePolicies: [] as BrowserHostnamePolicy[],
		enforceTakeover: async () => void calls.push("takeover"),
		onEgressDenied: async () => void calls.push("egress-denied"),
		consumeBudget: () => void calls.push("budget"),
		retain: async (result: unknown) => result,
	};
	const call = (overrides: Partial<Parameters<typeof governBrowserTools>[1]>) =>
		governBrowserTools(tools, { ...gates, ...overrides }).browser_execute!
			.execute!({ code: "1" } as never, {} as never);

	await call({});
	assert.deepEqual(calls, ["takeover", "budget"]);
	assert.equal(run.created(), 1);

	// Without a session verdict (dynamic mode), hostname rules refuse it.
	calls.length = 0;
	await assert.rejects(
		call({ hostnamePolicies: allowHttpbin }),
		/Browser egress denied \(uninspectable_cdp\)/,
	);
	assert.deepEqual(calls, ["takeover", "egress-denied"]);

	// A persistent session enforcing the allowlist as guardrails allows it.
	calls.length = 0;
	await call({ hostnamePolicies: allowHttpbin, executeEgress: null });
	assert.deepEqual(calls, ["takeover", "budget"]);

	// Quick actions still check their URL per call.
	await assert.rejects(
		governBrowserTools(tools, {
			...gates,
			hostnamePolicies: allowHttpbin,
			executeEgress: null,
		}).browser_markdown!.execute!(
			{ url: "https://evil.test/" } as never,
			{} as never,
		),
		/Browser egress denied \(hostname_not_allowed: evil.test\)/,
	);

	await assert.rejects(
		call({
			consumeBudget: () => {
				throw new Error("browser_budget_exhausted");
			},
		}),
		/browser_budget_exhausted/,
	);
	await assert.rejects(
		call({
			enforceTakeover: async () => {
				throw new Error("Browser session is paused for approval a-1.");
			},
		}),
		/paused for approval/,
	);
	assert.equal(run.created(), 1);
	assert.equal(
		(
			governBrowserTools(tools, { ...gates, approvalRequired: true })
				.browser_execute as { needsApproval?: boolean }
		).needsApproval,
		true,
	);
}

// browser_session_close ends the session and its takeover gate; the next
// call starts a fresh browser and says so. Status never exposes ids.
{
	scopes.clear();
	const store = memoryStore();
	const run = fakeBrowserRun();
	const events: BrowserSessionLifecycleEvent[] = [];
	const session = turn(store, run, {
		events,
		hostnamePolicies: allowHttpbin,
	});
	let gateCleared = 0;
	const tools = browserSessionTools(
		() => session,
		() => policy,
		async () => void gateCleared++,
	);
	await execute(session);
	assert.deepEqual(
		await tools.browser_session_close!.execute!({}, {} as never),
		{
			closed: true,
		},
	);
	assert.equal(gateCleared, 1);
	assert.equal(run.alive.size, 0);
	const next = await execute(session);
	assert.equal(next.restarted, true);
	assert.deepEqual(kinds(events), ["opened", "closed", "restarted"]);
	const status = await tools.browser_session_status!.execute!({}, {} as never);
	assert.deepEqual(status, {
		mode: "persistent",
		name: "research",
		keepAliveMs: 300_000,
		egress: "guardrails",
		allowedDomains: ["*.example.com", "httpbin.org"],
		open: true,
		login: null,
	});
}

// Ledger rows: one reused row per run and session; closes are distinct.
{
	const turnIds = { tediId: "tedi-1", runId: "run-1", conversationId: "c-1" };
	const reused = browserSessionRuntimeEvent(
		{
			kind: "reused",
			name: "research",
			sessionId: "session-1",
			allowedDomains: null,
		},
		turnIds,
		new Date(0),
	);
	assert.equal(reused.id, "run-1:browser-session:reused:session-1");
	assert.equal(reused.kind, "browser.session.reused");
	assert.deepEqual(reused.payload, {
		name: "research",
		sessionId: "session-1",
		allowedDomains: null,
	});
	const closed = browserSessionRuntimeEvent(
		{ kind: "closed", name: "research", reason: "tedi_request" },
		turnIds,
		new Date(5),
	);
	assert.equal(closed.id, "run-1:browser-session:closed:research:5");
	assert.equal(closed.kind, "browser.session.closed");
}

// browser_execute's description leads with the verified usage note in both
// session modes, keeping the SDK's own description after it.
{
	const store = memoryStore();
	const run = fakeBrowserRun();
	const text = (description: unknown) => {
		assert.equal(typeof description, "string");
		return description as string;
	};
	const persistent = text(turn(store, run).tools.browser_execute!.description);
	const dynamic = text(
		createTediBrowserSession({
			ctx: {
				storage: store,
				exports: { CodemodeRuntime: class {} },
				facets: { get: () => ({}) },
			} as unknown as DurableObjectState,
			browser: run.binding as never,
			loader: {} as WorkerLoader,
			policy: undefined,
			store,
		}).tools.browser_execute!.description,
	);
	for (const description of [persistent, dynamic]) {
		assert.ok(description.startsWith(BROWSER_EXECUTE_USAGE_HEADING));
		for (const call of [
			"cdp.send({ method, params, sessionId })",
			"cdp.attachToTarget({ targetId })",
			'method: "Target.createTarget"',
			'method: "Page.navigate"',
			'method: "Runtime.evaluate"',
			"document.querySelector('nav a[href]')",
			"browser_markdown({ url })",
			"browser_extract({ url, prompt, schema })",
			'request_browser_takeover({ reason: "login", note })',
			"browser_session_close",
		]) {
			assert.ok(description.includes(call), call);
		}
	}
	assert.ok(persistent.endsWith("\n\nbrowser"));
	assert.ok(persistent.includes('sessionId: "active"'));
	assert.ok(dynamic.includes("cdp.startSession()"));
	assert.ok(dynamic.includes("## Available connectors"));
}

console.log("browser-session tests passed");
