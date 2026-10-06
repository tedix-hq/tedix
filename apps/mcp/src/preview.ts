/**
 * Headless Widget Preview Handler
 *
 * GET /_preview?tool=<toolId>&args=<json>
 *
 * Executes a real MCP tool, fetches the widget HTML, and injects a
 * non-executable tool data for standalone rendering. Any headless
 * browser can navigate to the URL and screenshot the fully rendered widget.
 *
 * Pattern: the existing tedix-tool-data hydration seam; no fake host or
 * client-side MCP connection is needed.
 *
 * @module @tedix/mcp/preview
 */

import {
	parseAdapterScope,
	type ToolConfig,
} from "@tedix/api-contract/schemas/tools";
import { createToolHandler, type ToolExecutionContext } from "./mcp/handler";
import {
	type CachedAppData,
	fetchWidgetHtmlForApp,
	getAppContext,
} from "./mcp/server-factory";
import {
	getToolLayoutSpec,
	resolveToolWidgetRoute,
} from "./mcp/utils/render-widget";
import type { AppData } from "./resolution";

// =============================================================================
// MAIN HANDLER
// =============================================================================

export async function handlePreviewRequest(
	_request: Request,
	url: URL,
	app: AppData,
	env: CloudflareEnv,
): Promise<Response> {
	const toolId = url.searchParams.get("tool");
	if (!toolId) {
		return new Response(
			"Missing required query parameter: tool\n\nUsage: /_preview?tool=<toolId>&args={...}",
			{ status: 400, headers: { "Content-Type": "text/plain" } },
		);
	}

	// Parse args
	const argsParam = url.searchParams.get("args") ?? "{}";
	let args: Record<string, unknown>;
	try {
		args = JSON.parse(argsParam);
	} catch {
		return new Response(`Invalid JSON in "args" parameter: ${argsParam}`, {
			status: 400,
			headers: { "Content-Type": "text/plain" },
		});
	}

	// Get cached app context with tools
	let cachedData: CachedAppData;
	try {
		cachedData = await getAppContext(app.id, app.slug, env);
	} catch (error) {
		return new Response(
			`Failed to load app context: ${error instanceof Error ? error.message : "Unknown error"}`,
			{ status: 502, headers: { "Content-Type": "text/plain" } },
		);
	}

	// Find tool by toolId
	const tool = cachedData.tools.find((t) => t.toolId === toolId);
	if (!tool) {
		const available = cachedData.tools
			.filter((t) => t.widgetKey)
			.map((t) => t.toolId)
			.join(", ");
		return new Response(
			`Tool not found: "${toolId}"\n\nAvailable widget tools: ${available || "(none)"}`,
			{ status: 404, headers: { "Content-Type": "text/plain" } },
		);
	}

	// Validate tool has a widget
	if (!tool.widgetKey && !tool.outputTemplate) {
		return new Response(
			`Tool "${toolId}" has no widget. Set widgetKey or outputTemplate on the tool config.`,
			{ status: 400, headers: { "Content-Type": "text/plain" } },
		);
	}

	// Execute tool (with adapter routing, same as normal MCP flow)
	const handler = createToolHandler();
	const toolConfig = (tool.config ?? {}) as unknown as ToolConfig;
	const adapterScope = parseAdapterScope(tool.adapterScope);
	const resultStrategy = tool.resultStrategy as
		| "merge"
		| "first_success"
		| "parallel_all"
		| undefined;
	const ctx: ToolExecutionContext<ToolConfig> = {
		appId: cachedData.app.id,
		app: cachedData.app,
		appCapabilities: cachedData.capabilities,
		env,
		config: toolConfig,
		toolId: tool.toolId,
		requestId: crypto.randomUUID(),
		adapterScope,
		resultStrategy,
		appMetadata: cachedData.metadata as Record<string, unknown> | null,
	};

	let structuredContent: Record<string, unknown>;
	try {
		const result = await handler.execute(args, ctx);
		structuredContent = handler.buildStructuredContent(result, ctx);
	} catch (error) {
		return new Response(
			`Tool execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			{ status: 500, headers: { "Content-Type": "text/plain" } },
		);
	}

	// Derive widget route (same logic as tool-registration.ts)
	let widgetRoute = resolveToolWidgetRoute(tool);
	const layoutSpec = getToolLayoutSpec(tool);

	if (!widgetRoute) {
		// Fallback: use widgetRoute from tool or toolId
		widgetRoute = `/${(tool.widgetRoute || tool.toolId).replace(/^\//, "")}`;
	}

	// Build extra headers for render-capable widgets
	const extraHeaders: Record<string, string> = {};
	if (layoutSpec) {
		extraHeaders["X-Tedix-Layout-Spec"] = JSON.stringify(layoutSpec);
	}

	// Fetch widget HTML
	let html: string;
	try {
		html = await fetchWidgetHtmlForApp(
			cachedData,
			widgetRoute,
			tool.description ?? tool.title,
			"apps-sdk",
			env,
			Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
		);
	} catch (error) {
		return new Response(
			`Widget HTML fetch failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			{ status: 502, headers: { "Content-Type": "text/plain" } },
		);
	}

	// Inject preview runtime
	const previewHtml = injectPreviewData(html, structuredContent);

	return new Response(previewHtml, {
		status: 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

// =============================================================================
// RUNTIME INJECTION
// =============================================================================

/**
 * Escape characters that could break out of a JSON script block.
 * Prevent XSS while embedding JSON in <script type="application/json">.
 */
function escapeJsonForScript(json: string): string {
	return json
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026");
}

/** Embed the same inert hydration payload used by the OS host. */
export function injectPreviewData(html: string, toolOutput: unknown): string {
	const data = `<script type="application/json" id="tedix-tool-data">${escapeJsonForScript(JSON.stringify(toolOutput))}</script>`;
	const headClose = html.indexOf("</head>");
	return headClose === -1
		? data + html
		: html.slice(0, headClose) + data + html.slice(headClose);
}
