import { SidebarAppSchema } from "@tedix/api-contract/schemas/app";

export function sidebarAppConfig(
	config: Record<string, unknown> | null | undefined,
) {
	if (config?.codeMode !== true) return null;
	const parsed = SidebarAppSchema.safeParse(config.sidebarApp);
	return parsed.success ? parsed.data : null;
}

export const SIDEBAR_APP_WIDGET_DESCRIPTION =
	"Tedix workspace: your organizations, decisions waiting for you and recent activity.";

export function sidebarAppToolMeta(
	slug: string,
	config: Record<string, unknown> | null | undefined,
) {
	if (!sidebarAppConfig(config)) return {};
	return {
		ui: {
			resourceUri: `ui://widgets/mcp-app/${slug}/r/sidebar-app.html`,
			visibility: ["model", "app"],
		},
		"openai/ui": { entrypoints: [{ type: "global" }] },
		"openai/widgetAccessible": true,
		"openai/toolInvocation/invoking": "Opening Tedix…",
		"openai/toolInvocation/invoked": "Tedix opened",
	};
}
