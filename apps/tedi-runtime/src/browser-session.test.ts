import { strict as assert } from "node:assert";
import type {
	Browser,
	ListableBrowserSessionStore,
	StoredBrowserSession,
} from "agents/browser";
import { z } from "zod";
import {
	BROWSER_RESTARTED_NOTE,
	browserSessionSignature,
	createTediBrowserSession,
	governBrowserTools,
} from "./browser-session";

/** Durable store stand-in: survives a new session object, like DO storage. */
function memoryStore(): ListableBrowserSessionStore {
	const rows = new Map<string, StoredBrowserSession>();
	return {
		acquireLock: () => ({ release: () => {} }),
		get: (key) => rows.get(key),
		set: (key, value) => void rows.set(key, value),
		delete: (key) => void rows.delete(key),
		list: (prefix) =>
			new Map([...rows].filter(([key]) => key.startsWith(prefix))),
	};
}

/** Browser Run binding stand-in: creates sessions, reports dead ones as 410. */
function fakeBrowserRun() {
	const alive = new Set<string>();
	let created = 0;
	const binding = {
		async fetch(input: RequestInfo | URL, init?: RequestInit) {
			const url = new URL(String(input));
			if (init?.method === "POST" && url.pathname === "/v1/devtools/browser") {
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
	return { binding, alive, created: () => created };
}

const policy = {
	mode: "persistent" as const,
	name: "research",
	keepAliveMs: 300_000,
};

/** The SDK tool, mocked down to what it does with the Browser: resolve it. */
const mockBrowserTool = ((options: { browser: unknown }) => ({
	description: "browser",
	inputSchema: z.object({ code: z.string() }),
	execute: async () => {
		const resolved = await (options.browser as Browser).resolve();
		return {
			result: resolved.sessionId,
			...(resolved.restarted ? { restarted: true as const } : {}),
		};
	},
	toModelOutput: () => ({ type: "text" as const, value: "" }),
})) as never;

function turn(
	store: ListableBrowserSessionStore,
	run: ReturnType<typeof fakeBrowserRun>,
	onRestarted?: () => void,
) {
	return createTediBrowserSession({
		ctx: {} as DurableObjectState,
		browser: run.binding as never,
		loader: {} as WorkerLoader,
		policy,
		store,
		onRestarted,
		persistentTool: mockBrowserTool,
	});
}

const execute = async (session: ReturnType<typeof turn>) =>
	(await session.tools.browser_execute!.execute!(
		{ code: "1" } as never,
		{} as never,
	)) as { result: string; restarted?: true; notice?: string };

// A persistent session survives across two turns, each with a fresh
// session object over the same durable store (DO hibernation between turns).
{
	const store = memoryStore();
	const run = fakeBrowserRun();
	const first = await execute(turn(store, run));
	const second = await execute(turn(store, run));
	assert.equal(first.result, "session-1");
	assert.equal(second.result, "session-1");
	assert.equal(second.restarted, undefined);
	assert.equal(second.notice, undefined);
	assert.equal(run.created(), 1);
	assert.equal(await turn(store, run).currentSessionId(), "session-1");
}

// A lost browser is replaced and the restart reaches the model as a note.
{
	const store = memoryStore();
	const run = fakeBrowserRun();
	let restarts = 0;
	await execute(turn(store, run));
	run.alive.clear();
	const result = await execute(turn(store, run, () => restarts++));
	assert.equal(result.result, "session-2");
	assert.equal(result.restarted, true);
	assert.ok(result.notice?.startsWith(BROWSER_RESTARTED_NOTE));
	assert.equal(restarts, 1);
}

// The signature changes with the policy so a cached session is rebuilt.
assert.equal(browserSessionSignature(undefined), "dynamic");
assert.equal(browserSessionSignature({ mode: "dynamic" }), "dynamic");
assert.equal(browserSessionSignature(policy), "persistent:research:300000");

// Every gate still applies to the persistent browser_execute tool.
{
	const run = fakeBrowserRun();
	const tools = turn(memoryStore(), run).tools;
	const calls: string[] = [];
	const gates = {
		approvalRequired: false,
		hostnamePolicies: [] as {
			allowedHostnames: string[];
			deniedHostnames: string[];
		}[],
		enforceTakeover: async () => void calls.push("takeover"),
		onEgressDenied: async () => void calls.push("egress-denied"),
		consumeBudget: () => void calls.push("budget"),
		retain: async (result: unknown) => result,
	};
	const call = (overrides: Partial<typeof gates>) =>
		governBrowserTools(tools, { ...gates, ...overrides }).browser_execute!
			.execute!({ code: "1" } as never, {} as never);

	await call({});
	assert.deepEqual(calls, ["takeover", "budget"]);
	assert.equal(run.created(), 1);

	calls.length = 0;
	await assert.rejects(
		call({
			hostnamePolicies: [
				{ allowedHostnames: ["example.com"], deniedHostnames: [] },
			],
		}),
		/Browser egress denied \(uninspectable_cdp\)/,
	);
	assert.deepEqual(calls, ["takeover", "egress-denied"]);

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

console.log("browser-session tests passed");
