/**
 * Official-MCP-conformance fixture for the Tedix stateless MCP transport.
 *
 * Builds the `McpServer` + `mountMcp()` options that `serve.ts` mounts so the
 * `@modelcontextprotocol/conformance` CLI (2026-07-28 scenario suite + the
 * `io.modelcontextprotocol/tasks` extension scenarios) can exercise
 * `packages/mcp/src/transport.ts` end to end.
 *
 * The registered tools/resources/prompts mirror the reference
 * "everything server" fixture the conformance suite is written against:
 * `test_simple_text`, `test_image_content`, the `test_input_required_result_*`
 * MRTR family, the SEP-2663 task tools (`greet`, `slow_compute`,
 * `failing_job`, `protocol_error_job`, `confirm_delete`, `multi_input`,
 * `test_tool_with_task`), the `test://` resources, and the `test_*` prompts.
 *
 * MRTR is served through the SDK's NATIVE 2026-07-28 path — handlers return
 * `inputRequired({...})` and read `ctx.mcpReq.inputResponses` /
 * `ctx.mcpReq.requestState()` — with `createRequestStateCodec` providing the
 * spec-mandated HMAC integrity protection for `requestState`.
 */
import {
	acceptedContent,
	CLIENT_CAPABILITIES_META_KEY,
	createRequestStateCodec,
	inputRequired,
	inputResponse,
	type McpServer,
	MissingRequiredClientCapabilityError,
	ResourceTemplate,
	type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import { MCP_TASKS_EXTENSION } from "../src/protocol";
import { createMcpServer } from "../src/server";
import {
	McpTaskError,
	type McpTaskHandlers,
	type McpTaskState,
} from "../src/tasks";
import type { MountMcpOptions } from "../src/transport";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { sleep } from "@tedix/worker-kit/sleep";

const SERVER_NAME = "tedix-conformance-fixture";
const SERVER_VERSION = "1.0.0";

/** 1x1 red PNG pixel (from the reference everything-server fixture). */
export const TEST_IMAGE_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** Minimal WAV file (from the reference everything-server fixture). */
export const TEST_AUDIO_BASE64 =
	"UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAA=";

/**
 * SEP-1613 / SEP-2106: raw JSON Schema 2020-12 with $schema, $defs, $anchor,
 * composition and conditional keywords — the conformance suite asserts these
 * survive `tools/list` untouched.
 */
const JSON_SCHEMA_2020_12_INPUT_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object" as const,
	$defs: {
		address: {
			$anchor: "addressDef",
			type: "object",
			properties: {
				street: { type: "string" },
				city: { type: "string" },
			},
		},
	},
	properties: {
		name: { type: "string" },
		address: { $ref: "#/$defs/address" },
		contactMethod: { type: "string", enum: ["phone", "email"] },
		phone: { type: "string" },
		email: { type: "string" },
	},
	allOf: [{ anyOf: [{ required: ["phone"] }, { required: ["email"] }] }],
	if: {
		properties: { contactMethod: { const: "phone" } },
		required: ["contactMethod"],
	},
	// `then` is the JSON Schema conditional keyword, not a thenable.
	then: { required: ["phone"] },
	else: { required: ["email"] },
	additionalProperties: false,
};

// =============================================================================
// requestState codec (SEP-2322 integrity MUST)
// =============================================================================

interface FixtureState {
	kind: string;
	round?: number;
	name?: string;
}

/**
 * Module-level so every per-request server instance shares the same key —
 * MRTR rounds arrive on separate stateless POSTs.
 */
const stateCodec = createRequestStateCodec<FixtureState>({
	key: "tedix-conformance-fixture-request-state-hmac-key-000",
});

// =============================================================================
// In-memory task store (SEP-2663) backing the transport's McpTaskHandlers
// =============================================================================

const TASK_TTL_MS = 300_000;
const TASK_POLL_INTERVAL_MS = 100;

interface FixtureTask {
	taskId: string;
	status: "working" | "input_required" | "completed" | "cancelled" | "failed";
	createdAt: string;
	lastUpdatedAt: string;
	inputRequests?: Record<string, unknown>;
	answers: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: Record<string, unknown> };
	timer?: ReturnType<typeof setTimeout>;
	onInputComplete?: (
		task: FixtureTask,
		answers: Record<string, unknown>,
	) => void;
}

const taskStore = new Map<string, FixtureTask>();

function isTerminal(task: FixtureTask): boolean {
	return (
		task.status === "completed" ||
		task.status === "cancelled" ||
		task.status === "failed"
	);
}

function touchTask(task: FixtureTask): void {
	task.lastUpdatedAt = new Date().toISOString();
}

function newTask(): FixtureTask {
	const now = new Date().toISOString();
	const task: FixtureTask = {
		taskId: crypto.randomUUID(),
		status: "working",
		createdAt: now,
		lastUpdatedAt: now,
		answers: {},
	};
	taskStore.set(task.taskId, task);
	return task;
}

function completeTask(
	task: FixtureTask,
	result: Record<string, unknown>,
): void {
	if (isTerminal(task)) return;
	task.status = "completed";
	task.result = result;
	task.inputRequests = undefined;
	touchTask(task);
}

function failTask(
	task: FixtureTask,
	error: { code: number; message: string; data?: Record<string, unknown> },
): void {
	if (isTerminal(task)) return;
	task.status = "failed";
	task.error = error;
	task.inputRequests = undefined;
	touchTask(task);
}

/**
 * Flat SEP-2663 `CreateTaskResult` (`Result & Task` intersection): resultType
 * "task" + taskId/status/createdAt/lastUpdatedAt/ttlMs at the top level, no
 * nested `task` wrapper, no `requestState`, no result/error/inputRequests.
 */
function createTaskResult(task: FixtureTask): Record<string, unknown> {
	return {
		resultType: "task",
		taskId: task.taskId,
		status: task.status,
		createdAt: task.createdAt,
		lastUpdatedAt: task.lastUpdatedAt,
		ttlMs: TASK_TTL_MS,
		pollIntervalMs: TASK_POLL_INTERVAL_MS,
	};
}

/** McpTaskHandlers for `mountMcp({ taskHandlers })` over the in-memory store. */
export const fixtureTaskHandlers: McpTaskHandlers = {
	async get({ taskId }) {
		const task = taskStore.get(taskId);
		if (!task) throw McpTaskError.notFound(taskId);
		const state: McpTaskState = {
			taskId: task.taskId,
			status: task.status,
			createdAt: task.createdAt,
			lastUpdatedAt: task.lastUpdatedAt,
			ttlMs: TASK_TTL_MS,
			pollIntervalMs: TASK_POLL_INTERVAL_MS,
		};
		if (task.status === "input_required" && task.inputRequests) {
			state.inputRequests = { ...task.inputRequests };
		}
		if (task.status === "completed" && task.result) {
			state.result = task.result;
		}
		if (task.status === "failed" && task.error) {
			state.error = task.error;
		}
		return state;
	},
	async update({ taskId, inputResponses }) {
		const task = taskStore.get(taskId);
		if (!task) throw McpTaskError.notFound(taskId);
		if (task.status !== "input_required" || !task.inputRequests) return;
		for (const [key, response] of Object.entries(inputResponses)) {
			if (key in task.inputRequests) {
				task.answers[key] = response;
				delete task.inputRequests[key];
			}
		}
		touchTask(task);
		if (Object.keys(task.inputRequests).length === 0) {
			task.status = "working";
			task.inputRequests = undefined;
			touchTask(task);
			task.onInputComplete?.(task, task.answers);
		}
	},
	async cancel({ taskId }) {
		const task = taskStore.get(taskId);
		if (!task) throw McpTaskError.notFound(taskId);
		if (isTerminal(task)) return; // idempotent empty ack
		if (task.timer) clearTimeout(task.timer);
		task.status = "cancelled";
		task.inputRequests = undefined;
		touchTask(task);
	},
};

// =============================================================================
// Helpers
// =============================================================================

function textResult(text: string): {
	content: Array<{ type: "text"; text: string }>;
} {
	return { content: [{ type: "text", text }] };
}

function clientCapabilitiesOf(ctx: ServerContext): Record<string, unknown> {
	const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
	const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY];
	return isRecord(caps) ? caps : {};
}

function tasksDeclared(ctx: ServerContext): boolean {
	const extensions = clientCapabilitiesOf(ctx).extensions;
	return isRecord(extensions) && MCP_TASKS_EXTENSION in extensions;
}

/** Read the accepted content of an answered elicitation from a tasks/update payload. */
function answerContent(answer: unknown): Record<string, unknown> {
	if (!isRecord(answer)) return {};
	if (isRecord(answer.content)) return answer.content;
	return answer;
}

function elicitText(message: string, field: string) {
	return inputRequired.elicit({
		message,
		requestedSchema: {
			type: "object",
			properties: { [field]: { type: "string" } },
			required: [field],
		},
	});
}

const elicitConfirm = () =>
	inputRequired.elicit({
		message: "Please confirm",
		requestedSchema: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		},
	});

/**
 * Tools whose SEP-2663 task support is `required`: calling them from a client
 * that did not declare the tasks extension MUST answer `-32021`.
 */
const REQUIRED_TASK_TOOLS = new Set(["failing_job", "test_tool_with_task"]);

// =============================================================================
// Fixture server
// =============================================================================

// NOTE: era binding (SDK `_negotiatedProtocolVersion`) is owned by
// `mountMcp()` — it marks the per-request server instance as 2026-07-28 when
// the caller declares the modern `MCP-Protocol-Version` header, so the SDK
// serves the modern codec (native `inputRequired()`, removed 2025 methods →
// 404). The fixture needs no workaround.

export interface Fixture {
	server: McpServer;
	options: MountMcpOptions;
}

export function buildFixture(): Fixture {
	const server = createMcpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: {
				tools: {},
				prompts: {},
				resources: {},
				completions: {},
			},
			requestState: {
				verify: (state, ctx) => stateCodec.verify(state, ctx),
			},
		},
	);

	registerBasicTools(server);
	registerMrtrTools(server);
	registerTaskTools(server);
	registerResources(server);
	registerPrompts(server);
	installToolCallGates(server);

	const options: MountMcpOptions = {
		discover: {
			serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			capabilities: {
				tools: {},
				prompts: {},
				resources: {},
				completions: {},
			},
			instructions:
				"Conformance fixture for the Tedix stateless MCP transport.",
		},
		taskHandlers: fixtureTaskHandlers,
		completionHandler: ({ ref, argument }) => {
			const candidates =
				ref.type === "ref/prompt"
					? (PROMPT_ARG_COMPLETIONS[ref.name]?.[argument.name] ?? [])
					: (TEMPLATE_ARG_COMPLETIONS[ref.uri]?.[argument.name] ?? []);
			const values = candidates.filter((value) =>
				value.startsWith(argument.value),
			);
			return { values, total: values.length, hasMore: false };
		},
	};

	return { server, options };
}

const PROMPT_ARG_COMPLETIONS: Record<string, Record<string, string[]>> = {
	test_prompt_with_arguments: {
		arg1: ["alpha", "alpine", "beta"],
		arg2: ["one", "two", "three"],
	},
};

const TEMPLATE_ARG_COMPLETIONS: Record<string, Record<string, string[]>> = {
	"test://template/{id}/data": {
		id: ["1", "2", "3"],
	},
};

// =============================================================================
// Basic tools (content types, errors, diagnostics)
// =============================================================================

function registerBasicTools(server: McpServer): void {
	server.registerTool(
		"test_simple_text",
		{ description: "Tests simple text content response", inputSchema: {} },
		async () => textResult("This is a simple text response for testing."),
	);

	server.registerTool(
		"test_image_content",
		{ description: "Tests image content response", inputSchema: {} },
		async () => ({
			content: [
				{
					type: "image" as const,
					data: TEST_IMAGE_BASE64,
					mimeType: "image/png",
				},
			],
		}),
	);

	server.registerTool(
		"test_audio_content",
		{ description: "Tests audio content response", inputSchema: {} },
		async () => ({
			content: [
				{
					type: "audio" as const,
					data: TEST_AUDIO_BASE64,
					mimeType: "audio/wav",
				},
			],
		}),
	);

	server.registerTool(
		"test_embedded_resource",
		{
			description: "Tests embedded resource content response",
			inputSchema: {},
		},
		async () => ({
			content: [
				{
					type: "resource" as const,
					resource: {
						uri: "test://embedded-resource",
						mimeType: "text/plain",
						text: "This is an embedded resource content.",
					},
				},
			],
		}),
	);

	server.registerTool(
		"test_multiple_content_types",
		{
			description:
				"Tests response with multiple content types (text, image, resource)",
			inputSchema: {},
		},
		async () => ({
			content: [
				{ type: "text" as const, text: "Multiple content types test:" },
				{
					type: "image" as const,
					data: TEST_IMAGE_BASE64,
					mimeType: "image/png",
				},
				{
					type: "resource" as const,
					resource: {
						uri: "test://mixed-content-resource",
						mimeType: "application/json",
						text: JSON.stringify({ test: "data", value: 123 }),
					},
				},
			],
		}),
	);

	server.registerTool(
		"test_error_handling",
		{ description: "Tests error response handling", inputSchema: {} },
		async () => {
			throw new Error("This tool intentionally returns an error for testing");
		},
	);

	// Extension-rich stateless mounts promote this request to request-scoped
	// SSE as soon as the first related progress notification is emitted.
	server.registerTool(
		"test_tool_with_progress",
		{
			description: "Tests tool that reports progress notifications",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const progressToken =
				(ctx.mcpReq._meta as Record<string, unknown> | undefined)
					?.progressToken ?? 0;
			for (const progress of [0, 50, 100]) {
				await ctx.mcpReq
					.notify({
						method: "notifications/progress",
						params: { progressToken, progress, total: 100 },
					})
					.catch(() => {});
			}
			return textResult(String(progressToken));
		},
	);

	server.registerTool(
		"test_tool_with_logging",
		{
			description: "Tests tool that emits log messages during execution",
			inputSchema: {},
		},
		async () => textResult("Tool with logging executed successfully"),
	);

	// server-stateless diagnostics: the response stream must contain no
	// independent JSON-RPC requests / no unauthorized notifications/message.
	server.registerTool(
		"test_streaming_elicitation",
		{
			description: "Diagnostic tool validating response progress streams",
			inputSchema: {},
		},
		async () => textResult("Streaming complete"),
	);

	server.registerTool(
		"test_logging_tool",
		{ description: "Diagnostic logging validator tool", inputSchema: {} },
		async () => textResult("Logging evaluated"),
	);

	// The -32021 rejection path lives in installToolCallGates(); this handler
	// is the declared-capability success path.
	server.registerTool(
		"test_missing_capability",
		{ description: "Test tool requiring sampling", inputSchema: {} },
		async () => textResult("Success"),
	);

	// SEP-2243 custom Mcp-Param-* headers: a tool with an `x-mcp-header`
	// binding, exercised by http-custom-header-server-validation. mountMcp()
	// validates inbound Mcp-Param-* against this schema (reject invalid Base64,
	// header-omitted-but-value-in-body → -32020 + HTTP 400); the outbound side
	// is src/mcp-param-headers.ts. Registered with the raw-JSON Standard Schema
	// directly (not a post-hoc `.inputSchema` swap) so `server.toolInputSchemaJson`
	// — the source mountMcp's inbound validator reads — returns the x-mcp-header
	// binding, mirroring how production config-driven tools register.
	server.registerTool(
		"test_custom_header_tool",
		{
			description:
				"Tool with an x-mcp-header parameter binding (SEP-2243 custom headers)",
			inputSchema: rawJsonSchemaAsStandardSchema({
				type: "object",
				properties: {
					api_key: { type: "string", "x-mcp-header": "Api-Key" },
				},
				required: ["api_key"],
			}) as never,
		},
		async (args) =>
			textResult(`custom header tool called with: ${JSON.stringify(args)}`),
	);

	// SEP-1613 / SEP-2106: preserve the raw JSON Schema 2020-12 definition
	// through tools/list. The registered zod schema handles validation; the
	// advertised inputSchema is swapped post-registration (the register config
	// currently converts Standard Schemas, which would strip $schema/$defs).
	const jsonSchemaTool = server.registerTool(
		"json_schema_2020_12_tool",
		{
			description:
				"Tool with JSON Schema 2020-12 features for conformance testing (SEP-1613)",
			inputSchema: {},
		},
		async (args) =>
			textResult(
				`JSON Schema 2020-12 tool called with: ${JSON.stringify(args ?? {})}`,
			),
	);
	(jsonSchemaTool as unknown as { inputSchema?: unknown }).inputSchema =
		rawJsonSchemaAsStandardSchema(JSON_SCHEMA_2020_12_INPUT_SCHEMA);
}

/**
 * Minimal StandardSchemaWithJSON wrapper around a raw JSON Schema document:
 * `tools/list` re-emits the document verbatim; validation accepts anything
 * (the conformance checks only assert the advertised schema shape).
 */
function rawJsonSchemaAsStandardSchema(schema: Record<string, unknown>) {
	return {
		"~standard": {
			version: 1,
			vendor: "tedix-conformance",
			jsonSchema: {
				input: () => schema,
				output: () => schema,
			},
			validate: (value: unknown) => ({ value }),
		},
	};
}

// =============================================================================
// SEP-2322 ephemeral MRTR tools (native SDK inputRequired path)
// =============================================================================

function registerMrtrTools(server: McpServer): void {
	server.registerTool(
		"test_input_required_result_elicitation",
		{
			description: "MRTR: returns InputRequiredResult with elicitation request",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const name = acceptedContent<{ name: string }>(
				ctx.mcpReq.inputResponses,
				"user_name",
			)?.name;
			if (typeof name === "string") return textResult(`Hello, ${name}!`);
			return inputRequired({
				inputRequests: {
					user_name: elicitText("What is your name?", "name"),
				},
			});
		},
	);

	// SEP-1330 (titled enum + multi-select array) + SEP-1034 (per-type defaults):
	// a richer form-mode elicitation that exercises `enumNames`, an
	// `items.enum` multi-select with `minItems`/`maxItems`/`uniqueItems`, and
	// scalar defaults. Answered form-mode (no URL mode) exactly like the other
	// elicit tools, so the stateless transport round-trips it unchanged.
	server.registerTool(
		"test_input_required_result_rich_form",
		{
			description:
				"MRTR: rich form-mode elicitation (SEP-1330 titled enum + multi-select, SEP-1034 defaults)",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const accepted = acceptedContent<{
				tier?: string;
				scopes?: string[];
			}>(ctx.mcpReq.inputResponses, "preferences");
			if (accepted && typeof accepted.tier === "string") {
				const scopes = Array.isArray(accepted.scopes)
					? accepted.scopes.join(",")
					: "";
				return textResult(`tier=${accepted.tier}; scopes=${scopes}`);
			}
			return inputRequired({
				inputRequests: {
					preferences: inputRequired.elicit({
						message: "Choose a tier and the scopes to grant.",
						requestedSchema: {
							type: "object",
							properties: {
								tier: {
									type: "string",
									title: "Plan tier",
									enum: ["free", "pro", "enterprise"],
									enumNames: ["Free", "Pro", "Enterprise"],
									default: "pro",
								},
								scopes: {
									type: "array",
									title: "Granted scopes",
									items: { type: "string", enum: ["read", "write", "admin"] },
									minItems: 1,
									maxItems: 3,
									uniqueItems: true,
								},
								notify: { type: "boolean", default: true },
							},
							required: ["tier", "scopes"],
						},
					}),
				},
			});
		},
	);

	server.registerTool(
		"test_input_required_result_sampling",
		{
			description: "MRTR: returns InputRequiredResult with sampling request",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const view = inputResponse(ctx.mcpReq.inputResponses, "sample_request");
			if (view.kind === "sampling") {
				const content = view.result.content as Record<string, unknown>;
				const text =
					isRecord(content) && typeof content.text === "string"
						? content.text
						: "no response";
				return textResult(`Sampling result: ${text}`);
			}
			return inputRequired({
				inputRequests: {
					sample_request: inputRequired.createMessage({
						messages: [
							{
								role: "user",
								content: {
									type: "text",
									text: "What is the capital of France?",
								},
							},
						],
						maxTokens: 100,
					}),
				},
			});
		},
	);

	server.registerTool(
		"test_input_required_result_list_roots",
		{
			description: "MRTR: returns InputRequiredResult with roots/list request",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const view = inputResponse(ctx.mcpReq.inputResponses, "roots_request");
			if (view.kind === "roots") {
				return textResult(`Found ${view.roots.length} root(s)`);
			}
			return inputRequired({
				inputRequests: { roots_request: inputRequired.listRoots() },
			});
		},
	);

	server.registerTool(
		"test_input_required_result_request_state",
		{
			description: "MRTR: returns InputRequiredResult with requestState",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const state = ctx.mcpReq.requestState<FixtureState>();
			const confirm = acceptedContent<{ ok: boolean }>(
				ctx.mcpReq.inputResponses,
				"confirm",
			);
			if (state?.kind === "request-state" && confirm?.ok === true) {
				return textResult("state-ok: requestState validated");
			}
			return inputRequired({
				inputRequests: { confirm: elicitConfirm() },
				requestState: await stateCodec.mint({ kind: "request-state" }),
			});
		},
	);

	server.registerTool(
		"test_input_required_result_multiple_inputs",
		{
			description:
				"MRTR: returns InputRequiredResult with multiple input requests",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const state = ctx.mcpReq.requestState<FixtureState>();
			const responses = ctx.mcpReq.inputResponses;
			const name = acceptedContent<{ name: string }>(
				responses,
				"user_name",
			)?.name;
			const greetingView = inputResponse(responses, "greeting");
			const rootsView = inputResponse(responses, "client_roots");
			if (
				state?.kind === "multiple-inputs" &&
				typeof name === "string" &&
				greetingView.kind === "sampling" &&
				rootsView.kind === "roots"
			) {
				const greetingContent = greetingView.result.content as Record<
					string,
					unknown
				>;
				const greeting =
					isRecord(greetingContent) && typeof greetingContent.text === "string"
						? greetingContent.text
						: "Hello there!";
				return textResult(
					`Name: ${name}; Greeting: ${greeting}; Roots: ${rootsView.roots.length}`,
				);
			}
			return inputRequired({
				inputRequests: {
					user_name: elicitText("What is your name?", "name"),
					greeting: inputRequired.createMessage({
						messages: [
							{
								role: "user",
								content: { type: "text", text: "Generate a greeting" },
							},
						],
						maxTokens: 50,
					}),
					client_roots: inputRequired.listRoots(),
				},
				requestState: await stateCodec.mint({ kind: "multiple-inputs" }),
			});
		},
	);

	server.registerTool(
		"test_input_required_result_multi_round",
		{
			description: "MRTR: multi-round InputRequiredResult workflow",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const state = ctx.mcpReq.requestState<FixtureState>();
			const responses = ctx.mcpReq.inputResponses;
			if (state?.kind === "multi-round" && state.round === 1) {
				const name = acceptedContent<{ name: string }>(
					responses,
					"step1",
				)?.name;
				if (typeof name === "string") {
					return inputRequired({
						inputRequests: {
							step2: elicitText(
								"Step 2: What is your favorite color?",
								"color",
							),
						},
						requestState: await stateCodec.mint({
							kind: "multi-round",
							round: 2,
							name,
						}),
					});
				}
			}
			if (state?.kind === "multi-round" && state.round === 2) {
				const color = acceptedContent<{ color: string }>(
					responses,
					"step2",
				)?.color;
				if (typeof color === "string") {
					const name = typeof state.name === "string" ? state.name : "friend";
					return textResult(
						`Multi-round complete for ${name} who likes ${color}`,
					);
				}
			}
			return inputRequired({
				inputRequests: {
					step1: elicitText("Step 1: What is your name?", "name"),
				},
				requestState: await stateCodec.mint({ kind: "multi-round", round: 1 }),
			});
		},
	);

	// Tampering is caught by the codec's verify hook (ServerOptions.requestState)
	// before this handler runs: the seam answers -32602 for a forged state.
	server.registerTool(
		"test_input_required_result_tampered_state",
		{
			description: "MRTR: HMAC-signed requestState integrity test",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const state = ctx.mcpReq.requestState<FixtureState>();
			const confirm = acceptedContent<{ ok: boolean }>(
				ctx.mcpReq.inputResponses,
				"confirm",
			);
			if (state?.kind === "tamper-test" && confirm !== undefined) {
				return textResult("integrity-ok: state verified");
			}
			return inputRequired({
				inputRequests: { confirm: elicitConfirm() },
				requestState: await stateCodec.mint({ kind: "tamper-test" }),
			});
		},
	);

	server.registerTool(
		"test_input_required_result_capabilities",
		{
			description: "MRTR: respects client capabilities in inputRequests",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const responses = ctx.mcpReq.inputResponses;
			if (responses && Object.keys(responses).length > 0) {
				return textResult(
					`capabilities-ok: received ${Object.keys(responses).join(",")}`,
				);
			}
			const caps = clientCapabilitiesOf(ctx);
			const inputRequests: Record<string, unknown> = {};
			if (isRecord(caps.elicitation)) {
				inputRequests.elicit_input = elicitText("Elicitation input", "value");
			}
			if (isRecord(caps.sampling)) {
				inputRequests.sample_input = inputRequired.createMessage({
					messages: [
						{
							role: "user",
							content: { type: "text", text: "Sample request" },
						},
					],
					maxTokens: 50,
				});
			}
			if (Object.keys(inputRequests).length === 0) {
				return textResult("No supported capabilities declared");
			}
			return inputRequired({
				inputRequests: inputRequests as Parameters<
					typeof inputRequired
				>[0]["inputRequests"],
				requestState: await stateCodec.mint({ kind: "capabilities-test" }),
			});
		},
	);
}

// =============================================================================
// SEP-2663 task tools
// =============================================================================

function registerTaskTools(server: McpServer): void {
	server.registerTool(
		"greet",
		{
			description: "Sync-only greeting tool",
			inputSchema: { name: z.string() },
		},
		async ({ name }) => textResult(`Hello, ${name}!`),
	);

	const slowCompute = server.registerTool(
		"slow_compute",
		{
			description: "Task-supporting compute that sleeps N seconds",
			inputSchema: {
				seconds: z.number(),
				label: z.string().optional(),
			},
		},
		async ({ seconds, label }, ctx) => {
			const text = `computed:${label ?? "result"}`;
			if (!tasksDeclared(ctx)) {
				await sleep(Math.min(seconds, 2) * 1000);
				return textResult(text);
			}
			const task = newTask();
			task.timer = setTimeout(() => {
				completeTask(task, { content: [{ type: "text", text }] });
			}, seconds * 1000);
			return createTaskResult(task) as unknown as ReturnType<typeof textResult>;
		},
	);
	setTaskSupport(slowCompute, "optional");

	const failingJob = server.registerTool(
		"failing_job",
		{
			description: "Task-required job that reports a tool execution error",
			inputSchema: {},
		},
		async () => {
			// Reached only with the tasks extension declared (see the -32021 gate
			// in installToolCallGates); always escalates to a task.
			const task = newTask();
			task.timer = setTimeout(() => {
				completeTask(task, {
					content: [
						{ type: "text", text: "failing_job: tool execution failed" },
					],
					isError: true,
				});
			}, 700);
			return createTaskResult(task) as unknown as ReturnType<typeof textResult>;
		},
	);
	setTaskSupport(failingJob, "required");

	const protocolErrorJob = server.registerTool(
		"protocol_error_job",
		{
			description: "Task-supporting job that fails with a protocol error",
			inputSchema: {},
		},
		async (_args, ctx) => {
			if (!tasksDeclared(ctx)) {
				return {
					content: [{ type: "text", text: "protocol_error_job crashed" }],
					isError: true,
				};
			}
			const task = newTask();
			task.timer = setTimeout(() => {
				failTask(task, {
					code: -32603,
					message: "protocol_error_job crashed with an internal error",
				});
			}, 300);
			return createTaskResult(task) as unknown as ReturnType<typeof textResult>;
		},
	);
	setTaskSupport(protocolErrorJob, "optional");

	const confirmDelete = server.registerTool(
		"confirm_delete",
		{
			description: "Task-supporting delete that parks for elicitation",
			inputSchema: { filename: z.string() },
		},
		async ({ filename }, ctx) => {
			if (!tasksDeclared(ctx)) {
				return textResult(`deleted ${filename}`);
			}
			const task = newTask();
			task.status = "input_required";
			task.inputRequests = {
				confirm_delete: elicitText(
					`Really delete ${filename}?`,
					"confirmation",
				),
			};
			task.onInputComplete = (parked, answers) => {
				const content = answerContent(answers.confirm_delete);
				completeTask(parked, {
					content: [
						{
							type: "text",
							text: `deleted ${filename} (confirmation: ${JSON.stringify(content)})`,
						},
					],
				});
			};
			touchTask(task);
			return createTaskResult(task) as unknown as ReturnType<typeof textResult>;
		},
	);
	setTaskSupport(confirmDelete, "optional");

	const multiInput = server.registerTool(
		"multi_input",
		{
			description:
				"Task-supporting tool that fans out two parallel input requests",
			inputSchema: {},
		},
		async (_args, ctx) => {
			if (!tasksDeclared(ctx)) {
				return textResult("multi_input requires the tasks extension");
			}
			const task = newTask();
			task.status = "input_required";
			task.inputRequests = {
				first_value: elicitText("Provide the first value", "value"),
				second_value: elicitText("Provide the second value", "value"),
			};
			task.onInputComplete = (parked, answers) => {
				const first = answerContent(answers.first_value).value;
				const second = answerContent(answers.second_value).value;
				completeTask(parked, {
					content: [
						{
							type: "text",
							text: `multi_input complete: first=${String(first)}, second=${String(second)}`,
						},
					],
				});
			};
			touchTask(task);
			return createTaskResult(task) as unknown as ReturnType<typeof textResult>;
		},
	);
	setTaskSupport(multiInput, "optional");

	// SEP-2663 MRTR → Tasks composition: round 1 gathers input via the MRTR
	// loop, round 2 escalates to a task whose result reflects the answer.
	const toolWithTask = server.registerTool(
		"test_tool_with_task",
		{
			description:
				"Task-required tool composing the MRTR loop with task creation",
			inputSchema: {},
		},
		async (_args, ctx) => {
			const name = acceptedContent<{ name: string }>(
				ctx.mcpReq.inputResponses,
				"user_name",
			)?.name;
			if (typeof name !== "string") {
				return inputRequired({
					inputRequests: {
						user_name: elicitText("What is your name?", "name"),
					},
					requestState: await stateCodec.mint({ kind: "task-compose" }),
				});
			}
			const task = newTask();
			task.timer = setTimeout(() => {
				completeTask(task, {
					content: [{ type: "text", text: `Task greeting for ${name}` }],
				});
			}, 50);
			return createTaskResult(task) as unknown as ReturnType<typeof textResult>;
		},
	);
	setTaskSupport(toolWithTask, "required");
}

/**
 * `registerTool`'s config does not accept `execution` yet in this SDK build;
 * the RegisteredTool record surfaces it into `tools/list`, so stamp it there.
 */
function setTaskSupport(
	registered: unknown,
	taskSupport: "required" | "optional" | "forbidden",
): void {
	(registered as { execution?: { taskSupport: string } }).execution = {
		taskSupport,
	};
}

// =============================================================================
// Low-level tools/call gates (protocol errors before the handler runs)
// =============================================================================

/**
 * Pre-dispatch capability gates that must answer PROTOCOL errors (`-32021` +
 * HTTP 400). `registerTool` handlers cannot produce those — the SDK converts
 * every handler throw into an `isError` tool result — so the gate wraps the
 * McpServer-installed `tools/call` request handler directly.
 */
function installToolCallGates(server: McpServer): void {
	const protocol = server.server as unknown as {
		_requestHandlers: Map<
			string,
			(request: unknown, ctx: ServerContext) => Promise<unknown>
		>;
	};
	const inner = protocol._requestHandlers.get("tools/call");
	if (!inner) throw new Error("tools/call handler not installed");
	protocol._requestHandlers.set("tools/call", async (request, ctx) => {
		const params = (request as { params?: { name?: unknown } }).params;
		const name = typeof params?.name === "string" ? params.name : "";
		if (
			name === "test_missing_capability" &&
			!isRecord(clientCapabilitiesOf(ctx).sampling)
		) {
			throw new MissingRequiredClientCapabilityError({
				requiredCapabilities: { sampling: {} },
			});
		}
		if (REQUIRED_TASK_TOOLS.has(name) && !tasksDeclared(ctx)) {
			throw new MissingRequiredClientCapabilityError({
				requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
			});
		}
		return inner(request, ctx);
	});
}

// =============================================================================
// Resources
// =============================================================================

function registerResources(server: McpServer): void {
	server.registerResource(
		"static-text",
		"test://static-text",
		{
			title: "Static Text Resource",
			description: "A static text resource for testing",
			mimeType: "text/plain",
		},
		async () => ({
			contents: [
				{
					uri: "test://static-text",
					mimeType: "text/plain",
					text: "This is the content of the static text resource.",
				},
			],
		}),
	);

	server.registerResource(
		"static-binary",
		"test://static-binary",
		{
			title: "Static Binary Resource",
			description: "A static binary resource (image) for testing",
			mimeType: "image/png",
		},
		async () => ({
			contents: [
				{
					uri: "test://static-binary",
					mimeType: "image/png",
					blob: TEST_IMAGE_BASE64,
				},
			],
		}),
	);

	server.registerResource(
		"template",
		new ResourceTemplate("test://template/{id}/data", { list: undefined }),
		{
			title: "Resource Template",
			description: "A resource template with parameter substitution",
			mimeType: "application/json",
		},
		async (uri, variables) => {
			const id = variables.id;
			return {
				contents: [
					{
						uri: uri.toString(),
						mimeType: "application/json",
						text: JSON.stringify({
							id,
							templateTest: true,
							data: `Data for ID: ${String(id)}`,
						}),
					},
				],
			};
		},
	);

	server.registerResource(
		"watched-resource",
		"test://watched-resource",
		{
			title: "Watched Resource",
			description: "A watched resource for testing",
			mimeType: "text/plain",
		},
		async () => ({
			contents: [
				{
					uri: "test://watched-resource",
					mimeType: "text/plain",
					text: "Watched resource content",
				},
			],
		}),
	);
}

// =============================================================================
// Prompts
// =============================================================================

function registerPrompts(server: McpServer): void {
	server.registerPrompt(
		"test_simple_prompt",
		{
			title: "Simple Test Prompt",
			description: "A simple prompt without arguments",
		},
		async () => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: "This is a simple prompt for testing.",
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"test_prompt_with_arguments",
		{
			title: "Prompt With Arguments",
			description: "A prompt with required arguments",
			argsSchema: {
				arg1: z.string().describe("First test argument"),
				arg2: z.string().describe("Second test argument"),
			},
		},
		async ({ arg1, arg2 }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'`,
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"test_prompt_with_embedded_resource",
		{
			title: "Prompt With Embedded Resource",
			description: "A prompt that includes an embedded resource",
			argsSchema: {
				resourceUri: z.string().describe("URI of the resource to embed"),
			},
		},
		async ({ resourceUri }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "resource" as const,
						resource: {
							uri: resourceUri,
							mimeType: "text/plain",
							text: "Embedded resource content for testing.",
						},
					},
				},
				{
					role: "user",
					content: {
						type: "text",
						text: "Please process the embedded resource above.",
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"test_prompt_with_image",
		{
			title: "Prompt With Image",
			description: "A prompt that includes image content",
		},
		async () => ({
			messages: [
				{
					role: "user",
					content: {
						type: "image",
						data: TEST_IMAGE_BASE64,
						mimeType: "image/png",
					},
				},
				{
					role: "user",
					content: { type: "text", text: "Please analyze the image above." },
				},
			],
		}),
	);

	// SEP-2322: InputRequiredResult on a non-tool request (prompts/get).
	server.registerPrompt(
		"test_input_required_result_prompt",
		{
			title: "MRTR Prompt",
			description: "MRTR: prompt that requires elicitation input",
		},
		// Argument-less prompts receive (ctx) only; the SDK's registerPrompt
		// typings currently lack that overload, hence the cast.
		(async (ctx: ServerContext) => {
			const context = acceptedContent<{ context: string }>(
				ctx.mcpReq.inputResponses,
				"user_context",
			)?.context;
			if (typeof context === "string") {
				return {
					messages: [
						{
							role: "user",
							content: {
								type: "text",
								text: `Prompt with context: ${context}`,
							},
						},
					],
				};
			}
			return inputRequired({
				inputRequests: {
					user_context: elicitText(
						"What context should the prompt use?",
						"context",
					),
				},
			});
		}) as unknown as Parameters<typeof server.registerPrompt>[2],
	);
}
