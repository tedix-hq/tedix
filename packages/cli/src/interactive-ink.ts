import { isAuthError, isConnectionError } from "./operator/runtime-errors";
/**
 * ink-based interactive REPL (TTY): the Static-transcript chat surface, its
 * non-blocking background settler, approval flow, and session management.
 * Extracted verbatim from index.ts.
 */

import type { RenderOptions } from "ink";
import { StatusSpinner } from "./activity";
import { resolveWorkspaceName } from "./auth-resolve";
import { gatewayHost, INTERACTIVE_KEY_HINTS, renderBanner } from "./banner";
import {
	type CommandContext,
	findCommand,
	firstWord,
	formatInteractiveCommandHelp,
	interactiveSlashCommands,
	formatSendResult,
	printRunPayload,
} from "./commands";
import { approvalScopeKey, expandFileMentions } from "./composer";
import {
	ConversationPoller,
	parseHomeMessagesPayload,
} from "./conversation-poller";
import {
	DEFAULT_WORKSPACE,
	getCurrentWorkspace,
	listWorkspaces,
	setCurrentWorkspace,
} from "./credential-store";
import { type TerminalOutput, errorText } from "./format";
import type { ColorMode } from "./terminal";
import {
	DEFAULT_TEDIX_MCP_URL,
	type HomeRunSummary,
	isPendingHomeApproval,
	isSettledHomeStatus,
	summarizeHomePayload,
	type TedixHomeClient,
} from "./home-client";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { askHomeOnce, HomeSubmissionUnresolvedError } from "./home-submission";
import { InFlightRegistry } from "./inflight";
import { InkReplBridge } from "./ink-bridge";
import { isActivityNoise, LiveActivityPanel } from "./live-panel";
import { renderMarkdown } from "./markdown";
import { parseQuestionPrompt } from "./question-prompt";
import { CLI_VERSION, type CliOptions, defaultConversationId } from "./shared";
import { faint, muted } from "./theme";
import { listThreads, resolveThread, setThread } from "./thread-store";
import { waitForSettlement } from "./turn";
import { isTuiScreenReaderEnabled } from "./tui-accessibility";

/** Ink options shared with raw-terminal regression tests. */
export const INTERACTIVE_INK_RENDER_OPTIONS = {
	exitOnCtrlC: false,
	// Opt in to native terminal detection so Shift+Enter is distinguishable
	// from Enter where Kitty's keyboard protocol is supported.
	kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] },
	// Only rewrite lines whose rendered content changed. Spinner ticks otherwise
	// resend the bordered composer and decorations, magnifying missed cursor erase
	// into the stacked components seen in remote/local terminal surfaces.
	incrementalRendering: true,
} satisfies RenderOptions;

/**
 * Ordinary exit clears the draft first. Its empty placeholder is one row,
 * plus the two borders. Ink leaves this frame painted with the cursor below
 * it, so erase these rows before the parent shell prints its prompt.
 */
export function eraseInteractiveComposer(
	stream: Pick<NodeJS.WriteStream, "write">,
): void {
	stream.write(`${"\r\u001b[2K\u001b[1A".repeat(3)}\r\u001b[2K`);
}

function askHumanQuestion(summary: HomeRunSummary): string | null {
	if (summary.kernelRoute?.routeKind !== "ask_human") return null;
	const question = summary.kernelRoute.clarifyingQuestion;
	if (typeof question === "string" && question.trim()) return question.trim();
	return summary.assistantText?.trim() || null;
}

/** List logged-in workspaces and distinguish this process from the next launch. */
function printWorkspaceList(
	connectedWorkspace: string,
	sink: TerminalOutput,
): void {
	const selectedWorkspace = getCurrentWorkspace();
	const workspaces = listWorkspaces();
	if (workspaces.length === 0) {
		sink.log("No workspaces yet — run `tedix login`.");
		return;
	}
	sink.log("Workspaces (· connected now; * selected for next launch):");
	for (const w of workspaces) {
		const connected = w.name === connectedWorkspace ? "·" : " ";
		const selected = w.name === selectedWorkspace ? "*" : " ";
		sink.log(
			`  ${connected}${selected} ${w.name.padEnd(24)} ${gatewayHost(w.mcpUrl ?? "")}`,
		);
	}
}

/**
 * Decide what to commit as a settled turn's answer body (answer attribution).
 *
 * The captured `reportSendResult` output can be pure server noise (the
 * "no runtime events" progress placeholder) when a run settles without
 * `assistantText` — never commit that as the answer. Noise lines are stripped;
 * when nothing meaningful remains the turn is empty.
 *
 * Pure — exported for tests.
 */
export function resolveAnswerCommit(opts: { captured: string[] }): {
	source: "captured" | "empty";
	lines: string[];
} {
	const withoutNoise = opts.captured.filter((l) => !isActivityNoise(l));
	if (withoutNoise.some((l) => l.trim().length > 0)) {
		return { source: "captured", lines: withoutNoise };
	}
	return { source: "empty", lines: [] };
}

/** Commit fast and polled answers with the same attribution and replay policy. */
export function commitInkSendResult(
	summary: HomeRunSummary,
	context: Pick<CommandContext, "json" | "color" | "poll">,
	bridge: Pick<
		InkReplBridge,
		"markMessageSeen" | "markRunSeen" | "commitLines"
	>,
	onTediLabel?: (homeRunId: string, label: string) => void,
): void {
	const result = formatSendResult(summary, context);
	const resolved = resolveAnswerCommit({
		captured: [...result.stdout, ...result.stderr],
	});
	const label = summary.targetTediLabel?.trim();
	if (summary.status === "completed" && summary.delegatedTediId && label) {
		onTediLabel?.(summary.homeRunId, label);
	}
	const answerIsChildResult = Boolean(
		summary.status === "completed" &&
		summary.delegatedTediId &&
		summary.childRunPreview &&
		summary.assistantText === summary.childRunPreview,
	);
	bridge.markMessageSeen(`${summary.homeRunId}:assistant`);
	// A delegated acknowledgement must leave its later worker answer visible.
	if (
		summary.status !== "completed" ||
		answerIsChildResult ||
		!summary.delegatedTediId
	) {
		bridge.markRunSeen(summary.homeRunId);
	}
	bridge.commitLines(
		answerIsChildResult && label ? label : "kernel",
		resolved.source === "captured"
			? resolved.lines
			: [muted("(No reply — the run finished without text.)", context.color)],
	);
}

/**
 * HARD CEILING for a turn the CLI lost track of — waitForSettlement gave up
 * (pollTimeoutMs expired with the run still unsettled) or threw. Never leaves
 * the spinner running: commits a clear handoff or error line. The caller owns registry/panel
 * cleanup and clearDispatchInflight.
 *
 * Exported for tests.
 */
export function commitLostRunOutcome(opts: {
	bridge: InkReplBridge;
	homeRunId: string;
	error?: unknown;
}): void {
	const { bridge, homeRunId, error } = opts;
	bridge.commitLines(
		error !== undefined ? "error" : "handoff",
		error !== undefined
			? [
					`Error: ${errorText(error)}`,
					`Press ↑ to edit and resend, or inspect \`tedix tail ${homeRunId}\` if the run may still be active.`,
				]
			: [
					`Run ${homeRunId} is continuing in the background. I'll show its answer here when it arrives. You can also check \`tedix runs\` or \`tedix tail ${homeRunId}\`.`,
				],
	);
}

/**
 * Background settler for the ink REPL path.
 *
 * Same logic as backgroundSettle but routes output through the InkReplBridge
 * instead of printAbovePrompt/readline, so settled results commit to the
 * Static transcript rather than being cursor-written above the prompt.
 *
 * Termination guarantee: EVERY exit — settled, timeout-unsettled, thrown —
 * commits a terminal transcript item and clears the dispatch
 * in-flight flag, so the thinking spinner can never outlive the turn.
 *
 * Exported for tests.
 */
export async function backgroundSettleInk(opts: {
	client: TedixHomeClient;
	homeRunId: string;
	initialSummary: HomeRunSummary;
	options: CliOptions;
	color: ColorMode;
	registry: InFlightRegistry;
	panel: LiveActivityPanel;
	bridge: InkReplBridge;
	signal: AbortSignal;
	/**
	 * Reports the delegated tedi's label once the settled summary carries it,
	 * so the REPL can attribute the run's later async-completion message
	 * (surfaced by the conversation poller) to the tedi instead of "kernel".
	 */
	onTediLabel?: (homeRunId: string, label: string) => void;
	/**
	 * Present an approval discovered by the authoritative settlement read.
	 * The initial ask response can precede the kernel's delegation verdict, so
	 * the Ink path must open the same modal after background polling instead of
	 * committing fallback slash-command prose to the transcript.
	 */
	onPendingApproval?: (summary: HomeRunSummary) => Promise<void> | void;
	/** Present an ask_human route as an input-owning modal. */
	onPendingQuestion?: (summary: HomeRunSummary) => Promise<void> | void;
}): Promise<void> {
	const {
		client,
		homeRunId,
		initialSummary,
		options,
		color,
		registry,
		panel,
		bridge,
		signal,
	} = opts;

	try {
		const quietSpinner = new StatusSpinner({
			animate: false,
			quiet: true,
			onLog: (row) => panel.recordActivity(homeRunId, row),
			// Streamed answer text belongs to the DYNAMIC panel only — it is never
			// committed to the Ink transcript, so the canonical answer that
			// commitInkSendResult writes below stays the only persisted copy.
			onStream: (tail) => panel.recordAnswerStream(homeRunId, tail),
		});
		const summary = await waitForSettlement(
			client,
			homeRunId,
			initialSummary,
			{ ...options, pollTimeoutMs: options.pollTimeoutMs },
			color,
			quietSpinner,
		);
		if (signal.aborted) return;
		const entry = registry.settle(homeRunId);
		// Double-settle guard: another path (the conversation poller surfacing the
		// server-settled answer, or a duplicate settler) already committed this
		// run's outcome — nothing more to show. finally{} still clears in-flight.
		if (!entry) return;

		panel.settle(homeRunId);
		// Tell the poller this run's ack/output message was already shown by the
		// dispatch path. Run-level suppression is applied further down ONLY when
		// the committed answer is the promoted child result — a delegated turn
		// that settled on its fast-ack must still let the poller surface the
		// later `:async-completion:assistant` message (the tedi's actual answer).
		bridge.markMessageSeen(`${homeRunId}:assistant`);

		// The initial ask response commonly arrives before Home has persisted its
		// delegation verdict. If settlement reveals a parked approval, transfer
		// ownership from the old in-flight entry to the typed modal. Remove the
		// settled entry BEFORE invoking the callback: a session-scoped automatic
		// approval may immediately re-register this same Home run for its child
		// dispatch, and removing afterward would delete the new entry.
		if (isPendingHomeApproval(summary) && opts.onPendingApproval) {
			registry.remove(homeRunId);
			try {
				await opts.onPendingApproval(summary);
				return;
			} catch (error) {
				// Fail soft to the existing command-based approval receipt. The
				// server-side draft remains pending and exactly-once resolution is
				// still owned by respond_home_approval.
				bridge.commitLines("output", [
					`[tedix] Could not open the approval selector: ${errorText(error)}`,
				]);
			}
		}

		if (askHumanQuestion(summary) && opts.onPendingQuestion) {
			registry.remove(homeRunId);
			await opts.onPendingQuestion(summary);
			return;
		}

		// HARD CEILING: waitForSettlement RESOLVES (does not throw) when
		// pollTimeoutMs expires with the run still unsettled. Never fall through
		// to the answer-commit path with a non-answer.
		if (!isSettledHomeStatus(summary.status)) {
			commitLostRunOutcome({
				bridge,
				homeRunId,
			});
			registry.remove(homeRunId);
			return;
		}

		commitInkSendResult(
			summary,
			{ json: options.json, color, poll: options.poll },
			bridge,
			opts.onTediLabel,
		);
		registry.remove(homeRunId);
	} catch (error) {
		const entry = registry.settle(homeRunId);
		if (entry) {
			panel.settle(homeRunId);
			commitLostRunOutcome({
				bridge,
				homeRunId,
				error,
			});
			registry.remove(homeRunId);
		}
	} finally {
		bridge.clearDispatchInflight();
	}
}

/** Translate dispatch-policy internals into the operator decision being made. */
export function approvalReasonForDisplay(
	summary: HomeRunSummary,
	targetLabel: string,
): string | undefined {
	// The shadow-miss marker used to be prefixed onto `reason` and stripped here;
	// it is a structured field on the decision now, so there is nothing to undo.
	const raw = summary.delegationReason?.trim();
	if (!raw) return undefined;
	if (raw === "target not active") {
		return `${targetLabel} is in standby. Approval wakes it and dispatches this work order.`;
	}
	if (raw === "target requires approval for its actions") {
		return `${targetLabel}'s policy requires approval before this work order is dispatched.`;
	}
	if (raw === "operator explicitly held dispatch for approval") {
		return "You asked Home to hold this work order for an explicit decision.";
	}
	if (raw === "route classified as high risk") {
		return "Home classified this work order as high risk.";
	}
	return raw;
}

/**
 * Claim a terminal run for an explicit interactive `/run` read.
 *
 * The background settler and conversation poller may discover the same terminal
 * answer at the same time. The registry is the single ownership latch: the path
 * that settles it first renders the answer; the loser stays silent.
 */
export function claimTerminalRunForInteractiveRead(input: {
	bridge: InkReplBridge;
	homeRunId: string;
	panel: LiveActivityPanel;
	registry: InFlightRegistry;
	status?: string;
	wasTracked: boolean;
}): "print" | "suppress" {
	if (!input.wasTracked || !isSettledHomeStatus(input.status)) return "print";
	const entry = input.registry.settle(input.homeRunId);
	if (!entry) return "suppress";
	input.panel.settle(input.homeRunId);
	input.registry.remove(input.homeRunId);
	input.bridge.markMessageSeen(`${input.homeRunId}:assistant`);
	input.bridge.markRunSeen(input.homeRunId);
	return "print";
}

/** Print a static control index without duplicating the live activity panel. */
export function printInFlightRunSnapshot(
	panel: LiveActivityPanel,
	sink: TerminalOutput = console,
): void {
	const states = panel.getStates();
	if (states.length === 0) {
		sink.log("No in-flight runs.");
		return;
	}
	sink.log(`${states.length} run${states.length === 1 ? "" : "s"} in flight:`);
	for (const state of states) {
		const status = state.summary?.status ?? "running";
		const target = state.summary?.targetTediLabel
			? ` → ${state.summary.targetTediLabel}`
			: "";
		sink.log(
			`  ${state.entry.homeRunId} · ${state.entry.label} · ${status}${target}`,
		);
	}
	sink.log("Controls: /steer <id> <instruction> · /cancel <id> [reason]");
}

const IMMEDIATE_INK_COMMANDS = new Set([
	"activity",
	"clear",
	"exit",
	"help",
	"new",
	"quit",
	"runs",
	"use",
	"wait",
	"workspaces",
]);

export function shouldShowInkThinking(line: string): boolean {
	if (!line.startsWith("/")) return true;
	const [name] = firstWord(line.slice(1));
	const knownInteractiveCommand = interactiveSlashCommands().some(
		(command) => command.name === name,
	);
	if (!findCommand(name) && !knownInteractiveCommand) return false;
	return !IMMEDIATE_INK_COMMANDS.has(name);
}

/** Command-specific copy for deterministic remote reads in the Ink surface. */
export function inkThinkingLabel(line: string): string | undefined {
	if (!line.startsWith("/")) return undefined;
	const [name] = firstWord(line.slice(1));
	if (name === "sessions") return "Loading sessions";
	if (name === "resume") return "Loading session";
	return undefined;
}

/** Interactive commands and the keyboard controls discoverable at startup. */
export function formatInkInteractiveHelp(): string {
	return `${formatInteractiveCommandHelp()}\n\n${INTERACTIVE_KEY_HINTS.join("\n")}`;
}

/**
 * ink-based interactive REPL for TTY terminals.
 *
 * Uses ink's <Static> + dynamic <Box> model so committed transcript lines
 * go to native scrollback (write-once, never cursor-up'd) and only a small
 * dynamic area at the bottom re-renders. This replaces the readline + cursor-
 * manipulation approach for the TTY path only.
 */
export async function runInteractiveInk(
	ctx: CommandContext,
	conversationId: string,
	options?: CliOptions,
): Promise<void> {
	// Buffer keystrokes typed while ink loads and mounts — the dynamic imports
	// + first render take long enough that early characters were silently lost
	// (live finding: "hi! what can…" arrived as "what can…"). Captured raw here
	// and seeded as the composer's initial value below. Escape sequences and
	// control chars typed pre-mount are stripped (arrows/Enter can't meaningfully
	// replay into a not-yet-mounted composer).
	const earlyChunks: Buffer[] = [];
	const captureEarlyInput = (chunk: Buffer) => {
		earlyChunks.push(chunk);
	};
	if (process.stdin.isTTY) {
		try {
			process.stdin.setRawMode(true);
		} catch {
			// non-fatal: worst case early keystrokes are lost, as before
		}
		process.stdin.resume();
		process.stdin.on("data", captureEarlyInput);
	}

	// Lazily import ink so non-TTY/non-interactive paths never load React.
	const { render } = await import("ink");
	const { createElement } = await import("react");
	const { InkRepl } = await import("./ink-repl");

	const registry = new InFlightRegistry();
	const muxAbort = new AbortController();
	const connectedWorkspace = options
		? resolveWorkspaceName(options)
		: (getCurrentWorkspace() ?? DEFAULT_WORKSPACE);

	// Panel as a pure data source: runs the poll loop, accumulates RunState; the
	// ink layer renders it via getStates(). The panel itself never draws.
	const panel = new LiveActivityPanel({
		isTty: true,
		ops: ctx.client as unknown as import("./live-panel").PanelHomeOps,
	});

	// bridge is forward-declared so dispatchNonBlockingLine can close over it.
	// Assigned below after the dispatch closure is defined (before dispatch is called).
	// eslint-disable-next-line prefer-const
	let bridge: InkReplBridge = null!;
	const emit = (...args: unknown[]) =>
		bridge.commitLines("output", [args.map(String).join(" ")]);
	const sink: TerminalOutput = { log: emit, error: emit };
	ctx = { ...ctx, output: sink };

	// ── Session management state (/sessions /resume /new /rename /compact)
	interface SessionRow {
		id: string;
		title: string;
		lastMessageAt?: string;
	}
	// The most recent /sessions listing, so /resume <n> can pick by number.
	let sessionListing: SessionRow[] = [];
	// A /compact context brief awaiting attachment to the next outgoing message.
	let pendingContextBrief: string | null = null;
	// Explicitly session-local approval memory. Never persisted and never shared
	// with another terminal or Home conversation.
	const alwaysApproveScopes = new Set<string>();
	// homeRunId → delegated tedi label ("CTO"), captured at dispatch/settle so
	// the conversation poller can attribute a run's later async-completion
	// message (the tedi's actual answer) to the tedi instead of "● Kernel".
	const runTediLabels = new Map<string, string>();

	const parseSessionRows = (payload: unknown): SessionRow[] => {
		const root = isRecord(payload) ? payload : {};
		const arr = Array.isArray(root.conversations)
			? root.conversations
			: Array.isArray(payload)
				? payload
				: [];
		const rows: SessionRow[] = [];
		for (const entry of arr) {
			if (!isRecord(entry)) continue;
			const id = typeof entry.id === "string" ? entry.id : "";
			if (!id) continue;
			rows.push({
				id,
				// The server falls back to the conversation id as the title; treat
				// that as "untitled" so aliases/placeholders can render instead.
				title:
					typeof entry.title === "string" && entry.title !== id
						? entry.title
						: "",
				...(typeof entry.lastMessageAt === "string"
					? { lastMessageAt: entry.lastMessageAt }
					: {}),
			});
		}
		return rows;
	};

	const threadAliasFor = (targetConversationId: string): string | null =>
		listThreads().find((t) => t.conversationId === targetConversationId)
			?.name ?? null;

	// Switch every conversation-scoped surface to another session: future
	// dispatches (ctx), ops.send + one-shot helpers (options), and the proactive
	// message poller (bridge). In-flight runs keep settling against their
	// original conversation — registry entries carry their own conversationId.
	const switchSession = (
		id: string,
		note?: string,
		announce = true,
	): string => {
		ctx.conversationId = id;
		if (options) options.conversationId = id;
		bridge.setPollerConversation(id);
		// Prefer the local thread alias, then the server-side title from the
		// last /sessions listing — landing on a raw conversation id reads like
		// an error even when the switch worked.
		const alias =
			threadAliasFor(id) ??
			(sessionListing.find((row) => row.id === id)?.title || null);
		const announcement = `✓ Now in session ${alias ? `“${alias}” · ` : ""}${id}${note ? ` — ${note}` : ""}`;
		if (announce) sink.log(announcement);
		return announcement;
	};

	// Fresh session id. A named session reuses the --thread alias convention so
	// `tedix --thread <name> chat` reopens it from any directory.
	const freshSessionId = (name?: string): string => {
		if (name) {
			const id = `home:cli:thread:${name.replace(/[^a-zA-Z0-9_.:-]+/g, "-").slice(-80)}`;
			setThread(name, id);
			return id;
		}
		return `${defaultConversationId()}:${Date.now().toString(36)}`;
	};

	// Full CliOptions literal for inline settlement waits (/compact). Mirrors the
	// backgroundSettleInk options in the plain-text dispatch below.
	const inlineSettleOptions = (): CliOptions => ({
		conversationId: ctx.conversationId,
		follow: true,
		includeArchived: false,
		json: ctx.json,
		noColor: !ctx.color.enabled,
		poll: true,
		pollIntervalMs: ctx.pollIntervalMs,
		pollTimeoutMs: 90_000,
		repoContext: false,
		requireCodeProof: false,
		requireWorkstation: false,
		url: ctx.client
			? ((ctx.client as unknown as { url?: string }).url ??
				DEFAULT_TEDIX_MCP_URL)
			: DEFAULT_TEDIX_MCP_URL,
	});

	// Attach any active Home run to the same non-blocking settlement path used
	// by a freshly submitted message. Approval commands are a second dispatch
	// surface: a proposed multi-tedi plan is initially settled while it waits for
	// consent, then /approve transitions that existing parent run back to active.
	// Without registering that transition, the work ran correctly server-side
	// but the TUI stayed visually idle and never rendered its child rows.
	const trackBackgroundRun = (
		summary: HomeRunSummary,
		label: string,
		conversationId: string,
	): void => {
		if (isSettledHomeStatus(summary.status)) return;
		if (
			registry.list().some((entry) => entry.homeRunId === summary.homeRunId)
		) {
			return;
		}

		const inflightEntry = registry.add({
			homeRunId: summary.homeRunId,
			label,
			conversationId,
		});
		panel.add(inflightEntry);

		void backgroundSettleInk({
			client: ctx.client,
			homeRunId: summary.homeRunId,
			initialSummary: summary,
			onPendingApproval: presentInkApproval,
			onPendingQuestion: presentInkQuestion,
			onTediLabel: (homeRunId, tediLabel) =>
				runTediLabels.set(homeRunId, tediLabel),
			options: {
				...inlineSettleOptions(),
				conversationId,
				pollTimeoutMs: 120_000,
			},
			color: ctx.color,
			registry,
			panel,
			bridge,
			signal: muxAbort.signal,
		});
	};

	const resolveInkApproval = async (input: {
		homeRunId: string;
		decision: "approve" | "reject";
		rememberForSession: boolean;
		scope: string;
		targetLabel: string;
	}): Promise<void> => {
		const response = await ctx.client.respondHomeApproval({
			homeRunId: input.homeRunId,
			decision: input.decision,
			note: `${input.decision}${input.rememberForSession ? ` (always:${input.scope})` : ""} from tedix-cli TUI`,
		});
		if (input.decision === "reject") return;
		if (input.rememberForSession) {
			// Remember consent only after Home accepts it. A transient RPC failure must
			// leave the next matching delegation actionable instead of silently
			// auto-approving it.
			alwaysApproveScopes.add(input.scope);
		}

		let approved = summarizeHomePayload(response);
		try {
			approved =
				summarizeHomePayload(await ctx.client.readHomeRun(input.homeRunId)) ??
				approved;
		} catch {
			// The approval response is authoritative enough to acknowledge consent;
			// the conversation poller remains the fail-soft completion path.
		}
		if (!approved) return;
		bridge.markMessageSeen(`${approved.homeRunId}:assistant`);
		if (approved.targetTediLabel?.trim()) {
			runTediLabels.set(approved.homeRunId, approved.targetTediLabel.trim());
		}
		trackBackgroundRun(
			approved,
			approved.targetTediLabel?.trim() ?? input.targetLabel,
			approved.conversationId ?? ctx.conversationId,
		);
	};

	const presentInkApproval = async (summary: HomeRunSummary): Promise<void> => {
		const scope = approvalScopeKey(summary);
		const targetLabel =
			summary.targetTediLabel?.trim() ||
			summary.progressLabel?.trim() ||
			"Home";
		const detail =
			summary.delegationObjective?.trim() ||
			summary.assistantText?.trim() ||
			"Review and resolve this requested action.";
		if (alwaysApproveScopes.has(scope)) {
			await resolveInkApproval({
				homeRunId: summary.homeRunId,
				decision: "approve",
				rememberForSession: true,
				scope,
				targetLabel,
			});
			bridge.commitLines("system", [
				`${targetLabel} auto-approved for this session. Dispatching…`,
			]);
			return;
		}
		bridge.showApproval({
			homeRunId: summary.homeRunId,
			targetLabel,
			detail: detail.length > 280 ? `${detail.slice(0, 277)}…` : detail,
			reason: approvalReasonForDisplay(summary, targetLabel),
			scope,
			scopeLabel:
				summary.targetTediId || summary.targetTediLabel
					? `${targetLabel} delegations`
					: scope,
		});
	};

	const presentInkQuestion = (summary: HomeRunSummary): void => {
		const raw = askHumanQuestion(summary);
		if (!raw) return;
		const parsed = parseQuestionPrompt(raw);
		bridge.showQuestion({
			homeRunId: summary.homeRunId,
			prompt: parsed.prompt,
			options: parsed.options,
		});
	};

	// Non-blocking dispatch — same logic as in runInteractive's TTY branch.
	const dispatchNonBlockingLine = async (
		line: string,
	): Promise<"exit" | "dispatched" | "handled"> => {
		if (line === "/exit") return "exit";

		// /runs: list in-flight
		if (line === "/runs" || line.startsWith("/runs ")) {
			const arg = line.startsWith("/runs ") ? line.slice(6).trim() : "";
			if (arg) {
				const state = panel.findByPrefix(arg);
				if (!state) {
					const inFlight = registry.list();
					const match = inFlight.find(
						(e) => e.homeRunId.startsWith(arg) || e.label.startsWith(arg),
					);
					if (match) {
						sink.log(
							`  ${match.homeRunId}  ${match.label}  (${registry.elapsed(match)} elapsed)`,
						);
					} else {
						sink.log(`No in-flight run matching "${arg}".`);
					}
					return "handled";
				}
				const snap = panel.snapshot();
				const row = snap.find((l) => l.includes(state.entry.label));
				if (row) sink.log(row);
				const entry = state.entry;
				sink.log(
					`  homeRunId=${entry.homeRunId}  conversationId=${entry.conversationId}  elapsed=${registry.elapsed(entry)}`,
				);
				if (state.summary?.status) {
					sink.log(`  status=${state.summary.status}`);
				}
				if (state.tokens !== undefined) {
					sink.log(`  tokens=${state.tokens}`);
				}
				if (state.childTotal !== undefined && state.childTotal > 0) {
					sink.log(
						`  children=${state.childDone}/${state.childTotal} done  failed=${state.childFailed ?? 0}`,
					);
				}
				return "handled";
			}
			printInFlightRunSnapshot(panel, sink);
			return "handled";
		}

		if (line === "/activity" || line.startsWith("/activity ")) {
			const mode = line.startsWith("/activity ")
				? line.slice("/activity ".length).trim()
				: "";
			if (!mode) {
				bridge.cycleActivityMode();
				sink.log(
					"Activity view cycled. Use /activity compact|full|errors or Ctrl-G.",
				);
				return "handled";
			}
			if (mode !== "compact" && mode !== "full" && mode !== "errors") {
				sink.error("Usage: /activity compact|full|errors");
				return "handled";
			}
			bridge.setActivityMode(mode);
			sink.log(`Activity view: ${mode}.`);
			return "handled";
		}

		// /wait: block until all settle
		if (line === "/wait" || line.startsWith("/wait ")) {
			const n = registry.count;
			if (n === 0) {
				sink.log("No in-flight runs to wait for.");
			} else {
				sink.log(`Waiting for ${n} in-flight run(s)…`);
				await registry.waitAll({ signal: muxAbort.signal });
				sink.log("All runs settled.");
			}
			return "handled";
		}

		// /workspaces: distinguish the current connection from persisted selection.
		if (line === "/workspaces") {
			printWorkspaceList(connectedWorkspace, sink);
			return "handled";
		}

		// /use [<workspace>]: switch the active workspace (no arg → list).
		if (line === "/use" || line.startsWith("/use ")) {
			const target = line.startsWith("/use ") ? line.slice(5).trim() : "";
			if (!target) {
				printWorkspaceList(connectedWorkspace, sink);
				sink.log("Switch with /use <name>, then restart tedix to connect.");
				return "handled";
			}
			const ws = listWorkspaces().find((w) => w.name === target);
			if (!ws) {
				const names = listWorkspaces()
					.map((w) => w.name)
					.join(", ");
				sink.error(
					`No workspace "${target}". Logged in: ${names || "(none — run `tedix login`)"}.`,
				);
				return "handled";
			}
			if (target === getCurrentWorkspace()) {
				sink.log(`Already selected ${target} for the next launch.`);
				sink.log(`This session remains connected to ${connectedWorkspace}.`);
				return "handled";
			}
			setCurrentWorkspace(target);
			sink.log(
				`✓ Selected ${target} · ${gatewayHost(ws.mcpUrl ?? "")} for the next launch.`,
			);
			sink.log(
				`This session remains connected to ${connectedWorkspace}; restart tedix to connect to the selected workspace.`,
			);
			return "handled";
		}

		// /sessions [search]: list Home conversations (sessions) for switching.
		if (line === "/sessions" || line.startsWith("/sessions ")) {
			const search = line.startsWith("/sessions ") ? line.slice(10).trim() : "";
			try {
				const payload = await ctx.client.listHomeConversations({
					limit: 20,
					...(search ? { search } : {}),
				});
				sessionListing = parseSessionRows(payload);
			} catch (error) {
				sink.error(`Couldn't list sessions — ${errorText(error)}`);
				return "handled";
			}
			if (sessionListing.length === 0) {
				sink.log(
					search ? `No sessions matching “${search}”.` : "No sessions yet.",
				);
				return "handled";
			}
			bridge.showSessionPicker(
				sessionListing.map((row) => ({
					id: row.id,
					title: row.title || threadAliasFor(row.id) || "(untitled)",
					...(row.lastMessageAt ? { lastMessageAt: row.lastMessageAt } : {}),
				})),
				ctx.conversationId,
			);
			return "handled";
		}

		// /resume <n|id|threadName>: switch to another session.
		if (line === "/resume" || line.startsWith("/resume ")) {
			const arg = line.startsWith("/resume ") ? line.slice(8).trim() : "";
			if (!arg) {
				sink.log(
					"Usage: /resume <n|conversationId|threadName> — run /sessions to list.",
				);
				return "handled";
			}
			let target: string | null = null;
			const n = Number.parseInt(arg, 10);
			if (
				Number.isInteger(n) &&
				String(n) === arg &&
				n >= 1 &&
				n <= sessionListing.length
			) {
				target = sessionListing[n - 1]?.id ?? null;
			}
			target ??= resolveThread(arg);
			if (!target) {
				const hit = sessionListing.find(
					(row) =>
						row.id === arg || row.id.startsWith(arg) || row.title === arg,
				);
				target = hit?.id ?? (arg.includes(":") ? arg : null);
			}
			if (!target) {
				sink.error(
					`No session matching “${arg}”. Run /sessions first, or pass a full conversation id.`,
				);
				return "handled";
			}
			if (target === ctx.conversationId) {
				sink.log("Already in that session.");
				return "handled";
			}
			// Land with context: replay the tail of the resumed transcript
			// (best-effort) in transcript voice (›/●), oldest → newest. Sort by
			// createdAt instead of trusting server order — the previous blind
			// reverse() flipped an already-chronological payload into
			// answers-before-questions.
			try {
				const payload = await ctx.client.readHomeMessages({
					conversationId: target,
					limit: 8,
				});
				const messages = parseHomeMessagesPayload(payload)
					.filter((m) => (m.content ?? "").trim())
					.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
				for (const msg of messages.slice(-8)) {
					const first = (msg.content ?? "").split("\n")[0] ?? "";
					const preview =
						first.length > 100 ? `${first.slice(0, 100)}…` : first;
					sink.log(msg.role === "user" ? `› ${preview}` : `● ${preview}`);
				}
			} catch {
				// context preview is decorative
			}
			switchSession(target);
			return "handled";
		}

		// /new [name]: start a fresh session (empty kernel context)
		// and wipe the visible transcript back to the banner — the new session
		// starts on a clean canvas, Claude-Code style.
		if (line === "/new" || line.startsWith("/new ")) {
			const name = line.startsWith("/new ") ? line.slice(5).trim() : "";
			pendingContextBrief = null;
			const announcement = switchSession(
				freshSessionId(name || undefined),
				"fresh context",
				false,
			);
			bridge.clearTranscript([announcement]);
			return "handled";
		}

		// /rename <title>: set the server-side session title (Tedix OS + /sessions).
		if (line === "/rename" || line.startsWith("/rename ")) {
			const title = line.startsWith("/rename ") ? line.slice(8).trim() : "";
			if (!title) {
				sink.log("Usage: /rename <new title>");
				return "handled";
			}
			try {
				await ctx.client.renameConversation({
					conversationId: ctx.conversationId,
					title,
				});
				sink.log(
					`✓ Renamed this session to “${title}” (shows in /sessions and Tedix OS).`,
				);
			} catch (error) {
				sink.error(`Rename failed — ${errorText(error)}`);
			}
			return "handled";
		}

		// /compact [focus]: create an explicit cross-session handoff. Tedix Home
		// does not currently expose an in-place context-pruning operation, so this
		// command must never pretend the original durable conversation was trimmed.
		if (line === "/compact" || line.startsWith("/compact ")) {
			const focus = line.startsWith("/compact ") ? line.slice(9).trim() : "";
			try {
				const { summary: initial } = await askHomeOnce({
					client: ctx.client,
					content: `Produce a compact context brief of this conversation for a session handoff: key facts, decisions, open items, and any ids worth keeping.${focus ? ` Prioritize this focus: ${focus}.` : ""} Reply with only the brief.`,
					conversationId: ctx.conversationId,
					metadata: { source: "tedix-cli", mode: "compact" },
				});
				// The brief is consumed here, never rendered as a turn — suppress both
				// the ack and any later poller surfacing for this run.
				bridge.markMessageSeen(`${initial.homeRunId}:assistant`);
				bridge.markRunSeen(initial.homeRunId);
				const quiet = new StatusSpinner({ animate: false, quiet: true });
				const settled = await waitForSettlement(
					ctx.client,
					initial.homeRunId,
					initial,
					inlineSettleOptions(),
					ctx.color,
					quiet,
				);
				const brief = settled.assistantText?.trim();
				if (!brief) throw new Error("Home returned no summary");
				pendingContextBrief = brief;
				const announcement = switchSession(
					freshSessionId(),
					"compacted",
					false,
				);
				await bridge.rebuildTranscript([
					announcement,
					"Fresh session started. The handoff brief will be attached to your next message; the original session remains resumable.",
				]);
			} catch (error) {
				sink.error(`Compaction failed — ${errorText(error)}`);
			}
			return "handled";
		}

		// /help
		if (line === "/help") {
			sink.log(formatInkInteractiveHelp());
			return "handled";
		}

		// Other slash commands
		if (line.startsWith("/")) {
			const [name, rest] = firstWord(line.slice(1));
			if (name === "approve" || name === "reject") {
				const [homeRunId] = firstWord(rest);
				if (!homeRunId) {
					sink.error(`${name} requires a homeRunId`);
					return "handled";
				}
				try {
					const pending = summarizeHomePayload(
						await ctx.client.readHomeRun(homeRunId),
					);
					const targetLabel = pending?.targetTediLabel?.trim() || "Home";
					await resolveInkApproval({
						homeRunId,
						decision: name,
						rememberForSession: false,
						scope: pending ? approvalScopeKey(pending) : "approval",
						targetLabel,
					});
					bridge.commitLines("system", [
						name === "approve"
							? `${targetLabel} approved. Dispatching…`
							: `${targetLabel} delegation rejected.`,
					]);
				} catch (error) {
					bridge.commitLines("error", [
						`Approval failed — ${errorText(error)}`,
					]);
				}
				return "handled";
			}
			// `/run` can race the background settler at the exact terminal edge.
			// Read once, then claim the registry latch before rendering. If the
			// settler already claimed it, stay silent instead of duplicating the answer.
			if (name === "run") {
				const [homeRunId] = firstWord(rest);
				if (!homeRunId) {
					sink.error("run requires a homeRunId");
					return "handled";
				}
				const wasTracked = registry
					.list()
					.some((entry) => entry.homeRunId === homeRunId);
				if (wasTracked) {
					try {
						const payload = await ctx.client.readHomeRun(homeRunId);
						const summary = summarizeHomePayload(payload);
						const outcome = claimTerminalRunForInteractiveRead({
							bridge,
							homeRunId,
							panel,
							registry,
							status: summary?.status,
							wasTracked,
						});
						if (outcome === "print") printRunPayload(payload, ctx);
					} catch (error) {
						sink.error(errorText(error));
					}
					return "handled";
				}
			}
			const spec = findCommand(name);
			if (spec) {
				try {
					await spec.handler(rest, ctx);
				} catch (error) {
					sink.error(errorText(error));
				}
				return "handled";
			}
			sink.error(`Unknown command /${name}. Type /help for commands.`);
			return "handled";
		}

		// Plain text → non-blocking dispatch
		const { text: expandedText, attached, skipped } = expandFileMentions(line);
		if (attached.length > 0) {
			sink.log(
				`  ↳ attached ${attached.length} file(s): ${attached.join(", ")}`,
			);
		}
		if (skipped.length > 0) {
			sink.log(
				`  ↳ skipped @${skipped.join(", @")} (not a readable file — missing, a directory, binary, or >64KB)`,
			);
		}
		// /compact handoff: prepend the captured brief to the first message of the
		// fresh session so the kernel starts with the carried-over context.
		let text = expandedText;
		if (pendingContextBrief) {
			text = `[Compacted context from the previous session]\n${pendingContextBrief}\n\n---\n\n${text}`;
			pendingContextBrief = null;
			sink.log("  ↳ attached compacted context from the previous session");
		}

		let summary: HomeRunSummary;
		try {
			const dispatched = await askHomeOnce({
				client: ctx.client,
				content: text,
				conversationId: ctx.conversationId,
				metadata: {
					source: "tedix-cli",
					cwd: process.cwd(),
					mode: "interactive",
				},
			});
			summary = dispatched.summary;
			if (dispatched.recovered) {
				bridge.commitLines("system", [
					"Reconnected to the accepted run. Your message was not resent.",
				]);
			}
		} catch (error) {
			if (isAuthError(error)) {
				bridge.commitLines("error", [
					"Authentication failed. Run `tedix login` or check your gateway credentials.",
				]);
				return "handled";
			}
			if (error instanceof HomeSubmissionUnresolvedError) {
				bridge.commitLines("error", [error.message]);
				return "handled";
			}
			bridge.commitLines("error", [
				`Couldn't send that message — ${errorText(error)}. Press ↑ to edit and resend.`,
			]);
			return "handled";
		}

		// Seed the parent output-message id IMMEDIATELY so the poller never
		// re-surfaces the ack ("On it — delegating…") mid-flight as a duplicate
		// turn. Deliberately NOT markRunSeen: the run's later async-completion
		// message (`:async-completion:assistant` — the delegated tedi's actual
		// result) must still surface through the poller.
		bridge.markMessageSeen(`${summary.homeRunId}:assistant`);
		if (summary.delegatedTediId && summary.targetTediLabel?.trim()) {
			runTediLabels.set(summary.homeRunId, summary.targetTediLabel.trim());
		}

		if (isPendingHomeApproval(summary)) {
			await presentInkApproval(summary);
			return "dispatched";
		}

		if (isSettledHomeStatus(summary.status)) {
			if (askHumanQuestion(summary)) {
				presentInkQuestion(summary);
				return "dispatched";
			}
			commitInkSendResult(summary, ctx, bridge);
			return "dispatched";
		}

		// Non-blocking path: register + background settle.
		const label = line.slice(0, 40);
		trackBackgroundRun(summary, label, ctx.conversationId);

		return "dispatched";
	};

	bridge = new InkReplBridge({
		getRegistryCount: () => registry.count,
		getRegistryList: () => registry.list(),
		waitAll: () => registry.waitAll({ signal: muxAbort.signal }),
		dispatch: dispatchNonBlockingLine,
		getPanelStates: () => panel.getStates(),
		cancel: (homeRunId, reason) =>
			ctx.client.cancelHomeRun({ homeRunId, reason }),
		steer: (homeRunId, instruction) =>
			ctx.client.steerHomeRun({ homeRunId, instruction }),
		shouldShowThinking: shouldShowInkThinking,
		thinkingLabelFor: inkThinkingLabel,
		resolveApproval: resolveInkApproval,
		resolveQuestion: async (answer) => {
			const result = await dispatchNonBlockingLine(answer);
			if (result === "exit") {
				throw new Error("the session exited before the answer was sent");
			}
		},
	});

	// ── Conversation poller: surfaces proactive INBOX_WAKE messages ───────────
	// While the ink REPL is active, poll readHomeMessages on a slow interval.
	// When a new assistant message arrives that was NOT committed by the dispatch
	// path (e.g. a CTO result delivered via INBOX_WAKE), it surfaces in the
	// transcript automatically under the "kernel" speaker label.
	//
	// Seeding (mark existing messages seen) + poller start are deferred to a
	// background task AFTER render() below — the blocking seed read here was the
	// ~30s cold-start hang. A cold gateway must never delay the banner/prompt.
	let pollerFailureReported = false;
	const poller = new ConversationPoller({
		conversationId,
		intervalMs: 4_000,
		readMessages: async (cid) => {
			// Drive the unhealthy-only connection indicator off the persistent poll: a
			// successful read = connected; a connection-class failure = reconnecting
			// (the WS stream surfaces mid-turn "lost"). Mirrors Tedix OS's poll/SSE split.
			try {
				const result = await ctx.client.readHomeMessages({
					conversationId: cid,
				});
				bridge.setConnection("connected");
				return result;
			} catch (err) {
				if (isConnectionError(err)) bridge.setConnection("reconnecting");
				throw err; // keep the poller fail-soft (onError swallows below)
			}
		},
		onNewAssistantMessage: (msg) => {
			// Render markdown (fits wide tables to the terminal width) the same way
			// the dispatch path does, so a proactively-delivered result with a table
			// doesn't wrap into an unreadable dashes-and-pipes mess.
			const rendered = renderMarkdown(msg.content, ctx.color);
			const lines = rendered.split("\n").filter((l) => l.length > 0);
			if (lines.length === 0) return;
			// A surfaced assistant answer for a run the dispatch path is still
			// tracking means the server settled the turn while the CLI's settle
			// path stayed blind (stalled read / dropped WS). Treat it as turn
			// completion: settle the registry entry so backgroundSettleInk's
			// double-settle guard drops its own late commit, and drop the panel row.
			if (msg.runId) {
				const entry = registry.settle(msg.runId);
				if (entry) {
					panel.settle(msg.runId);
					registry.remove(msg.runId);
				}
			}
			// Attribute a delegation's async-completion (the tedi's own answer)
			// to the tedi — "● CTO" — using the label captured at dispatch/settle.
			// Other proactive messages (kernel updates, cross-session traffic with
			// no known label) keep the kernel speaker.
			const tediLabel =
				msg.runId && msg.id.endsWith(":async-completion:assistant")
					? runTediLabels.get(msg.runId)
					: undefined;
			// commitLines on a conversational speaker clears the thinking spinner
			// + streaming slot — the turn terminates the moment the answer lands.
			bridge.commitLines(tediLabel ?? "kernel", lines);
		},
		onError: (err) => {
			// Poll errors never crash the REPL. A CONNECTION-class blip is ordinary
			// and stays quiet, but anything else means proactive delivery is down —
			// the delegated answer this poller exists to surface will not arrive —
			// so say it once rather than leaving the operator to ask again.
			if (isConnectionError(err) || pollerFailureReported) return;
			pollerFailureReported = true;
			sink.error(
				`Proactive result delivery is not working in this session: ${errorText(err)}`,
			);
		},
	});
	// ── end conversation poller (seeded + started in the background below) ────

	const isScreenReaderEnabled = isTuiScreenReaderEnabled();
	const greeting = options
		? renderBanner({
				version: CLI_VERSION,
				workspace: resolveWorkspaceName(options),
				gatewayUrl: options.url,
				cwd: process.cwd(),
				color: ctx.color,
				columns: process.stdout.columns,
				screenReader: isScreenReaderEnabled,
			})
		: [`Tedix Home CLI (${conversationId})`, ...INTERACTIVE_KEY_HINTS];

	const slashCommands = interactiveSlashCommands();

	// Stop the early capture and distill it to printable text just before the
	// REPL mounts (ink attaches its own stdin listeners in render()).
	process.stdin.off("data", captureEarlyInput);
	const initialInput = Buffer.concat(earlyChunks)
		.toString("utf8")
		// Strip terminal escape sequences before mounting Ink.
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
		// Drop control characters such as Enter and Tab typed before mount.
		.replace(/[\x00-\x1f\x7f]/g, "");

	const { unmount, waitUntilExit } = render(
		createElement(InkRepl, {
			controller: bridge,
			greeting,
			slashCommands,
			...(initialInput ? { initialInput } : {}),
		}),
		{ ...INTERACTIVE_INK_RENDER_OPTIONS, isScreenReaderEnabled },
	);

	// Render-first startup: the banner is already on screen. Now seed the "seen"
	// message ids and start the poller off the critical path, so a cold gateway
	// can't stall the launch (this read was the ~30s cold-start hang).
	void (async () => {
		try {
			const seedPayload = await ctx.client.readHomeMessages({
				conversationId,
				limit: 50,
			});
			for (const msg of parseHomeMessagesPayload(seedPayload)) {
				bridge.markMessageSeen(msg.id);
			}
		} catch {
			// Non-fatal: the poller still works; the SEEN set grows monotonically.
		}
		bridge.startConversationPoller(poller);
	})();

	try {
		await waitUntilExit();
	} finally {
		unmount();
		if (process.stdout.isTTY && !isScreenReaderEnabled)
			eraseInteractiveComposer(process.stdout);
		bridge.stop();
		panel.stop();
		muxAbort.abort();
		if (registry.count > 0) {
			await registry.waitAll({ signal: muxAbort.signal }).catch(() => {});
		}
	}
}
