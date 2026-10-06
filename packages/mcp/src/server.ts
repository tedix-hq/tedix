/**
 * @tedix/mcp-shared — MCP Server Factory
 *
 * Constructs SDK McpServer instances with structured input-validation results.
 * Shared by the MCP edge, Agent runtime, CMS, and Docs Workers.
 */
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/server";

// =============================================================================
// SEP-1303 — STRUCTURED INPUT-VALIDATION TOOL RESULTS
// =============================================================================

/**
 * Machine-readable error discriminator stamped on input-validation tool
 * results (`structuredContent.error` and `_meta["com.tedix/error"]`), matching
 * the existing `insufficient_scope` result convention in apps/mcp.
 */
export const INPUT_VALIDATION_ERROR_CODE = "input_validation_error";

/** One normalized Standard Schema validation issue. */
export interface ToolInputValidationIssue {
	/** Dot-joined property path (omitted for root-level issues). */
	path?: string;
	message: string;
}

/** Minimal Standard Schema v1 surface (what the SDK stores per tool). */
interface StandardSchemaLike {
	"~standard": {
		validate(
			data: unknown,
		):
			| { issues?: ReadonlyArray<StandardIssueLike>; value?: unknown }
			| Promise<{ issues?: ReadonlyArray<StandardIssueLike>; value?: unknown }>;
	};
}

interface StandardIssueLike {
	message: string;
	path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
}

/** Mirrors the SDK's private `formatIssue` (path-prefixed message). */
function issuePath(issue: StandardIssueLike): string | undefined {
	if (!issue.path?.length) return undefined;
	return issue.path
		.map((p) => String(typeof p === "object" ? p.key : p))
		.join(".");
}

function normalizeIssues(
	issues: ReadonlyArray<StandardIssueLike>,
): ToolInputValidationIssue[] {
	return issues.map((issue) => {
		const path = issuePath(issue);
		return path ? { path, message: issue.message } : { message: issue.message };
	});
}

/**
 * Build the SEP-1303 input-validation TOOL RESULT (2026-07-28 spec,
 * `docs/specification/2026-07-28/server/tools.mdx` "Error Handling"): invalid tool
 * arguments are a **Tool Execution Error** — a normal `tools/call` result with
 * `isError: true` and actionable text content — NOT a JSON-RPC `-32602`
 * Protocol Error, so agent loops receive the feedback in-context and
 * self-correct.
 *
 * The text content keeps the SDK's exact prose
 * (`Input validation error: Invalid arguments for tool <name>: <detail>`) for
 * backward compatibility; `structuredContent` + `_meta["com.tedix/error"]`
 * carry the machine-readable issue list so callers stop parsing prose.
 */
export function buildInputValidationErrorResult(
	toolName: string,
	issues: ToolInputValidationIssue[],
): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
	structuredContent: {
		error: typeof INPUT_VALIDATION_ERROR_CODE;
		tool: string;
		issues: ToolInputValidationIssue[];
	};
	_meta: { "com.tedix/error": typeof INPUT_VALIDATION_ERROR_CODE };
} {
	const detail = issues
		.map((issue) =>
			issue.path ? `${issue.path}: ${issue.message}` : issue.message,
		)
		.join(", ");
	return {
		content: [
			{
				type: "text",
				text: `Input validation error: Invalid arguments for tool ${toolName}: ${detail}`,
			},
		],
		isError: true,
		structuredContent: {
			error: INPUT_VALIDATION_ERROR_CODE,
			tool: toolName,
			issues,
		},
		_meta: { "com.tedix/error": INPUT_VALIDATION_ERROR_CODE },
	};
}

/**
 * The SDK's private tool-validation seam (`McpServer.validateToolInput` +
 * `McpServer.createToolError`, `@modelcontextprotocol/server` 2.0.0).
 * Both are declared `private` in the .d.ts, so the patch reaches them through
 * this structural cast — the same pinned-private-seam approach the conformance
 * fixture uses for `_negotiatedProtocolVersion`. `src/transport.test.ts` pins
 * the structured result on the wire, so an SDK bump that renames either method
 * fails the suite instead of silently degrading.
 */
interface PatchableToolValidation {
	validateToolInput?: (
		tool: { inputSchema?: StandardSchemaLike },
		args: unknown,
		toolName: string,
	) => Promise<unknown>;
	createToolError?: (errorMessage: string) => unknown;
}

/**
 * Upgrade invalid-argument `tools/call` outcomes to the structured SEP-1303
 * result for every tool registered on this server (SDK zod tools AND
 * config-driven JSON-schema tools — both flow through `registerTool`, whose
 * dispatch validates via `validateToolInput` and converts the throw with
 * `createToolError`).
 *
 * Without this patch the SDK already returns a spec-conformant
 * `isError: true` text result; the patch adds the machine-readable
 * `structuredContent`/`_meta` payload. If the SDK seam is missing (renamed on
 * a bump), the patch no-ops and the SDK's text-only result remains — the
 * transport test pinning `structuredContent` then fails loudly.
 */
function applyInputValidationResultPatch(server: SdkMcpServer): void {
	const patchable = server as unknown as PatchableToolValidation;
	const originalValidate = patchable.validateToolInput;
	const originalCreateToolError = patchable.createToolError;
	if (
		typeof originalValidate !== "function" ||
		typeof originalCreateToolError !== "function"
	) {
		console.error(
			"[mcp-server] SDK tool-validation seam missing (validateToolInput/createToolError); structured input-validation results disabled",
		);
		return;
	}

	// Transfers structured issues from the validation throw to the SDK's
	// catch (`createToolError` only receives the message string). Keyed by the
	// exact message so an interleaved unrelated handler error can never pick up
	// the wrong payload; cleared on every new failure (per-request server
	// instances hold at most one in-flight validation).
	const pendingByMessage = new Map<
		string,
		{ toolName: string; issues: ToolInputValidationIssue[] }
	>();

	patchable.validateToolInput = async (tool, args, toolName) => {
		const schema = tool.inputSchema;
		if (typeof schema?.["~standard"]?.validate !== "function") {
			return originalValidate.call(server, tool, args, toolName);
		}
		const result = await schema["~standard"].validate(args ?? {});
		if (result.issues && result.issues.length > 0) {
			const issues = normalizeIssues(result.issues);
			const message = buildInputValidationErrorResult(toolName, issues)
				.content[0]?.text as string;
			pendingByMessage.clear();
			pendingByMessage.set(message, { toolName, issues });
			throw new Error(message);
		}
		return result.value;
	};

	patchable.createToolError = (errorMessage: string) => {
		const pending = pendingByMessage.get(errorMessage);
		if (pending) {
			pendingByMessage.delete(errorMessage);
			return buildInputValidationErrorResult(pending.toolName, pending.issues);
		}
		return originalCreateToolError.call(server, errorMessage);
	};
}

// =============================================================================
// FACTORY
// =============================================================================

type ServerInfo = ConstructorParameters<typeof SdkMcpServer>[0];
type ServerOptions = ConstructorParameters<typeof SdkMcpServer>[1];

/**
 * Construct the SDK's `McpServer` directly.
 *
 * Use this anywhere Tedix code currently does `new McpServer(...)` from
 * `@modelcontextprotocol/server`.
 */
export function createMcpServer(
	serverInfo: ServerInfo,
	options?: ServerOptions,
): SdkMcpServer {
	const server = new SdkMcpServer(serverInfo, options);
	applyInputValidationResultPatch(server);
	return server;
}

// Re-export the SDK's McpServer type for downstream consumers.
export type { McpServer } from "@modelcontextprotocol/server";
