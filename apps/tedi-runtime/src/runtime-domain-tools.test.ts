import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";

const options = { toolCallId: "domain-test", messages: [] };

// Exercise the parent tool entry points so extraction must preserve their wiring.
{
	const calls: unknown[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-example", slug: "example" },
		ensureIdentity: async () => {},
		env: {
			TEDI_STORAGE: {
				async list(input: unknown) {
					calls.push(input);
					return {
						objects: [{ key: "tedi-example/objects/report", size: 6 }],
						truncated: true,
						cursor: "next",
					};
				},
				async get(key: string) {
					calls.push(key);
					return key.endsWith("missing")
						? null
						: {
								text: async () => "abcdef",
								customMetadata: { source: "example" },
							};
				},
				async put(...args: unknown[]) {
					calls.push(args);
					return { etag: "etag", version: "version" };
				},
			},
		},
	});
	const tools = agent.objectStoreAiTools();
	const listed = await tools.object_store_list.execute(
		{ prefix: "report", limit: 10 },
		options,
	);
	assert.equal(listed.cursor, "next");
	assert.deepEqual(listed.objects, [
		{ path: "report", size: 6, uploaded: null },
	]);
	assert.deepEqual(calls.shift(), {
		prefix: "tedi-example/objects/report",
		limit: 10,
	});
	assert.deepEqual(
		await tools.object_store_read_text.execute({ path: "../escape" }, options),
		{ ok: false, error: "path must be a safe object path" },
	);
	assert.equal(calls.length, 0);
	const read = await tools.object_store_read_text.execute(
		{ path: "report", maxChars: 3 },
		options,
	);
	assert.equal(read.content, "abc");
	assert.equal(read.chars, 6);
	assert.equal(read.truncated, true);
	assert.deepEqual(
		await tools.object_store_read_text.execute({ path: "missing" }, options),
		{ ok: false, error: "not_found", key: "tedi-example/objects/missing" },
	);
	const written = await tools.object_store_write_text.execute(
		{ path: "report", content: "é" },
		options,
	);
	assert.equal(written.size, 2);
	assert.deepEqual(calls.at(-1), [
		"tedi-example/objects/report",
		"é",
		{
			httpMetadata: { contentType: "text/plain; charset=utf-8" },
			customMetadata: { producer: "tedi-runtime", slug: "example" },
		},
	]);
	agent.state = {};
	assert.deepEqual(await tools.object_store_list.execute({}, options), {
		ok: false,
		error: "Tedi identity is not resolved",
	});
}

{
	const agent = tediDo({ state: { orgId: "org-example" }, env: {} });
	const tools = agent.r2SqlAiTool();
	assert.equal(
		(await tools.r2_sql_query.execute({}, options)).error,
		"not_configured",
	);
	agent.env = {
		CF_ACCOUNT_ID: "account",
		CF_R2_SQL_TOKEN: "test-only",
		R2_SQL_WAREHOUSE: "warehouse",
	};
	const originalFetch = globalThis.fetch;
	const calls: Array<{ url: string; query: string }> = [];
	try {
		globalThis.fetch = async (url, init) => {
			calls.push({
				url: String(url),
				query: JSON.parse(String(init?.body)).query,
			});
			return Response.json({ result: { rows: [{ count: 2 }] } });
		};
		assert.equal((await tools.r2_sql_query.execute({}, options)).ok, false);
		assert.equal(calls.length, 0);
		const result = await tools.r2_sql_query.execute(
			{ select: ["count(*)"] },
			options,
		);
		assert.deepEqual(result.rows, [{ count: 2 }]);
		assert.match(calls[0]!.query, /org-example/);
		assert.match(calls[0]!.url, /accounts\/account\/r2-sql\/query\/warehouse$/);
		await tools.r2_sql_query.execute({ action: "describe_columns" }, options);
		assert.match(calls[1]!.query, /DESCRIBE/);
		globalThis.fetch = async () => new Response("denied", { status: 403 });
		assert.deepEqual(
			await tools.r2_sql_query.execute({ select: ["count(*)"] }, options),
			{
				ok: false,
				configured: true,
				status: 403,
				error: "analytics provider returned HTTP 403",
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

{
	const scope = { kind: "conversation", key: "example" };
	const binding = { runId: "run-example" };
	const calls: unknown[] = [];
	const agent = tediDo({
		runDurableCode: (...args: unknown[]) => {
			calls.push(args);
			return "executed";
		},
		searchDurableCode: (...args: unknown[]) => {
			calls.push(args);
			return "searched";
		},
		describeDurableCode: (...args: unknown[]) => {
			calls.push(args);
			return "described";
		},
		getDurableCodeExecution: (...args: unknown[]) => {
			calls.push(args);
			return "read";
		},
		listDurableCodeExecutions: (...args: unknown[]) => {
			calls.push(args);
			return ["execution"];
		},
	});
	const tools = agent.durableCodemodeAiTools(scope, binding);
	assert.equal(
		await tools.run_durable_code.execute({ code: "code" }, options),
		"executed",
	);
	assert.equal(
		await tools.search_durable_code.execute({ query: "query" }, options),
		"searched",
	);
	assert.equal(
		await tools.describe_durable_code.execute({ target: "target" }, options),
		"described",
	);
	assert.equal(
		await tools.get_code_execution.execute(
			{ execution_id: "execution" },
			options,
		),
		"read",
	);
	assert.deepEqual(await tools.list_code_executions.execute({}, options), {
		executions: ["execution"],
	});
	assert.deepEqual(calls, [
		[{ code: "code" }, scope, binding],
		["query", scope],
		["target", scope],
		["execution", scope],
		[20, scope],
	]);
}

{
	const calls: unknown[] = [];
	const binding = { runId: "run-example" };
	const agent = tediDo({
		state: {
			budgets: { browserBudgetDaily: 7 },
			toolPolicy: { browser: "always-approve" },
		},
		computerWorkspace: () => ({ workspace: {} }),
		getBrowserSession: () => ({
			tools: {
				browser_execute: {
					execute: async () => {
						calls.push("execute");
						return "result";
					},
				},
			},
			executeEgress: null,
			close: async () => true,
		}),
		browserHostnamePolicies: () => [],
		enforceBrowserTakeoverGate: async (name: string) => {
			calls.push(name);
		},
		getBrowserBudgetStore: () => ({
			consume: (limit: number) => calls.push(limit),
			status: (limit: number) => ({ limit }),
			persistentMinutes: () => ({ day: "2026-10-27", minutes: 5, ms: 300_000 }),
		}),
		requestBrowserTakeover: (...args: unknown[]) => {
			calls.push(args);
			return "requested";
		},
		browserTakeoverStatus: (...args: unknown[]) => {
			calls.push(args);
			return "status";
		},
		ctx: {
			storage: {
				get: async () => undefined,
				delete: async (key: string) => {
					calls.push(key);
				},
			},
		},
	});
	const tools = agent.browserAiTools(null, binding);
	assert.equal(tools.browser_execute.needsApproval, true);
	assert.equal(await tools.browser_execute.execute({}, options), "result");
	assert.deepEqual(calls.splice(0), ["browser_execute", 7, "execute"]);
	assert.deepEqual(await tools.browser_budget_status.execute({}, options), {
		limit: 7,
		persistentMinutes: { day: "2026-10-27", minutes: 5, ms: 300_000 },
		approvalPolicy: "always-approve",
		hostnamePolicy: { organization: null, tedi: null },
		timezone: "UTC",
	});
	assert.equal(
		await tools.request_browser_takeover.execute(
			{ reason: "mfa", note: "Continue" },
			options,
		),
		"requested",
	);
	assert.deepEqual(calls.pop(), [
		{ reason: "mfa", note: "Continue", limit: 7 },
		binding,
	]);
	assert.equal(
		await tools.get_browser_takeover_status.execute(
			{ approvalRequestId: "approval" },
			options,
		),
		"status",
	);
	assert.deepEqual(calls.pop(), ["approval", 7]);
	await tools.browser_session_close.execute({}, options);
	assert.equal(calls.length, 1);
}

console.log("runtime domain tool characterization tests passed");
