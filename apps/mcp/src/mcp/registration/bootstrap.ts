/**
 * Bootstrap tool + resource registration.
 *
 * Always-on tools that don't come from D1 `app_tools`:
 * - `get_info` — server identity (name, slug, tool count, capabilities)
 * - `__track_widget_analytics` — internal widget event reporter
 * - `app-info` resource — same identity payload, addressable as a resource
 *
 * Called from `buildMcpServer()` once per request. Skill resources
 * (`list_skills`, `read_skill`, `skill://`) live in their own registration
 * path — see `tool-registration.ts::registerAppSkills`.
 */

import * as z from "zod";
import { createMcpLogger } from "../../log";
import type { ServerContext } from "../server-context";
import { registerAccountProfile } from "./account-profile";

const log = createMcpLogger("mcp.registration.bootstrap");

/**
 * Register minimal bootstrap tools (fallback when no D1 tools exist).
 * Satisfies OpenAI Apps SDK requirement of ≥1 tool during initialize handshake.
 */
export function registerBootstrapTools(agent: ServerContext): void {
	registerAccountProfile(agent);
	const appName = agent.app?.name ?? "Unknown App";
	const appSlug = agent.appSlug ?? "unknown";

	const getInfoTool = agent.server.registerTool(
		"get_info",
		{
			title: `${appName} Info`,
			description: `Get metadata about the ${appName} MCP server itself (name, version, tool count). Only use when the user asks about this server's identity or capabilities — NOT for answering general questions.`,
			inputSchema: z.object({}),
			annotations: {
				readOnlyHint: true,
				openWorldHint: false,
				destructiveHint: false,
			},
		},
		async () => {
			const info = {
				name: appName,
				slug: appSlug,
				description: agent.app?.description ?? null,
				domain: agent.app?.domain ?? null,
				logoUrl: agent.app?.logoUrl ?? null,
				serverVersion: agent.getServerVersion(),
				toolCount: agent.registeredTools.size,
				capabilities: agent.appCapabilities,
			};

			const text = [
				`${info.name} MCP Server v${info.serverVersion}`,
				info.description ? `\n${info.description}` : "",
				`\nTools: ${info.toolCount}`,
				info.domain ? `Domain: ${info.domain}` : "",
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text" as const, text }],
				structuredContent: info,
			};
		},
	);

	agent.registeredTools.set("get_info", getInfoTool);
	console.log("[MCP] Registered bootstrap tool: get_info");

	// ------------------------------------------------------------------
	// __track_widget_analytics — internal widget interaction tracking
	// ------------------------------------------------------------------
	const trackWidgetAnalyticsTool = agent.server.registerTool(
		"__track_widget_analytics",
		{
			title: "Track Widget Analytics",
			description:
				"Internal tool for widgets to report user interaction events. Not intended for direct AI use.",
			inputSchema: z.object({
				eventType: z
					.enum([
						"item_impression",
						"item_click",
						"external_cta_click",
						"checkout_start",
						"filter",
						"sort",
						"select_item",
					])
					.describe("Event type"),
				itemId: z
					.string()
					.max(256)
					.optional()
					.describe("Item ID for item_click/select_item events"),
				itemPosition: z
					.number()
					.int()
					.min(0)
					.max(10000)
					.optional()
					.describe("Zero-based item position in list"),
				widgetKey: z
					.string()
					.max(128)
					.optional()
					.describe("Widget layout key (e.g. search_listings)"),
				displayMode: z
					.enum(["inline", "fullscreen", "pip", "modal"])
					.optional()
					.describe("Current display mode"),
				metadata: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"Optional JSON metadata (filter field/value, sort key, etc.)",
					),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: false,
			},
		},
		async ({
			eventType,
			itemId,
			itemPosition,
			widgetKey,
			displayMode,
			metadata,
		}) => {
			let parsedMetadata: Record<string, unknown> | undefined;
			if (metadata) {
				try {
					parsedMetadata = JSON.parse(metadata) as Record<string, unknown>;
				} catch {
					parsedMetadata = { raw: metadata };
				}
			}
			const event = {
				id: crypto.randomUUID(),
				appId: agent.appId,
				sessionId: agent.traceId,
				eventType,
				itemId,
				itemPosition,
				widgetKey,
				displayMode,
				metadata: parsedMetadata,
				createdAt: new Date().toISOString(),
			};

			agent.ctx.waitUntil(
				agent.apiClient.analytics
					.trackWidgetEvents({
						events: [event],
						// Defense-in-depth: server validates every event.appId === expectedAppId
						expectedAppId: agent.appId,
					})
					.catch((err: unknown) => {
						log.error("Failed to track widget event", {
							event: "widget_analytics.track_failed",
							appId: agent.appId,
							traceId: agent.traceId,
							outcome: "unavailable",
							error: err,
						});
					}),
			);

			return {
				content: [{ type: "text" as const, text: '{"success":true}' }],
				structuredContent: { success: true },
			};
		},
	);

	agent.registeredTools.set(
		"__track_widget_analytics",
		trackWidgetAnalyticsTool,
	);
	console.log("[MCP] Registered bootstrap tool: __track_widget_analytics");
}

/**
 * Register minimal bootstrap resources (fallback).
 */
export function registerBootstrapResources(agent: ServerContext): void {
	const appSlug = agent.appSlug || "unknown";
	const infoResourceUri = `info://${appSlug}/app-info.json`;

	const infoResource = agent.server.registerResource(
		"app-info",
		infoResourceUri,
		{ description: `${agent.app?.name ?? "App"} information and capabilities` },
		async () => {
			const info = {
				name: agent.app?.name ?? "Unknown App",
				slug: appSlug,
				description: agent.app?.description ?? null,
				domain: agent.app?.domain ?? null,
				logoUrl: agent.app?.logoUrl ?? null,
				serverVersion: agent.getServerVersion(),
				toolCount: agent.registeredTools.size,
				capabilities: agent.appCapabilities,
			};

			return {
				contents: [
					{
						uri: infoResourceUri,
						mimeType: "application/json",
						text: JSON.stringify(info, null, 2),
					},
				],
			};
		},
	);

	agent.registeredResources.set("app-info", infoResource);
	console.log("[MCP] Registered bootstrap resource: app-info");
}
