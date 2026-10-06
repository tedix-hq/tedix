import { FLOW_EXIT_FAIL } from "./flow";
import { cyan, dim, errorText } from "./format";
import {
	readGatewayProjection,
	rowsFrom,
	type GatewayProjectionClient,
} from "./gateway-projection";

export interface WorkflowContext {
	client: GatewayProjectionClient;
	color: { enabled: boolean };
	json: boolean;
	limit?: number;
}

export function workflowUsage(): string {
	return [
		"tedix workflow — observe the execution engine behind automations and skill runs",
		"",
		"Verbs:",
		"  tedix workflow list [--limit <n>]",
		"  tedix workflow health [--limit <n>]",
		"  tedix workflow runs [--limit <n>]",
		"  tedix workflow status <workflowId>",
		"",
		"This surface is read-only engine observability. Use `tedix skill run` for a",
		"persistent skill or `tedix flow run --file` for a one-off flow.",
	].join("\n");
}

async function callAndPrint(
	ctx: WorkflowContext,
	callable: string,
	input: Record<string, unknown>,
	rowKey?: string,
): Promise<number> {
	const value = await readGatewayProjection(ctx.client, callable, input);
	if (ctx.json || !rowKey) {
		console.log(JSON.stringify(value, null, ctx.json ? 0 : 2));
		return 0;
	}
	const rows = rowsFrom(value, rowKey);
	if (rows.length === 0) {
		console.log(dim("no workflows", ctx.color));
		return 0;
	}
	for (const row of rows) {
		const id = row.workflowId ?? row.definitionId ?? row.id ?? "?";
		const state =
			row.status ??
			row.healthStatus ??
			row.health ??
			row.lifecycleState ??
			row.kind ??
			"?";
		const label = row.name ?? row.skillSlug ?? row.workflowType ?? "";
		console.log(
			`${String(state).padEnd(14)} ${cyan(String(id), ctx.color)} ${String(label)}`,
		);
	}
	return 0;
}

export async function runWorkflowCommand(
	args: string,
	ctx: WorkflowContext,
): Promise<number> {
	const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const target = rest[0] ?? "";
	const limit = ctx.limit ?? 20;
	try {
		switch (verb) {
			case "":
			case "help":
				console.log(workflowUsage());
				return 0;
			case "list":
				return await callAndPrint(
					ctx,
					"workflows.list_workflow_definitions",
					{ limit, offset: 0 },
					"definitions",
				);
			case "health":
				return await callAndPrint(
					ctx,
					"workflows.list_workflow_definition_health",
					{ limit, offset: 0 },
					"health",
				);
			case "runs":
				return await callAndPrint(
					ctx,
					"workflows.list_workflow_runs",
					{ limit },
					"runs",
				);
			case "status":
				if (!target)
					throw new Error("Usage: tedix workflow status <workflowId>");
				return await callAndPrint(ctx, "workflows.get_workflow_status", {
					workflowId: target,
				});
			default:
				throw new Error(
					`unknown workflow verb "${verb}" — expected list, health, runs, or status`,
				);
		}
	} catch (error) {
		console.error(errorText(error));
		return FLOW_EXIT_FAIL;
	}
}
