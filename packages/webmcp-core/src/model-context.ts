/**
 * Structural types for the experimental WebMCP browser surface.
 *
 * WebMCP (webmachinelearning/webmcp; Chrome 155+ behind
 * `enable-webmcp-testing`; supported by ChatGPT's in-app browser) exposes a
 * `modelContext` object that lets a page register tools an in-page browser
 * agent can call. The spec surface is `document.modelContext.registerTool`;
 * deployed experiments have also exposed `navigator.modelContext` and the
 * older whole-set `provideContext` shape. These types stay structural so the
 * registry copes with every shape; `spec-conformance.ts` type-checks them
 * against the `webmcp-types` package so spec drift fails `type-check`.
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
	provideContext?: (context: { tools: WebMcpToolDef[] }) => void;
}

/** Where the host object was found. `document` is the current draft. */
export type WebMcpHostSource = "document" | "navigator";

/** Which projection API the detected host offers. */
export type WebMcpHostApi = "registerTool" | "provideContext" | "none";

export interface ResolvedModelContext {
	context: ModelContextLike;
	source: WebMcpHostSource;
}

/**
 * Feature-detect the WebMCP surface wherever the host put it, reporting WHICH
 * surface answered. The registry and diagnostic probe use this single
 * detection path, so the probe can never
 * disagree with what the registry actually resolved.
 *
 * `document.modelContext` (current draft) wins over `navigator.modelContext`
 * (deployed experiment) when both exist.
 */
export function resolveModelContextSource(): ResolvedModelContext | null {
	const fromDocument = (
		globalThis.document as Document & { modelContext?: ModelContextLike }
	)?.modelContext;
	if (fromDocument) return { context: fromDocument, source: "document" };
	const fromNavigator = (
		globalThis.navigator as Navigator & { modelContext?: ModelContextLike }
	)?.modelContext;
	if (fromNavigator) return { context: fromNavigator, source: "navigator" };
	return null;
}

/**
 * Classify a detected host by the projection API it exposes. `none` means an
 * object is present but implements neither shape — a host the registry can
 * detect but cannot project onto.
 */
export function describeModelContextApi(
	context: ModelContextLike | null,
): WebMcpHostApi {
	if (!context) return "none";
	if (context.registerTool) return "registerTool";
	if (context.provideContext) return "provideContext";
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
