import { createMcpLogger } from "../log";
import type { ServerContext } from "./server-context";
import { resolveToolWidgetRoute } from "./utils/render-widget";
import { registerGenUiAuthoringTools } from "./genui-tool-registration";
import { registerDynamicTool } from "./widget-tool-registration";
import { registerDetailResource } from "./detail-resource-registration";
const log = createMcpLogger("mcp.tool_registration");

/** Bootstrap tool IDs */
const BOOTSTRAP_TOOL_IDS = new Set(["get_info"]);

/**
 * Register all app-specific tools from D1 app_tools table.
 * This is the primary registration method called after app context is loaded.
 */
export async function registerAppTools(agent: ServerContext): Promise<void> {
	if (!agent.appId) {
		console.warn("[MCP] No app ID for tool registration, using bootstrap");
		return;
	}

	// Tools are pre-loaded into loadedTools by server-factory
	const tools = Array.from(agent.loadedTools.values());

	if (tools.length === 0) {
		console.log(`[MCP] No D1 tools found for app: ${agent.appSlug}`);
		return;
	}

	console.log(
		`[MCP] Registering ${tools.length} tools for app ${agent.appSlug}`,
	);

	// Track resource URIs across tools to handle shared widgetKeys
	const registeredResourceUris = new Set<string>();
	const d1ToolIds = new Set(tools.map((t) => t.toolId));
	const keptBootstrapTools: string[] = [];

	for (const bootstrapToolId of BOOTSTRAP_TOOL_IDS) {
		if (!d1ToolIds.has(bootstrapToolId)) {
			keptBootstrapTools.push(bootstrapToolId);
		}
	}

	for (const tool of tools) {
		const existingBootstrap = agent.registeredTools.get(tool.toolId);
		if (existingBootstrap && !agent.appToolIds.has(tool.toolId)) {
			const isKnownBootstrap = BOOTSTRAP_TOOL_IDS.has(tool.toolId);
			try {
				existingBootstrap.remove();
				agent.registeredTools.delete(tool.toolId);
				if (isKnownBootstrap) {
					console.log(`[MCP] D1 tool "${tool.toolId}" replaces bootstrap tool`);
				} else {
					console.log(
						`[MCP] Removed existing tool: ${tool.toolId} (replacing with D1 version)`,
					);
				}
			} catch (error) {
				log.warn("Failed to replace bootstrap tool", {
					event: "tool_registration.bootstrap_removal_failed",
					appId: agent.appId,
					toolName: tool.toolId,
					outcome: "unavailable",
					error,
				});
			}
		}

		try {
			await registerDynamicTool(agent, tool, registeredResourceUris);
		} catch (error) {
			log.error("Failed to register tool", {
				event: "tool_registration.failed",
				appId: agent.appId,
				toolName: tool.toolId,
				outcome: "unavailable",
				error,
			});
		}
	}

	for (const keptToolId of keptBootstrapTools) {
		console.log(`[MCP] Using bootstrap tool "${keptToolId}" (no D1 override)`);
	}

	// GenUI authoring tools are MCP-native bootstrap tools because
	// design_widget_ui uses MCP sampling; expose them on operator surfaces.
	await registerGenUiAuthoringTools(agent);

	// Register shared detail resource for host modal views
	const hasWidgetTools = Array.from(agent.loadedTools.values()).some(
		(t) => resolveToolWidgetRoute(t) !== null,
	);
	if (hasWidgetTools) {
		await registerDetailResource(agent);
	}

	const toolScopes = agent.appMetadata?.mcpConfig?.toolScopes as
		| Record<string, string[]>
		| undefined;
	if (toolScopes) {
		for (const [toolId, scopes] of Object.entries(toolScopes)) {
			if (scopes && scopes.length > 0) {
				agent.authRequiredTools.add(toolId);
			}
		}
	}
}
