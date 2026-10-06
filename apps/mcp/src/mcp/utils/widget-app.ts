import type { AppTool, ServerContext } from "../server-context";

function recordFrom(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function sourceAppSlugFromConfig(
	config: Record<string, unknown> | null,
): string | undefined {
	for (const key of ["_sourceAppSlug", "_aggregateAppSlug", "_appSlug"]) {
		const value = config?.[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

export function isWidgetAppSlug(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-z0-9-]{1,63}$/i.test(value);
}

/**
 * Resolve the app whose widget route owns an app tool.
 *
 * Aggregate tools retain their source app in config while first-party tools
 * fall back to the MCP app serving the current request. Keep this lightweight:
 * resource templates use it without loading the Code Mode compiler bundle.
 */
export function resolveWidgetAppSlug(
	serverCtx: Pick<ServerContext, "appSlug">,
	tool: AppTool,
): string {
	const config = recordFrom(tool.config);
	const aggregateNamespace =
		typeof config?._aggregateNamespace === "string"
			? config._aggregateNamespace
			: undefined;
	const toolPrefix = tool.toolId.includes("__")
		? tool.toolId.split("__")[0]
		: undefined;

	return (
		[sourceAppSlugFromConfig(config), aggregateNamespace, toolPrefix].find(
			isWidgetAppSlug,
		) ?? serverCtx.appSlug
	);
}
