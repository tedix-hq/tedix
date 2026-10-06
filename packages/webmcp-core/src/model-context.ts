/**
 * Structural types for the experimental WebMCP browser surface.
 *
 * WebMCP (webmachinelearning/webmcp; Chrome 146 experimental; supported by
 * ChatGPT's in-app browser) exposes a `modelContext` object that lets a page
 * register tools an in-page browser agent can call. The standard is still
 * moving: the current community draft uses `document.modelContext`, while
 * deployed experiments have also exposed `navigator.modelContext` and the
 * older whole-set `provideContext` shape. These types are structural on
 * purpose — no dependency on a types package for an experimental API — and
 * the registry copes with either shape. Absent API = silent no-op.
 */

/** MCP `CallToolResult` subset the WebMCP bridge understands. */
export interface WebMcpToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

export interface WebMcpToolDef {
	/** Verb-first snake_case, per the repo-wide MCP naming rule. */
	name: string;
	description: string;
	/** JSON Schema for the tool input. */
	inputSchema: Record<string, unknown>;
	/** Current draft annotations. Hints never replace server authorization. */
	annotations: {
		readOnlyHint: boolean;
		untrustedContentHint: boolean;
	};
	execute: (
		args: Record<string, unknown>,
		options?: WebMcpToolExecuteOptions,
	) => Promise<WebMcpToolResult>;
}

export interface WebMcpRegisterOptions {
	signal?: AbortSignal;
}

/** Current WebMCP options supplied when an agent executes a tool. */
export interface WebMcpToolExecuteOptions {
	/** Signals cancellation by the user or browser agent. */
	signal?: AbortSignal;
}

export interface ModelContextLike {
	registerTool?: (
		tool: WebMcpToolDef,
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
 * yet bound). The readiness doctrine in docs/product/tedix-os.md requires one
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
