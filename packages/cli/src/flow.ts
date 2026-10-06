/**
 * `tedix flow` — ephemeral skill workflows for external coding agents.
 *
 * The problem this solves: a coding agent's cost is `turns × context window`,
 * not `bytes per tool result`. Long sessions sit on a large context plateau and
 * pay it on every tool call, so a call costs about the same whether it returns
 * 200 bytes or 200 KB; the turn count is the dominant term.
 *
 * A skill workflow collapses N steps into ONE turn: the steps and their
 * intermediate output execute inside a durable Cloudflare Workflow and never
 * enter the agent's context window — only the bounded return value does.
 *
 * Why a verb and not a doc: The gateway's built-in `flow.*` provider composes
 * skill authoring, tedi selection, execution, and bounded status projection.
 * This CLI verb supplies the local one-file authoring experience and watch
 * loop without inventing a second capability or dispatch model.
 *
 * ONE FILE. A workflow needs BOTH executable source and a capability manifest,
 * and the manifest lives in SKILL.md frontmatter — two artifacts for what the
 * agent thinks of as one script. `tedix flow` reads a leading `/* tedix ... *\/`
 * block from the plan file and renders SKILL.md from it, so the agent writes
 * and reasons about exactly one file:
 *
 *   /* tedix
 *   name: audit-tool-annotations
 *   description: Check every app tool's annotations against its handler.
 *   capabilities:
 *     mcp:
 *       app_config: [list_app_tools]
 *   *\/
 *   export default { async run(event, step, env) { ... } }
 *
 * TRANSPORT. Same gateway path as `tedix work`/`tedix code`: one
 * fixed `flow.run|status|inspect|list|tools` Code Mode snippet per call via
 * `client.runCode`. No new MCP transport and no second auth flow. `flow.run`
 * composes a destructive-governed workflow start, so its explicit reason rides
 * the existing `runCodeWithDestructiveApproval` helper.
 *
 * LIFECYCLE. Every run authored here lands as a `draft` skill. Drafts execute
 * explicitly but never fire on a schedule, and unpromoted flow drafts
 * auto-archive after 14 days without use — the right shape for throwaway
 * orchestration.
 * A draft that proves itself is promoted through the ordinary governed path
 * (execute-to-promote, human disposer); this verb deliberately provides no
 * promotion shortcut.
 */

import { readFileSync } from "node:fs";
import { normalizeCodeResult, truncationErrorMessage } from "./code-result";
import {
	cyan,
	dim,
	errorText,
	formatDuration,
	green,
	red,
	yellow,
} from "./format";
import type { ColorMode } from "./terminal";
import type { TedixHomeClient } from "./home-client";
import { sleep as sleepDefault } from "@tedix/worker-kit/sleep";

/** Matches the `tedix work` convention: non-zero means the operation failed. */
export const FLOW_EXIT_FAIL = 2;
/** `--watch` horizon expired while the run was still active — not a failure. */
export const FLOW_EXIT_WATCH_TIMEOUT = 3;

/** Default `--watch` horizon (seconds) and the bounded poll interval. */
export const DEFAULT_WATCH_SECONDS = 900;
const WATCH_POLL_INTERVAL_MS = 5_000;
/**
 * Terminal engine states returned by the gateway's `flow.status` projection;
 * anything outside this set is still moving.
 */
const TERMINAL_STATUSES = new Set([
	"completed",
	"failed",
	"canceled",
	"cancelled",
	"terminated",
]);

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FlowOptions {
	/** `run`: path to the plan file carrying source + `/* tedix *\/` manifest. */
	file?: string;
	/** `run`: existing executable skill UUID; mutually exclusive with file. */
	skill?: string;
	/** Poll until the run settles; optional seconds override. */
	watch?: number;
	/** Tedi slug (or UUID) whose namespace executes the run. */
	as?: string;
	/** Repeatable `--param k=v`, or `--params '<json>'`. */
	param?: string[];
	params?: string;
	/** Override the manifest-derived skill title. */
	title?: string;
	/** Audit reason recorded with the destructive run authorization. */
	reason?: string;
	/** `list`: page size. */
	limit?: number;
}

export interface FlowContext {
	client: Pick<TedixHomeClient, "runCode" | "runCodeWithDestructiveApproval">;
	color: ColorMode;
	json: boolean;
	workspace: string;
	flow: FlowOptions;
	/** Injected in tests so the watch loop does not actually sleep. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

interface FlowError {
	code?: string;
	status?: number;
	message: string;
}

interface FlowResult {
	value: unknown;
	error?: FlowError;
}

/**
 * The manifest half of a plan file.
 *
 * Kept as raw YAML lines rather than parsed structure: the platform validator
 * is authoritative for manifest shape, and re-implementing a YAML parser here
 * would only add a second, weaker opinion that drifts. The CLI's job is to
 * move the block into SKILL.md frontmatter intact.
 */
interface PlanManifest {
	name?: string;
	description?: string;
	/** Raw YAML body, verbatim, minus any `name:`/`description:` scalars. */
	yaml: string;
}

interface Plan {
	source: string;
	manifest: PlanManifest;
}

/** Leading `/* tedix ... *\/` block. Anchored: only the FIRST block counts. */
const MANIFEST_BLOCK_RE = /^\s*\/\*\s*tedix\s*\n([\s\S]*?)\*\//;

/**
 * Split a plan file into workflow source and manifest YAML.
 *
 * The manifest block is left in the source verbatim. It is a comment, so it
 * costs nothing at runtime, and stripping it would make the stored revision
 * differ from the file the agent wrote — which is exactly the drift the
 * revision-pinning machinery exists to make visible.
 */
export function parsePlan(text: string): Plan {
	const match = text.match(MANIFEST_BLOCK_RE);
	if (!match) {
		throw new Error(
			"plan file has no leading `/* tedix ... */` manifest block — a workflow " +
				"needs a capability manifest (see `tedix flow --help`)",
		);
	}
	const body = match[1] ?? "";
	const lines = body.split("\n");
	let name: string | undefined;
	let description: string | undefined;
	const rest: string[] = [];
	for (const line of lines) {
		const scalar = line.match(/^(name|description):\s*(.*)$/);
		// Only top-level (unindented) scalars are the skill's own identity; an
		// indented `name:` belongs to a nested manifest structure and must pass
		// through untouched.
		if (scalar && !line.startsWith(" ") && !line.startsWith("\t")) {
			const value = (scalar[2] ?? "").trim().replace(/^["']|["']$/g, "");
			if (scalar[1] === "name") name = value || undefined;
			else description = value || undefined;
			continue;
		}
		rest.push(line);
	}
	return {
		source: text,
		manifest: {
			...(name ? { name } : {}),
			...(description ? { description } : {}),
			yaml: rest.join("\n").replace(/\n+$/, ""),
		},
	};
}

/**
 * Render SKILL.md for an ephemeral flow.
 *
 * The `capabilities:` block must survive into stored content verbatim — that is
 * the manifest the runtime enforces `env.MCP` against. Everything else here is
 * human-facing framing for the review surfaces a draft may later reach.
 */
export function renderSkillMd(
	manifest: PlanManifest,
	title: string,
	description: string,
): string {
	const body = manifest.yaml.trim();
	return [
		"---",
		`name: ${title}`,
		`description: ${description}`,
		...(body ? [body] : []),
		"---",
		"",
		`# ${title}`,
		"",
		description,
		"",
		"## Provenance",
		"",
		"Authored by an external coding agent via `tedix flow run`. This is an",
		"ephemeral draft: it executes explicitly, never fires on a schedule, and",
		"auto-archives after 14 days without use. Promotion to the baseline org",
		"library goes through the ordinary governed path, not through this verb.",
		"",
	].join("\n");
}

/**
 * Run one Code Mode snippet and split a structured contract error from a value.
 *
 * Mirrors `work.ts::runSource` deliberately, including the truncation rule: a
 * gateway-truncated result is unparseable, so it is an error rather than data.
 * Silently treating a clipped page as a value is the exact failure mode that
 * produced phantom-empty board lists.
 */
async function runSource(
	ctx: FlowContext,
	source: string,
	destructiveApprovalReason?: string,
): Promise<FlowResult> {
	try {
		const raw = destructiveApprovalReason
			? await ctx.client.runCodeWithDestructiveApproval(
					source,
					destructiveApprovalReason,
				)
			: await ctx.client.runCode(source);
		const normalized = normalizeCodeResult(raw);
		if (normalized.truncated) {
			return {
				value: normalized.value,
				error: {
					code: "RESULT_TRUNCATED",
					message: truncationErrorMessage(normalized),
				},
			};
		}
		const { value } = normalized;
		const error = flowErrorFromValue(value);
		return error ? { value, error } : { value };
	} catch (error) {
		return { value: undefined, error: { message: errorText(error) } };
	}
}

/**
 * oRPC contract errors cross Code Mode as a structured RESULT value rather than
 * a thrown exception, so success is decided by inspecting the value.
 */
function flowErrorFromValue(value: unknown): FlowError | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.ok === false) {
		const message =
			typeof record.error === "string"
				? record.error
				: typeof record.message === "string"
					? record.message
					: "gateway rejected the call";
		return { code: "GATEWAY_REJECTED", message };
	}
	const code = typeof record.code === "string" ? record.code : undefined;
	const status = typeof record.status === "number" ? record.status : undefined;
	const message =
		typeof record.message === "string" ? record.message : undefined;
	const isError =
		code !== undefined &&
		(record.defined === true || (status !== undefined && status >= 400));
	if (!isError) return undefined;
	return {
		...(code ? { code } : {}),
		...(status !== undefined ? { status } : {}),
		message: message ?? code ?? "flow error",
	};
}

type FlowCallable =
	| "flow.run"
	| "flow.status"
	| "flow.inspect"
	| "flow.list"
	| "flow.tools";

function flowInput(
	ctx: FlowContext,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const tediSlug = ctx.flow.as?.trim();
	if (!tediSlug) return args;
	if (UUID_RE.test(tediSlug)) {
		throw new Error("flow --as requires a tedi slug, not a UUID");
	}
	return { ...args, tediSlug };
}

/** Build and run one fixed gateway-native `flow.*` snippet. */
async function flowCall(
	ctx: FlowContext,
	callable: FlowCallable,
	args: Record<string, unknown>,
	destructiveApprovalReason?: string,
): Promise<FlowResult> {
	return runSource(
		ctx,
		`async () => await ${callable}(${JSON.stringify(flowInput(ctx, args))})`,
		destructiveApprovalReason,
	);
}

/** Poll one run through the provider's bounded status projection. */
async function statusCall(
	ctx: FlowContext,
	runId: string,
): Promise<FlowResult> {
	return flowCall(ctx, "flow.status", { runId });
}

/** Merge `--param k=v` repeats and `--params '<json>'` into one params object. */
export function collectParams(options: FlowOptions): Record<string, unknown> {
	const params: Record<string, unknown> = {};
	if (options.params) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(options.params);
		} catch (error) {
			throw new Error(`--params is not valid JSON: ${errorText(error)}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("--params must be a JSON object");
		}
		Object.assign(params, parsed as Record<string, unknown>);
	}
	for (const entry of options.param ?? []) {
		const index = entry.indexOf("=");
		if (index <= 0) {
			throw new Error(`--param expects k=v, got: ${entry}`);
		}
		const key = entry.slice(0, index);
		const raw = entry.slice(index + 1);
		// Let obvious scalars through as typed values; everything else stays a
		// string. Guessing harder than this loses more than it gains.
		params[key] =
			raw === "true"
				? true
				: raw === "false"
					? false
					: raw !== "" && !Number.isNaN(Number(raw))
						? Number(raw)
						: raw;
	}
	return params;
}

function pickString(value: unknown, ...keys: string[]): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const key of keys) {
		const found = record[key];
		if (typeof found === "string" && found) return found;
	}
	return undefined;
}

function unwrap(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") return {};
	const record = value as Record<string, unknown>;
	// Handlers return either the row directly or wrapped under `data`/`run`.
	for (const key of ["data", "run", "skill", "entry"]) {
		const nested = record[key];
		if (nested && typeof nested === "object" && !Array.isArray(nested)) {
			return nested as Record<string, unknown>;
		}
	}
	return record;
}

/**
 * `tedix flow run` — author an ephemeral draft, start it, optionally watch.
 *
 * Three gateway round trips in the common `--watch` case plus one poll per
 * interval, versus the N-turn in-context loop this replaces.
 */
async function runFlow(ctx: FlowContext): Promise<number> {
	const file = ctx.flow.file?.trim();
	const existingSkillId = ctx.flow.skill?.trim();
	if (file && existingSkillId) {
		throw new Error("flow run accepts either --file or --skill, not both");
	}
	if (!file && !existingSkillId) {
		throw new Error(
			"Usage: tedix flow run (--file <plan.ts> | --skill <uuid>) [--watch] [--param k=v]",
		);
	}
	if (existingSkillId && !UUID_RE.test(existingSkillId)) {
		throw new Error("--skill requires a skill UUID");
	}
	let plan: Plan | undefined;
	if (file) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			throw new Error(`cannot read plan file ${file}: ${errorText(error)}`);
		}
		plan = parsePlan(text);
	}
	const title =
		ctx.flow.title?.trim() ||
		plan?.manifest.name ||
		`flow-${
			(file ?? existingSkillId ?? "existing-skill")
				.split("/")
				.pop()
				?.replace(/\.[^.]+$/, "") ?? "adhoc"
		}`;
	const description =
		plan?.manifest.description ??
		(existingSkillId
			? "Existing executable skill started through the Tedix CLI."
			: "Ephemeral workflow authored by an external coding agent.");
	const params = collectParams(ctx.flow);
	const reason =
		ctx.flow.reason?.trim() ||
		`tedix flow run: ${existingSkillId ? "existing skill" : "ephemeral draft workflow"} "${title}"`;

	// The gateway provider owns draft policy, skill recording, tedi selection,
	// and workflow admission. The CLI contributes the local one-file manifest.
	const started = await flowCall(
		ctx,
		"flow.run",
		{
			...(plan
				? {
						source: plan.source,
						name: title,
						description,
						skillDoc: renderSkillMd(plan.manifest, title, description),
					}
				: { skillId: existingSkillId }),
			reason,
			...(Object.keys(params).length ? { params } : {}),
		},
		reason,
	);
	if (started.error) {
		printError(ctx, "starting the workflow failed", started.error);
		return FLOW_EXIT_FAIL;
	}
	const run = unwrap(started.value);
	const skillId = pickString(run, "skillId");
	const runId = pickString(run, "runId", "id");
	if (!skillId || !runId) {
		printError(ctx, "flow.run returned incomplete run identity", {
			message: JSON.stringify(started.value).slice(0, 400),
		});
		return FLOW_EXIT_FAIL;
	}

	if (!ctx.flow.watch) {
		if (ctx.json) {
			console.log(JSON.stringify({ skillId, runId, status: "queued" }));
		} else {
			console.log(
				`${green("started", ctx.color)} ${cyan(runId, ctx.color)}\n` +
					`${dim(`  skill  ${skillId}${plan ? " (draft)" : ""}`, ctx.color)}\n` +
					`${dim(`  watch  tedix flow status ${runId} --watch`, ctx.color)}`,
			);
		}
		return 0;
	}
	return watchRun(ctx, runId, { skillId });
}

/**
 * Poll one run to terminal and print only its bounded result.
 *
 * `flow.status` is the gateway-owned compact lifecycle projection. The step
 * timeline lives behind `flow inspect`; keeping it out of this loop prevents a
 * long run from growing the caller's context on every poll.
 */
async function watchRun(
	ctx: FlowContext,
	runId: string,
	extra: { skillId?: string } = {},
): Promise<number> {
	const sleep = ctx.sleep ?? sleepDefault;
	const now = ctx.now ?? Date.now;
	const horizonMs =
		(ctx.flow.watch && ctx.flow.watch > 0
			? ctx.flow.watch
			: DEFAULT_WATCH_SECONDS) * 1_000;
	const deadline = now() + horizonMs;
	let last: Record<string, unknown> = {};
	let status = "";

	while (now() < deadline) {
		const polled = await statusCall(ctx, runId);
		if (polled.error) {
			printError(ctx, "polling the run failed", polled.error);
			return FLOW_EXIT_FAIL;
		}
		last = unwrap(polled.value);
		status = (pickString(last, "status", "state") ?? "").toLowerCase();
		if (TERMINAL_STATUSES.has(status)) break;
		await sleep(WATCH_POLL_INTERVAL_MS);
	}

	if (!TERMINAL_STATUSES.has(status)) {
		if (ctx.json) {
			console.log(
				JSON.stringify({ runId, status: status || "unknown", timedOut: true }),
			);
		} else {
			console.error(
				yellow(
					`watch horizon expired with the run still ${status || "active"} — ` +
						`tedix flow status ${runId}`,
					ctx.color,
				),
			);
		}
		return FLOW_EXIT_WATCH_TIMEOUT;
	}

	const failed = status !== "completed";
	if (ctx.json) {
		console.log(
			JSON.stringify({
				runId,
				...(extra.skillId ? { skillId: extra.skillId } : {}),
				status,
				result: last.output ?? null,
				error: last.error ?? null,
			}),
		);
	} else {
		const heading = failed ? red(status, ctx.color) : green(status, ctx.color);
		console.log(`${heading} ${cyan(runId, ctx.color)}`);
		const durationMs = Number(last.durationMs ?? last.elapsedMs ?? 0);
		if (durationMs > 0) {
			console.log(dim(`  took   ${formatDuration(durationMs)}`, ctx.color));
		}
		const payload = last.output;
		if (payload !== undefined && payload !== null) {
			console.log(`\n${JSON.stringify(payload, null, 2)}`);
		}
		if (last.error) {
			console.error(`\n${errorText(last.error)}`);
		}
		if (failed) {
			console.error(dim(`\n  inspect  tedix flow inspect ${runId}`, ctx.color));
		}
	}
	return failed ? FLOW_EXIT_FAIL : 0;
}

/** `tedix flow status <runId>` — compact poll, optionally watching to terminal. */
async function statusFlow(ctx: FlowContext, runId: string): Promise<number> {
	if (!runId) throw new Error("Usage: tedix flow status <runId> [--watch]");
	if (ctx.flow.watch) return watchRun(ctx, runId);
	const polled = await statusCall(ctx, runId);
	if (polled.error) {
		printError(ctx, "reading run status failed", polled.error);
		return FLOW_EXIT_FAIL;
	}
	const row = unwrap(polled.value);
	const status = (
		pickString(row, "status", "state") ?? "unknown"
	).toLowerCase();
	if (ctx.json) {
		console.log(
			JSON.stringify({
				runId,
				status,
				result: row.output ?? null,
				error: row.error ?? null,
			}),
		);
		return TERMINAL_STATUSES.has(status) && status !== "completed"
			? FLOW_EXIT_FAIL
			: 0;
	}
	console.log(
		`${status === "completed" ? green(status, ctx.color) : status === "failed" ? red(status, ctx.color) : yellow(status, ctx.color)} ${cyan(runId, ctx.color)}`,
	);
	const payload = row.output;
	if (payload !== undefined && payload !== null) {
		console.log(`\n${JSON.stringify(payload, null, 2)}`);
	}
	if (row.error) {
		console.error(`\n${errorText(row.error)}`);
	}
	return TERMINAL_STATUSES.has(status) && status !== "completed"
		? FLOW_EXIT_FAIL
		: 0;
}

/**
 * `tedix flow inspect <runId>` — the evidence view.
 *
 * Deliberately a SEPARATE verb from the watch loop. `flow.inspect` composes
 * steps, tool-call receipts, artifacts, and warnings; pulling that on every
 * poll would reintroduce exactly the context growth this verb exists to avoid.
 */
async function inspectFlow(ctx: FlowContext, runId: string): Promise<number> {
	if (!runId) throw new Error("Usage: tedix flow inspect <runId>");
	const result = await flowCall(ctx, "flow.inspect", { runId });
	if (result.error) {
		printError(ctx, "inspecting the run failed", result.error);
		return FLOW_EXIT_FAIL;
	}
	console.log(JSON.stringify(result.value, null, ctx.json ? 0 : 2));
	return 0;
}

/** `tedix flow list` — recent runs for the acting tedi. */
async function listFlows(ctx: FlowContext): Promise<number> {
	const result = await flowCall(ctx, "flow.list", {
		limit: ctx.flow.limit && ctx.flow.limit > 0 ? ctx.flow.limit : 15,
	});
	if (result.error) {
		printError(ctx, "listing runs failed", result.error);
		return FLOW_EXIT_FAIL;
	}
	const value = result.value as Record<string, unknown> | undefined;
	const rows = (value?.runs ??
		value?.entries ??
		value?.data ??
		value) as unknown;
	if (ctx.json) {
		console.log(JSON.stringify(rows ?? []));
		return 0;
	}
	if (!Array.isArray(rows) || rows.length === 0) {
		console.log(dim("no recent runs", ctx.color));
		return 0;
	}
	for (const row of rows as Array<Record<string, unknown>>) {
		const status = String(row.status ?? "?");
		const paint =
			status === "completed"
				? green(status, ctx.color)
				: status === "failed"
					? red(status, ctx.color)
					: yellow(status, ctx.color);
		console.log(
			`${paint.padEnd(12)} ${cyan(String(row.runId ?? row.id ?? "?"), ctx.color)} ${dim(String(row.skillSlug ?? ""), ctx.color)}`,
		);
	}
	return 0;
}

/** `tedix flow tools` — exact workflow-visible tedi method inventory. */
async function listFlowTools(ctx: FlowContext): Promise<number> {
	const result = await flowCall(ctx, "flow.tools", {});
	if (result.error) {
		printError(ctx, "listing workflow tools failed", result.error);
		return FLOW_EXIT_FAIL;
	}
	const value = (result.value ?? {}) as Record<string, unknown>;
	if (ctx.json) {
		console.log(JSON.stringify(value));
		return 0;
	}
	const methods = Array.isArray(value.methods) ? value.methods : [];
	console.log(
		`${green(String(value.tediSlug ?? "tedi"), ctx.color)} workflow methods (${methods.length})`,
	);
	for (const method of methods) console.log(`  ${String(method)}`);
	console.log(
		dim(
			"Declare only these names under capabilities.mcp.tedi; use discover.search for every other namespace.",
			ctx.color,
		),
	);
	return 0;
}

function printError(
	ctx: FlowContext,
	headline: string,
	error: FlowError,
): void {
	if (ctx.json) {
		console.error(JSON.stringify({ ok: false, headline, ...error }));
		return;
	}
	console.error(
		`${red(headline, ctx.color)}${error.code ? dim(` [${error.code}]`, ctx.color) : ""}\n  ${error.message}`,
	);
}

export function flowUsage(): string {
	return [
		"tedix flow — run ephemeral skill workflows off your context window",
		"",
		"Verbs:",
		"  tedix flow run (--file <plan.ts> | --skill <uuid>) [--watch[=secs]] [--param k=v] [--params '<json>']",
		"  tedix flow status <runId> [--watch[=secs]]",
		"  tedix flow inspect <runId>",
		"  tedix flow list [--limit <n>]",
		"  tedix flow tools [--as <tediSlug>]",
		"",
		"Options:",
		"  --as <tediSlug>   Tedi namespace that executes the run (default: gateway-selected)",
		"  --title <text>    Override the manifest-derived skill title",
		"  --skill <uuid>    Run an existing executable skill; no draft is created",
		"  --reason <text>   Audit reason recorded with the run authorization",
		"  --json            Machine-readable output",
		"",
		"Plan file shape — source and capability manifest in ONE file:",
		"",
		"  /* tedix",
		"  name: audit-tool-annotations",
		"  description: Check every app tool's annotations against its handler.",
		"  capabilities:",
		"    mcp:",
		"      app_config: [list_app_tools]",
		"  */",
		"  export default {",
		"    async run(event, step, env) {",
		"      const tools = await step.do('list', () =>",
		"        env.MCP.app_config.list_app_tools({ limit: 200 }));",
		"      return { count: tools.length };  // keep the RETURN small",
		"    },",
		"  };",
		"",
		"The return value is what enters your context. Put bulk output in an",
		"artifact (record_artifact) and return the reference, not the payload.",
		"env.MCP calls already return the normalized tool value: structuredContent",
		"when present, otherwise JSON-parsed text, plain text, or non-text content.",
		"Do not read .content/.structuredContent or add your own envelope unwrapping.",
		"Before declaring capabilities.mcp.tedi, run `tedix flow tools`. The",
		"workflow bridge exposes a curated tedi inventory that can be narrower",
		"than the full Code Mode catalog. Use discover.search for other namespaces.",
		"",
		"File-authored runs become draft skills: they execute explicitly, never fire",
		"on a schedule, and auto-archive after 14 days unused. --skill runs the",
		"existing definition without creating or changing a skill.",
	].join("\n");
}

export async function runFlowCommand(
	args: string,
	ctx: FlowContext,
): Promise<number> {
	const trimmed = args.trim();
	const [verb = "", ...rest] = trimmed.split(/\s+/).filter(Boolean);
	const target = rest[0] ?? "";
	try {
		switch (verb) {
			case "":
			case "help":
				console.log(flowUsage());
				return 0;
			case "run":
				return await runFlow(ctx);
			case "status":
				return await statusFlow(ctx, target);
			case "inspect":
				return await inspectFlow(ctx, target);
			case "list":
				return await listFlows(ctx);
			case "tools":
				return await listFlowTools(ctx);
			default:
				console.error(
					errorText(
						`unknown flow verb "${verb}" — expected run, status, inspect, list, or tools`,
					),
				);
				return FLOW_EXIT_FAIL;
		}
	} catch (error) {
		console.error(errorText(error));
		return FLOW_EXIT_FAIL;
	}
}
