import { createMcpLogger } from "../log";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import {
	parseAdapterScope,
	type ResultStrategy,
	type ToolAnnotations,
} from "@tedix/api-contract/schemas/tools";
import { clientSupportsTasks } from "@tedix/mcp-shared/tasks";
import {
	enforceExpectedAnnotations,
	requireDestructiveToolApproval,
	stripDestructiveApprovalArgs,
} from "./governance";
import {
	type ToolCallback,
	wrapToolCallTelemetry,
} from "./middleware/telemetry";
import {
	attachPaymentResponseMeta,
	checkToolPayment,
	getToolPaymentPolicy,
	settleToolPayment,
} from "./payments";
import type { AppTool, ServerContext } from "./server-context";
import { executeTool } from "./tool-execution";
import {
	enforceToolRiskRateLimit,
	toolApprovalMetadata,
} from "./tool-risk-policy";
import {
	projectNativeOutputEvidence,
	type ToolInputStandardSchema,
} from "./utils/schema";
import { resolveToolRequestMeta } from "./tool-registration";
import {
	deriveSecuritySchemes,
	enforceNativeToolScopeGate,
} from "./tool-registration-policy";
const log = createMcpLogger("mcp.tool_registration");

/**
 * Register a text-only tool (no widget, no resources).
 *
 * Uses server.registerTool() (not the deprecated server.tool()) to support
 * the full config object: title, outputSchema, annotations, and _meta.
 *
 * Long-running operations should return workflow/job handles through normal
 * tool output. Do not use SDK v1 `experimental.tasks` here: the current MCP
 * Tasks extension has a different negotiation and polling model.
 */
export async function registerTextOnlyTool(
	agent: ServerContext,
	tool: AppTool,
	inputSchema: ToolInputStandardSchema,
	annotations?: ToolAnnotations,
	outputSchema?: StandardSchemaWithJSON,
): Promise<void> {
	const toolTypeId = tool.toolTypeId;
	if (!toolTypeId) {
		log.error("Skipping tool without a type", {
			event: "tool_registration.missing_type",
			appId: agent.appId,
			toolName: tool.toolId,
			outcome: "misconfigured",
		});
		return;
	}

	// Build _meta for text-only tools (D1 metadata, invocationStatus, visibility, securitySchemes)
	const meta: Record<string, unknown> =
		tool.meta && typeof tool.meta === "object" && !Array.isArray(tool.meta)
			? { ...(tool.meta as Record<string, unknown>) }
			: {};

	// securitySchemes — per-tool auth declaration for ChatGPT
	const secSchemes = deriveSecuritySchemes(
		tool.toolId,
		agent.appMetadata?.mcpConfig as Record<string, unknown> | undefined,
	);
	if (secSchemes) {
		meta.securitySchemes = secSchemes;
	}

	// Parse invocationStatus from dedicated column, falling back to config
	const invocationStatus = (tool.invocationStatus ??
		(tool.config as Record<string, unknown> | null)?.invocationStatus) as {
		invoking?: string;
		invoked?: string;
	} | null;
	if (invocationStatus?.invoking) {
		meta["openai/toolInvocation/invoking"] = invocationStatus.invoking;
	}
	if (invocationStatus?.invoked) {
		meta["openai/toolInvocation/invoked"] = invocationStatus.invoked;
	}

	// Visibility
	if (tool.visibility) {
		meta["openai/visibility"] = tool.visibility;
	}

	// Tedix namespace — tool provenance metadata for the MCP plugin
	meta["com.tedix/appSlug"] = agent.appSlug ?? "unknown";
	meta["com.tedix/toolTypeId"] = tool.toolTypeId ?? "unknown";
	// Provenance comes from the configured connection, never upstream _meta.
	delete meta["com.tedix/connectedTool"];
	Object.assign(meta, { ...toolApprovalMetadata(tool), ...meta });
	const paymentPolicy = getToolPaymentPolicy(tool);
	if (paymentPolicy) {
		meta["x-tedix/paymentRequired"] = true;
		// agents-x402 discovery extension: Cloudflare buyer agents read these
		// two keys from tools/list to compare prices before calling.
		meta["agents-x402/paymentRequired"] = true;
		const priceUSD = Number(paymentPolicy.amount);
		if (Number.isFinite(priceUSD)) {
			meta["agents-x402/priceUSD"] = priceUSD;
		}
	}
	if (tool.widgetKey) {
		meta["com.tedix/hasWidget"] = true;
		meta["com.tedix/widgetKey"] = tool.widgetKey;
	}
	const transport = (tool.config as Record<string, unknown> | null)?.transport;
	if (transport === "mcp" || transport === "external") {
		meta["com.tedix/transport"] = transport;
	}

	// Standard synchronous tool registration
	const cb: ToolCallback = async (args, ctx) => {
		// Scope gate first (mirrors the Code Mode inner-tool order): close the
		// gap where code-built home__* tools, merged after enforceMcpAccess,
		// reach the native dispatch with no request-level scope check.
		const scopeDenial = enforceNativeToolScopeGate(agent, tool);
		if (scopeDenial) return scopeDenial;

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

		const payment = await checkToolPayment({
			agent,
			tool,
			args: executionArgs,
			extra,
		});
		if (!payment.paid) return payment.result;

		const result = await executeTool(agent, tool, executionArgs, {
			adapterScope: parseAdapterScope(tool.adapterScope),
			resultStrategy: (tool.resultStrategy as ResultStrategy) ?? "merge",
			clientSupportsTasks: clientSupportsTasks(extra?._meta),
		});
		if (result.isError) return result;
		const settlement = await settleToolPayment(agent, payment.settlement);
		if (!settlement.settled) return settlement.result;
		return attachPaymentResponseMeta(
			projectNativeOutputEvidence(result, tool.outputSchema),
			settlement.paymentResponse ?? payment.paymentResponse,
		);
	};

	const registeredTool = agent.server.registerTool(
		tool.toolId,
		{
			title: tool.title,
			description: tool.description ?? tool.title,
			inputSchema,
			...(outputSchema && { outputSchema }),
			...(tool.icons ? { icons: tool.icons } : {}),
			...(annotations && { annotations }),
			...(Object.keys(meta).length > 0 && { _meta: meta }),
		},
		wrapToolCallTelemetry(
			tool.toolId,
			agent,
			cb,
			tool,
		) as unknown as Parameters<typeof agent.server.registerTool>[2],
	);

	agent.registeredTools.set(tool.toolId, registeredTool);
	agent.appToolIds.add(tool.toolId);
	agent.loadedTools.set(tool.toolId, tool);
	if (tool.authRequired) agent.authRequiredTools.add(tool.toolId);
	if (tool.visibility === "private") agent.authRequiredTools.add(tool.toolId);
}
