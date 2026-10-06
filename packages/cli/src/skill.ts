import { FLOW_EXIT_FAIL, type FlowContext, runFlowCommand } from "./flow";
import { cyan, dim, errorText, green } from "./format";
import {
	readGatewayProjection,
	rowsFrom,
	type GatewayProjectionClient,
} from "./gateway-projection";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SkillContext {
	client: GatewayProjectionClient & FlowContext["client"];
	color: FlowContext["color"];
	json: boolean;
	workspace: string;
	limit?: number;
	flow: FlowContext["flow"];
}

export function skillUsage(): string {
	return [
		"tedix skill — manage reusable organization skills",
		"",
		"Verbs:",
		"  tedix skill list [--limit <n>]",
		"  tedix skill show <skillUuid>",
		"  tedix skill run <skillUuid> [--watch[=secs]] [--param k=v] [--params '<json>']",
		"  tedix skill status <runId> [--watch[=secs]]",
		"  tedix skill inspect <runId>",
		"  tedix skill runs [--limit <n>]",
		"",
		"Skills are persistent, revisioned capabilities. `skill run` uses the same",
		"durable execution path as `flow run --skill`; it never creates a draft.",
		"Use `tedix flow run --file <plan.ts>` for a one-off authored flow and",
		"`tedix workflow ...` to observe the execution engine.",
	].join("\n");
}

function requireUuid(value: string, label: string): void {
	if (!UUID_RE.test(value)) throw new Error(`${label} requires a UUID`);
}

async function listSkills(ctx: SkillContext): Promise<number> {
	const value = await readGatewayProjection(
		ctx.client,
		"skills.list_skills_by_org",
		{
			limit: ctx.limit ?? 25,
			offset: 0,
			summary: true,
		},
	);
	if (ctx.json) {
		console.log(JSON.stringify(value));
		return 0;
	}
	const rows = rowsFrom(value, "entries", "skills", "items", "data");
	if (rows.length === 0) {
		console.log(dim("no skills", ctx.color));
		return 0;
	}
	for (const row of rows) {
		console.log(
			`${green(String(row.lifecycleState ?? row.status ?? "skill"), ctx.color).padEnd(12)} ${cyan(String(row.id ?? row.skillId ?? "?"), ctx.color)} ${String(row.slug ?? row.name ?? "")}`,
		);
	}
	return 0;
}

async function showSkill(ctx: SkillContext, id: string): Promise<number> {
	requireUuid(id, "skill show");
	const value = await readGatewayProjection(ctx.client, "skills.get_skills", {
		id,
	});
	console.log(JSON.stringify(value, null, ctx.json ? 0 : 2));
	return 0;
}

async function listRuns(ctx: SkillContext): Promise<number> {
	const value = await readGatewayProjection(
		ctx.client,
		"skills.run_workflow_history",
		{
			limit: ctx.limit ?? 20,
		},
	);
	if (ctx.json) {
		console.log(JSON.stringify(value));
		return 0;
	}
	const rows = rowsFrom(value, "runs", "entries", "data");
	if (rows.length === 0) {
		console.log(dim("no skill runs", ctx.color));
		return 0;
	}
	for (const row of rows) {
		console.log(
			`${String(row.status ?? "?").padEnd(12)} ${cyan(String(row.runId ?? row.id ?? "?"), ctx.color)} ${String(row.skillSlug ?? row.skillId ?? "")}`,
		);
	}
	return 0;
}

export async function runSkillCommand(
	args: string,
	ctx: SkillContext,
): Promise<number> {
	const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const target = rest[0] ?? "";
	try {
		switch (verb) {
			case "":
			case "help":
				console.log(skillUsage());
				return 0;
			case "list":
				return await listSkills(ctx);
			case "show":
				if (!target) throw new Error("Usage: tedix skill show <skillUuid>");
				return await showSkill(ctx, target);
			case "run":
				if (!target) throw new Error("Usage: tedix skill run <skillUuid>");
				requireUuid(target, "skill run");
				return await runFlowCommand("run", {
					...ctx,
					flow: { ...ctx.flow, file: undefined, skill: target },
				});
			case "status":
				return await runFlowCommand(`status ${target}`, ctx);
			case "inspect":
				return await runFlowCommand(`inspect ${target}`, ctx);
			case "runs":
				return await listRuns(ctx);
			default:
				throw new Error(
					`unknown skill verb "${verb}" — expected list, show, run, status, inspect, or runs`,
				);
		}
	} catch (error) {
		console.error(errorText(error));
		return FLOW_EXIT_FAIL;
	}
}
