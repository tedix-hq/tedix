/**
 * Public types for @tedix/tedi-codemode-core.
 *
 * Runtime-neutral — shared by Tedix MCP surfaces that wrap an inner tool
 * surface into one stateless Code Mode `code` tool.
 */

import type {
	DynamicWorkerExecutor,
	ResolvedProvider,
} from "@cloudflare/codemode";
import type { McpServer } from "@modelcontextprotocol/server";

export interface ToolSummary {
	name: string;
	description: string;
	paramSummary: string;
}

export interface CodeModeTraceContext {
	/**
	 * Runtime surface emitting Code Mode logs, for example `tedi-mcp` or
	 * `tedi-runtime-mcp`.
	 */
	surface: string;
	/** Owning organization for the wrapped tool surface. */
	organizationId?: string | null;
	/** Caller/correlation id from the surrounding request when available. */
	traceId?: string;
	/** Minimal authenticated caller projection for logs and live proof. */
	caller?: {
		authType?: string;
		clientId?: string;
		scopes?: string[];
		subject?: string;
	};
}

export interface CodeModeExecutionContext {
	/**
	 * Stable id for one Code Mode execution.
	 */
	executionId: string;
	/**
	 * Human-readable tool/run kind used only for observability.
	 */
	kind: "code";
}

export interface CodeModeRuntime {
	executor: DynamicWorkerExecutor;
	/**
	 * Build the provider list for one sandbox execution. The returned
	 * `codemode.*` provider is closed over this execution context, so inner
	 * tool-call logs cannot bleed across concurrent runs.
	 */
	createProviders(context: CodeModeExecutionContext): ResolvedProvider[];
	/**
	 * Add a non-MCP provider such as Cloudflare Shell `state.*`.
	 */
	addProvider(provider: ResolvedProvider): void;
	/**
	 * Return the structured context used in `_cm` logs and `__runtime()`.
	 */
	logContext(context: CodeModeExecutionContext): Record<string, unknown>;
}

/**
 * Optional hook for app-specific tool registration that shares the
 * Code Mode executor + providers. Called after the `code` tool is
 * registered on the outer server. The Agent runtime uses this to add
 * computer scratch-state providers and register its `execute` tool.
 */
export type CodeModeExtras = (
	outerServer: McpServer,
	runtime: CodeModeRuntime,
) => void | Promise<void>;

export interface RegisterCodeModeToolsOptions {
	/**
	 * Cloudflare WorkerLoader binding. When absent, registration
	 * returns false and the caller should fall back to standard
	 * tool registration on the outer server.
	 */
	loader: WorkerLoader | undefined;
	/**
	 * Identifier used in structured RPC + exec logs.
	 */
	tediId: string;
	/**
	 * Optional structured context copied into `_cm` logs and `codemode.__runtime()`.
	 */
	traceContext?: CodeModeTraceContext;
	/**
	 * Optional executor timeout in ms. Tedix callers fall back to 30s when unset
	 * (the SDK's own DynamicWorkerExecutor default is 60s as of @cloudflare/codemode 0.4.2).
	 */
	timeoutMs?: number;
	/**
	 * Optional token budget for the model-facing `code` result before it is
	 * wrapped in the detectable truncation envelope (see `bounded-result.ts`).
	 * Defaults to the @cloudflare/codemode default (6,000 tokens ≈ 24,000 chars
	 * of indented JSON).
	 */
	resultMaxTokens?: number;
	/**
	 * Optional app-specific tool registrations (e.g. runtime execute).
	 */
	extras?: CodeModeExtras;
	/**
	 * Optional additional sandbox capabilities exposed by `extras` providers.
	 * These are appended to the `code` tool description so the model can discover
	 * non-MCP providers such as `state.*` without guessing.
	 */
	extraInstructions?: string[];
}
