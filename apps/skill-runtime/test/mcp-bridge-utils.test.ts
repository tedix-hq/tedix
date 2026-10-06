import assert from "node:assert/strict";
import {
	McpInputRequiredError,
	unwrapJsonRpcToolResult as unwrapToolResult,
	stripCodeModeExecutionEnvelope,
} from "@tedix/mcp-shared/tool-result";
import {
	buildCodeModeCallSource,
	buildModernMcpBridgeRequest,
	extractPendingTediTaskId,
	injectWorkflowWorkItemMeta,
	injectWorkflowToolIdentity,
	needsAggregateCredentialRecovery,
	requiresAggregateCodeMode,
	resolveCodeModeNamespace,
	resolveMcpTarget,
	selectMcpToolNameFromList,
} from "../src/mcp-bridge-utils";
import {
	MAX_MCP_JSON_RPC_RESPONSE_BYTES,
	McpUpstreamResponseTooLargeError,
	readBoundedMcpResponseText,
	unwrapMcpResponseBody,
} from "../src/mcp-response-reader";
import { buildTenantRunContext, DISPATCH_SHIM } from "../src/runner";

const pinnedContext = buildTenantRunContext({
	skillId: "skill-1",
	skillSlug: "skill-one",
	tediId: "tedi-1",
	orgId: "org-1",
	runId: "run-1",
	executionEpoch: 0,
	admittedAt: "2026-08-31T00:00:00.000Z",
	workItemId: "work-1",
	manifest: {},
	namespaceToSlug: {},
	provenance: {
		source: {
			workflowSha256: "workflow",
			skillDocSha256: "skill-doc",
			skillRevision: 1,
			skillSlug: "skill-one",
		},
		runtime: {},
	},
});
assert.equal(pinnedContext.workItemId, "work-1");

// Regression for scheduled workflows losing their owner identity: the host
// creates __RUN_CONTEXT__, but the generated tenant allowlist must forward it.
assert.match(
	DISPATCH_SHIM,
	/const meta = freezeWorkflowValue\(this\.env\.__RUN_CONTEXT__ \|\| \{\}\)/,
);
assert.match(DISPATCH_SHIM, /__RUN_CONTEXT__:\s*meta/);
assert.match(DISPATCH_SHIM, /workItemId:\s*meta\.workItemId/);
assert.match(DISPATCH_SHIM, /MCP_UPSTREAM_RESPONSE_TOO_LARGE/);

// The first-party service-binding bridge speaks the sessionless 2026-07-28
// transport. Regression for executive workflow calls failing with -32601 after
// apps/mcp removed the legacy tools/call path.
const modernToolCall = buildModernMcpBridgeRequest({
	jsonrpc: "2.0",
	id: "call-1",
	method: "tools/call",
	params: {
		name: "ceo__run_tedi_turn",
		arguments: { text: "operate" },
		_meta: {
			"io.modelcontextprotocol/protocolVersion": "tenant-spoof",
			"com.tedix/workflowStep": { runId: "run-1" },
		},
	},
});
assert.deepEqual(modernToolCall.headers, {
	"MCP-Protocol-Version": "2026-07-28",
	"Mcp-Method": "tools/call",
	"Mcp-Name": "ceo__run_tedi_turn",
});
assert.deepEqual(
	(modernToolCall.body.params as Record<string, unknown>)._meta,
	{
		"io.modelcontextprotocol/protocolVersion": "2026-07-28",
		"io.modelcontextprotocol/clientInfo": {
			name: "tedix-skill-runtime",
			version: "1.0.0",
		},
		"io.modelcontextprotocol/clientCapabilities": {
			extensions: { "io.modelcontextprotocol/tasks": {} },
		},
		"com.tedix/workflowStep": { runId: "run-1" },
	},
);

// The workflow admission row, not tenant code or the tedi's later active
// checkout, owns output lineage. Host injection must override a colliding
// request-meta value and preserve the rest of the workflow envelope.
assert.deepEqual(
	injectWorkflowWorkItemMeta(
		{
			"io.tedix/workItemId": "tenant-spoof",
			"com.tedix/workflowStep": { runId: "run-1" },
		},
		"work-item-admitted",
	),
	{
		"io.tedix/workItemId": "work-item-admitted",
		"com.tedix/workflowStep": { runId: "run-1" },
	},
);
const unpinnedWorkflowMeta = { "com.tedix/workflowStep": { runId: "run-2" } };
assert.equal(
	injectWorkflowWorkItemMeta(unpinnedWorkflowMeta, null),
	unpinnedWorkflowMeta,
);

// Aggregate Code Mode keeps a tedi turn linkage as application data rather
// than converting the inner call to a protocol-native MCP Task. Poll only the
// exact accepted/pending linkage owned by the skill bridge.
const pendingTediTaskId = "tedi:5eed0038-0000-4000-8000-000000000038:run-1";
assert.equal(
	extractPendingTediTaskId({
		accepted: true,
		pending: true,
		assistant: null,
		task: { id: pendingTediTaskId, pollWith: "tasks/get" },
	}),
	pendingTediTaskId,
);
assert.equal(
	extractPendingTediTaskId({
		accepted: true,
		pending: false,
		task: { id: pendingTediTaskId, pollWith: "tasks/get" },
	}),
	null,
);
assert.equal(
	extractPendingTediTaskId({
		accepted: true,
		pending: true,
		task: { id: "foreign-task", pollWith: "tasks/get" },
	}),
	null,
);
assert.equal(
	extractPendingTediTaskId({
		accepted: true,
		pending: true,
		task: { id: pendingTediTaskId, pollWith: "custom/get" },
	}),
	null,
);

const modernTaskGet = buildModernMcpBridgeRequest({
	jsonrpc: "2.0",
	id: "task-1",
	method: "tasks/get",
	params: { taskId: "tedi-run-1" },
});
assert.deepEqual(modernTaskGet.headers, {
	"MCP-Protocol-Version": "2026-07-28",
	"Mcp-Method": "tasks/get",
	"Mcp-Name": "tedi-run-1",
});
assert.equal(
	(
		(modernTaskGet.body.params as Record<string, unknown>)._meta as Record<
			string,
			unknown
		>
	)["io.modelcontextprotocol/protocolVersion"],
	"2026-07-28",
);

const modernToolsList = buildModernMcpBridgeRequest({
	jsonrpc: "2.0",
	id: "list-1",
	method: "tools/list",
});
assert.deepEqual(modernToolsList.headers, {
	"MCP-Protocol-Version": "2026-07-28",
	"Mcp-Method": "tools/list",
});
assert.ok((modernToolsList.body.params as Record<string, unknown>)._meta);

// ── resolveMcpTarget: kernel/home → aggregate server + prefixed tool name ─────
// Regression for: env.MCP.home.ask routed to `home.<host>` → 404
// "No app found for subdomain: home", stalling durable goal-loop skills.
assert.deepEqual(resolveMcpTarget("home", "ask", {}, "acme-unified"), {
	slug: "acme-unified",
	toolName: "ask",
});
assert.deepEqual(
	resolveMcpTarget("home", "read_home_run", {}, "acme-unified"),
	{
		slug: "acme-unified",
		toolName: "home__read_home_run",
	},
);
assert.deepEqual(
	resolveMcpTarget("kernel", "approve_plan_assignments", {}, "acme-unified"),
	{
		slug: "acme-unified",
		toolName: "kernel__approve_plan_assignments",
	},
);

// A distinct organization routes to its own aggregate; no Tedix-specific
// fallback survives in the bridge.
assert.deepEqual(
	resolveMcpTarget("home", "read_home_run", {}, "tedix-unified"),
	{
		slug: "tedix-unified",
		toolName: "home__read_home_run",
	},
);

// A real app namespace maps to its own subdomain with the bare tool name.
assert.deepEqual(
	resolveMcpTarget("cms", "content_list", { cms: "cms-tedix" }, "acme-unified"),
	{ slug: "cms-tedix", toolName: "content_list" },
);

// SECURITY: a reserved aggregate namespace can never be shadowed by a mapped app
// slug — `home`/`kernel` always route to the aggregate even if an app slugged
// `home` exists in the org (otherwise that app would hijack every home/kernel
// tool call). Regression for the namespace-collision hijack finding.
assert.deepEqual(
	resolveMcpTarget("home", "ask", { home: "home-app" }, "acme-unified"),
	{
		slug: "acme-unified",
		toolName: "ask",
	},
);
assert.deepEqual(
	resolveMcpTarget(
		"kernel",
		"approve_plan_assignments",
		{ kernel: "kernel-app" },
		"acme-unified",
	),
	{ slug: "acme-unified", toolName: "kernel__approve_plan_assignments" },
);

// ── resolveMcpTarget: unmapped namespace → aggregate + prefixed tool name ─────
// Regression for: env.MCP.seo.query_gsc_search_analytics routed to the dead
// `seo.<host>` subdomain → HTTP 404 "No app found for subdomain: seo" (not a
// JSON-RPC -32601, so neither recovery fired) — platform gateway namespaces
// (`seo`/`cognitive`/`analytics`) were unreachable from skill workflows. An
// unmapped namespace is by construction not an app (resolveNamespaceSlugs
// already checked the exact, `-tedix`, and dashed candidates), so it routes to
// the aggregate under its prefixed wire name, exactly like home/kernel.
assert.deepEqual(
	resolveMcpTarget("seo", "query_gsc_search_analytics", {}, "acme-unified"),
	{
		slug: "acme-unified",
		toolName: "seo__query_gsc_search_analytics",
	},
);
assert.deepEqual(
	resolveMcpTarget("cognitive", "record_artifact", {}, "acme-unified"),
	{
		slug: "acme-unified",
		toolName: "cognitive__record_artifact",
	},
);
assert.deepEqual(resolveMcpTarget("my_app", "do_thing", {}, "acme-unified"), {
	slug: "acme-unified",
	toolName: "my_app__do_thing",
});
// A mapped app namespace still wins over the aggregate fallback.
assert.deepEqual(
	resolveMcpTarget(
		"promptwatch_tedix",
		"get_site_health",
		{
			promptwatch_tedix: "promptwatch-tedix",
		},
		"acme-unified",
	),
	{ slug: "promptwatch-tedix", toolName: "get_site_health" },
);

// Code-mode-only apps must be visible to apps/mcp's targeted aggregate
// hydration before the generated program executes. Its extractor recognizes
// dot calls, so normal verb-first snake_case tools use that form rather than
// appearing as an undefined namespace at runtime.
assert.equal(
	buildCodeModeCallSource("acme_official_tedix", "search_products", {
		query: "monitor",
	}),
	'async () => await acme_official_tedix.search_products({"query":"monitor"})',
);
assert.equal(
	buildCodeModeCallSource("firecrawl_tedix", "firecrawl_agent", {
		prompt: "research",
	}),
	'async () => await firecrawl_tedix.firecrawl_agent({"prompt":"research"})',
);
// Preserve safe support for unusual legacy tool names. apps/mcp recognizes
// this static bracket form too (covered by scope-extraction.test.ts).
assert.equal(
	buildCodeModeCallSource("legacy_provider", "search-items", {}),
	'async () => await legacy_provider["search-items"]({})',
);
assert.throws(
	() => buildCodeModeCallSource("not-safe-provider", "search", {}),
	/MCP_CODEMODE_NAMESPACE_INVALID/,
);

// A direct service-auth call to a tenant proxy may expose the source tool
// before the proxy's tenant credential overlay is applied. Only the pre-action
// structured credential miss is eligible for aggregate Code Mode recovery.
assert.equal(
	needsAggregateCredentialRecovery({
		ok: false,
		error:
			"Error: Connection credential not found. Ensure the provider is connected in Settings > Connections.",
	}),
	true,
);
assert.equal(
	needsAggregateCredentialRecovery({
		ok: false,
		error: "provider rate limited",
	}),
	false,
);
assert.equal(
	needsAggregateCredentialRecovery({
		ok: true,
		error: "connection credential not found",
	}),
	false,
);

// Identity-bound platform tools use the owner from the admitted run snapshot,
// never an invocation parameter supplied by tenant source.
assert.deepEqual(
	injectWorkflowToolIdentity(
		"cognitive",
		"record_artifact",
		{ name: "report.html", tediId: "spoofed-tedi" },
		"admitted-tedi",
	),
	{ name: "report.html", tediId: "admitted-tedi" },
);
assert.deepEqual(
	injectWorkflowToolIdentity(
		"tedix",
		"record_artifact",
		undefined,
		"admitted-tedi",
	),
	{ tediId: "admitted-tedi" },
);
assert.deepEqual(
	injectWorkflowToolIdentity("source", "fetch", { tediId: "input" }, "owner"),
	{ tediId: "input" },
);
assert.throws(
	() =>
		injectWorkflowToolIdentity(
			"cognitive",
			"record_artifact",
			["not", "an", "object"],
			"admitted-tedi",
		),
	/WORKFLOW_TOOL_ARGUMENTS_INVALID/,
);

assert.equal(
	selectMcpToolNameFromList("get_site_overview", {
		tools: [{ name: "cms__get_site_overview" }, { name: "get_site_overview" }],
	}),
	"get_site_overview",
);

assert.equal(
	selectMcpToolNameFromList("get_site_overview", {
		tools: [{ name: "cms__get_site_overview" }],
	}),
	"cms__get_site_overview",
);

assert.equal(
	selectMcpToolNameFromList("content_list", {
		tools: [{ name: "cms__content_list" }, { name: "docs__content_list" }],
	}),
	null,
);

assert.equal(selectMcpToolNameFromList("content_list", null), null);
assert.equal(selectMcpToolNameFromList("content_list", { tools: [{}] }), null);

// ── unwrapToolResult: input_required is a hard rejection, never a value ───────
// Regression for: the gateway's destructive-tool approval gate returns
// `resultType: "input_required"` with the approval prose as a content block —
// the old parser returned that prose as the resolved tool value, so skills
// believed a BLOCKED destructive call had succeeded.
const inputRequiredBody = JSON.stringify({
	jsonrpc: "2.0",
	id: "1",
	result: {
		resultType: "input_required",
		requestState: "opaque-state-1",
		inputRequests: { approval: { method: "elicitation/create" } },
		content: [
			{
				type: "text",
				text: 'Approval required for destructive action "repo_commit". Provide a reason and retry with inputResponses + requestState.',
			},
		],
	},
});
assert.throws(
	() => unwrapToolResult(inputRequiredBody, "repo_commit"),
	(err: unknown) =>
		err instanceof McpInputRequiredError &&
		err.code === "MCP_INPUT_REQUIRED" &&
		err.message.includes("repo_commit") &&
		err.message.includes("NOT executed"),
);

// Normal shapes still unwrap: structuredContent wins, single text content
// falls back to the (JSON-parsed) text, isError throws with the text.
assert.deepEqual(
	unwrapToolResult(
		JSON.stringify({
			jsonrpc: "2.0",
			id: "1",
			result: { structuredContent: { ok: true } },
		}),
		"list_things",
	),
	{ ok: true },
);
assert.equal(
	unwrapToolResult(
		JSON.stringify({
			jsonrpc: "2.0",
			id: "1",
			result: { content: [{ type: "text", text: "plain answer" }] },
		}),
		"list_things",
	),
	"plain answer",
);
assert.throws(
	() =>
		unwrapToolResult(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "1",
				result: { isError: true, content: [{ type: "text", text: "boom" }] },
			}),
			"list_things",
		),
	/MCP tool error: boom/,
);
assert.equal(
	unwrapToolResult("not json at all", "list_things"),
	"not json at all",
);

// ── resolveMcpTarget: reserved `tedi` namespace → calling tedi's own tools ────
// env.MCP.tedi.artifact_write_file must reach the CALLING tedi's aggregate
// namespace (configured by the aggregate), not a `tedi.<host>` app
// subdomain (regression: "No app found for subdomain: tedi").
assert.deepEqual(
	resolveMcpTarget(
		"tedi",
		"artifact_write_file",
		{},
		"acme-unified",
		"operator",
	),
	{ slug: "acme-unified", toolName: "operator__artifact_write_file" },
);
assert.deepEqual(
	resolveMcpTarget("tedi", "artifact_read_file", {}, "tedix-unified", "cto"),
	{ slug: "tedix-unified", toolName: "cto__artifact_read_file" },
);
// Shadow guard: an app slugged `tedi` must not hijack the reserved namespace.
assert.deepEqual(
	resolveMcpTarget(
		"tedi",
		"artifact_read_file",
		{ tedi: "tedi" },
		"acme-unified",
		"operator",
	),
	{ slug: "acme-unified", toolName: "operator__artifact_read_file" },
);
// Without a configured tedi namespace the call fails loudly, not with a 404.
assert.throws(
	() => resolveMcpTarget("tedi", "artifact_read_file", {}, "acme-unified"),
	/MCP_TARGET_UNRESOLVED/,
);

// Aggregate-tedi tools exist only as Code Mode providers. The bridge must use
// the configured role namespace in the generated program and must not spend a
// workflow attempt on the unreliable direct `cto__*` surface first.
assert.equal(requiresAggregateCodeMode("tedi"), true);
assert.equal(requiresAggregateCodeMode("home"), false);
assert.equal(requiresAggregateCodeMode("firecrawl"), false);
assert.equal(resolveCodeModeNamespace("tedi", "cto"), "cto");
assert.equal(
	resolveCodeModeNamespace("firecrawl_tedix", "cto"),
	"firecrawl_tedix",
);
assert.equal(
	buildCodeModeCallSource(
		resolveCodeModeNamespace("tedi", "cto"),
		"work_items_list",
		{ claimedByMe: true, limit: 1 },
	),
	'async () => await cto.work_items_list({"claimedByMe":true,"limit":1})',
);
assert.throws(() => resolveCodeModeNamespace("tedi"), /MCP_TARGET_UNRESOLVED/);

// ── bounded MCP response materialization ──────────────────────────────────────
assert.equal(MAX_MCP_JSON_RPC_RESPONSE_BYTES, 32 * 1024 * 1024);

const boundedPayload = JSON.stringify({ ok: true, evidence: "✓" });
assert.equal(
	await readBoundedMcpResponseText(
		new Response(boundedPayload, {
			headers: {
				"content-length": String(
					new TextEncoder().encode(boundedPayload).length,
				),
			},
		}),
		64,
	),
	boundedPayload,
);

function makeOverflowingResponse(contentLength?: string): {
	response: Response;
	wasCancelled: () => boolean;
} {
	let pullCount = 0;
	let cancelled = false;
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pullCount += 1;
			controller.enqueue(encoder.encode(pullCount === 1 ? "1234" : "56789"));
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		response: new Response(body, {
			headers:
				contentLength === undefined
					? undefined
					: { "content-length": contentLength },
		}),
		wasCancelled: () => cancelled,
	};
}

const honestOversized = makeOverflowingResponse("9");
await assert.rejects(
	() => readBoundedMcpResponseText(honestOversized.response, 8),
	(error: unknown) =>
		error instanceof McpUpstreamResponseTooLargeError &&
		error.code === "MCP_UPSTREAM_RESPONSE_TOO_LARGE" &&
		error.declaredBytes === 9 &&
		error.receivedBytes === undefined,
);
assert.equal(honestOversized.wasCancelled(), true);

const missingContentLength = makeOverflowingResponse();
await assert.rejects(
	() => readBoundedMcpResponseText(missingContentLength.response, 8),
	(error: unknown) =>
		error instanceof McpUpstreamResponseTooLargeError &&
		error.declaredBytes === undefined &&
		error.receivedBytes === 9,
);
assert.equal(missingContentLength.wasCancelled(), true);

const lyingContentLength = makeOverflowingResponse("4");
await assert.rejects(
	() => readBoundedMcpResponseText(lyingContentLength.response, 8),
	(error: unknown) =>
		error instanceof McpUpstreamResponseTooLargeError &&
		error.declaredBytes === 4 &&
		error.receivedBytes === 9,
);
assert.equal(lyingContentLength.wasCancelled(), true);

// A live Home acknowledgement was corrupted at metadata: inside echoed source.
// Exercise the actual framing helper and shared normalizer, not a copied parser.
const homeId = "home-run-1";
for (const content of [
	"metadata: { producer: original }",
	'data: literal\nevent: literal\nmetadata: "quoted"',
	"large echo ".repeat(4000) + "metadata: { receipt: true }",
]) {
	const value = {
		run: { id: homeId, status: "running" },
		userMessage: { content },
	};
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: "ask",
		result: {
			content: [{ type: "text", text: "Working in background" }],
			structuredContent: value,
		},
	});
	for (const type of [
		"application/json",
		"application/json; charset=utf-8",
		null,
	]) {
		assert.equal(unwrapMcpResponseBody(body, type), body);
		assert.deepEqual(
			unwrapToolResult(unwrapMcpResponseBody(body, type), "ask"),
			value,
		);
	}
	for (const newline of ["\n", "\r\n", "\r"]) {
		const framed = [
			": heartbeat data: ignored",
			"",
			"event: message",
			"id: metadata: ignored",
			"data: " + body,
			"",
			"",
		].join(newline);
		assert.deepEqual(
			unwrapToolResult(
				unwrapMcpResponseBody(framed, "text/event-stream; charset=utf-8"),
				"ask",
			),
			value,
		);
	}
}
// Only declared event streams are framed. Missing/wrong content type is not sniffed.
const undeclaredFrame = 'event: message\ndata: {"result":42}\n\n';
assert.equal(unwrapMcpResponseBody(undeclaredFrame, null), undeclaredFrame);
assert.equal(
	unwrapMcpResponseBody(undeclaredFrame, "application/json"),
	undeclaredFrame,
);
assert.equal(
	unwrapMcpResponseBody(undeclaredFrame, "text/event-stream-other"),
	undeclaredFrame,
);
assert.equal(
	unwrapMcpResponseBody("event: message\n: no data\n\n", "text/event-stream"),
	"event: message\n: no data\n\n",
);
const multiline =
	'event: message\ndata: {"result":\ndata: {"run":{"id":"' +
	homeId +
	'"}}}\n\n';
assert.deepEqual(
	unwrapToolResult(
		unwrapMcpResponseBody(multiline, "Text/Event-Stream"),
		"ask",
	),
	{ run: { id: homeId } },
);
// Direct tools, aggregate Code Mode, and task status retain their respective shapes.
for (const type of ["application/json", "text/event-stream"]) {
	const wire = (value: unknown) => {
		const body = JSON.stringify(value);
		return unwrapMcpResponseBody(
			type === "text/event-stream" ? "data: " + body + "\n\n" : body,
			type,
		);
	};
	const value = { run: { id: homeId }, metadata: "data: payload" };
	assert.deepEqual(
		stripCodeModeExecutionEnvelope(
			unwrapToolResult(
				wire({
					result: {
						structuredContent: { executionId: "code-1", result: value },
					},
				}),
				"home.ask",
			),
		),
		value,
	);
	const task = {
		taskId: "task-1",
		status: "completed",
		result: { structuredContent: value },
	};
	assert.deepEqual(JSON.parse(wire({ result: task })).result, task);
	assert.deepEqual(
		unwrapToolResult(JSON.stringify({ result: task.result }), "ask"),
		value,
	);
	assert.throws(
		() =>
			unwrapToolResult(
				wire({ error: { code: -32603, message: "metadata: provider error" } }),
				"ask",
			),
		/MCP tool error -32603: metadata: provider error/,
	);
	assert.throws(
		() =>
			unwrapToolResult(
				wire({
					result: {
						isError: true,
						content: [{ type: "text", text: "data: rejected" }],
					},
				}),
				"ask",
			),
		/MCP tool error: data: rejected/,
	);
	assert.throws(
		() =>
			unwrapToolResult(
				wire({ result: { resultType: "input_required", inputRequests: [] } }),
				"ask",
			),
		McpInputRequiredError,
	);
}
assert.equal(
	unwrapToolResult(
		unwrapMcpResponseBody("not json data: intact", "application/json"),
		"ask",
	),
	"not json data: intact",
);

console.log(
	"mcp-bridge-utils tests passed (incl. reserved tedi namespace and bounded responses)",
);
