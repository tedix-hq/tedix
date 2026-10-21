import { PLATFORM_OPERATOR_APP_SLUG } from "./platform-operator-tools";
import type { ServerContext } from "./server-context";

const GENUI_AUTHORING_APP_SLUGS = new Set([
	"tedix",
	PLATFORM_OPERATOR_APP_SLUG,
]);

function shouldRegisterGenUiAuthoringTools(agent: ServerContext): boolean {
	return GENUI_AUTHORING_APP_SLUGS.has(agent.appSlug);
}

export async function registerGenUiAuthoringTools(
	agent: ServerContext,
): Promise<void> {
	if (!shouldRegisterGenUiAuthoringTools(agent)) return;

	const { registerDesignWidgetUiTool } =
		await import("./tools/design-widget-ui");
	const { registerPreviewWidgetTool } = await import("./tools/preview-widget");
	registerDesignWidgetUiTool(agent);
	registerPreviewWidgetTool(agent);
}
