import { createMcpLogger } from "../log";
import { isToolDeniedForConnection } from "./no-funds-policy";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";
import {
	parseAdapterScope,
	type ResultStrategy,
} from "@tedix/api-contract/schemas/tools";
import * as z from "zod";
import {
	enforceExpectedAnnotations,
	requireDestructiveToolApproval,
	stripDestructiveApprovalArgs,
	withDestructiveApprovalSchema,
} from "./governance";
import type { AppTool, ServerContext } from "./server-context";
import { executeTool } from "./tool-execution";
import { enforceToolRiskRateLimit } from "./tool-risk-policy";
import {
	isExternalOpenApiTool,
	normalizeOpenApiExternalArgs,
} from "./utils/openapi-args";
import {
	getWidgetVersion,
	registerWidgetTool,
	type WidgetAppContext,
} from "./utils/register-widget";
import {
	getToolLayoutSpec,
	resolveToolWidgetRoute,
} from "./utils/render-widget";
import {
	jsonSchemaToInputSchema,
	jsonSchemaToOutputSchema,
	projectNativeOutputEvidence,
	type ToolInputStandardSchema,
} from "./utils/schema";
import { resolveToolRequestMeta } from "./tool-registration";
import {
	deriveSecuritySchemes,
	resolveWireAnnotations,
} from "./tool-registration-policy";
import { trackResourceRead } from "./resource-read-telemetry";
import { registerTextOnlyTool } from "./text-tool-registration";

const log = createMcpLogger("mcp.tool_registration");

/**
 * Wrap a D1 tool's stored inputSchema for SDK registration. Native tools
 * (transport rpc/code/undefined) validate strictly against the Tedix-owned
 * schema; upstream-validated tools (external/mcp) are lenient — the vendor is
 * the authoritative validator. External OpenAPI tools additionally get
 * page-size enum normalization before validation.
 */
function buildToolInputSchema(tool: AppTool): ToolInputStandardSchema {
	const transport = tool.config?.transport;
	return jsonSchemaToInputSchema(
		withDestructiveApprovalSchema(tool, resolveWireAnnotations(tool)),
		{
			toolId: tool.toolId,
			lenient: transport === "external" || transport === "mcp",
			...(isExternalOpenApiTool(tool)
				? {
						normalizeArgs: (args: Record<string, unknown>) =>
							normalizeOpenApiExternalArgs(args, tool.inputSchema),
					}
				: {}),
		},
	);
}

/**
 * Register a single tool from D1 configuration.
 * Uses the centralized registerWidgetTool helper for atomic tool + resource registration.
 */
export async function registerDynamicTool(
	agent: ServerContext,
	tool: AppTool,
	registeredResourceUris?: Set<string>,
): Promise<void> {
	if (isToolDeniedForConnection(agent, tool)) {
		// Retain identity for discovery diagnostics; registration and dispatch stay denied.
		agent.loadedTools.set(tool.toolId, tool);
		return;
	}
	const widgetVersion = getWidgetVersion(agent.env);

	// Prompt tools are handled separately by registerAppPrompts
	if (tool.toolTypeId === "prompt") return;

	const widgetRoute = resolveToolWidgetRoute(tool);
	const layoutSpec = getToolLayoutSpec(tool);

	if (!widgetRoute) {
		if (!tool.widgetKey && !tool.outputTemplate) {
			// Text-only tool
			const inputSchema = buildToolInputSchema(tool);
			const textAnn = resolveWireAnnotations(tool);
			const textOutputSchema = jsonSchemaToOutputSchema(tool.outputSchema);
			await registerTextOnlyTool(
				agent,
				tool,
				inputSchema,
				textAnn,
				textOutputSchema,
			);
			return;
		}
		log.error("Skipping widget tool without a resolved route", {
			event: "tool_registration.widget_route_missing",
			appId: agent.appId,
			toolName: tool.toolId,
			outcome: "misconfigured",
		});
		return;
	}

	// Convert schemas
	const inputSchema = buildToolInputSchema(tool);
	const outputSchema = jsonSchemaToOutputSchema(tool.outputSchema);

	const adapterScope = parseAdapterScope(tool.adapterScope);
	const annotations = resolveWireAnnotations(tool);

	const appContext: WidgetAppContext = {
		id: agent.appId,
		slug: agent.app?.slug ?? "unknown",
		name: agent.app?.name ?? "Unknown App",
		defaultWidgetDomain: agent.getWidgetDomain(),
	};

	const widgetSecSchemes = deriveSecuritySchemes(
		tool.toolId,
		agent.appMetadata?.mcpConfig as Record<string, unknown> | undefined,
	);
	const widgetConfig = z
		.record(z.string(), JsonValueSchema)
		.nullable()
		.safeParse(tool.config);
	if (!widgetConfig.success) {
		log.error("Skipping widget tool with non-JSON configuration", {
			event: "tool_registration.invalid_widget_config",
			appId: agent.appId,
			toolName: tool.toolId,
			outcome: "invalid",
		});
		return;
	}

	const widgetTool = {
		...tool,
		config: widgetConfig.data,
		authRequired: tool.authRequired ?? false,
		icons: tool.icons ?? null,
		executionTaskSupport: tool.executionTaskSupport ?? null,
		meta: tool.meta ?? null,
		schemaDialect: tool.schemaDialect ?? null,
		schemaSource: tool.schemaSource ?? null,
		schemaSourceRef: tool.schemaSourceRef ?? null,
		schemaSourceHash: tool.schemaSourceHash ?? null,
		schemaSyncedAt: tool.schemaSyncedAt ?? null,
	};

	const result = await registerWidgetTool({
		server: agent.server,
		serverCtx: agent,
		tool: widgetTool,
		widgetRoute,
		widgetVersion,
		appContext,
		annotations,
		inputSchema,
		outputSchema,
		registeredResourceUris,
		securitySchemes: widgetSecSchemes,
		handler: async (args, ctx) => {
			const extra = {
				_meta: resolveToolRequestMeta(ctx.mcpReq?._meta, agent.requestMeta),
			};
			const annotationFailure = enforceExpectedAnnotations(
				agent,
				tool,
				annotations,
				extra,
			);
			if (annotationFailure) return annotationFailure;

			const riskRateLimitFailure = await enforceToolRiskRateLimit(agent, tool);
			if (riskRateLimitFailure) return riskRateLimitFailure;

			const approvalFailure = await requireDestructiveToolApproval(
				agent,
				tool,
				annotations,
				{ args, extra },
			);
			if (approvalFailure) return approvalFailure;
			const executionArgs = stripDestructiveApprovalArgs(tool, args);

			return projectNativeOutputEvidence(
				await executeTool(agent, tool, executionArgs, {
					adapterScope,
					resultStrategy: (tool.resultStrategy as ResultStrategy) ?? "merge",
				}),
				tool.outputSchema,
			);
		},
		buildCsp: async (t) => agent.buildAppCsp(t),
		fetchHtml: async (route, description, hostType) => {
			const extraHeaders: Record<string, string> = {};
			if (layoutSpec) {
				extraHeaders["X-Tedix-Layout-Spec"] = JSON.stringify(layoutSpec);
			}
			return agent.fetchWidgetHtml(route, description, hostType, extraHeaders);
		},
		onResourceRead: (event) => {
			trackResourceRead(
				agent,
				{
					resourceUri: event.resourceUri,
					resourceType: event.resourceType,
					widgetKey: event.widgetKey,
					toolId: event.toolId,
				},
				event.toolId,
			);
		},
	});

	if (!result) {
		log.error("Skipping widget tool after registration returned no result", {
			event: "tool_registration.widget_registration_empty",
			appId: agent.appId,
			toolName: tool.toolId,
			outcome: "unavailable",
		});
		return;
	}

	agent.toolOutputTemplates.set(tool.toolId, result.outputTemplate);
	agent.loadedTools.set(tool.toolId, tool);

	if (tool.authRequired) agent.authRequiredTools.add(tool.toolId);
	if (tool.visibility === "private") agent.authRequiredTools.add(tool.toolId);

	agent.appToolIds.add(tool.toolId);

	const appsSdkResourceId = `widget-${tool.toolId}`;
	const mcpAppResourceId = `mcp-app-${tool.toolId}`;
	agent.appResourceIds.add(appsSdkResourceId);
	agent.appResourceIds.add(mcpAppResourceId);
}
