import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import { readFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { normalizeCodeResult, truncationErrorMessage } from "./code-result";
import { FLOW_EXIT_FAIL, type FlowContext, runFlowCommand } from "./flow";
import { cyan, dim, errorText, green, red } from "./format";
import {
	readGatewayProjection,
	rowsFrom,
	type GatewayProjectionClient,
} from "./gateway-projection";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Fields kept per listed skill, so a long list fits the gateway result cap. */
const SKILL_ROW_FIELDS = ["id", "slug", "title", "lifecycleState"] as const;
const STEP_ROW_FIELDS = [
	"name",
	"kind",
	"status",
	"outcome",
	"attempt",
	"durationMs",
	"error",
] as const;
const SCHEDULE_ROW_FIELDS = [
	"id",
	"cron",
	"enabled",
	"nextFireAt",
	"lastFireAt",
	"lastRunId",
	"lastError",
] as const;

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
		"  tedix skill find <query> [--limit <n>]",
		"  tedix skill show <skillUuid|slug> [--file SKILL.md|<path>]",
		"  tedix skill schedule <skillUuid|slug>",
		"  tedix skill edit <skillUuid> --file SKILL.md [--file scripts/workflow.ts ...] [--reason <text>]",
		"  tedix skill run <skillUuid> [--watch[=secs]] [--param k=v] [--params '<json>']",
		"  tedix skill status <runId> [--watch[=secs]]",
		"  tedix skill inspect <runId> [--limit <n>]",
		"  tedix skill runs [--limit <n>]",
		"",
		"Skills are persistent, revisioned capabilities. `skill run` uses the same",
		"durable execution path as `flow run --skill`; it never creates a draft.",
		"`skill inspect` lists a run's steps, failed first, without step output;",
		"`tedix flow inspect <runId>` returns the full evidence.",
		"`skill edit` writes a new revision: SKILL.md replaces the content, other",
		"files are added or replaced by their path relative to SKILL.md.",
		"Use `tedix flow run --file <plan.ts>` for a one-off authored flow and",
		"`tedix workflow ...` to observe the execution engine.",
	].join("\n");
}

function requireUuid(value: string, label: string): void {
	if (!UUID_RE.test(value)) throw new Error(`${label} requires a UUID`);
}

function skillSelector(id: string, verb: string): Record<string, string> {
	if (UUID_RE.test(id)) return { skillId: id };
	if (SLUG_RE.test(id)) return { slug: id };
	throw new Error(`skill ${verb} requires a UUID or canonical slug`);
}

/** Rows per gateway call; a larger --limit is read page by page. */
const SKILL_PAGE = 50;

async function listSkills(ctx: SkillContext, query?: string): Promise<number> {
	const wanted = ctx.limit ?? 25;
	const rows: Record<string, unknown>[] = [];
	while (rows.length < wanted) {
		const limit = Math.min(SKILL_PAGE, wanted - rows.length);
		const value = await readGatewayProjection(
			ctx.client,
			"skills.list_skills_by_org",
			{
				limit,
				offset: rows.length,
				summary: true,
				...(query ? { query } : {}),
			},
			SKILL_ROW_FIELDS,
			"entries",
		);
		const page = rowsFrom(value, "entries", "skills", "items", "data");
		rows.push(...page);
		if (page.length < limit) break;
	}
	if (ctx.json) {
		console.log(JSON.stringify({ entries: rows }));
		return 0;
	}
	if (rows.length === 0) {
		console.log(
			dim(query ? `no skills match "${query}"` : "no skills", ctx.color),
		);
		return 0;
	}
	for (const row of rows) {
		console.log(
			`${green(String(row.lifecycleState ?? row.status ?? "skill"), ctx.color).padEnd(12)} ${cyan(String(row.id ?? row.skillId ?? "?"), ctx.color)} ${String(row.slug ?? row.name ?? "")}${row.title ? dim(`  ${String(row.title)}`, ctx.color) : ""}`,
		);
	}
	return 0;
}

/** Characters of one file per gateway call, well under the result cap. */
const FILE_CHUNK = 12_000;

/**
 * Sandbox statements that leave the skill in `e` and its files in `files`.
 * A slug resolves through get_skills_for_mcp (standing rules) and otherwise
 * through an exact-slug catalog match.
 */
function skillReadStatements(id: string): string {
	const read = UUID_RE.test(id)
		? `const g = await skills.get_skills(${codeModeLiteral({ id })}); let e = g?.entry ?? g;`
		: `const m = await skills.get_skills_for_mcp(${codeModeLiteral({ slug: id })}); let e = m?.entry ?? null; if (!e) { const hit = (await skills.list_skills_by_org(${codeModeLiteral({ query: id, limit: 20, offset: 0, summary: true })})).entries?.find((x) => x.slug === ${codeModeLiteral(id)}); if (hit) { const g = await skills.get_skills({ id: hit.id }); e = g?.entry ?? g; } }`;
	return `${read} if (!e) return { missing: true }; const files = e.files ?? {};`;
}

async function runSkillProjection(
	ctx: SkillContext,
	source: string,
): Promise<Record<string, unknown>> {
	const normalized = normalizeCodeResult(await ctx.client.runCode(source));
	if (normalized.truncated) throw new Error(truncationErrorMessage(normalized));
	return (normalized.value ?? {}) as Record<string, unknown>;
}

/**
 * A bounded summary (metadata, a SKILL.md preview, file names and sizes), or
 * with `--file <path>` one file whole, read in chunks so a large skill never
 * hits the gateway's result cap.
 */
async function showSkill(ctx: SkillContext, id: string): Promise<number> {
	if (!UUID_RE.test(id) && !SLUG_RE.test(id))
		throw new Error("skill show requires a UUID or canonical slug");
	const read = skillReadStatements(id);
	const notFound = () => new Error(`no skill ${id} in this organization`);
	const path = ctx.flow.file?.trim();
	if (path) {
		let text = "";
		for (let offset = 0; ; offset += FILE_CHUNK) {
			const chunk = await runSkillProjection(
				ctx,
				`async () => { ${read} const path = ${codeModeLiteral(path)}; const text = path === "SKILL.md" ? e.content : files[path]; if (typeof text !== "string") return { missingFile: path, files: ["SKILL.md", ...Object.keys(files)] }; return { total: text.length, chunk: text.slice(${offset}, ${offset + FILE_CHUNK}) }; }`,
			);
			if (chunk.missing) throw notFound();
			if (chunk.missingFile)
				throw new Error(
					`skill ${id} has no file ${path}; files: ${(chunk.files as string[]).join(", ")}`,
				);
			text += String(chunk.chunk ?? "");
			if (offset + FILE_CHUNK >= Number(chunk.total)) break;
		}
		console.log(ctx.json ? JSON.stringify({ path, content: text }) : text);
		return 0;
	}
	const summary = await runSkillProjection(
		ctx,
		`async () => { ${read} return { id: e.id, slug: e.slug, title: e.title, description: e.description, lifecycleState: e.lifecycleState, revision: e.revision ?? e.version ?? null, tediId: e.tediId ?? null, contentChars: (e.content ?? "").length, contentPreview: (e.content ?? "").slice(0, 1500), files: Object.entries(files).map(([path, text]) => ({ path, chars: String(text).length })) }; }`,
	);
	if (summary.missing) throw notFound();
	console.log(JSON.stringify(summary, null, ctx.json ? 0 : 2));
	if (!ctx.json)
		console.log(
			dim(
				`\n  whole file: tedix skill show ${id} --file SKILL.md (or a path above)`,
				ctx.color,
			),
		);
	return 0;
}

async function showSchedule(ctx: SkillContext, id: string): Promise<number> {
	const value = await readGatewayProjection(
		ctx.client,
		"skills.list_skill_workflow_schedules",
		{ ...skillSelector(id, "schedule"), limit: 20 },
		SCHEDULE_ROW_FIELDS,
		"schedules",
	);
	if (ctx.json) {
		console.log(JSON.stringify(value));
		return 0;
	}
	const rows = rowsFrom(value, "schedules");
	if (rows.length === 0) {
		console.log(dim("no schedule for this skill", ctx.color));
		return 0;
	}
	for (const row of rows) {
		const state = row.enabled
			? green("enabled", ctx.color)
			: dim("paused", ctx.color);
		console.log(
			`${state.padEnd(10)} ${String(row.cron ?? "?")}  next ${String(row.nextFireAt ?? "—")}  last ${String(row.lastFireAt ?? "—")}${row.lastError ? red(`  last error: ${String(row.lastError).slice(0, 200)}`, ctx.color) : ""}`,
		);
	}
	return 0;
}

/** Steps of one run, failed first, without step output. */
async function inspectRun(ctx: SkillContext, runId: string): Promise<number> {
	if (!runId) throw new Error("Usage: tedix skill inspect <runId>");
	const value = await readGatewayProjection(
		ctx.client,
		"skills.list_skill_workflow_steps",
		{ runId, includeContent: false, limit: ctx.limit ?? 100 },
		STEP_ROW_FIELDS,
		"steps",
	);
	const rows = rowsFrom(value, "steps");
	const failed = (row: Record<string, unknown>) =>
		row.status === "failed" || row.outcome === "failure";
	const ordered = [...rows.filter(failed), ...rows.filter((r) => !failed(r))];
	const more = (value as { truncated?: boolean } | null)?.truncated === true;
	if (ctx.json) {
		console.log(JSON.stringify({ runId, steps: ordered, truncated: more }));
		return 0;
	}
	if (ordered.length === 0) {
		console.log(dim("no recorded steps", ctx.color));
		return 0;
	}
	for (const row of ordered) {
		const status = String(row.status ?? row.outcome ?? "?");
		const error =
			row.error && typeof row.error === "object"
				? String(
						(row.error as Record<string, unknown>).message ??
							JSON.stringify(row.error),
					)
				: row.error
					? String(row.error)
					: "";
		console.log(
			`${(failed(row) ? red(status, ctx.color) : status).padEnd(10)} ${String(row.name ?? "?")}${row.attempt && Number(row.attempt) > 1 ? dim(` attempt ${String(row.attempt)}`, ctx.color) : ""}${typeof row.durationMs === "number" ? dim(` ${Math.round(row.durationMs)}ms`, ctx.color) : ""}${error ? `\n           ${error.slice(0, 300)}` : ""}`,
		);
	}
	if (more)
		console.log(
			dim(
				"\n  more steps exist; raise --limit or use tedix flow inspect",
				ctx.color,
			),
		);
	return 0;
}

/** SKILL.md becomes the content; other files are keyed relative to it. */
export function skillEditPayload(paths: readonly string[]): {
	content?: string;
	files: Record<string, string>;
} {
	if (paths.length === 0)
		throw new Error(
			"skill edit requires --file SKILL.md and/or --file <supporting file>",
		);
	const skillMd = paths.find((path) => basename(path) === "SKILL.md");
	const root = skillMd ? dirname(skillMd) : process.cwd();
	const files: Record<string, string> = {};
	let content: string | undefined;
	for (const path of paths) {
		const text = readFileSync(path, "utf8");
		if (path === skillMd) {
			content = text;
			continue;
		}
		const key = relative(root, path).split("\\").join("/");
		if (!key || key.startsWith("../"))
			throw new Error(
				`${path} is outside the skill folder; pass it relative to SKILL.md`,
			);
		files[key] = text;
	}
	return { ...(content !== undefined ? { content } : {}), files };
}

/**
 * Write one revision. `improve_skills` replaces the whole files map, so the
 * merge with the stored files runs in the sandbox and file bodies never make
 * a round trip through this process.
 */
async function editSkill(ctx: SkillContext, id: string): Promise<number> {
	requireUuid(id, "skill edit");
	const { content, files } = skillEditPayload(ctx.flow.files ?? []);
	const reason = ctx.flow.reason?.trim() || "Edited from tedix skill edit";
	const source = `async () => {
		const id = ${JSON.stringify(id)};
		const update = ${JSON.stringify(files)};
		const current = await skills.get_skills({ id });
		const entry = current?.entry ?? current;
		const changed = Object.keys(update).length > 0;
		const result = await skills.improve_skills({
			id,
			${content !== undefined ? `content: ${JSON.stringify(content)},` : ""}
			...(changed ? { files: { ...(entry?.files ?? {}), ...update } } : {}),
			revisionReasoning: ${JSON.stringify(reason)},
		});
		const saved = result?.entry ?? result;
		return { id: saved?.id, slug: saved?.slug, revision: saved?.revision ?? saved?.version ?? null, files: Object.keys(saved?.files ?? {}) };
	}`;
	const normalized = normalizeCodeResult(await ctx.client.runCode(source));
	if (normalized.truncated) throw new Error(truncationErrorMessage(normalized));
	const saved = normalized.value as Record<string, unknown> | undefined;
	if (ctx.json) {
		console.log(JSON.stringify(saved));
		return 0;
	}
	console.log(
		`${green("saved", ctx.color)} ${cyan(String(saved?.id ?? id), ctx.color)} ${String(saved?.slug ?? "")}${saved?.revision != null ? dim(` revision ${String(saved.revision)}`, ctx.color) : ""}`,
	);
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
			case "find":
				if (!rest.length) throw new Error("Usage: tedix skill find <query>");
				return await listSkills(ctx, rest.join(" ").slice(0, 120));
			case "show":
				if (!target)
					throw new Error("Usage: tedix skill show <skillUuid|slug>");
				return await showSkill(ctx, target);
			case "schedule":
				if (!target)
					throw new Error("Usage: tedix skill schedule <skillUuid|slug>");
				return await showSchedule(ctx, target);
			case "edit":
				if (!target)
					throw new Error(
						"Usage: tedix skill edit <skillUuid> --file SKILL.md [--file <path> ...]",
					);
				return await editSkill(ctx, target);
			case "run":
				if (!target) throw new Error("Usage: tedix skill run <skillUuid>");
				requireUuid(target, "skill run");
				if (ctx.flow.file !== undefined)
					throw new Error(
						"skill run does not accept --file; use tedix flow run --file <plan.ts>",
					);
				return await runFlowCommand("run", {
					...ctx,
					flow: { ...ctx.flow, skill: target },
				});
			case "status":
				return await runFlowCommand(`status ${target}`, ctx);
			case "inspect":
				return await inspectRun(ctx, target);
			case "runs":
				return await listRuns(ctx);
			default:
				throw new Error(
					`unknown skill verb "${verb}" — expected list, find, show, schedule, edit, run, status, inspect, or runs`,
				);
		}
	} catch (error) {
		console.error(errorText(error));
		return FLOW_EXIT_FAIL;
	}
}
