import { MCP_RESULT_CACHE_HINT_META_KEY } from "@tedix/mcp-shared/transport";
import type { AppTool, ServerContext } from "./server-context";
import {
	buildResourceUris,
	getWidgetVersion,
	WIDGET_MIME_TYPES,
	WIDGET_RESOURCE_CACHE_HINT,
} from "./utils/register-widget";

/**
 * Register the shared item-detail widget resource for host modal detail views.
 *
 * When inline widgets call `window.openai.requestModal({ template })`, the host
 * opens this resource as a separate iframe. Using a dedicated template avoids
 * the BrowserRouter detection error that occurs when requestModal is called
 * without a template on Astro MPA widgets.
 *
 * Called once per app after widget tools are registered.
 */
export async function registerDetailResource(
	agent: ServerContext,
): Promise<void> {
	const appSlug = agent.app?.slug;
	if (!appSlug) return;

	const widgetVersion = getWidgetVersion(agent.env);
	const widgetRoute = "/r/item-detail";
	const { appsSdk: appsSdkUri, mcpApp: mcpAppUri } = buildResourceUris(
		appSlug,
		widgetRoute,
		widgetVersion,
	);
	const widgetDomain = agent.getWidgetDomain();

	// Apps SDK resource (ChatGPT)
	const appsSdkId = "widget-item-detail";
	if (!agent.registeredResources.has(appsSdkId)) {
		const res = agent.server.registerResource(
			appsSdkId,
			appsSdkUri,
			{ description: "Item detail modal view" },
			async () => {
				const [html, csp] = await Promise.all([
					agent.fetchWidgetHtml(widgetRoute, "Item detail", "apps-sdk"),
					agent.buildAppCsp(undefined as unknown as AppTool),
				]);

				return {
					contents: [
						{
							uri: appsSdkUri,
							mimeType: WIDGET_MIME_TYPES.APPS_SDK,
							text: html,
							_meta: {
								"openai/widgetDescription": "Item detail view",
								"openai/widgetPrefersBorder": true,
								"openai/widgetDomain": widgetDomain,
								"openai/widgetCSP": csp,
							},
						},
					],
					// Static deploy-versioned template → long public freshness hint
					// (consumed + stripped by the transport).
					_meta: {
						[MCP_RESULT_CACHE_HINT_META_KEY]: WIDGET_RESOURCE_CACHE_HINT,
					},
				};
			},
		);
		if (res) {
			agent.registeredResources.set(appsSdkId, res);
			agent.appResourceIds.add(appsSdkId);
		}
	}

	// MCP-App resource
	const mcpAppId = "mcp-app-item-detail";
	if (!agent.registeredResources.has(mcpAppId)) {
		const res = agent.server.registerResource(
			mcpAppId,
			mcpAppUri,
			{ description: "Item detail modal view (mcp-app)" },
			async () => {
				const [html, csp] = await Promise.all([
					agent.fetchWidgetHtml(widgetRoute, "Item detail", "mcp-app"),
					agent.buildAppCsp(undefined as unknown as AppTool),
				]);

				return {
					contents: [
						{
							uri: mcpAppUri,
							mimeType: WIDGET_MIME_TYPES.MCP_APP,
							text: html,
							_meta: {
								ui: {
									domain: widgetDomain,
									prefersBorder: true,
									csp: {
										resourceDomains: csp.resource_domains,
										connectDomains: csp.connect_domains,
										frameDomains: csp.frame_domains,
										redirectDomains: csp.redirect_domains,
									},
								},
							},
						},
					],
					// Static deploy-versioned template → long public freshness hint
					// (consumed + stripped by the transport).
					_meta: {
						[MCP_RESULT_CACHE_HINT_META_KEY]: WIDGET_RESOURCE_CACHE_HINT,
					},
				};
			},
		);
		if (res) {
			agent.registeredResources.set(mcpAppId, res);
			agent.appResourceIds.add(mcpAppId);
		}
	}

	console.log(`[MCP] Registered item-detail modal resource: ${appsSdkUri}`);
}
