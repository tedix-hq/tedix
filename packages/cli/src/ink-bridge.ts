/**
 * Bridge between the ink REPL (React state) and the existing async business
 * logic in interactive-ink.ts.
 *
 * The adapter:
 *   1. Publishes explicitly committed output as transcript items.
 *   2. Drives the panel poll loop and propagates RunState[] to the REPL via
 *      an onUpdate subscription.
 *   3. Implements the ReplController interface consumed by InkRepl.
 *   4. Owns the ConversationPoller that surfaces proactive INBOX_WAKE messages
 *      from delegated tedis into the transcript automatically.
 *
 * No I/O or cursor manipulation — all output flows through React state.
 */

import type { ConnectionStatus } from "./operator/connection-status";
import { classifyTurnLiveness } from "./operator/turn-liveness";
import type { ConversationPoller } from "./conversation-poller";
import { nextFrameIndex } from "./ink-live-panel";
import type {
	ApprovalPromptState,
	QuestionPromptState,
	ReplController,
	ReplLifecycle,
	ReplState,
	SessionPickerItem,
	SessionPickerState,
	TranscriptItem,
} from "./ink-repl";
import type { ActivityDisplayMode, RunState } from "./live-panel";

type UpdateHandler = (state: ReplState) => void;

type ActivePrompt =
	| { kind: "session"; value: SessionPickerState }
	| { kind: "approval"; value: ApprovalPromptState }
	| { kind: "question"; value: QuestionPromptState };

// Native scrollback makes every missed cursor erase visible, so animation is
// intentionally calm: actual stream/panel changes still publish immediately,
// while the decorative spinner/elapsed clock advances only once per second.
// This keeps liveness transitions accurate without generating a constant
// repaint stream on SSH, tmux, browser terminals, or slower GPU renderers.
export const INK_TICK_MS = 1_000;

/**
 * Speakers that are NOT a conversational answer: committing them must not
 * settle the pending turn (banner = greeting, output = slash-command echo,
 * you = the operator's own words, system = a CLI-generated acknowledgment
 * such as the Esc-interrupt notice). Everything else — "kernel", "error", or
 * a tedi name — is an answer/terminal outcome, and committing it always
 * clears the thinking spinner (FIX: no path may leave the
 * spinner running after the answer is already in the transcript).
 */
const NON_ANSWER_SPEAKERS = new Set(["banner", "output", "you", "system"]);

const LIFECYCLE_LABELS: Record<Exclude<ReplLifecycle, "idle">, string> = {
	contacting_home: "Contacting Home",
	awaiting_settlement: "Waiting for Home run",
};

export class InkReplBridge implements ReplController {
	// External-state suppliers injected by runInteractiveInk
	readonly #getRegistryCount: () => number;
	readonly #getRegistryList: () => Array<{
		homeRunId: string;
		label: string;
		startedAt: number;
	}>;
	readonly #waitAll: () => Promise<void>;
	readonly #dispatch: (
		line: string,
	) => Promise<"exit" | "dispatched" | "handled">;
	readonly #cancel: (homeRunId: string, reason?: string) => Promise<unknown>;
	readonly #steer: (homeRunId: string, instruction: string) => Promise<unknown>;
	readonly #shouldShowThinking: (line: string) => boolean;
	readonly #thinkingLabelFor: (line: string) => string | undefined;
	readonly #resolveApproval: (input: {
		homeRunId: string;
		decision: "approve" | "reject";
		rememberForSession: boolean;
		scope: string;
		targetLabel: string;
	}) => Promise<void>;
	readonly #resolveQuestion: (answer: string) => Promise<void>;

	// Panel state owned by the bridge (polled from LiveActivityPanel data)
	readonly #getPanelStates: () => RunState[];

	// Pending transcript items to commit on next update
	#pendingCommits: TranscriptItem[] = [];
	#clearScreenSeq = 0;
	#clearScreenLines: string[] = [];

	// Update subscribers (typically just one — the REPL component)
	#handlers = new Set<UpdateHandler>();

	// Animation state
	#frameIndex = 0;
	#ticker: ReturnType<typeof setInterval> | undefined;

	// Pending state — the dead-air window between a dispatch and the first panel
	// row. The lifecycle gives that wait a stable, typed meaning.
	#thinkingSince: number | null = null;
	#thinkingLabel = "Thinking";
	#lifecycle: ReplLifecycle = "idle";

	// Activity heartbeat for the shared live → slow → stuck liveness ceiling.
	#lastActivityAt = 0;
	// Footer connection indicator (connected | reconnecting | lost).
	#connection: ConnectionStatus = "connected";
	// One input owner; the renderer receives read-only projections below.
	#activePrompt: ActivePrompt | null = null;
	#activityMode: ActivityDisplayMode = "compact";

	// Sequential counter for item ids
	#seq = 0;

	// Owned conversation poller (started in startConversationPoller; optional)
	#poller: ConversationPoller | undefined;
	// The banner renders before its background poller finishes its initial read.
	// A fast Home response can therefore be committed during that window. Keep
	// its deduplication markers until the poller attaches instead of dropping
	// them, or the first poll re-renders the answer as a second turn.
	#pendingSeenMessageIds = new Set<string>();
	#pendingSeenRunIds = new Set<string>();

	constructor(opts: {
		getRegistryCount: () => number;
		getRegistryList: () => Array<{
			homeRunId: string;
			label: string;
			startedAt: number;
		}>;
		waitAll: () => Promise<void>;
		dispatch: (line: string) => Promise<"exit" | "dispatched" | "handled">;
		getPanelStates: () => RunState[];
		cancel: (homeRunId: string, reason?: string) => Promise<unknown>;
		steer?: (homeRunId: string, instruction: string) => Promise<unknown>;
		shouldShowThinking?: (line: string) => boolean;
		thinkingLabelFor?: (line: string) => string | undefined;
		resolveApproval?: (input: {
			homeRunId: string;
			decision: "approve" | "reject";
			rememberForSession: boolean;
			scope: string;
			targetLabel: string;
		}) => Promise<void>;
		resolveQuestion?: (answer: string) => Promise<void>;
	}) {
		this.#getRegistryCount = opts.getRegistryCount;
		this.#getRegistryList = opts.getRegistryList;
		this.#waitAll = opts.waitAll;
		this.#dispatch = opts.dispatch;
		this.#getPanelStates = opts.getPanelStates;
		this.#cancel = opts.cancel;
		this.#steer =
			opts.steer ??
			(async () => {
				throw new Error("Steering is unavailable");
			});
		this.#shouldShowThinking = opts.shouldShowThinking ?? (() => true);
		this.#thinkingLabelFor = opts.thinkingLabelFor ?? (() => undefined);
		this.#resolveApproval =
			opts.resolveApproval ??
			(async () => {
				throw new Error("Approval resolution is unavailable");
			});
		this.#resolveQuestion =
			opts.resolveQuestion ??
			(async () => {
				throw new Error("Question resolution is unavailable");
			});

		// Animate only while there is live state. An unconditional ticker used to
		// publish the entire REPL state while idle and repainted the full dynamic
		// area ~11 times/second during work, amplifying flicker and stale frames.
		this.#ticker = setInterval(() => {
			if (this.#thinkingSince === null && this.#getPanelStates().length === 0) {
				return;
			}
			this.#frameIndex = nextFrameIndex(this.#frameIndex);
			this.#push();
		}, INK_TICK_MS);
		this.#ticker.unref?.();
	}

	/**
	 * Attach and start a ConversationPoller.  The bridge wires it so that:
	 *  - New assistant messages surface via commitLines("kernel", [...]) into
	 *    the Static transcript automatically.
	 *  - The dispatch path calls markDispatchInflight/clearDispatchInflight to
	 *    pause the poller during active dispatches.
	 *
	 * Call once after construction, before the REPL renders.
	 */
	startConversationPoller(poller: ConversationPoller): void {
		this.#poller = poller;
		for (const messageId of this.#pendingSeenMessageIds) {
			poller.markSeen(messageId);
		}
		this.#pendingSeenMessageIds.clear();
		for (const homeRunId of this.#pendingSeenRunIds) {
			poller.markRunSeen(homeRunId);
		}
		this.#pendingSeenRunIds.clear();
		poller.start();
	}

	/**
	 * Seed a message id into the poller's SEEN set.
	 * Call this when the dispatch path (backgroundSettleInk) commits a settled
	 * run answer, so the poller never double-shows that same assistant message.
	 *
	 * Before the poller attaches, the marker is buffered and applied on attach.
	 */
	markMessageSeen(messageId: string): void {
		if (this.#poller) {
			this.#poller.markSeen(messageId);
			return;
		}
		this.#pendingSeenMessageIds.add(messageId);
	}

	/**
	 * Retarget the attached poller to another conversation (REPL session
	 * switch). Safe to call when no poller is attached (no-op).
	 */
	setPollerConversation(conversationId: string): void {
		this.#poller?.setConversationId(conversationId);
	}

	/**
	 * Request a terminal + transcript wipe back to the banner (/new).
	 * Pushed synchronously so it lands BEFORE any lines the caller commits
	 * afterwards — the session-switch confirmation opens the fresh canvas.
	 */
	clearTranscript(lines: string[] = []): void {
		this.#clearScreenSeq++;
		this.#clearScreenLines = lines.flatMap((line) => line.split("\n"));
		this.#push();
	}

	/**
	 * Rebuild a session after a blocking command. First publish the cleared live
	 * state and yield one event-loop turn so Ink owns that cursor update; then
	 * wipe and redraw. Otherwise useStdout restores its previous dynamic frame
	 * (including the stale spinner) immediately after the new banner.
	 */
	async rebuildTranscript(lines: string[] = []): Promise<void> {
		this.#thinkingSince = null;
		this.#lastActivityAt = 0;
		this.#lifecycle = "idle";
		this.#push();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		this.clearTranscript(lines);
	}

	/**
	 * Seed a home run id into the poller's seen-run set.
	 * Call this from backgroundSettleInk before committing the answer so the
	 * poller skips the output message produced by that run.
	 *
	 * Before the poller attaches, the marker is buffered and applied on attach.
	 */
	markRunSeen(homeRunId: string): void {
		if (this.#poller) {
			this.#poller.markRunSeen(homeRunId);
			return;
		}
		this.#pendingSeenRunIds.add(homeRunId);
	}

	/**
	 * Inform the poller that a dispatch is in-flight.
	 * The poller skips poll ticks while in-flight to reduce unnecessary MCP calls.
	 * Matched with clearDispatchInflight.
	 */
	markDispatchInflight(): void {
		this.#poller?.setInflight();
		this.#setThinking(true, "awaiting_settlement");
	}

	/** Match for markDispatchInflight: called when a dispatch settles or errors. */
	clearDispatchInflight(): void {
		this.#poller?.clearInflight();
		this.#setThinking(false);
	}

	/**
	 * Toggle the pending status line. The REPL shows it only while there is no
	 * panel row, so the copy should describe the real boundary
	 * the operator is waiting on rather than a generic personality flourish.
	 */
	#setThinking(
		on: boolean,
		lifecycle: Exclude<ReplLifecycle, "idle"> = "contacting_home",
		label?: string,
	): void {
		if (on) {
			if (this.#thinkingSince === null) {
				this.#thinkingSince = Date.now();
				this.#lastActivityAt = this.#thinkingSince;
			}
			this.#lifecycle = lifecycle;
			this.#thinkingLabel = label ?? LIFECYCLE_LABELS[lifecycle];
		} else {
			if (this.#thinkingSince === null) return;
			this.#thinkingSince = null;
			this.#lastActivityAt = 0;
			this.#lifecycle = "idle";
		}
		this.#push();
	}

	/**
	 * Stamp an activity heartbeat — keeps an in-flight turn "live" (resets the
	 * no-activity gap that classifyTurnLiveness reads). No-op when no turn is in
	 * flight. Called on successful polls and activity updates.
	 */
	markActivity(): void {
		if (this.#thinkingSince !== null) this.#lastActivityAt = Date.now();
	}

	/** Update the unhealthy-only connection indicator; repaint on a real change. */
	setConnection(status: ConnectionStatus): void {
		if (this.#connection === status) return;
		this.#connection = status;
		this.#push();
	}

	buildPrompt(): string {
		// A clean Codex-style caret. Workspace identity lives in the write-once
		// banner, so the prompt stays uncluttered and matches the "› You" marker.
		return "› ";
	}

	showSessionPicker(
		items: SessionPickerItem[],
		currentConversationId: string,
	): void {
		this.#activePrompt = {
			kind: "session",
			value: { items, currentConversationId },
		};
		this.#push();
	}

	showApproval(prompt: Omit<ApprovalPromptState, "resolving">): void {
		this.#thinkingSince = null;
		this.#lastActivityAt = 0;
		this.#lifecycle = "idle";
		this.#activePrompt = {
			kind: "approval",
			value: { ...prompt, resolving: false },
		};
		this.#push();
	}

	showQuestion(prompt: Omit<QuestionPromptState, "resolving">): void {
		this.#thinkingSince = null;
		this.#lastActivityAt = 0;
		this.#lifecycle = "idle";
		this.#activePrompt = {
			kind: "question",
			value: { ...prompt, resolving: false },
		};
		this.#push();
	}

	dismissQuestion(): void {
		const prompt =
			this.#activePrompt?.kind === "question" ? this.#activePrompt.value : null;
		if (!prompt || prompt.resolving) return;
		this.#activePrompt = null;
		this.commitLines("kernel", prompt.prompt.split("\n"));
		this.commitLines("system", [
			"Question left unanswered. Your next message can answer it.",
		]);
	}

	async respondQuestion(answer: string): Promise<void> {
		const prompt =
			this.#activePrompt?.kind === "question" ? this.#activePrompt.value : null;
		const trimmed = answer.trim();
		if (!prompt || prompt.resolving || !trimmed) return;
		this.#activePrompt = null;
		this.commitLines("kernel", prompt.prompt.split("\n"));
		this.commitLines("you", trimmed.split("\n"));
		try {
			await this.#resolveQuestion(trimmed);
		} catch (error) {
			this.commitLines("error", [
				`Couldn't send that answer — ${error instanceof Error ? error.message : String(error)}. Edit it and try again.`,
			]);
		}
	}

	setActivityMode(mode: ActivityDisplayMode): void {
		if (this.#activityMode === mode) return;
		this.#activityMode = mode;
		this.#push();
	}

	cycleActivityMode(): void {
		const modes: ActivityDisplayMode[] = ["compact", "full", "errors"];
		const index = modes.indexOf(this.#activityMode);
		this.setActivityMode(modes[(index + 1) % modes.length] ?? "compact");
	}

	dismissApproval(): void {
		const prompt =
			this.#activePrompt?.kind === "approval" ? this.#activePrompt.value : null;
		if (!prompt || prompt.resolving) return;
		const { targetLabel, homeRunId } = prompt;
		this.#activePrompt = null;
		this.commitLines("system", [
			`${targetLabel} approval left pending. Resolve with /approve ${homeRunId} or /reject ${homeRunId}.`,
		]);
	}

	async respondApproval(
		decision: "approve" | "reject",
		rememberForSession: boolean,
	): Promise<void> {
		const prompt =
			this.#activePrompt?.kind === "approval" ? this.#activePrompt.value : null;
		if (!prompt || prompt.resolving) return;
		const resolving: ActivePrompt = {
			kind: "approval",
			value: { ...prompt, resolving: true },
		};
		this.#activePrompt = resolving;
		this.#push();
		try {
			await this.#resolveApproval({
				homeRunId: prompt.homeRunId,
				decision,
				rememberForSession,
				scope: prompt.scope,
				targetLabel: prompt.targetLabel,
			});
			// A later prompt may have arrived while the request was in flight.
			if (this.#activePrompt === resolving) this.#activePrompt = null;
			this.commitLines("system", [
				decision === "approve"
					? `${prompt.targetLabel} approved${rememberForSession ? " for this session" : ""}. Dispatching…`
					: `${prompt.targetLabel} delegation rejected.`,
			]);
		} catch (error) {
			const ownsPrompt = this.#activePrompt === resolving;
			if (ownsPrompt) {
				this.#activePrompt = { kind: "approval", value: prompt };
			}
			this.commitLines(ownsPrompt ? "error" : "system", [
				`Approval failed for ${prompt.targetLabel} (${prompt.homeRunId}) — ${error instanceof Error ? error.message : String(error)}`,
			]);
		}
	}

	dismissSessionPicker(): void {
		if (this.#activePrompt?.kind !== "session") return;
		this.#activePrompt = null;
		this.#push();
	}

	async selectSession(conversationId: string): Promise<void> {
		if (
			this.#activePrompt?.kind !== "session" ||
			!this.#activePrompt.value.items.some((item) => item.id === conversationId)
		) {
			return;
		}
		this.#activePrompt = null;
		this.#push();
		try {
			await this.dispatch(`/resume ${conversationId}`);
		} catch (error) {
			this.commitLines("error", [
				`Couldn't resume session — ${error instanceof Error ? error.message : String(error)}`,
			]);
		}
	}

	async dispatch(
		line: string,
	): Promise<"exit" | "dispatched" | "handled" | string[]> {
		// Local-only commands should feel immediate. Remote commands show pending
		// state from submit through kernel routing until a panel row or stream token
		// makes progress specific.
		const showThinking = this.#shouldShowThinking(line);
		if (showThinking) {
			// Pause proactive polling before the Home request starts. A fast server
			// answer can be persisted while ask is still returning; polling in
			// that gap would render it before the dispatch path has a run id to seed
			// or register, and the later settler would render it a second time.
			this.#poller?.setInflight();
			this.#setThinking(true, "contacting_home", this.#thinkingLabelFor(line));
		}
		let result: "exit" | "dispatched" | "handled";
		try {
			result = await this.#dispatch(line);
		} catch (error) {
			if (showThinking) this.clearDispatchInflight();
			throw error;
		}
		// Sync commands (handled/exit) never enter backgroundSettleInk, so stop the
		// spinner here. "dispatched" turns keep it until clearDispatchInflight — but
		// ONLY when a background settle is actually tracking the run (registry has
		// an entry). A fast-settled turn also returns "dispatched" after committing
		// inline WITHOUT ever entering backgroundSettleInk; nothing would ever call
		// clearDispatchInflight for it, so the spinner would run forever (the
		// "Percolating… escalating to stuck" bug). Registry-count zero means no
		// settler owns the spinner → clear it here.
		if (
			showThinking &&
			(result !== "dispatched" || this.#getRegistryCount() === 0)
		) {
			this.clearDispatchInflight();
		}
		return result;
	}

	onUpdate(handler: UpdateHandler): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	shouldExit(): boolean {
		return this.#getRegistryCount() === 0;
	}

	foregroundRun(): { homeRunId: string; label: string } | null {
		const list = this.#getRegistryList();
		const foreground = list[list.length - 1];
		return foreground
			? { homeRunId: foreground.homeRunId, label: foreground.label }
			: null;
	}

	async steerForeground(instruction: string): Promise<boolean> {
		const foreground = this.foregroundRun();
		if (!foreground) return false;
		try {
			await this.#steer(foreground.homeRunId, instruction);
			this.commitLines("system", [
				`Steered ${foreground.label}. The active run will incorporate your follow-up.`,
			]);
			return true;
		} catch (error) {
			this.commitLines("error", [
				`Steering failed — ${error instanceof Error ? error.message : String(error)}. The message is still queued.`,
			]);
			return false;
		}
	}

	async waitAll(): Promise<void> {
		await this.#waitAll();
	}

	/**
	 * Esc-to-interrupt: cancel the FOREGROUND run — the most recently started
	 * in-flight run. getRegistryList() sorts ascending by startedAt (see
	 * InFlightRegistry.list()), so the newest entry is the last one in the
	 * array. No-ops when nothing is in flight.
	 *
	 * Gives the operator immediate feedback: a "system" transcript line
	 * commits BEFORE the cancel round-trip is awaited. The run's own
	 * settlement (canceled status) surfaces normally afterward through the
	 * existing poller/backgroundSettleInk machinery — this method does not
	 * duplicate that.
	 */
	async interruptForeground(): Promise<void> {
		const list = this.#getRegistryList();
		const foreground = list[list.length - 1];
		if (!foreground) return;
		this.commitLines("system", [`Interrupting ${foreground.label}…`]);
		try {
			await this.#cancel(foreground.homeRunId, "canceled via Esc");
		} catch {
			// Best-effort: a failed cancel RPC leaves the run in flight; the
			// operator can retry with Esc or `/cancel <homeRunId>`.
		}
	}

	/**
	 * Commit captured lines from backgroundSettle as a transcript item.
	 *
	 * Committing a conversational ANSWER (any speaker outside
	 * NON_ANSWER_SPEAKERS — kernel, a tedi name, or error) settles the pending
	 * turn as a side effect: the thinking spinner stops. This is the
	 * defense-in-depth guarantee that once answer
	 * text is in the transcript, no code path can leave the spinner running
	 * (fast-settle, poller-surfaced completion, timeout fallback — all funnel
	 * through here).
	 */
	commitLines(speaker: string, lines: string[]): void {
		if (lines.length === 0) return;
		if (!NON_ANSWER_SPEAKERS.has(speaker)) {
			this.#thinkingSince = null;
			this.#lastActivityAt = 0;
			this.#lifecycle = "idle";
		}
		const item: TranscriptItem = {
			id: `b${(this.#seq++).toString()}`,
			speaker,
			// Normalize to TRUE lines: formatted output arrives as one
			// element per output call, each of which can embed newlines (a
			// whole markdown-rendered answer in one element). An embedded "\n"
			// inside the CommittedTurn marker-row <Text> splits the render mid-
			// element and breaks the gutter indentation — split here so every
			// consumer sees one array element per rendered line.
			lines: lines.flatMap((line) => line.split("\n")),
		};
		this.#pendingCommits.push(item);
		this.#push();
	}

	stop(): void {
		if (this.#ticker) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
		this.#poller?.stop();
		this.#poller = undefined;
	}

	#push(): void {
		const now = Date.now();
		const state: ReplState = {
			panelStates: this.#getPanelStates(),
			pendingCommits: this.#pendingCommits,
			frameIndex: this.#frameIndex,
			now,
			thinkingSince: this.#thinkingSince,
			thinkingLabel: this.#thinkingLabel,
			lifecycle: this.#lifecycle,
			liveness:
				this.#thinkingSince !== null
					? classifyTurnLiveness(this.#lastActivityAt, now)
					: "live",
			livenessElapsedMs:
				this.#thinkingSince !== null
					? Math.max(0, now - this.#thinkingSince)
					: 0,
			connection: this.#connection,
			sessionPicker:
				this.#activePrompt?.kind === "session"
					? this.#activePrompt.value
					: null,
			approvalPrompt:
				this.#activePrompt?.kind === "approval"
					? this.#activePrompt.value
					: null,
			questionPrompt:
				this.#activePrompt?.kind === "question"
					? this.#activePrompt.value
					: null,
			activityMode: this.#activityMode,
			clearScreenSeq: this.#clearScreenSeq,
			clearScreenLines: this.#clearScreenLines,
		};
		// Drain pending commits — they are consumed once by the REPL component
		this.#pendingCommits = [];
		this.#clearScreenLines = [];
		for (const handler of this.#handlers) {
			handler(state);
		}
	}
}
