import { TediWorkspaceConnector } from "./durable-codemode";
import assert from "node:assert/strict";
import { constructedTediDo, tediDo } from "../test/tedi-do";
import { validateDurableCodeSource } from "./durable-codemode-policy";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";
import { type AgentMcpTools, handleMcp } from "./mcp-mount";

assert.deepEqual(
	validateDurableCodeSource(
		"async () => { const result = await mcp.search_tools({ query: 'x' }); return result; }",
	),
	{ ok: true },
);
assert.match(
	validateDurableCodeSource(
		"async () => { const mcp = await mcp.call_tool({ name: 'x' }); return mcp; }",
	).error ?? "",
	/Do not shadow the mcp sandbox namespace/,
);

// The parent must not materialize an automatic second MCP tool catalog.
assert.equal(
	"includeMcpTools" in constructedTediDo(),
	false,
	"the parent cannot materialize a second MCP catalog",
);

// Durable execution uses the framework-neutral Code Mode runtime API, and the
// model sees the search/describe companions.
{
	const executed: unknown[] = [];
	const agent = tediDo({
		state: {},
		computerEnvironment: () => ({ selected: async () => null }),
		async getDurableCodemodeRuntime() {
			return {
				async execute(request: unknown) {
					executed.push(request);
					return { status: "completed", executionId: "", result: 1 };
				},
			};
		},
		computerCodeRouting: { record: async () => {} },
		async searchDurableCode(query: string) {
			return { query };
		},
		async describeDurableCode(target: string) {
			return { target };
		},
	});
	const scope = { kind: "conversation", key: "main" };
	const tools = agent.durableCodemodeAiTools(scope, null) as Record<
		string,
		{ execute: (input: unknown, options: unknown) => Promise<unknown> }
	>;
	const options = { toolCallId: "t", messages: [] };
	const code = "async () => { return await mcp.search_tools({ query: 'x' }); }";
	await tools.run_durable_code!.execute({ code }, options);
	assert.deepEqual(executed, [{ code }]);
	assert.deepEqual(
		await tools.search_durable_code!.execute({ query: "q" }, options),
		{
			query: "q",
		},
	);
	assert.deepEqual(
		await tools.describe_durable_code!.execute({ target: "t" }, options),
		{ target: "t" },
	);
}

// The tedi's MCP surface lists the same companions when they are wired.
{
	const response = await handleMcp(
		new Request("https://cto.tedi.tedix.dev/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"Mcp-Method": "tools/list",
				"Mcp-Protocol-Version": "2026-07-28",
				[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller({
					method: "service",
					principalId: "service-1",
					principalType: "service",
					scopes: ["tedi:admin"],
				}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientInfo": {
							name: "test",
							version: "1",
						},
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		}),
		"cto",
		{
			searchDurableCode: async () => ({}),
			describeDurableCode: async () => ({}),
			recoverCodeExecution: async () => ({
				recovered: false,
				execution_id: "test",
				reason: "too_recent",
			}),
		} as unknown as AgentMcpTools,
	);
	const listed = (await response.json()) as {
		result?: { tools?: Array<{ name: string }> };
	};
	const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
	assert.ok(names.includes("search_durable_code"), JSON.stringify(listed));
	assert.ok(names.includes("describe_durable_code"));
	assert.ok(names.includes("recover_code_execution"));
}

console.log("durable-codemode OK");

{
	const calls: unknown[] = [];
	const connector = Object.create(TediWorkspaceConnector.prototype);
	connector.workspace = {
		readFile: async () => {
			throw new Error("Connector must not read separately");
		},
		writeFile: async () => {
			throw new Error("Connector must not write separately");
		},
		deleteFile: async () => {
			throw new Error("Connector must not delete separately");
		},
		writeReversibleFile: async (...args: unknown[]) => {
			calls.push(["write", ...args]);
			return { previousContent: "prior" };
		},
		restoreFile: async (...args: unknown[]) => {
			calls.push(["restore", ...args]);
		},
	};
	const write = connector.tools().write_file;
	const input = { path: "note.txt", content: "approved" };
	const receipt = await write.execute(input);
	await write.revert(input, receipt);
	assert.deepEqual(calls, [
		["write", "note.txt", "approved"],
		["restore", "note.txt", "approved", "prior"],
	]);
	await assert.rejects(write.revert(input, {}), /Missing prior/);
	connector.workspace = {};
	await assert.rejects(write.execute(input), /owner-guarded reversible/);
	await assert.rejects(
		write.revert(input, { previousContent: null }),
		/owner-guarded rollback/,
	);
}

// Capture the actual parent's options and construct the real installed browser
// runtime. Its executor bridge uses only a primitive fictional entrypoint;
// neither the browser binding nor a tenant facet executes.
{
	const bunTestModule = "bun:test";
	const { mock } = await import(bunTestModule);
	const { createBrowserRuntime } = await import("agents/browser/ai");
	const { DynamicWorkerExecutor } = await import("@cloudflare/codemode");
	const installedConstructor = createBrowserRuntime;
	const captures: Parameters<typeof installedConstructor>[0][] = [];
	const events: Record<string, unknown>[] = [];
	const originalLog = console.log;
	let browserCalls = 0;
	let manifest: unknown;
	let fail = false;
	const nativeError = new Error("fictional native refusal");
	const rawCallback = () => ({
		compatibilityDate: "2026-06-17",
		mainModule: "raw.js",
		modules: {},
	});
	const entrypoint = {
		evaluate: async () => ({ result: 7, logs: [] }),
		[Symbol.dispose]() {},
	};
	const stub = { getEntrypoint: () => entrypoint, dispose() {} };
	const loader = {
		load(code: unknown) {
			assert.equal(this, loader);
			manifest = code;
			if (fail) throw nativeError;
			return stub;
		},
		get(name: unknown, callback: unknown) {
			assert.equal(this, loader);
			assert.equal(name, null);
			assert.equal(callback, rawCallback);
			return stub;
		},
	};
	mock.module("agents/browser/ai", () => ({
		createBrowserRuntime: (
			options: Parameters<typeof installedConstructor>[0],
		) => {
			captures.push(options);
			return installedConstructor(options);
		},
	}));
	console.log = (value: unknown) => events.push(JSON.parse(String(value)));
	try {
		const ctx = {
			exports: { CodemodeRuntime: class {} },
			facets: { get: () => ({}) },
		};
		const browser = {
			fetch() {
				browserCalls++;
				throw new Error("no browser execution");
			},
		};
		const agent = tediDo({ ctx, env: { BROWSER: browser, LOADER: loader } });
		const runtime = agent.getBrowserRuntime();
		assert.equal(agent.getBrowserRuntime(), runtime);
		assert.equal(captures.length, 1);
		const options = captures[0]!;
		assert.equal(options.ctx, agent.ctx);
		assert.equal(options.browser, browser);
		assert.equal(options.name, "tedi-native-browser");
		assert.deepEqual(options.quickActions, { maxChars: 0 });
		assert.deepEqual(options.session, { mode: "dynamic" });
		assert.equal(events.length, 0);
		const raw = {
			compatibilityDate: "2026-06-17",
			mainModule: "raw.js",
			modules: {},
			compatibilityFlags: ["nodejs_compat"],
		};
		assert.equal(options.loader!.load(raw), stub);
		assert.equal(manifest, raw);
		assert.equal(options.loader!.get(null, rawCallback), stub);
		const executor = new DynamicWorkerExecutor({
			loader: options.loader!,
			timeout: 1000,
		});
		await executor.execute("async () => 7", []);
		assert.deepEqual(
			(manifest as { compatibilityFlags: unknown }).compatibilityFlags,
			["nodejs_compat"],
		);
		assert.equal(
			(manifest as unknown as { globalOutbound: unknown }).globalOutbound,
			null,
		);
		fail = true;
		assert.throws(
			() => options.loader!.load(raw),
			(error) => error === nativeError,
		);
		const missing = tediDo({ ctx, env: { BROWSER: browser } });
		missing.getBrowserRuntime();
		assert.equal(captures[1]!.loader, undefined);
		assert.equal(browserCalls, 0);
		assert.equal(events.length, 8);
		for (const event of events) {
			assert.deepEqual(Object.keys(event).sort(), [
				"event",
				"identity",
				"method",
				"phase",
				"reason",
				"surface",
				"version",
			]);
			assert.equal(event.surface, "tedi_browser_code");
			assert.equal(event.reason, "tedi_browser_authored_invocation");
		}
		assert.deepEqual(
			events.map((event) => event.phase),
			[
				"attempted",
				"returned",
				"attempted",
				"returned",
				"attempted",
				"returned",
				"attempted",
				"threw",
			],
		);
	} finally {
		console.log = originalLog;
		mock.module("agents/browser/ai", () => ({
			createBrowserRuntime: installedConstructor,
		}));
	}
}
