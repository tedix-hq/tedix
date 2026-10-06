import type { TerminalOutput } from "./format";
import { normalizeCodeResult } from "./code-result";
import { streamHomeRunEvents } from "./events";
import type { ColorMode } from "./terminal";
import {
	dim,
	emitEventNdjson,
	green,
	type InspectBundle,
	type InspectViewOptions,
	printInspectBundle,
	printReadPayload,
	formatSummary,
	printUnknownPayload,
	renderEventPretty,
	yellow,
} from "./format";
import type { HomeRunSummary, TedixHomeClient } from "./home-client";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	delegatedChildStopFromPayload,
	isPendingHomeApproval,
	isSettledHomeStatus,
	summarizeHomePayload,
} from "./home-client";

export type GoalLoopEvaluator = "deterministic" | "adversarial" | "work_items";

/**
 * MCP Home operations are injected so command handlers stay free of transport
 * plumbing and the registry has no import cycle back into the entrypoint.
 */
export interface HomeOps {
	childEvidence(input: {
		childRunId: string;
		delegatedTediId: string;
	}): Promise<unknown>;
	childTree(conversationId: string): Promise<unknown>;
	inspect(homeRunId: string): Promise<InspectBundle>;
	send(content: string): Promise<HomeRunSummary>;
}

export interface CommandContext {
	output?: TerminalOutput;
	channel?: string;
	client: TedixHomeClient;
	color: ColorMode;
	conversationId: string;
	cursor?: string;
	offset?: string;
	follow: boolean;
	goalBudgetUsd?: number;
	goalCondition?: string;
	goalEvaluator?: GoalLoopEvaluator;
	goalMaxTurns?: number;
	goalObjectiveId?: string;
	harnessVersionId?: string;
	includeArchived: boolean;
	inspectView?: InspectViewOptions;
	json: boolean;
	limit?: number;
	ops: HomeOps;
	/**
	 * Whether this invocation waits for settlement (true/undefined) or was an
	 * explicit `--no-poll` fire-and-forget dispatch (false). Drives the exit
	 * code for a run that is still executing when the CLI stops waiting.
	 */
	poll?: boolean;
	pollIntervalMs: number;
	search?: string;
}

export type CommandHandler = (
	args: string,
	ctx: CommandContext,
) => Promise<number>;

export interface CommandSpec {
	aliases?: string[];
	/** Positional argument shape for help, e.g. "<homeRunId> [note]". */
	argHint?: string;
	handler: CommandHandler;
	name: string;
	summary: string;
}

export function firstWord(text: string): [string, string] {
	const trimmed = text.trim();
	const [first = "", ...rest] = trimmed.split(/\s+/);
	return [first, rest.join(" ").trim()];
}

/**
 * Map a settled run status to a process exit code so automation can detect
 * outcomes: 0 success, 2 failed/canceled. A run still executing when the poll
 * budget expires exits EXIT_RUN_UNSETTLED (3) via reportSendResult instead.
 */
export function exitCodeForStatus(status: string | undefined): number {
	if (status === "failed") return 2;
	if (status === "canceled") return 2;
	return 0;
}

/**
 * Exit code for a polled turn whose run was still running/queued server-side
 * when the poll budget (`--poll-timeout-ms`) expired. Distinct from 2
 * (failed/canceled) so automation can tell "still working — follow up with
 * `tedix run <id>`" from a genuine failure. `--no-poll` dispatches keep 0.
 */
export const EXIT_RUN_UNSETTLED = 3;

async function handleRun(args: string, ctx: CommandContext): Promise<number> {
	const [homeRunId] = firstWord(args);
	if (!homeRunId) throw new Error("run requires a homeRunId");
	const payload = await ctx.client.readHomeRun(homeRunId);
	printRunPayload(payload, ctx);
	// Reading a run keeps its read-success exit contract, regardless of run status.
	return 0;
}

export function printRunPayload(payload: unknown, ctx: CommandContext): void {
	const summary = summarizeHomePayload(payload);
	if (ctx.json || !summary) {
		printReadPayload(payload, ctx.json, ctx.output);
		return;
	}
	const output = ctx.output ?? console;
	output.log(`Run ${summary.homeRunId}: ${summary.status ?? "unknown"}`);
	const result = formatSendResult(summary, { ...ctx, poll: false });
	for (const line of result.stdout) output.log(line);
	for (const line of result.stderr) output.error(line);
}

async function handleInspect(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	const [homeRunId] = firstWord(args);
	if (!homeRunId) throw new Error("inspect requires a homeRunId");
	printInspectBundle(
		await ctx.ops.inspect(homeRunId),
		ctx.json,
		ctx.inspectView,
		ctx.output,
	);
	return 0;
}

async function handleChildEvidence(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	const [delegatedTediId, rest] = firstWord(args);
	const [childRunId] = firstWord(rest);
	if (!delegatedTediId || !childRunId) {
		throw new Error("child-evidence requires a delegatedTediId and childRunId");
	}
	printReadPayload(
		await ctx.ops.childEvidence({ childRunId, delegatedTediId }),
		ctx.json,
		ctx.output,
	);
	return 0;
}

async function handleChildTree(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	const conversationId = args.trim() || ctx.conversationId;
	printReadPayload(
		await ctx.ops.childTree(conversationId),
		ctx.json,
		ctx.output,
	);
	return 0;
}

async function handleRuns(args: string, ctx: CommandContext): Promise<number> {
	printReadPayload(
		await ctx.client.readHomeRunSet({
			conversationId: args.trim() || ctx.conversationId,
			limit: ctx.limit ?? 20,
		}),
		ctx.json,
		ctx.output,
	);
	return 0;
}

async function handleMessages(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	printReadPayload(
		await ctx.client.readHomeMessages({
			conversationId: args.trim() || ctx.conversationId,
			limit: ctx.limit ?? 20,
			...(ctx.cursor ? { cursor: ctx.cursor } : {}),
		}),
		ctx.json,
		ctx.output,
	);
	return 0;
}

async function handleConversations(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	const search = args.trim() || ctx.search;
	printReadPayload(
		await ctx.client.listHomeConversations({
			includeArchived: ctx.includeArchived,
			limit: ctx.limit ?? 20,
			...(ctx.channel ? { channel: ctx.channel } : {}),
			...(ctx.cursor ? { cursor: ctx.cursor } : {}),
			...(search ? { search } : {}),
		}),
		ctx.json,
		ctx.output,
	);
	return 0;
}

async function handleRename(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	const [conversationId, title] = firstWord(args);
	if (!conversationId || !title.trim()) {
		throw new Error("rename requires a conversationId and a title");
	}
	printUnknownPayload(
		await ctx.client.renameConversation({
			conversationId,
			title: title.trim(),
		}),
		ctx.json,
		ctx.output,
	);
	return 0;
}

function pinHandler(pinned: boolean): CommandHandler {
	return async (args, ctx) => {
		const conversationId = args.trim();
		if (!conversationId) {
			throw new Error(`${pinned ? "pin" : "unpin"} requires a conversationId`);
		}
		printUnknownPayload(
			await ctx.client.pinConversation({ conversationId, pinned }),
			ctx.json,
			ctx.output,
		);
		return 0;
	};
}

async function handleDelete(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	const conversationId = args.trim();
	if (!conversationId) throw new Error("delete requires a conversationId");
	printUnknownPayload(
		await ctx.client.deleteConversation({ conversationId }),
		ctx.json,
		ctx.output,
	);
	return 0;
}

async function handleTraces(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	const runId = args.trim();
	if (runId) {
		printReadPayload(
			await ctx.client.readHomeTrace(runId),
			ctx.json,
			ctx.output,
		);
		return 0;
	}
	printReadPayload(
		await ctx.client.listKernelTraceBundles({
			limit: ctx.limit ?? 20,
			...(ctx.harnessVersionId
				? { harnessVersionId: ctx.harnessVersionId }
				: {}),
		}),
		ctx.json,
		ctx.output,
	);
	return 0;
}

/**
 * How long an approval waits for the work it just released.
 *
 * A delegated turn typically takes under a minute end to end, so a budget
 * has to clear a minute comfortably without hanging a terminal forever. Past
 * it the run is reported as unsettled with the command to resume — the same
 * contract `ask` uses, never silence.
 */
const APPROVAL_FOLLOW_BUDGET_MS = 180_000;

function approvalHandler(decision: "approve" | "reject"): CommandHandler {
	return async (args, ctx) => {
		const [homeRunId, note] = firstWord(args);
		if (!homeRunId) throw new Error(`${decision} requires a homeRunId`);
		printUnknownPayload(
			await ctx.client.respondHomeApproval({
				decision,
				homeRunId,
				note: note || `${decision} from tedix-cli`,
			}),
			ctx.json,
			ctx.output,
		);
		// Approving DISPATCHES work; the answer lands asynchronously, long after
		// this ack. Ending here is why an operator could approve a delegation,
		// have the tedi run three model rounds and be billed for them, and see
		// nothing: `status` reports the run SET (what is in flight) and the answer
		// lives in the conversation, which nothing read back. `cancel` already
		// follows its delegated child for exactly this reason.
		//
		// Rejecting releases nothing, so there is nothing to wait for.
		if (decision !== "approve" || ctx.poll === false) return 0;
		return followApprovedRun(homeRunId, ctx);
	};
}

/**
 * Wait for an approved run to settle and report it, or say where it went.
 *
 * Polls rather than streams: an approval is a one-shot shell command, and the
 * event stream is the `run --follow` surface. Any read failure ends the wait
 * quietly — the approval itself already succeeded and must not be reported as
 * failed because a follow-up read did not.
 */
async function followApprovedRun(
	homeRunId: string,
	ctx: CommandContext,
): Promise<number> {
	const deadline = Date.now() + APPROVAL_FOLLOW_BUDGET_MS;
	let summary: HomeRunSummary | null = null;
	try {
		while (Date.now() < deadline) {
			summary = summarizeHomePayload(await ctx.client.readHomeRun(homeRunId));
			// A payload this parser cannot summarize will not start summarizing on
			// the next tick either — waiting out the whole budget for it would
			// hang the terminal on a shape change.
			if (!summary) break;
			if (isSettledHomeStatus(summary.status)) break;
			await new Promise((resolve) =>
				setTimeout(resolve, Math.max(500, ctx.pollIntervalMs)),
			);
		}
	} catch {
		return 0;
	}
	if (!summary) return 0;
	const result = formatSendResult(summary, ctx);
	const out = ctx.output ?? console;
	for (const line of result.stdout) out.log(line);
	for (const line of result.stderr) (ctx.output ?? console).error(line);
	return result.exitCode;
}

async function handleRetry(args: string, ctx: CommandContext): Promise<number> {
	const [workItemId] = firstWord(args);
	if (!workItemId) throw new Error("retry requires a workItemId");
	printUnknownPayload(
		await ctx.client.retryDelegation(workItemId),
		ctx.json,
		ctx.output,
	);
	return 0;
}

async function handleCancel(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	const [homeRunId, reason] = firstWord(args);
	if (!homeRunId) throw new Error("cancel requires a homeRunId");
	const canceled = await ctx.client.cancelHomeRun({
		homeRunId,
		reason: reason || "canceled from tedix-cli",
	});
	if (ctx.json) {
		printUnknownPayload(canceled, true, ctx.output);
	} else {
		(ctx.output ?? console).log(`Cancel requested for ${homeRunId}.`);
	}
	// A cancel of a DELEGATED run propagates a stop to the live child, but that
	// `delegatedChildStop` outcome lands in run.metadata ASYNCHRONOUSLY — after the
	// cancel ack — so the ack alone can't tell the operator whether the child was
	// actually stopped. Read the run once; only if it is a delegation do we poll
	// briefly and surface the outcome (closing the loop without a manual `run`
	// poll). Non-delegated cancels and --json skip this entirely (no delay).
	if (!ctx.json) {
		const first = await ctx.client.readHomeRun(homeRunId);
		const summary = summarizeHomePayload(first);
		const isDelegation = Boolean(
			summary?.delegatedTediId || summary?.childRunId,
		);
		if (isDelegation) {
			let stop = delegatedChildStopFromPayload(first);
			for (let attempt = 0; !stop && attempt < 3; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 1200));
				stop = delegatedChildStopFromPayload(
					await ctx.client.readHomeRun(homeRunId),
				);
			}
			if (stop) {
				const paint = stop.outcome === "succeeded" ? green : yellow;
				const child = stop.childRunId
					? ` ${dim(stop.childRunId, ctx.color)}`
					: "";
				(ctx.output ?? console).log(
					`  ${dim("↳ delegated child stop:", ctx.color)} ${paint(stop.outcome, ctx.color)}${child}`,
				);
			}
		}
	}
	return 0;
}

async function handleSteer(args: string, ctx: CommandContext): Promise<number> {
	const [homeRunId, instruction] = firstWord(args);
	if (!homeRunId || !instruction) {
		throw new Error("steer requires a homeRunId and instruction");
	}
	printUnknownPayload(
		await ctx.client.steerHomeRun({ homeRunId, instruction }),
		ctx.json,
		ctx.output,
	);
	return 0;
}

function inlineGoalParts(args: string): {
	condition: string;
	content: string;
} {
	const separator = args.indexOf("::");
	if (separator < 0) {
		throw new Error(
			"goal requires <condition> :: <prompt> in chat, or --condition <text> outside chat",
		);
	}
	return {
		condition: args.slice(0, separator).trim(),
		content: args.slice(separator + 2).trim(),
	};
}

function workflowIdFromPayload(payload: unknown): string | null {
	if (!isRecord(payload)) return null;
	if (typeof payload.workflowId === "string") return payload.workflowId;
	const data = isRecord(payload.data) ? payload.data : null;
	return data && typeof data.workflowId === "string" ? data.workflowId : null;
}

function printGoalStatusPayload(
	payload: unknown,
	json: boolean,
	sink: TerminalOutput = console,
): void {
	if (json || !isRecord(payload)) {
		printUnknownPayload(payload, json, sink);
		return;
	}
	const id = typeof payload.id === "string" ? payload.id : "(unknown)";
	const status =
		typeof payload.status === "string" ? payload.status : "unknown";
	sink.log(`Goal ${id} · ${status}`);
	const output = isRecord(payload.output) ? payload.output : null;
	if (!output) return;
	const met =
		output.met === true ? "met" : output.met === false ? "not met" : "";
	const stop = typeof output.stop === "string" ? output.stop : "";
	const turns = typeof output.turns === "number" ? output.turns : null;
	const totalCostUsd =
		typeof output.totalCostUsd === "number" ? output.totalCostUsd : null;
	sink.log(
		`  result: ${[
			met,
			stop,
			turns === null ? "" : `${turns} turn${turns === 1 ? "" : "s"}`,
			totalCostUsd === null ? "" : `$${totalCostUsd.toFixed(4)}`,
		]
			.filter(Boolean)
			.join(" · ")}`,
	);
	const evidence = Array.isArray(output.evidence) ? output.evidence : [];
	for (const value of evidence) {
		if (!isRecord(value)) continue;
		const turn = typeof value.turn === "number" ? `turn ${value.turn}` : "turn";
		const parts = [
			turn,
			typeof value.status === "string" ? value.status : "",
			typeof value.routeKind === "string" ? value.routeKind : "",
			typeof value.verdict === "string" ? value.verdict : "",
			typeof value.runId === "string" ? value.runId : "",
		].filter(Boolean);
		sink.log(`  ${parts.join(" · ")}`);
	}
}

/** Start the deployed, governed L2 goal loop through gateway-native Code Mode. */
async function handleGoal(args: string, ctx: CommandContext): Promise<number> {
	const inline = ctx.goalCondition ? null : inlineGoalParts(args);
	const condition = (ctx.goalCondition ?? inline?.condition ?? "").trim();
	const content = (inline?.content ?? args).trim();
	if (!condition || !content) {
		throw new Error("goal requires both a completion condition and a prompt");
	}
	const maxTurns = ctx.goalMaxTurns ?? 3;
	if (maxTurns < 1 || maxTurns > 8) {
		throw new Error("goal max turns must be between 1 and 8");
	}
	const budgetUsd = ctx.goalBudgetUsd ?? 0.25;
	const evaluator = ctx.goalEvaluator ?? "adversarial";
	if (evaluator === "work_items" && !ctx.goalObjectiveId) {
		throw new Error(
			"goal evaluator work_items requires --objective-id <objectiveId>",
		);
	}
	const input = {
		content,
		condition,
		maxTurns,
		budgetUsd,
		evaluator,
		conversationId: ctx.conversationId,
		...(ctx.goalObjectiveId ? { objectiveId: ctx.goalObjectiveId } : {}),
	};
	const result = await ctx.client.runCode(
		`async () => await kernel.start_goal_loop(${JSON.stringify(input)})`,
	);
	const value = normalizeCodeResult(result).value;
	if (ctx.json) {
		printUnknownPayload(value, true, ctx.output);
		return 0;
	}
	const workflowId = workflowIdFromPayload(value);
	if (!workflowId) {
		printUnknownPayload(value, false, ctx.output);
		return 0;
	}
	(ctx.output ?? console).log(`Goal loop started: ${workflowId}`);
	(ctx.output ?? console).log(`  inspect with: /goal-status ${workflowId}`);
	(ctx.output ?? console).log(
		`  ceilings: ${maxTurns} turn(s) · $${budgetUsd.toFixed(2)} · ${evaluator} evaluator`,
	);
	return 0;
}

/** Read one goal-loop Workflow without exposing the widget rendering envelope. */
async function handleGoalStatus(
	args: string,
	ctx: CommandContext,
): Promise<number> {
	const [workflowId] = firstWord(args);
	if (!workflowId) throw new Error("goal-status requires a workflowId");
	const result = await ctx.client.runCode(
		`async () => await workflows.get_workflow_status({ workflowId: ${JSON.stringify(workflowId)} })`,
	);
	const value = normalizeCodeResult(result).value;
	const payload = isRecord(value) && value.data ? value.data : value;
	printGoalStatusPayload(payload, ctx.json, ctx.output);
	return 0;
}

/**
 * Incrementally tail a Home run's offset-based kernel event stream.
 * `--no-follow` reads the current events once; otherwise it follows until the
 * run settles or the operator interrupts (Ctrl-C -> exit 130).
 */
async function handleTail(args: string, ctx: CommandContext): Promise<number> {
	const [homeRunId, rest] = firstWord(args);
	if (!homeRunId) throw new Error("tail requires a homeRunId");
	// Optional child scope: `tail <homeRunId> <delegatedTediId> <childRunId>`.
	const [delegatedTediId, childRest] = firstWord(rest);
	const [childRunId] = firstWord(childRest);
	const controller = new AbortController();
	const onSignal = () => controller.abort();
	process.on("SIGINT", onSignal);
	const stream = streamHomeRunEvents(
		ctx.client,
		{
			homeRunId,
			...(delegatedTediId && childRunId ? { childRunId, delegatedTediId } : {}),
			...(ctx.offset ? { offset: ctx.offset } : {}),
		},
		{
			live: ctx.follow,
			pollIntervalMs: ctx.pollIntervalMs,
			signal: controller.signal,
		},
	);
	try {
		for await (const event of stream) {
			if (ctx.json)
				emitEventNdjson(
					event,
					ctx.output ? (line) => ctx.output!.log(line) : undefined,
				);
			else (ctx.output ?? console).log(renderEventPretty(event, ctx.color));
		}
	} finally {
		process.off("SIGINT", onSignal);
	}
	if (controller.signal.aborted) return 130;
	return exitCodeForStatus(stream.status);
}

export const COMMANDS: CommandSpec[] = [
	{
		argHint: "<homeRunId>",
		handler: handleRun,
		name: "run",
		summary: "Read one Home run",
	},
	{
		argHint: "<homeRunId>",
		handler: handleInspect,
		name: "inspect",
		summary: "Read a Home run plus traces, child tree, and child evidence",
	},
	{
		argHint: "<homeRunId>",
		handler: handleTail,
		name: "tail",
		summary: "Stream a Home run's events (--no-follow for a snapshot)",
	},
	{
		argHint: "<delegatedTediId> <childRunId>",
		handler: handleChildEvidence,
		name: "child-evidence",
		summary: "Read events and artifacts for one delegated child run",
	},
	{
		argHint: "[conversationId]",
		handler: handleChildTree,
		name: "child-tree",
		summary: "Inspect delegated child runs in a Home conversation",
	},
	{
		argHint: "[conversationId]",
		handler: handleRuns,
		name: "runs",
		summary: "Read the Home run set for a conversation",
	},
	{
		argHint: "[conversationId]",
		handler: handleMessages,
		name: "messages",
		summary: "Read transcript messages",
	},
	{
		argHint: "[search]",
		handler: handleConversations,
		name: "conversations",
		summary: "List or search Home conversations",
	},
	{
		argHint: "<conversationId> <title>",
		handler: handleRename,
		name: "rename",
		summary: "Rename a Home conversation (shows in Tedix OS + CLI)",
	},
	{
		argHint: "<conversationId>",
		handler: pinHandler(true),
		name: "pin",
		summary: "Pin a Home conversation to the top (org-shared)",
	},
	{
		argHint: "<conversationId>",
		handler: pinHandler(false),
		name: "unpin",
		summary: "Unpin a Home conversation",
	},
	{
		argHint: "<conversationId>",
		handler: handleDelete,
		name: "delete",
		summary:
			"Permanently delete a Home conversation and cancel its active runs",
	},
	{
		argHint: "[homeRunId]",
		handler: handleTraces,
		name: "traces",
		summary: "Read a converged run trace or list trace bundles",
	},
	{
		argHint: "<homeRunId> [note]",
		handler: approvalHandler("approve"),
		name: "approve",
		summary: "Approve a waiting Home run",
	},
	{
		argHint: "<homeRunId> [note]",
		handler: approvalHandler("reject"),
		name: "reject",
		summary: "Reject a waiting Home run",
	},
	{
		argHint: "<homeRunId> [reason]",
		handler: handleCancel,
		name: "cancel",
		summary: "Cancel a Home run",
	},
	{
		argHint: "<workItemId>",
		handler: handleRetry,
		name: "retry",
		summary: "Retry a blocked delegated Work Item",
	},
	{
		argHint: "<homeRunId> <instruction>",
		handler: handleSteer,
		name: "steer",
		summary: "Add operator steering to an active run",
	},
	{
		argHint: "<condition> :: <prompt>",
		handler: handleGoal,
		name: "goal",
		summary: "Start a bounded goal loop (defaults: 3 turns, $0.25)",
	},
	{
		argHint: "<workflowId>",
		handler: handleGoalStatus,
		name: "goal-status",
		summary: "Read a goal loop's status and terminal evidence",
	},
];

const BY_NAME: Map<string, CommandSpec> = new Map(
	COMMANDS.flatMap((spec) =>
		[spec.name, ...(spec.aliases ?? [])].map(
			(name) => [name, spec] as [string, CommandSpec],
		),
	),
);

export function findCommand(name: string): CommandSpec | undefined {
	return BY_NAME.get(name);
}

/** Slash-command names (for interactive tab-completion). */
export function commandNames(): string[] {
	return [...COMMANDS.map((spec) => `/${spec.name}`), "/help", "/exit"];
}

/** Registry-driven interactive help (kept in sync with COMMANDS, no drift). */
export function formatCommandHelp(): string {
	// Pad to a column, but always keep ≥2 spaces — a long invocation (e.g.
	// /child-evidence <delegatedTediId> <childRunId>) used to collide with its
	// summary when it overflowed padEnd(38).
	const pad = (s: string) => (s.length >= 38 ? `${s}  ` : s.padEnd(38));
	const rows = COMMANDS.map((spec) => {
		const invocation = `/${spec.name}${spec.argHint ? ` ${spec.argHint}` : ""}`;
		return `  ${pad(invocation)}${spec.summary}`;
	});
	return [
		"Commands (also usable as `tedix <name>` outside chat):",
		...rows,
		`  ${pad("/help")}Show this list`,
		`  ${pad("/exit")}Quit (or Ctrl-D)`,
	].join("\n");
}

interface InteractiveCommandSpec {
	argHint?: string;
	name: string;
	summary: string;
}

/**
 * Commands with semantics owned by the Ink REPL rather than the generic CLI
 * registry. Keeping them declarative makes typeahead and help agree, while
 * avoiding collisions with `/runs` and `/rename` from the non-interactive CLI.
 */
const INTERACTIVE_COMMANDS: readonly InteractiveCommandSpec[] = [
	{ name: "help", summary: "Show this command reference" },
	{ name: "exit", summary: "Quit after active runs settle" },
	{ argHint: "[prefix]", name: "runs", summary: "List in-flight runs" },
	{
		argHint: "compact|full|errors",
		name: "activity",
		summary: "Set nested tool and delegation detail",
	},
	{
		argHint: "<message>",
		name: "parallel",
		summary: "Start an explicit sibling Home run",
	},
	{ name: "wait", summary: "Wait for in-flight runs to settle" },
	{ name: "workspaces", summary: "List logged-in workspaces" },
	{
		argHint: "[workspace]",
		name: "use",
		summary: "Select a workspace for the next launch",
	},
	{ argHint: "[search]", name: "sessions", summary: "List Home conversations" },
	{
		argHint: "<n|id|name>",
		name: "resume",
		summary: "Switch Home conversation",
	},
	{ argHint: "[name]", name: "new", summary: "Start fresh Home context" },
	{ argHint: "<title>", name: "rename", summary: "Rename this conversation" },
	{
		argHint: "[focus]",
		name: "compact",
		summary: "Carry a focused brief into a fresh session",
	},
];

const INTERACTIVE_OVERRIDES = new Set(["runs", "rename"]);

function formatInteractiveRows(
	rows: readonly InteractiveCommandSpec[],
): string[] {
	return rows.flatMap((row) => {
		const invocation = `/${row.name}${row.argHint ? ` ${row.argHint}` : ""}`;
		const inline = `  ${invocation.padEnd(34)}${row.summary}`;
		return inline.length <= 78
			? [inline]
			: [`  ${invocation}`, `      ${row.summary}`];
	});
}

/** TUI menu data from the same command definitions as its help. */
export function interactiveSlashCommands(): Array<{
	argHint?: string;
	description: string;
	name: string;
	source: "home" | "interactive";
}> {
	return [
		...INTERACTIVE_COMMANDS.map(({ argHint, name, summary }) => ({
			...(argHint ? { argHint } : {}),
			description: summary,
			name,
			source: "interactive" as const,
		})),
		...COMMANDS.filter((spec) => !INTERACTIVE_OVERRIDES.has(spec.name)).map(
			({ argHint, name, summary }) => ({
				...(argHint ? { argHint } : {}),
				description: summary,
				name,
				source: "home" as const,
			}),
		),
	];
}

/** Focused, collision-free command reference for the interactive Ink REPL. */
export function formatInteractiveCommandHelp(): string {
	const homeCommands = COMMANDS.filter(
		(spec) => !INTERACTIVE_OVERRIDES.has(spec.name),
	).map(({ argHint, name, summary }) => ({ argHint, name, summary }));
	return [
		"Interactive commands:",
		...formatInteractiveRows(INTERACTIVE_COMMANDS),
		"",
		"Choosing a surface:",
		"  Stay here (Home) for durable conversations, rationale, delegation,",
		"  and approvals. Ask Home to discover and use tenant tools, skills, resources,",
		"  or prompts when available.",
		"  Use `tedix code '<js>'` for stateless gateway calls; start with",
		"  discover.search({ query, limit: 1, includeParameters: true }) for one exact schema.",
		"  Use `tedix flow run --file <plan.ts> --watch` for roughly 10+ tool steps.",
		"",
		"Home inspection and control:",
		...formatInteractiveRows(homeCommands),
	].join("\n");
}

/**
 * Format a settled or waiting send result without writing to the terminal.
 * Shell and interactive callers choose where to emit the same output.
 */
export function formatSendResult(
	summary: HomeRunSummary,
	ctx: Pick<CommandContext, "json" | "color" | "poll">,
): { stdout: string[]; stderr: string[]; exitCode: number } {
	const stdout = formatSummary(summary, ctx.json, ctx.color);
	const stderr: string[] = [];
	// A propose_tool_write run can COMPLETE while internally declining the write —
	// the answer text reads like the draft was made, but nothing was. Flag it and
	// exit non-zero so a human isn't misled and automation can detect it.
	if (summary.writeDeclined) {
		if (!ctx.json) {
			const { stage, detail } = summary.writeDeclined;
			stderr.push(
				`⚠ Write not performed — declined at "${stage}"${detail ? ` (${detail})` : ""}. Nothing was created or sent.`,
			);
		}
		return { stdout, stderr, exitCode: 2 };
	}
	// A delegation that needs approval parks as a completed Home recommendation,
	// not a raw approval row. Tell the operator how to act on the run metadata.
	if (isPendingHomeApproval(summary) && !ctx.json) {
		stdout.push(
			`This delegation needs your approval before it dispatches — run: tedix approve ${summary.homeRunId}`,
		);
	}
	if (!isSettledHomeStatus(summary.status)) {
		// The run is still executing server-side (poll budget expired, or an
		// explicit --no-poll dispatch). Say so explicitly — never end as if the
		// last printed text were the final answer.
		const notice = `Run ${summary.homeRunId} is still ${
			summary.status ?? "running"
		} on the server — this is not the final answer. Follow up with: tedix run ${summary.homeRunId}`;
		// Fix #8 pattern: human notices go to stderr in --json mode so they never
		// corrupt the JSON stdout stream.
		if (ctx.json) stderr.push(notice);
		else stdout.push(notice);
		// Exit 3 only when the caller actually waited for settlement; --no-poll is
		// a deliberate fire-and-forget, so a successful dispatch stays 0.
		return {
			stdout,
			stderr,
			exitCode: ctx.poll === false ? 0 : EXIT_RUN_UNSETTLED,
		};
	}
	return { stdout, stderr, exitCode: exitCodeForStatus(summary.status) };
}

export function reportSendResult(
	summary: HomeRunSummary,
	ctx: Pick<CommandContext, "json" | "color" | "poll" | "output">,
): number {
	const result = formatSendResult(summary, ctx);
	for (const line of result.stdout) (ctx.output ?? console).log(line);
	for (const line of result.stderr) (ctx.output ?? console).error(line);
	return result.exitCode;
}
