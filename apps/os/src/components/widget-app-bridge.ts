import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
	McpUiHostContext,
	McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps";

export function createWidgetAppBridge(
	handleCallTool: NonNullable<AppBridge["oncalltool"]>,
	handleUpdateModelContext: NonNullable<AppBridge["onupdatemodelcontext"]>,
	hostContext: McpUiHostContext,
	permissions?: McpUiResourcePermissions,
	handleMessage?: NonNullable<AppBridge["onmessage"]>,
): AppBridge {
	const bridge = new AppBridge(
		null,
		{ name: "Tedix OS", version: "1.0.0" },
		{
			openLinks: {},
			...(handleMessage ? { message: { text: {} } } : {}),
			serverTools: {},
			updateModelContext: { text: {} },
			...(permissions && Object.keys(permissions).length > 0
				? { sandbox: { permissions } }
				: {}),
		},
		{ hostContext },
	);
	bridge.onopenlink = async ({ url }) => {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			return { isError: true };
		}
		if (
			!["https:", "http:"].includes(target.protocol) ||
			target.username ||
			target.password
		)
			return { isError: true };
		window.open(target.href, "_blank", "noopener,noreferrer");
		return {};
	};
	bridge.oncalltool = handleCallTool;
	bridge.onupdatemodelcontext = handleUpdateModelContext;
	if (handleMessage) bridge.onmessage = handleMessage;
	return bridge;
}
