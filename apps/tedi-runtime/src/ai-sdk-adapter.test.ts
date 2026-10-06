import { privateInferenceOriginGuard } from "./runtime-inference-origin";
/**
 * Standalone assertions for `selectAzureDeployment` — the shared-catalog
 * deployment selector. Run directly: `bun run src/ai-sdk-adapter.test.ts`.
 *
 * The load-bearing guarantee: with NO override the selector returns
 * `env.AZURE_CHAT_DEPLOYMENT` byte-for-byte (no parse/trim round-trip), so the
 * configured default stays unchanged. A valid
 * Azure override selects its model; anything else falls back byte-for-byte.
 */
import assert from "node:assert/strict";
import {
	AiRequestTooLargeError,
	assertAiRequestSize,
	DEFAULT_MAX_AI_REQUEST_BYTES,
	resolveMaxAiRequestBytes,
} from "./ai-request-guard";
import {
	aiGatewayRequestSignal,
	azureGatewayByokHeaders,
	azureGatewayRequest,
	DEFAULT_AI_REQUEST_TIMEOUT_MS,
	resolveAiRequestTimeoutMs,
	selectAzureDeployment,
} from "./ai-sdk-adapter";
import { aigMetadataHeader } from "./llm";

{
	assert.equal(
		resolveAiRequestTimeoutMs(undefined),
		DEFAULT_AI_REQUEST_TIMEOUT_MS,
	);
	assert.equal(resolveAiRequestTimeoutMs("45000"), 45_000);
	assert.equal(
		resolveAiRequestTimeoutMs("600000"),
		DEFAULT_AI_REQUEST_TIMEOUT_MS,
	);
	assert.equal(
		resolveAiRequestTimeoutMs("not-a-number"),
		DEFAULT_AI_REQUEST_TIMEOUT_MS,
	);

	const caller = new AbortController();
	const composed = aiGatewayRequestSignal([caller.signal], 60_000);
	caller.abort("caller canceled");
	assert.equal(composed.aborted, true);
	assert.equal(composed.reason, "caller canceled");

	const timed = aiGatewayRequestSignal([], 1);
	await new Promise<void>((resolve) =>
		timed.addEventListener("abort", () => resolve(), { once: true }),
	);
	assert.equal(timed.aborted, true);
}

{
	const headers = azureGatewayByokHeaders(
		{
			"api-key": "stale-worker-key",
			"x-test": "kept",
			"cf-aig-no-wholesale": "false",
		},
		"gateway-token",
		JSON.stringify({ surface: "tedi", tediId: "cto" }),
	);
	assert.equal(headers.has("api-key"), false);
	assert.equal(headers.get("cf-aig-no-wholesale"), "true");
	assert.equal(headers.get("cf-aig-authorization"), "Bearer gateway-token");
	assert.equal(headers.get("x-test"), "kept");
}

{
	assert.equal(
		aigMetadataHeader({
			tediId: "tedi-id",
			orgId: "org-id",
			sessionKeyHash: "01234567",
			source: "cron:brain-consolidation",
			attribution: '{"v":1,"r":"run-1","w":"work-1"}',
		}),
		JSON.stringify({
			tediId: "tedi-id",
			orgId: "org-id",
			sessionKeyHash: "01234567",
			source: "cron:brain-consolidation",
			attribution: '{"v":1,"r":"run-1","w":"work-1"}',
		}),
	);
	assert.throws(
		() =>
			aigMetadataHeader({
				tediId: "tedi-id",
				orgId: "org-id",
				sessionKeyHash: "01234567",
				source: "cron:brain-consolidation",
				attribution: '{"v":1,"r":"run-1","w":"work-1"}',
				extra: "must-fail",
			} as never),
		/5-entry limit/,
	);
}

{
	assert.equal(
		resolveMaxAiRequestBytes(undefined),
		DEFAULT_MAX_AI_REQUEST_BYTES,
	);
	assert.equal(resolveMaxAiRequestBytes("123"), 123);
	assert.doesNotThrow(() => assertAiRequestSize("1234", "4"));
	assert.throws(
		() => assertAiRequestSize("12345", "4"),
		(error) =>
			error instanceof AiRequestTooLargeError &&
			error.bytes === 5 &&
			error.limit === 4,
	);
}

// --- BYTE-FOR-BYTE default: whitespace is preserved with no override ----------
{
	// `parseModelRef` trims; the default path must NOT, or a deployment value with
	// surrounding whitespace would silently differ from the legacy direct read.
	assert.equal(
		selectAzureDeployment({ AZURE_CHAT_DEPLOYMENT: " x " }),
		" x ",
		"no override → exact env deployment, including whitespace",
	);
	assert.equal(
		selectAzureDeployment({ AZURE_CHAT_DEPLOYMENT: "gpt-5-1-preview" }),
		"gpt-5-1-preview",
	);
	// Explicit null/undefined override behaves like no override.
	assert.equal(
		selectAzureDeployment({ AZURE_CHAT_DEPLOYMENT: " x " }, null),
		" x ",
	);
}

// --- a VALID Azure override selects its catalog model -------------------------
{
	assert.equal(
		selectAzureDeployment(
			{ AZURE_CHAT_DEPLOYMENT: "gpt-5-1-preview" },
			{ modelRef: "azure-openai/gpt-5.6-terra" },
		),
		"gpt-5.6-terra",
	);
}

// --- a REJECTED override (non-azure / disallowed / malformed) falls back ------
{
	const env = { AZURE_CHAT_DEPLOYMENT: " x " };
	// non-azure provider this adapter can't serve
	assert.equal(
		selectAzureDeployment(env, { modelRef: "anthropic/claude-opus" }),
		" x ",
		"non-azure override → byte-for-byte env fallback",
	);
	// not a catalog model
	assert.equal(
		selectAzureDeployment(env, { modelRef: "azure-openai/not-in-catalog" }),
		" x ",
	);
	// malformed override
	assert.equal(selectAzureDeployment(env, { modelRef: "garbage" }), " x ");
}

// --- ToolSet exposes mcp_complete_argument and delegates to executeTool -------
{
	const { tedixMcpAITools } = await import("./ai-sdk-adapter");
	const calls: Array<{ name: string; args: unknown }> = [];
	const stubRuntime = {
		executeTool: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			return { supported: true, values: ["sess_abc"] };
		},
	} as never;
	const tools = tedixMcpAITools(stubRuntime);
	const completeTool = tools.mcp_complete_argument;
	assert.ok(completeTool, "mcp_complete_argument is exposed to the model");
	const result = await completeTool.execute?.(
		// ToolSet values erase per-tool input types; the runtime stub sees the raw args.
		{ server: "peer-tedi", argument: "session_key", partial: "sess_" } as never,
		{ toolCallId: "t1", messages: [], context: undefined },
	);
	assert.deepEqual(result, { supported: true, values: ["sess_abc"] });
	assert.deepEqual(calls, [
		{
			name: "mcp_complete_argument",
			args: { server: "peer-tedi", argument: "session_key", partial: "sess_" },
		},
	]);
}

// --- Embedded tenant scope disables Code Mode and forces host arguments -----
{
	const { tedixMcpAITools } = await import("./ai-sdk-adapter");
	const calls: Array<{ name: string; args: unknown }> = [];
	const stubRuntime = {
		refreshConnections: async () => {},
		executeTool: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			return { ok: true };
		},
	} as never;
	const tools = tedixMcpAITools(stubRuntime, {
		conversationId: "embedded-conversation",
		runId: "embedded-run",
		toolArgumentConstraints: { companyId: "8042" },
		toolNamespacePrefix: "acme_staging",
		toolAllowedCallables: [
			"acme_staging.orders_status_summary",
			"work.list_work_items",
		],
	});
	assert.equal(tools.tedix_mcp_code, undefined);
	assert.deepEqual(Object.keys(tools), [
		"mcp_read_result",
		"tedix_mcp_call_tool",
	]);
	await tools.tedix_mcp_call_tool?.execute?.(
		{
			callable: "acme_staging.orders_status_summary",
			args: { companyId: "1", statusId: 9 },
		} as never,
		{ toolCallId: "t2", messages: [], context: undefined },
	);
	const rejected = await tools.tedix_mcp_call_tool?.execute?.(
		{
			callable: "identity.identity_me",
			args: {},
		} as never,
		{ toolCallId: "t3", messages: [], context: undefined },
	);
	const rejectedHostWrite = await tools.tedix_mcp_call_tool?.execute?.(
		{
			callable: "acme_staging.add_order_comment",
			args: { companyId: "1", text: "hello" },
		} as never,
		{ toolCallId: "t3-write", messages: [], context: undefined },
	);
	await tools.tedix_mcp_call_tool?.execute?.(
		{ callable: "work.list_work_items", args: { limit: 3 } } as never,
		{ toolCallId: "t4", messages: [], context: undefined },
	);
	assert.deepEqual(rejected, {
		ok: false,
		error: "This tool is not permitted for the tenant-bound embedded session.",
		tool: "tedix_mcp_call_tool",
	});
	assert.deepEqual(rejectedHostWrite, rejected);
	assert.deepEqual(calls, [
		{
			name: "tedix_mcp_call_tool",
			args: {
				callable: "acme_staging.orders_status_summary",
				args: { companyId: "8042", statusId: 9 },
			},
		},
		{
			name: "tedix_mcp_call_tool",
			args: { callable: "work.list_work_items", args: { limit: 3 } },
		},
	]);
}

// --- Embedded exact calls recover once from a pre-dispatch sync backoff -----
{
	const { tedixMcpAITools } = await import("./ai-sdk-adapter");
	let calls = 0;
	let refreshes = 0;
	const order: string[] = [];
	const stubRuntime = {
		executeTool: async (_name: string, args: Record<string, unknown>) => {
			order.push("execute");
			calls += 1;
			if (calls === 1) throw new Error("MCP sync in failure backoff");
			assert.deepEqual(args, {
				callable: "acme_staging.orders_list",
				args: { limit: 1, companyId: "1" },
			});
			return { orders: [{ id: 1, companyId: 1 }] };
		},
		refreshConnections: async () => {
			order.push("refresh");
			refreshes += 1;
		},
	} as never;
	const tools = tedixMcpAITools(stubRuntime, {
		conversationId: "embedded-conversation",
		runId: "embedded-run",
		toolArgumentConstraints: { companyId: "1" },
		toolNamespacePrefix: "acme_staging",
		toolAllowedCallables: ["acme_staging.orders_list"],
	});
	const result = await tools.tedix_mcp_call_tool?.execute?.(
		{ callable: "acme_staging.orders_list", args: { limit: 1 } } as never,
		{ toolCallId: "t4", messages: [], context: undefined },
	);
	assert.deepEqual(result, { orders: [{ id: 1, companyId: 1 }] });
	assert.equal(refreshes, 2);
	assert.equal(calls, 2);
	assert.deepEqual(order, ["refresh", "execute", "refresh", "execute"]);
}

// --- Home/kernel exact calls recover from detailed cold-connect backoff -----
{
	const { tedixMcpAITools } = await import("./ai-sdk-adapter");
	let calls = 0;
	let refreshes = 0;
	const order: string[] = [];
	const stubRuntime = {
		executeTool: async (_name: string, args: Record<string, unknown>) => {
			order.push("execute");
			calls += 1;
			if (calls === 1) {
				throw new Error(
					"MCP sync in failure backoff after: MCP connect tedix timed out after 10000ms",
				);
			}
			assert.deepEqual(args, {
				callable: "tedix.validate_tedi_app_access",
				args: { tediId: "reviewer-id" },
			});
			return { status: "valid", ok: true };
		},
		refreshConnections: async () => {
			order.push("refresh");
			refreshes += 1;
		},
	} as never;
	const tools = tedixMcpAITools(stubRuntime, {
		conversationId: "reviewer-conversation",
		runId: "reviewer-run",
	});
	const result = await tools.tedix_mcp_call_tool?.execute?.(
		{
			callable: "tedix.validate_tedi_app_access",
			args: { tediId: "reviewer-id" },
		} as never,
		{ toolCallId: "t5", messages: [], context: undefined },
	);
	assert.deepEqual(result, { status: "valid", ok: true });
	assert.equal(refreshes, 1);
	assert.equal(calls, 2);
	assert.deepEqual(order, ["execute", "refresh", "execute"]);
}

// --- Reviewer Code Mode recovers from detailed cold-connect backoff --------
{
	const { tedixMcpAITools } = await import("./ai-sdk-adapter");
	let calls = 0;
	let refreshes = 0;
	const order: string[] = [];
	const code =
		"async () => tedix.validate_tedi_app_access({ tediId: 'reviewer-id' })";
	const stubRuntime = {
		executeTool: async (name: string, args: Record<string, unknown>) => {
			order.push("execute");
			calls += 1;
			assert.equal(name, "tedix_mcp_code");
			assert.deepEqual(args, { code });
			if (calls === 1) {
				throw new Error(
					"MCP sync in failure backoff after: MCP connect tedix timed out after 10000ms",
				);
			}
			return { status: "valid", ok: true };
		},
		refreshConnections: async () => {
			order.push("refresh");
			refreshes += 1;
		},
	} as never;
	const tools = tedixMcpAITools(stubRuntime, {
		conversationId: "reviewer-conversation",
		runId: "reviewer-code-run",
	});
	const result = await tools.tedix_mcp_code?.execute?.({ code } as never, {
		toolCallId: "t6",
		messages: [],
		context: undefined,
	});
	assert.deepEqual(result, { status: "valid", ok: true });
	assert.equal(refreshes, 1);
	assert.equal(calls, 2);
	assert.deepEqual(order, ["execute", "refresh", "execute"]);
}

console.log("ai-sdk-adapter.test.ts: all assertions passed");

// Generated programs must not repeat the live namespace-reflection / TDZ failures.
{
	const { tedixMcpAITools } = await import("./ai-sdk-adapter");
	const tools = tedixMcpAITools({} as never);
	const description = tools.tedix_mcp_code?.description ?? "";
	assert.ok(typeof description === "string");
	assert.match(description, /uninvoked async/);
	assert.match(description, /includeParameters: true/);
	assert.match(description, /never resolve callables through globalThis/);
	assert.match(description, /Do not shadow a namespace/);
	assert.match(description, /tedix_mcp_call_tool/);
}

// Embedded schema hydration uses the supplied canonical runtime and keeps the model call-only.
{
	const { preparedTedixMcpAITools } = await import("./ai-sdk-adapter");
	const calls: Array<{
		name: string;
		args: Record<string, unknown>;
		options: unknown;
	}> = [];
	const binding = {
		conversationId: "embedded-schema",
		runId: "embedded-schema-run",
		toolArgumentConstraints: { accountId: "a" },
		toolNamespacePrefix: "inventory",
		toolAllowedCallables: ["inventory.get_item"],
	};
	const runtime = {
		executeTool: async (
			name: string,
			args: Record<string, unknown>,
			options: unknown,
		) => {
			calls.push({ name, args, options });
			return [
				{
					callable: "inventory.get_item",
					parameters: {
						type: "object",
						properties: { id: { type: "integer" } },
						required: ["id"],
					},
				},
			];
		},
	} as never;
	const tools = await preparedTedixMcpAITools(runtime, binding);
	assert.deepEqual(Object.keys(tools), [
		"mcp_read_result",
		"tedix_mcp_call_tool",
	]);
	assert.match(
		String(tools.tedix_mcp_call_tool!.description),
		/"required":\["id"\]/,
	);
	assert.match(
		String(tools.tedix_mcp_call_tool!.description),
		/external_embedded_tool_schemas/,
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.name, "tedix_mcp_code");
	assert.deepEqual(calls[0]!.options, { binding });
	assert.match(String(calls[0]!.args.code), /discover.describe/);
	await preparedTedixMcpAITools(runtime, null);
	assert.equal(
		calls.length,
		1,
		"ordinary chat does not hydrate embedded metadata",
	);
}

// --- A warm runtime does not re-handshake before every question ------------
{
	const { tedixMcpAITools } = await import("./ai-sdk-adapter");
	let refreshes = 0;
	const order: string[] = [];
	const stubRuntime = {
		executeTool: async () => {
			order.push("execute");
			return { ok: true };
		},
		refreshConnections: async () => {
			order.push("refresh");
			refreshes += 1;
		},
	} as never;
	const tools = tedixMcpAITools(stubRuntime, {
		conversationId: "embedded-conversation",
		runId: "embedded-run",
		toolArgumentConstraints: { companyId: "1" },
		toolNamespacePrefix: "acme_staging",
		toolAllowedCallables: ["acme_staging.orders_list"],
	});
	const call = () =>
		tools.tedix_mcp_call_tool?.execute?.(
			{ callable: "acme_staging.orders_list", args: {} } as never,
			{ toolCallId: "warm", messages: [], context: undefined },
		);
	await call();
	await call();
	await call();
	// The cold connector is still warmed once; two seconds of handshake do not
	// get charged to the second and third question in the same conversation.
	assert.equal(refreshes, 1);
	assert.deepEqual(order, ["refresh", "execute", "execute", "execute"]);
	console.log("tenant-bound connectors warm once per runtime");
}

// --- Admitted tool schemas are described once, not before every question ---
{
	const { preparedTedixMcpAITools, embeddedSchemaCacheKey } =
		await import("./ai-sdk-adapter");
	let describes = 0;
	const stubRuntime = {
		refreshConnections: async () => {},
		executeTool: async (name: string) => {
			if (name !== "tedix_mcp_code") return { ok: true };
			describes += 1;
			return [
				{
					callable: "acme_staging.orders_list",
					parameters: { type: "object", properties: {} },
				},
			];
		},
	} as never;
	const binding = {
		conversationId: "tenant-a:session-1",
		runId: "embedded-run",
		toolArgumentConstraints: { companyId: "1" },
		toolNamespacePrefix: "acme_staging",
		toolAllowedCallables: ["acme_staging.orders_list"],
	};
	let clock = 1_000;
	const prepare = () =>
		preparedTedixMcpAITools(stubRuntime, binding as never, () => clock);

	const first = await prepare();
	assert.equal(describes, 1, "the first turn resolves the schemas");
	assert.match(
		String(first.tedix_mcp_call_tool?.description),
		/Exact admitted parameter schemas/,
	);

	const second = await prepare();
	assert.equal(describes, 1, "a later turn reuses the resolved schemas");
	assert.match(
		String(second.tedix_mcp_call_tool?.description),
		/acme_staging\.orders_list/,
		"the reused schemas still reach the model",
	);

	clock += 11 * 60 * 1000;
	await prepare();
	assert.equal(describes, 2, "the window expires rather than pinning forever");

	// A different allowlist is a different question entirely.
	await preparedTedixMcpAITools(
		stubRuntime,
		{
			...binding,
			toolAllowedCallables: ["acme_staging.orders_status"],
		} as never,
		() => clock,
	);
	assert.equal(describes, 3, "a changed allowlist resolves again");

	// The cache outlives the runtime instance, because a Durable Object
	// hibernates between questions and the next turn builds a new one.
	const recycledRuntime = {
		refreshConnections: async () => {},
		executeTool: async (name: string) => {
			if (name !== "tedix_mcp_code") return { ok: true };
			describes += 1;
			return [];
		},
	} as never;
	await preparedTedixMcpAITools(recycledRuntime, binding as never, () => clock);
	assert.equal(describes, 3, "a recycled runtime reuses the resolved schemas");

	// One tenant never reads another's schemas.
	await preparedTedixMcpAITools(
		stubRuntime,
		{ ...binding, conversationId: "tenant-b:session-1" } as never,
		() => clock,
	);
	assert.equal(describes, 4, "a different conversation owner resolves its own");
	assert.notEqual(
		embeddedSchemaCacheKey(binding as never),
		embeddedSchemaCacheKey({
			...binding,
			toolAllowedCallables: ["acme_staging.orders_status"],
		} as never),
	);
	console.log("embedded tool schemas are described once per window");
}

// --- A failed description is retried, never cached ---------------------------
{
	const { preparedTedixMcpAITools } = await import("./ai-sdk-adapter");
	let describes = 0;
	const stubRuntime = {
		refreshConnections: async () => {},
		executeTool: async (name: string) => {
			if (name !== "tedix_mcp_code") return { ok: true };
			describes += 1;
			return [];
		},
	} as never;
	const binding = {
		conversationId: "c",
		runId: "r",
		toolArgumentConstraints: { companyId: "1" },
		toolNamespacePrefix: "acme_staging",
		toolAllowedCallables: ["acme_staging.orders_list"],
	};
	await preparedTedixMcpAITools(stubRuntime, binding as never);
	await preparedTedixMcpAITools(stubRuntime, binding as never);
	assert.equal(describes, 2, "an empty description is never pinned");
	console.log("a failed schema read is retried on the next turn");
}

// Successful schema discovery already warmed the connector. Failed exact calls
// invalidate only this binding's descriptions, without replaying the operation.
{
	const { preparedTedixMcpAITools } = await import("./ai-sdk-adapter");
	let discoveries = 0;
	let refreshes = 0;
	let actions = 0;
	const binding = {
		conversationId: "schema-warm-regression:session",
		runId: "run",
		toolArgumentConstraints: { companyId: "8042" },
		toolNamespacePrefix: "inventory",
		toolAllowedCallables: ["inventory.get_item"],
	};
	const runtime = {
		refreshConnections: async () => {
			refreshes += 1;
		},
		executeTool: async (name: string) => {
			if (name === "tedix_mcp_code") {
				discoveries += 1;
				return [
					{
						callable: "inventory.get_item",
						parameters: {
							type: "object",
							properties: { id: { type: "integer" } },
						},
					},
				];
			}
			actions += 1;
			throw new Error(
				"Structured content does not match the tool's output schema",
			);
		},
	} as never;
	const tools = await preparedTedixMcpAITools(runtime, binding);
	await tools.tedix_mcp_call_tool?.execute?.(
		{ callable: "inventory.get_item", args: { id: 1 } } as never,
		{ toolCallId: "schema-failure", messages: [], context: undefined },
	);
	assert.equal(refreshes, 0, "do not repeat discovery's successful sync");
	assert.equal(
		actions,
		1,
		"failed output validation must not replay the action",
	);
	await preparedTedixMcpAITools(runtime, binding);
	assert.equal(
		discoveries,
		2,
		"failure invalidates this binding's cached descriptions",
	);
}

// --- An admitted callable with no schema is named, not silently offered ------
{
	const { preparedTedixMcpAITools } = await import("./ai-sdk-adapter");
	let describes = 0;
	const stubRuntime = {
		refreshConnections: async () => {},
		executeTool: async (name: string) => {
			if (name !== "tedix_mcp_code") return { ok: true };
			describes += 1;
			// The gateway mounts only one of the two admitted callables.
			return [
				{
					callable: "acme_staging.orders_detail",
					parameters: {
						type: "object",
						properties: { id: { type: "integer" } },
					},
				},
			];
		},
	} as never;
	const binding = {
		conversationId: "tenant-partial:session-1",
		runId: "embedded-run",
		toolArgumentConstraints: { companyId: "8042" },
		toolNamespacePrefix: "acme_staging",
		toolAllowedCallables: [
			"acme_staging.orders_detail",
			"acme_staging.orders_search",
		],
	};
	let clock = 5_000;
	const tools = await preparedTedixMcpAITools(
		stubRuntime,
		binding as never,
		() => clock,
	);
	const description = String(tools.tedix_mcp_call_tool?.description);
	assert.match(description, /acme_staging\.orders_detail/);
	assert.match(
		description,
		/Not available in this session[\s\S]*acme_staging\.orders_search/,
		"the unmountable callable is named as unavailable, not just omitted",
	);

	// The partial read is reused briefly rather than re-described every turn.
	await preparedTedixMcpAITools(stubRuntime, binding as never, () => clock);
	assert.equal(describes, 1, "a partial read is not re-described immediately");

	// ...and it heals in a minute instead of being pinned for the full window.
	clock += 61 * 1000;
	await preparedTedixMcpAITools(stubRuntime, binding as never, () => clock);
	assert.equal(describes, 2, "a partial read expires on the short window");
	console.log("an unmounted admitted callable is reported, not advertised");
}

// Connect-time warm and the first question share pending metadata, not business calls.
{
	const { preparedTedixMcpAITools } = await import("./ai-sdk-adapter");
	let describes = 0;
	let release!: (rows: unknown[]) => void;
	const response = new Promise<unknown[]>((resolve) => {
		release = resolve;
	});
	const runtime = {
		executeTool: async () => {
			describes++;
			return response;
		},
	} as never;
	const binding = {
		conversationId: "singleflight-owner:embed:first",
		runId: "warm:first",
		toolArgumentConstraints: { companyId: "8042" },
		toolNamespacePrefix: "inventory",
		toolAllowedCallables: ["inventory.get_item"],
	};
	const warm = preparedTedixMcpAITools(runtime, binding);
	const turn = preparedTedixMcpAITools(runtime, {
		...binding,
		runId: "chat:first",
	});
	assert.equal(
		describes,
		1,
		"warm and turn must not queue duplicate discovery",
	);
	const otherRuntime = {
		executeTool: async () => {
			describes++;
			return response;
		},
	} as never;
	const other = preparedTedixMcpAITools(otherRuntime, binding);
	assert.equal(
		describes,
		2,
		"a separate runtime must prepare its own connector",
	);
	const changed = preparedTedixMcpAITools(runtime, {
		...binding,
		toolAllowedCallables: ["inventory.list_items"],
	});
	assert.equal(
		describes,
		3,
		"a different admitted set must not join pending discovery",
	);
	release([{ callable: "inventory.get_item", parameters: { type: "object" } }]);
	const [warmTools, turnTools] = await Promise.all([
		warm,
		turn,
		other,
		changed,
	]);
	assert.equal(
		warmTools.tedix_mcp_call_tool?.description,
		turnTools.tedix_mcp_call_tool?.description,
	);
}

// A failed shared read clears its pending promise, allowing the next request to retry.
{
	const { preparedTedixMcpAITools } = await import("./ai-sdk-adapter");
	let describes = 0;
	let reject!: (reason: Error) => void;
	const pending = new Promise<unknown[]>((_, rejectRead) => {
		reject = rejectRead;
	});
	const runtime = {
		executeTool: async () => {
			describes++;
			return describes === 1
				? pending
				: [{ callable: "inventory.get_item", parameters: { type: "object" } }];
		},
	} as never;
	const binding = {
		conversationId: "singleflight-retry:embed:first",
		runId: "retry-run",
		toolArgumentConstraints: { companyId: "8042" },
		toolNamespacePrefix: "inventory",
		toolAllowedCallables: ["inventory.get_item"],
	};
	const first = preparedTedixMcpAITools(runtime, binding);
	const second = preparedTedixMcpAITools(runtime, binding);
	reject(new Error("temporary metadata failure"));
	await Promise.all([first, second]);
	assert.equal(describes, 1);
	const retried = await preparedTedixMcpAITools(runtime, binding);
	assert.equal(describes, 2);
	assert.match(
		String(retried.tedix_mcp_call_tool?.description),
		/inventory.get_item/,
	);
}

const providerRoot =
	"https://workers-binding.ai/ai-gateway/gateways/test/azure-openai";
assert.deepEqual(
	azureGatewayRequest(
		"https://resource.openai.azure.com/openai/v1/responses",
		providerRoot,
		'{"model":"gpt-5.6-terra"}',
	),
	{
		api: "responses",
		model: "gpt-5.6-terra",
		url: `${providerRoot}/resource/openai/v1/responses`,
	},
);
const userinfoUrl = new URL(
	"https://resource.openai.azure.com/openai/v1/responses",
);
userinfoUrl.username = "user";
for (const url of [
	"https://resource.openai.azure.com/openai/deployments/model/chat/completions?api-version=2025-03-01-preview",
	"http://resource.openai.azure.com/openai/v1/responses",
	"https://resource.openai.azure.com.evil.test/openai/v1/responses",
	"https://resource.openai.azure.com:444/openai/v1/responses",
	userinfoUrl.href,
	"https://resource.openai.azure.com/openai/v1/responses?api-version=old",
	"https://resource.openai.azure.com/openai/deployments/model/responses",
	"https://resource.openai.azure.com/openai/v1/unknown",
])
	assert.throws(
		() => azureGatewayRequest(url, providerRoot, '{"model":"gpt-5.6-terra"}'),
		/Refusing Azure/,
	);
assert.throws(
	() =>
		azureGatewayRequest(
			"https://resource.openai.azure.com/openai/v1/responses",
			providerRoot,
			"{}",
		),
	/missing its deployment/,
);

// Exercise the real adapter/SDK boundary with reusable frozen provider options.
// Function strictness is separate from structured output and provider tools.
{
	const { azureModel } = await import("./ai-sdk-adapter");
	const { responsesFixtureStream } =
		await import("../test/pi-runtime/responses-recovery-fixture");
	const requests: Record<string, any>[] = [];
	const env = {
		AZURE_OPENAI_RESOURCE: "test-resource",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-terra",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "test-gateway",
		AI_GATEWAY_BINDING_PROVIDERS: "azure-openai",
		SECRETS_MASTER_KEY: "fixture-signing-secret",
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
		API_SERVICE: {
			fetch: async () =>
				Response.json({
					json: {
						allowed: true,
						settlementMode: "disabled",
						attributionVersion: 3,
						executionId: "12345678-1234-4123-8123-123456789abc",
						sendBefore: "2099-01-01T00:00:00.000Z",
						reservationId: null,
						expiresAt: null,
						estimatedChargeMicros: null,
					},
				}),
		},
		AI: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				assert.equal(
					new Headers(init?.headers).get("cf-aig-no-wholesale"),
					"true",
				);
				const body = (await new Request(input, init).json()) as Record<
					string,
					any
				>;
				requests.push(body);
				if (body.stream) return responsesFixtureStream(2);
				return Response.json({
					id: "resp-options",
					object: "response",
					created_at: 1,
					model: "gpt-5.6-terra",
					status: "completed",
					output: [
						{
							type: "message",
							id: "msg-options",
							role: "assistant",
							content: [{ type: "output_text", text: "ok", annotations: [] }],
						},
					],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				});
			},
		},
	} as unknown as import("./llm").AzureChatEnv;
	const model = azureModel(
		env,
		{ orgId: "test-org", tediId: "fixture-tedi", source: "ci" },
		undefined,
		privateCapturedGuard(() => {}, "test-org"),
	).responses("gpt-5.6-terra");
	const schema = {
		type: "object" as const,
		properties: { optional: { type: "string" as const } },
		additionalProperties: false,
	};
	Object.freeze(schema.properties.optional);
	Object.freeze(schema.properties);
	Object.freeze(schema);
	const options = {
		prompt: [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: "inspect" }],
			},
		],
		maxOutputTokens: 16_000,
		providerOptions: {
			azure: { reasoningEffort: "medium", strictJsonSchema: true },
		},
		responseFormat: {
			type: "json" as const,
			name: "answer",
			schema: {
				type: "object" as const,
				properties: { answer: { type: "string" as const } },
				required: ["answer"],
				additionalProperties: false,
			},
		},
		tools: [
			{
				type: "function" as const,
				name: "default_omission",
				inputSchema: schema,
			},
			{
				type: "function" as const,
				name: "explicit_strict",
				inputSchema: schema,
				strict: true,
			},
			{
				type: "function" as const,
				name: "explicit_omission",
				inputSchema: schema,
				strict: false,
			},
			{
				type: "provider" as const,
				id: "openai.web_search" as const,
				name: "search",
				args: { searchContextSize: "low" },
			},
		],
	};
	for (const entry of options.tools) Object.freeze(entry);
	Object.freeze(options.tools);
	const before = structuredClone(options);
	for (const streaming of [false, true]) {
		if (streaming) {
			const result = await model.doStream(options);
			for await (const _part of result.stream) {
			}
		} else await model.doGenerate(options);
		const wire = requests.at(-1)!;
		assert.deepEqual(
			wire.tools.slice(0, 3).map((entry: { strict: boolean }) => entry.strict),
			[false, true, false],
		);
		for (const entry of wire.tools.slice(0, 3))
			assert.deepEqual(entry.parameters, schema);
		assert.deepEqual(wire.tools[3], {
			type: "web_search",
			search_context_size: "low",
		});
		assert.equal(wire.text.format.strict, true);
		assert.deepEqual(wire.text.format.schema, options.responseFormat.schema);
		assert.equal(wire.reasoning.effort, "medium");
		assert.equal(wire.max_output_tokens, 16_000);
		assert.equal(wire.store, false);
		assert.ok(wire.include.includes("reasoning.encrypted_content"));
		assert.deepEqual(
			options,
			before,
			"middleware cannot mutate caller tools, schema or options",
		);
	}
	const { tools: _tools, ...withoutTools } = options;
	await model.doGenerate(withoutTools);
	assert.equal(requests.at(-1)!.tools, undefined);
	assert.equal(requests.at(-1)!.text.format.strict, true);
	console.log(
		"Responses preserves explicit function strictness, provider tools, output format and input immutability",
	);
}

const wireGuardAdmission = () =>
	Response.json({
		json: {
			allowed: true,
			settlementMode: "disabled",
			attributionVersion: 3,
			executionId: "12345678-1234-4123-8123-123456789abc",
			sendBefore: "2099-01-01T00:00:00.000Z",
			reservationId: null,
			expiresAt: null,
			estimatedChargeMicros: null,
		},
	});
const { generateText } = await import("ai");

function privateCapturedGuard(recheck: () => void, orgId = "org"): () => void {
	const owner = {
		orgId,
		tediId: "fixture-tedi",
		objectId: "a".repeat(64),
	};
	return privateInferenceOriginGuard(
		{
			kind: "unselected_native",
			root: {
				owner,
				objectName: "fixture-root",
				className: "AgentTediDO",
				path: [],
				generation: 0,
			},
			selected: {
				owner,
				className: "AgentTediDO",
				identityName: "fixture-root",
				facetName: null,
				path: [],
				generation: 0,
			},
			configurationHash: "b".repeat(64),
		},
		recheck,
	);
}
// Real adapter and service-bound billing, with no provider or financial writes.
for (const route of ["azure-https", "azure-binding"] as const) {
	const savedFetch = globalThis.fetch;
	let retryProbe = false;
	let sends = 0,
		admissions = 0,
		active = true,
		release!: () => void,
		entered!: () => void;
	const barrier = new Promise<void>((r) => {
		release = r;
	});
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const wire = async (_input?: unknown, init?: RequestInit) => {
		sends++;
		assert.ok(!JSON.stringify(init).includes("beforeDispatch"));
		if (retryProbe) {
			active = false;
			return new Response("scripted transient provider failure", {
				status: 503,
			});
		}
		throw new Error("controlled-wire-reached");
	};
	const env = {
		AZURE_OPENAI_RESOURCE: "fixture",
		AZURE_OPENAI_API_VERSION: "test",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-terra",
		AZURE_OBSERVER_DEPLOYMENT: "gpt-5.6-terra",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "gateway",
		SECRETS_MASTER_KEY: "fixture-signing-secret",
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
		CF_AI_GATEWAY_TOKEN: "token",
		...(route.endsWith("binding")
			? {
					AI_GATEWAY_BINDING_PROVIDERS: route.startsWith("azure")
						? "azure-openai"
						: "workers-ai",
				}
			: {}),
		AI: { fetch: wire, run: wire },
		API_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = await new Request(input, init).text();
				assert.ok(!body.includes("beforeDispatch"));
				admissions++;
				entered();
				await barrier;
				return wireGuardAdmission();
			},
		},
	};
	globalThis.fetch = wire;
	const guard = () => {
		if (!active) throw new Error("revoked");
	};
	const invoke = async (
		guard: () => void,
		signal?: AbortSignal,
		maxRetries = 0,
	) => {
		const { azureModel } = await import("./ai-sdk-adapter");
		const model = azureModel(
			env as never,
			{ orgId: "org", tediId: "fixture-tedi" },
			undefined,
			guard,
		).responses("gpt-5.6-terra");
		return generateText({
			model,
			prompt: "fixture",
			maxRetries,
			abortSignal: signal,
		});
	};
	try {
		const pending = invoke(privateCapturedGuard(guard));
		await started;
		assert.equal(sends, 0);
		active = false;
		release();
		await assert.rejects(pending, {
			name: "ProviderDispatchGuardError",
			phase: "before_dispatch",
			providerRequestSent: false,
		});
		assert.equal(sends, 0);
		active = true;
		await assert.rejects(
			invoke(privateCapturedGuard(guard)),
			/controlled-wire-reached/,
		);
		assert.equal(sends, 1, route + " positive adapter reaches selected wire");
		active = false;
		await assert.rejects(invoke(privateCapturedGuard(guard)), {
			phase: "before_dispatch",
		});
		assert.equal(sends, 1);
		await assert.rejects(invoke(privateCapturedGuard(async () => {})), {
			phase: "before_dispatch",
		});
		assert.equal(sends, 1);
		active = true;
		retryProbe = true;
		await assert.rejects(
			invoke(privateCapturedGuard(guard), undefined, 1),
			(error: unknown) => {
				const failure = error as {
					name: string;
					lastError: { phase: string; providerRequestSent: boolean };
					errors: Array<{ statusCode?: number }>;
				};
				assert.equal(failure.name, "AI_RetryError");
				assert.equal(failure.errors.length, 2);
				const firstFailure = failure.errors[0];
				assert.ok(firstFailure);
				assert.equal(firstFailure.statusCode, 503);
				assert.equal(failure.lastError.phase, "before_dispatch");
				assert.equal(failure.lastError.providerRequestSent, false);
				return true;
			},
		);
		assert.equal(
			sends,
			2,
			"first actual SDK 503 wire remains dispatched; retry is fenced",
		);
		retryProbe = false;
		const cancelled = new AbortController();
		env.API_SERVICE.fetch = async () => {
			admissions++;
			cancelled.abort(new Error("cancelled-after-billing"));
			return wireGuardAdmission();
		};
		active = true;
		await assert.rejects(invoke(privateCapturedGuard(guard), cancelled.signal));
		assert.equal(
			sends,
			2,
			route + " successful billing does not bypass cancellation",
		);
		assert.ok(admissions >= 3);
	} finally {
		globalThis.fetch = savedFetch;
	}
}
console.log("PASS: selected adapter private wire authority");

{
	const { azureModel } = await import("./ai-sdk-adapter");
	assert.throws(
		() => azureModel({ AZURE_OPENAI_RESOURCE: "fixture" } as never),
		/authenticated AI Gateway/,
	);
}

// Real SDK retries share the original private capture's clock, over both transports.
for (const route of ["https", "binding"] as const) {
	const savedFetch = globalThis.fetch,
		now = Date.now,
		time = now();
	let wires = 0,
		bills = 0;
	Date.now = () => time;
	const guard = privateCapturedGuard(() => {});
	const wire = async () => {
		wires++;
		Date.now = () => time + 600_001;
		return new Response("unknown-503", { status: 503 });
	};
	const env = {
		SECRETS_MASTER_KEY: "fixture-signing-secret",
		AZURE_OPENAI_RESOURCE: "fixture",
		AZURE_OPENAI_API_VERSION: "test",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-terra",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "gateway",
		CF_AI_GATEWAY_TOKEN: "token",
		...(route === "binding"
			? { AI_GATEWAY_BINDING_PROVIDERS: "azure-openai" }
			: {}),
		AI: { fetch: wire },
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
		API_SERVICE: {
			fetch: async () => {
				bills++;
				return wireGuardAdmission();
			},
		},
	};
	globalThis.fetch = wire;
	try {
		const { azureModel } = await import("./ai-sdk-adapter");
		const model = azureModel(
			env as never,
			{ orgId: "org", tediId: "fixture-tedi" },
			undefined,
			guard,
		).responses("gpt-5.6-terra");
		await assert.rejects(
			generateText({ model, prompt: "fixture", maxRetries: 1 }),
			(error: any) => {
				assert.equal(error.name, "AI_RetryError");
				assert.equal(error.lastError.phase, "before_dispatch");
				assert.equal(error.errors[0].statusCode, 503);
				return true;
			},
		);
		assert.equal(wires, 1);
		assert.equal(bills, 1);
	} finally {
		Date.now = now;
		globalThis.fetch = savedFetch;
	}
}
// Reuse one SDK model concurrently; reverse receipts without borrowing another request's execution.
for (const route of ["https", "binding"] as const) {
	const savedFetch = globalThis.fetch;
	const pending = new Map<number, () => void>(),
		executions = new Map<number, string>(),
		sent = new Map<number, string>();
	const wire = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init),
			body = (await request.json()) as any;
		const metadata = JSON.parse(request.headers.get("cf-aig-metadata")!);
		const { decodeAiGatewayAttribution } =
			await import("@tedix/api-contract/schemas/ai-gateway-attribution");
		sent.set(
			body.max_output_tokens,
			decodeAiGatewayAttribution(metadata.attribution)!.executionId!,
		);
		assert.ok(!JSON.stringify(metadata).includes("originToken"));
		assert.ok(!JSON.stringify(metadata).includes("objectId"));
		return Response.json({
			id: "resp-test",
			object: "response",
			created_at: 1,
			model: "gpt-5.6-terra",
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg-test",
					role: "assistant",
					content: [{ type: "output_text", text: "ok", annotations: [] }],
				},
			],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		});
	};
	const env = {
		SECRETS_MASTER_KEY: "fixture-signing-secret",
		AZURE_OPENAI_RESOURCE: "fixture",
		AZURE_OPENAI_API_VERSION: "test",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-terra",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "gateway",
		CF_AI_GATEWAY_TOKEN: "token",
		...(route === "binding"
			? { AI_GATEWAY_BINDING_PROVIDERS: "azure-openai" }
			: {}),
		AI: { fetch: wire },
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
		API_SERVICE: {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const envelope = (await new Request(input, init).json()) as any,
					projection = envelope.json ?? envelope;
				const tokens = projection.estimatedOutputTokens,
					executionId = crypto.randomUUID();
				executions.set(tokens, executionId);
				await new Promise<void>((resolve) => pending.set(tokens, resolve));
				const response = (await wireGuardAdmission().json()) as any;
				response.json.executionId = executionId;
				return Response.json(response);
			},
		},
	};
	globalThis.fetch = wire;
	try {
		const { azureModel } = await import("./ai-sdk-adapter");
		const model = azureModel(
			env as never,
			{ orgId: "org", tediId: "fixture-tedi" },
			undefined,
			privateCapturedGuard(() => {}),
		).responses("gpt-5.6-terra");
		const a = generateText({
				model,
				prompt: "first",
				maxOutputTokens: 11,
				maxRetries: 0,
			}),
			b = generateText({
				model,
				prompt: "second",
				maxOutputTokens: 22,
				maxRetries: 0,
			});
		while (pending.size < 2) await new Promise((r) => setTimeout(r, 1));
		pending.get(22)!();
		await b;
		pending.get(11)!();
		await a;
		assert.deepEqual(
			sent,
			new Map([
				[22, executions.get(22)!],
				[11, executions.get(11)!],
			]),
		);
		assert.notEqual(sent.get(11), sent.get(22));
	} finally {
		globalThis.fetch = savedFetch;
	}
}
console.log(
	"PASS actual SDK HTTPS/binding logical retry nonrenewal and reversed concurrent receipt isolation",
);
