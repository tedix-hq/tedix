/**
 * Structural types for the experimental WebMCP browser surface.
 *
 * WebMCP (webmachinelearning/webmcp; Chrome 155+ behind
 * `enable-webmcp-testing`; supported by ChatGPT's in-app browser) exposes a
 * `modelContext` object that lets a page register tools an in-page browser
 * agent can call. The only surface is `document.modelContext.registerTool`.
 * The draft removed `provideContext` on 2026-03-05 (webmcp#132) and moved
 * the getter from `navigator` to `document` on 2026-05-27 (webmcp#184);
 * Chromium deprecated `navigator.modelContext` in 150 and ChatGPT's Site
 * tools read `document.modelContext.registerTool`, so no host we target
 * needs the old `navigator.modelContext` or `provideContext` fallbacks and
 * they were removed. `spec-conformance.ts` type-checks these types against
 * the `webmcp-types` package so spec drift fails `type-check`.
 * Absent API = silent no-op.
 */

/** MCP `CallToolResult` subset the WebMCP bridge understands. */
export interface WebMcpToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/**
 * Spec tool annotations. Every hint defaults to false and hints never replace
 * server authorization.
 */
export interface WebMcpToolAnnotations {
	/** The tool only reads state. */
	readOnlyHint?: boolean;
	/** The result may carry content from untrusted sources. */
	untrustedContentHint?: boolean;
	/**
	 * Running the tool has significant, real-world or non-reversible effects,
	 * so hosts confirm every call instead of once per site.
	 */
	consequentialHint?: boolean;
	/** For debugging and developer tooling, not end-user interactions. */
	debugging?: boolean;
}

export interface WebMcpToolDef {
	/** Verb-first snake_case, per the repo-wide MCP naming rule. */
	name: string;
	/** Optional human-readable title. */
	title?: string;
	description: string;
	/** JSON Schema for the tool input. */
	inputSchema: Record<string, unknown>;
	annotations: WebMcpToolAnnotations;
	execute: (
		args: Record<string, unknown>,
		options?: WebMcpToolExecuteOptions,
	) => Promise<WebMcpToolResult>;
}

export interface WebMcpRegisterOptions {
	/** Aborting unregisters the tool. */
	signal?: AbortSignal;
	/** Origins allowed to call the tool from an embedding page. */
	exposedTo?: string[];
}

/** Current WebMCP options supplied when an agent executes a tool. */
export interface WebMcpToolExecuteOptions {
	/** Signals cancellation by the user or browser agent. */
	signal?: AbortSignal;
}

/** A tool as the spec `registerTool` receives it: execute per the spec contract. */
export type WebMcpSpecTool = Omit<WebMcpToolDef, "execute"> & {
	execute: (
		args: Record<string, unknown>,
		options?: WebMcpToolExecuteOptions,
	) => Promise<unknown>;
};

export interface ModelContextLike {
	registerTool?: (
		tool: WebMcpSpecTool,
		options?: WebMcpRegisterOptions,
	) => Promise<unknown> | unknown;
}

/** Which projection API the detected host offers. */
export type WebMcpHostApi = "registerTool" | "none";

/**
 * Feature-detect the WebMCP surface on the document. The registry and
 * diagnostic probe use this single detection path, so the probe can never
 * disagree with what the registry actually resolved.
 */
export function resolveModelContext(): ModelContextLike | null {
	return (
		(globalThis.document as Document & { modelContext?: ModelContextLike })
			?.modelContext ?? null
	);
}

/**
 * Classify a detected host by the projection API it exposes. `none` means an
 * object is present but has no `registerTool` — a host the registry can
 * detect but cannot project onto.
 */
export function describeModelContextApi(
	context: ModelContextLike | null,
): WebMcpHostApi {
	if (!context) return "none";
	if (context.registerTool) return "registerTool";
	return "none";
}

function resultText(result: WebMcpToolResult): string {
	return result.content.map((part) => part.text).join("\n");
}

/**
 * Projects an MCP-shaped result onto the spec's execute contract, where the
 * host serializes the fulfilled value for the agent and only a rejection
 * counts as a failed call: an error result throws its text, a success returns
 * its structured data (or its text) once instead of both copies.
 */
export function toSpecToolOutput(result: WebMcpToolResult): unknown {
	if (result.isError === true) throw new Error(resultText(result));
	return result.structuredContent ?? resultText(result);
}

/** Standard success shape: compact JSON plus an OS deep link for the human. */
export function webMcpResult(
	data: Record<string, unknown>,
	deepLink?: string,
): WebMcpToolResult {
	const structured = deepLink ? { ...data, deepLink } : data;
	return {
		content: [{ type: "text", text: JSON.stringify(structured) }],
		structuredContent: structured,
	};
}

export function webMcpError(message: string): WebMcpToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

/**
 * Stable, typed, retryable failure for a tool invoked while the authenticated
 * tenant context is not executable (session expired mid-page, org scope not
 * yet bound). The readiness doctrine in docs/engineering/product/tedix-os.md requires one
 * uniform `context_unavailable` shape across every scope — never an ad hoc
 * message like "Organization identity is temporarily unavailable".
 */
export function webMcpContextUnavailable(detail?: string): WebMcpToolResult {
	const structured: Record<string, unknown> = {
		error: "context_unavailable",
		retryable: true,
		...(detail ? { detail } : {}),
	};
	return {
		content: [{ type: "text", text: JSON.stringify(structured) }],
		structuredContent: structured,
		isError: true,
	};
}
