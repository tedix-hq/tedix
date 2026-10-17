import {
	DelegationCapabilityPlanSchema,
	type DelegationCapabilityPlan,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { Tool, ToolSet } from "ai";
import * as z from "zod";

export function capabilityPlanForMetadata(
	metadata: Record<string, unknown> | null,
): DelegationCapabilityPlan | undefined {
	const order = metadata?.delegationWorkOrder;
	if (!order || typeof order !== "object" || Array.isArray(order))
		return undefined;
	const value = (order as Record<string, unknown>).capabilityPlan;
	if (value === undefined) return undefined;
	return DelegationCapabilityPlanSchema.parse(value);
}

/** Narrow existing gated tools; never construct a new provider credential. */
export function capabilityToolSet(input: {
	tools: ToolSet;
	plan?: DelegationCapabilityPlan;
	onEvaluation?: (event: {
		toolCallId: string;
		tool: string;
		requestedSurface: string;
		allowed: boolean;
		reason: string | null;
	}) => Promise<void>;
}): ToolSet {
	const { tools, plan } = input;
	if (!plan) return tools;
	if (plan.missingCapabilities.length)
		throw new Error(
			`capability gap: ${plan.missingCapabilities.join(", ")}; return to Home for rerouting`,
		);
	const toolIds = new Set(plan.allowedToolIds);
	const callables = plan.allowedToolIds.filter((id) => id.includes("."));
	const selected = [...toolIds].filter((id) => !id.includes("."));
	if (callables.length)
		selected.push(
			"tedix_mcp_search_tools",
			"tedix_mcp_call_tool",
			"mcp_read_result",
		);
	const result: ToolSet = {};
	for (const name of selected) {
		const definition = tools[name] as
			| Tool<Record<string, unknown>, unknown>
			| undefined;
		if (!definition?.execute)
			throw new Error(
				`capability tool unavailable: ${name}; return to Home for rerouting`,
			);
		const execute = definition.execute;
		result[name] = {
			...definition,
			...(name === "tedix_mcp_search_tools"
				? {
						description: `Read the current parameter schema for one granted callable before calling it. Exact callables: ${callables.join(", ")}.`,
						inputSchema: z.object({
							query: z.enum(callables as [string, ...string[]]),
						}),
					}
				: {}),
			execute: async (args, options) => {
				const values =
					args && typeof args === "object"
						? (args as Record<string, unknown>)
						: {};
				let reason: string | null = null;
				if (
					name === "tedix_mcp_search_tools" &&
					!callables.includes(String(values.query))
				)
					reason = "Discovery is outside the capability plan";
				if (
					name === "browser_markdown" &&
					!plan.urls.includes(String(values.url))
				)
					reason = "URL is outside the delegated request";
				if (name === "tedix_mcp_call_tool") {
					if (!callables.includes(String(values.callable)))
						reason = "MCP callable is outside the capability plan";
					const providerArgs = values.args as
						| Record<string, unknown>
						| undefined;
					if (
						plan.requiredCapabilities.includes("output.read") &&
						String(values.callable).endsWith(".get_os_output") &&
						!plan.outputIds.includes(String(providerArgs?.outputId))
					)
						reason = "Output is outside the delegated request";
				}
				await input.onEvaluation?.({
					toolCallId: options.toolCallId,
					tool: name,
					requestedSurface:
						name === "tedix_mcp_call_tool" ? String(values.callable) : name,
					allowed: reason === null,
					reason,
				});
				if (reason) throw new Error(reason);
				return execute(
					name === "tedix_mcp_search_tools"
						? { query: values.query, includeParameters: true, limit: 1 }
						: args,
					options,
				);
			},
		} as ToolSet[string];
	}
	return result;
}
