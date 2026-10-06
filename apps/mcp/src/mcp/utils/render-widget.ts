import type { AppTool } from "../server-context";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { contentFreeMcpException, createMcpLogger } from "../../log";

const log = createMcpLogger("mcp.widget.render");

function getToolConfigRecord(tool: AppTool): Record<string, unknown> | null {
	const { config } = tool;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return null;
	}
	return config as Record<string, unknown>;
}

export function getToolLayoutSpec(
	tool: AppTool,
): Record<string, unknown> | null {
	const config = getToolConfigRecord(tool);
	const layoutSpec = config?.layoutSpec;

	if (isRecord(layoutSpec)) {
		return layoutSpec;
	}

	if (typeof layoutSpec === "string") {
		try {
			const parsed = JSON.parse(layoutSpec);
			if (isRecord(parsed)) {
				return parsed;
			}
		} catch (error) {
			log.warn("Widget layout spec parse failed", {
				event: "widget.layout_spec_parse_failed",
				outcome: "invalid",
				error: contentFreeMcpException(error),
			});
		}
	}

	return null;
}

/**
 * Bundle-tier widget: a committed, self-contained HTML document carried on
 * the tool config instead of a json-render layoutSpec. Served verbatim as
 * the MCP Apps resource through the same CSP envelope and host data seam —
 * pre-declared and reviewable per revision, never generated at render time.
 * Size-capped: a bundle beyond the cap is treated as absent (fail closed to
 * the json-render shell) rather than truncated into broken markup.
 */
export const MAX_WIDGET_BUNDLE_HTML_BYTES = 512 * 1024;

export function getToolBundleHtml(tool: AppTool): string | null {
	const config = getToolConfigRecord(tool);
	const bundleHtml = config?.widgetBundleHtml;
	if (typeof bundleHtml !== "string") return null;
	const trimmed = bundleHtml.trim();
	if (trimmed.length === 0) return null;
	if (new TextEncoder().encode(trimmed).length > MAX_WIDGET_BUNDLE_HTML_BYTES) {
		log.warn("Widget bundle exceeds byte limit", {
			event: "widget.bundle_too_large",
			outcome: "invalid",
		});
		return null;
	}
	return trimmed;
}

export function isRenderWidgetTool(tool: AppTool): boolean {
	return (
		tool.widgetKey === "render" ||
		getToolLayoutSpec(tool) !== null ||
		getToolBundleHtml(tool) !== null
	);
}

export function getToolLayoutId(tool: AppTool): string {
	const config = getToolConfigRecord(tool);
	const layoutId = config?.layoutId;
	return typeof layoutId === "string" && layoutId.trim().length > 0
		? layoutId
		: tool.toolId;
}

/**
 * All widget tools route through /r/{layoutId} (json-render pipeline).
 */
export function resolveToolWidgetRoute(tool: AppTool): string | null {
	if (isRenderWidgetTool(tool)) {
		return `/r/${getToolLayoutId(tool)}`;
	}
	return null;
}
