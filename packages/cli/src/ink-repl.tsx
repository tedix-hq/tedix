/**
 * ink-based interactive REPL for the tedix CLI.
 *
 * Architecture:
 *   <Static items={transcript}> — committed turns, written once to scrollback
 *   <Box> (dynamic area)
 *     <InkLivePanel>   — in-flight run panel (spinner + live data)
 *     <TextInput>      — prompt line
 *
 * ALL business logic (client, auth, inflight registry, backgroundSettle,
 * dispatchNonBlockingLine, commands) is wired in externally via the
 * ReplController — this file is presentation + React state only.
 */

import {
	CONNECTION_STATUS_COPY,
	type ConnectionStatus,
} from "./operator/connection-status";
import {
	formatTurnDuration,
	type TurnLivenessLevel,
} from "./operator/turn-liveness";
import {
	Box,
	useBoxMetrics,
	type DOMElement,
	Static,
	Text,
	useApp,
	useInput,
	useIsScreenReaderEnabled,
	useStdout,
	useWindowSize,
} from "ink";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { completeInput, replaceMentionCompletion } from "./composer";
import TextInput from "./composer-input";
import { formatDuration } from "./format";
import { InkLivePanel } from "./ink-live-panel";
import { type ActivityDisplayMode, FRAMES, type RunState } from "./live-panel";
import { MESSAGE_QUEUE_LIMIT, MessageQueue } from "./message-queue";
import {
	appendReplHistory,
	findPreviousHistoryMatch,
	loadReplHistory,
} from "./repl-history";
import { THEME_HEX } from "./theme";
import { DecisionDetail } from "./tui-detail";
import {
	approvalIdentity,
	questionIdentity,
	keyboardOwner,
	transitionInteraction,
	type InteractionMode,
	type InteractionEvent,
} from "./tui-interaction";

// ── Transcript item (committed, write-once) ──────────────────────────────────

export interface TranscriptItem {
	id: string;
	/** Label: "you", "kernel", "error", or a tedi name. */
	speaker: string;
	lines: string[];
}

export interface SessionPickerItem {
	id: string;
	title: string;
	lastMessageAt?: string;
}

export interface SessionPickerState {
	items: SessionPickerItem[];
	currentConversationId: string;
}

export interface ApprovalPromptState {
	homeRunId: string;
	targetLabel: string;
	detail: string;
	reason?: string;
	scope: string;
	scopeLabel: string;
	resolving: boolean;
}

export interface QuestionPromptState {
	homeRunId: string;
	prompt: string;
	options: Array<{ label: string; value: string }>;
	resolving: boolean;
}

/**
 * Per-speaker turn marker + role colors (Claude-Code-style ● / › markers).
 * The default speakers ("you", "kernel") render label-FREE, Claude-Code
 * style — the marker + body color carry the role; a name would be noise.
 * Speakers that carry real information keep a label: tedi names ("CTO") say
 * WHICH worker answered, and error/system flag non-conversational lines.
 * `bodyColor` differentiates roles: the operator's own words are context, not
 * content, so "you" bodies render muted.
 */
const TURN_STYLES: Record<
	string,
	{ marker: string; color: string; label: string | null; bodyColor?: string }
> = {
	you: {
		marker: "›",
		color: THEME_HEX.muted,
		label: null,
		bodyColor: THEME_HEX.muted,
	},
	kernel: { marker: "●", color: THEME_HEX.accent, label: null },
	error: { marker: "●", color: THEME_HEX.danger, label: "Error" },
	system: {
		marker: "●",
		color: THEME_HEX.faint,
		label: null,
		bodyColor: THEME_HEX.faint,
	},
	handoff: {
		marker: "●",
		color: THEME_HEX.faint,
		label: null,
		bodyColor: THEME_HEX.faint,
	},
};

function turnStyle(speaker: string): {
	marker: string;
	color: string;
	label: string | null;
	bodyColor?: string;
} {
	// Unknown speakers are tedi names → a warm ● with the name as the label.
	return (
		TURN_STYLES[speaker] ?? {
			marker: "●",
			color: THEME_HEX.warn,
			label: speaker,
		}
	);
}

/** Slash commands are controls; only their result belongs in the transcript. */
export function shouldEchoSubmittedLine(line: string): boolean {
	return !line.startsWith("/");
}

/**
 * A committed conversational turn, Claude-Code style: the body's FIRST line
 * shares the marker line (`› what can you do?` / `● Here's what…`), with
 * continuation lines indented 2 spaces so the markers form a clean gutter.
 * Labeled speakers (tedi names, Error) keep the label inline before the body.
 */
function CommittedTurn({ item }: { item: TranscriptItem }) {
	const s = turnStyle(item.speaker);
	// Label-free speakers put the first NON-BLANK body line on the marker row
	// (captured console output routinely leads with a blank line, which would
	// otherwise render a lonely "●" with the answer below it).
	const firstIdx =
		s.label === null
			? item.lines.findIndex((line) => line.trim().length > 0)
			: -1;
	const first = firstIdx >= 0 ? (item.lines[firstIdx] ?? "") : "";
	const rest = firstIdx >= 0 ? item.lines.slice(firstIdx + 1) : item.lines;
	return (
		<>
			<Text>
				<Text color={s.color}>
					{s.marker}
					{s.label ? <Text bold>{` ${s.label}`}</Text> : null}
				</Text>
				{s.label ? null : (
					<Text {...(s.bodyColor ? { color: s.bodyColor } : {})}>
						{` ${first}`}
					</Text>
				)}
			</Text>
			<Box flexDirection="column" marginLeft={2}>
				{rest.map((line, i) => (
					<Text
						key={`${item.id}-${i}`}
						{...(s.bodyColor ? { color: s.bodyColor } : {})}
					>
						{line}
					</Text>
				))}
			</Box>
		</>
	);
}

// ── Controller interface (wired by index.ts) ─────────────────────────────────

/**
 * External interface injected into the REPL.
 *
 * index.ts creates a ReplController wrapping dispatchNonBlockingLine,
 * backgroundSettle, the InFlightRegistry, and the LiveActivityPanel data.
 * The REPL calls these methods and subscribes to state updates via onUpdate.
 */
export interface ReplController {
	/** Prompt prefix — the composer caret (e.g. "› "). */
	buildPrompt(): string;

	/**
	 * Dispatch one input line. Returns:
	 *   "exit"       → quit
	 *   "dispatched" → non-blocking send; panel/settled will update via onUpdate
	 *   "handled"    → slash command handled inline
	 *   lines[]      → blocking result lines to commit to transcript immediately
	 */
	dispatch(line: string): Promise<"exit" | "dispatched" | "handled" | string[]>;

	/**
	 * Subscribe to panel/streaming state updates (called by the active-state
	 * animation ticker AND
	 * by backgroundSettle when a run settles). The REPL re-renders on each call.
	 */
	onUpdate(handler: (state: ReplState) => void): () => void;

	/** True when the REPL should quit (e.g. registry.count===0 after /exit). */
	shouldExit(): boolean;

	/** Wait for all in-flight runs to settle (called on Ctrl-D / /exit). */
	waitAll(): Promise<void>;

	/**
	 * Interrupt the foreground (most-recently-started) in-flight run — bound
	 * to Esc. No-ops when nothing is in flight; the run settles normally as
	 * "canceled" afterward through the existing poller/settle machinery.
	 */
	interruptForeground(): Promise<void>;
	/** Active foreground run, used to queue instead of accidentally forking. */
	foregroundRun(): { homeRunId: string; label: string } | null;
	/** Send an in-progress correction to the foreground Home run. */
	steerForeground(instruction: string): Promise<boolean>;
	/** Change how much nested tool/delegation activity is visible. */
	setActivityMode(mode: ActivityDisplayMode): void;
	cycleActivityMode(): void;

	/** Close the active session picker without changing conversations. */
	dismissSessionPicker(): void;

	/** Close the picker and resume the selected Home conversation. */
	selectSession(conversationId: string): Promise<void>;

	/** Leave a pending approval parked and restore the composer. */
	dismissApproval(): void;

	/** Resolve the active approval without creating a second inference turn. */
	respondApproval(
		decision: "approve" | "reject",
		rememberForSession: boolean,
	): Promise<void>;
	/** Leave an ask_human prompt unanswered and restore the composer. */
	dismissQuestion(): void;
	/** Answer an ask_human prompt as the next durable Home turn. */
	respondQuestion(answer: string): Promise<void>;
}

/** Explicit remote-turn boundary shown by the dynamic Ink surface. */
export type ReplLifecycle = "idle" | "contacting_home" | "awaiting_settlement";

/** Full render state pushed to the REPL by the controller. */
export interface ReplState {
	/** Current in-flight runs for the live panel. */
	panelStates: RunState[];
	/** Settled transcript items to commit since last update. */
	pendingCommits: TranscriptItem[];
	/** In-flight spinner frame index (0–9). */
	frameIndex: number;
	/** Current timestamp for elapsed-time rendering. */
	now: number;
	/** Pending "thinking" start time (null = not thinking) + the verb to show. */
	thinkingSince: number | null;
	thinkingLabel: string;
	/** Typed current remote-turn boundary; idle when no turn is pending. */
	lifecycle: ReplLifecycle;
	/** Shared live → slow → stuck turn-liveness verdict + elapsed since start. */
	liveness: TurnLivenessLevel;
	livenessElapsedMs: number;
	/** Kernel transport state for the unhealthy-only indicator above the composer. */
	connection: ConnectionStatus;
	/** Interactive /sessions picker; null outside that modal interaction. */
	sessionPicker: SessionPickerState | null;
	/** Inline approval interaction; owns keyboard input while present. */
	approvalPrompt: ApprovalPromptState | null;
	/** Kernel ask_human interaction; owns keyboard input while present. */
	questionPrompt: QuestionPromptState | null;
	/** Nested tool/delegation verbosity for the dynamic live panel. */
	activityMode: ActivityDisplayMode;
	/**
	 * Monotonic clear-screen request counter (/new). When it advances,
	 * the REPL wipes the terminal + transcript back to the banner — same as
	 * Ctrl-L — before appending this state's pendingCommits.
	 */
	clearScreenSeq: number;
	/** Lines written after the banner in the same clear-screen frame. */
	clearScreenLines: string[];
}

// ── REPL component ────────────────────────────────────────────────────────────

interface ReplProps {
	controller: ReplController;
	greeting: string[];
	/** Slash commands for the typeahead menu, including their displayed signature. */
	slashCommands?: {
		argHint?: string;
		description: string;
		name: string;
		source: "home" | "interactive";
	}[];
	/**
	 * Keystrokes captured while ink was still loading/mounting (see the early
	 * stdin buffer in `runInteractiveInk`) — seeded as the composer's initial
	 * value so typing during startup is never lost.
	 */
	initialInput?: string;
}

export function InkRepl({
	controller,
	greeting,
	slashCommands,
	initialInput,
}: ReplProps) {
	const { exit } = useApp();
	const { write: writeStdout } = useStdout();
	const { rows } = useWindowSize();
	const screenReader = useIsScreenReaderEnabled();
	const dynamicRows = Math.max(1, rows - 1);
	const pickerVisibleRows = Math.max(1, Math.min(10, rows - 8));

	const initialTranscript = (): TranscriptItem[] => {
		// Greeting lines committed as the first item.
		if (greeting.length === 0) return [];
		return [{ id: "greeting", speaker: "banner", lines: greeting }];
	};

	type LiveState = Omit<
		ReplState,
		"pendingCommits" | "clearScreenLines" | "clearScreenSeq"
	>;
	// Transcript and live state share one React snapshot. Controller callbacks
	// originate outside React events, so separate setters can flush as adjacent
	// terminal frames even when their logical update is atomic. Terminals that
	// miss the intervening erase then show a duplicated answer/composer.
	const [renderState, setRenderState] = useState<{
		transcript: TranscriptItem[];
		live: LiveState;
	}>(() => ({
		transcript: initialTranscript(),
		live: {
			panelStates: [],
			frameIndex: 0,
			now: Date.now(),
			thinkingSince: null,
			thinkingLabel: "Thinking",
			lifecycle: "idle",
			liveness: "live",
			livenessElapsedMs: 0,
			connection: "connected",
			sessionPicker: null,
			approvalPrompt: null,
			questionPrompt: null,
			activityMode: "compact",
		},
	}));
	const { transcript, live } = renderState;
	const {
		panelStates,
		frameIndex,
		now,
		thinkingSince,
		thinkingLabel,
		liveness,
		livenessElapsedMs,
		connection,
		sessionPicker,
		approvalPrompt,
		questionPrompt,
		activityMode,
	} = live;

	// Input state — seeded with any keystrokes buffered during startup.
	const [inputValue, setInputValue] = useState(initialInput ?? "");
	const inputValueRef = useRef(inputValue);
	useLayoutEffect(() => {
		inputValueRef.current = inputValue;
	}, [inputValue]);
	const [contentRows, setContentRows] = useState(1);
	const contentRowsRef = useRef(1);
	const handleContentRowsChange = useCallback((totalRows: number) => {
		contentRowsRef.current = Math.max(1, totalRows);
		setContentRows(contentRowsRef.current);
	}, []);
	const [prompt, setPrompt] = useState(() => controller.buildPrompt());
	// Prevent a second submit while a blocking slash command is resolving, but
	// do not turn that guard into a render state. Replacing the composer with an
	// ellipsis produced two unnecessary full-width frames around every command.
	const submittingRef = useRef(false);
	const [exitPending, setExitPending] = useState(false);
	const queueRef = useRef(new MessageQueue());
	const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
	const refreshQueue = useCallback(
		() => setQueuedMessages(queueRef.current.list()),
		[],
	);
	const [, setSessionPickerSel] = useState(0);
	const sessionPickerSelRef = useRef(0);
	const sessionPickerIdentityRef = useRef<SessionPickerState | null>(null);
	if (sessionPickerIdentityRef.current !== sessionPicker) {
		sessionPickerIdentityRef.current = sessionPicker;
		if (sessionPicker) {
			const currentIndex = sessionPicker.items.findIndex(
				(item) => item.id === sessionPicker.currentConversationId,
			);
			sessionPickerSelRef.current = currentIndex >= 0 ? currentIndex : 0;
		} else {
			sessionPickerSelRef.current = 0;
		}
	}
	const sessionPickerSel = sessionPickerSelRef.current;
	const [, setApprovalSel] = useState(0);
	const approvalSelRef = useRef(0);
	const approvalKey = approvalIdentity(approvalPrompt);
	const approvalIdentityRef = useRef<string | null>(null);
	if (approvalIdentityRef.current !== approvalKey) {
		approvalIdentityRef.current = approvalKey;
		approvalSelRef.current = 0;
	}
	const approvalSel = approvalSelRef.current;
	const [, setQuestionSel] = useState(0);
	const questionSelRef = useRef(0);
	const questionKey = questionIdentity(questionPrompt);
	const questionIdentityRef = useRef<string | null>(null);
	if (questionIdentityRef.current !== questionKey) {
		questionIdentityRef.current = questionKey;
		questionSelRef.current = 0;
	}
	const questionSel = questionSelRef.current;
	const [questionDraft, setQuestionDraft] = useState("");
	const questionEntrySubmitBlockedRef = useRef(false);
	const liveContentRef = useRef<DOMElement>(null);
	const [liveOffset, setLiveOffset] = useState(0);
	const { height: liveHeight } = useBoxMetrics(liveContentRef);
	const interactionContext = {
		question: questionKey,
		approval: approvalKey,
		picker: Boolean(sessionPicker),
	};
	const interactionContextRef = useRef(interactionContext);
	interactionContextRef.current = interactionContext;
	const [interactionMode, setInteractionMode] = useState<InteractionMode>({
		kind: "default",
	});
	const interactionModeRef = useRef<InteractionMode>(interactionMode);
	const changeInteraction = useCallback((event: InteractionEvent) => {
		const next = transitionInteraction(
			interactionContextRef.current,
			interactionModeRef.current,
			event,
		);
		interactionModeRef.current = next;
		setInteractionMode(next);
	}, []);
	const currentOwner = () =>
		keyboardOwner(interactionContextRef.current, interactionModeRef.current);
	const owner = keyboardOwner(interactionContext, interactionMode);
	const inspecting = owner === "decision_detail";
	const queueInspecting = owner === "queue_detail";
	const questionEditing = owner === "question_editor";
	const decisionIdentity = questionKey ?? approvalKey;
	const decisionIdentityRef = useRef(decisionIdentity);
	if (decisionIdentityRef.current !== decisionIdentity) {
		decisionIdentityRef.current = decisionIdentity;
		setQuestionDraft("");
		interactionModeRef.current = { kind: "default" };
		setInteractionMode(interactionModeRef.current);
	}

	// Continuation buffer for line-ending-with-backslash
	const continuationRef = useRef<string[]>([]);
	// Sequential counter for transcript ids
	const seqRef = useRef(0);
	const nextId = () => `t${(seqRef.current++).toString()}`;

	// Command history (↑/↓ recall). historyIdx === -1 means "editing a fresh
	// line"; draftRef preserves that in-progress line while browsing history.
	// Seeded once from the persistent history file so recall survives restarts.
	const historyLoadedRef = useRef(false);
	const historyRef = useRef<string[]>([]);
	if (!historyLoadedRef.current) {
		historyLoadedRef.current = true;
		historyRef.current = loadReplHistory();
	}
	const draftRef = useRef("");
	const [historyIdx, setHistoryIdx] = useState(-1);
	// Ctrl-R retains the original query while repeated presses walk backward
	// through matches. Any ordinary edit or arrow-history navigation resets it.
	const reverseSearchQueryRef = useRef<string | null>(null);
	const reverseSearchBeforeRef = useRef<number | null>(null);
	const [reverseSearchStatus, setReverseSearchStatus] = useState<string | null>(
		null,
	);
	const resetReverseSearch = useCallback(() => {
		reverseSearchQueryRef.current = null;
		reverseSearchBeforeRef.current = null;
		setReverseSearchStatus(null);
	}, []);
	const handleInputChange = useCallback(
		(value: string) => {
			if (currentOwner() !== "composer") return;
			resetReverseSearch();
			if (value !== inputValue) {
				queueRef.current.disarmCancel();
				refreshQueue();
			}
			inputValueRef.current = value;
			setInputValue(value);
		},
		[inputValue, refreshQueue, resetReverseSearch],
	);

	// Slash-command typeahead menu (open while typing "/cmd" with no space yet).
	const [menuSel, setMenuSel] = useState(0);
	// Esc closes the menu view for the CURRENT input without clearing it; any
	// further edit to the input (typing, backspace, history recall, submit)
	// clears the dismissal so the menu can reopen naturally (see the effect
	// below).
	const [menuDismissed, setMenuDismissed] = useState(false);
	const dismissNextMenuRef = useRef(false);
	const cmds = slashCommands ?? [];
	const menuPartial =
		inputValue.startsWith("/") &&
		!inputValue.includes(" ") &&
		!inputValue.includes("\n")
			? inputValue.slice(1)
			: null;
	const slashMenuItems =
		menuPartial !== null
			? cmds.filter((c) => c.name.startsWith(menuPartial)).slice(0, 8)
			: [];
	const mentionCompletions = useMemo(() => {
		const [matches] = completeInput(inputValue, []);
		return !inputValue.includes("\n") && inputValue.match(/(?:^|\s)@[^\s]*$/)
			? matches.slice(0, 8)
			: [];
	}, [inputValue]);
	const menuKind =
		slashMenuItems.length > 0
			? "slash"
			: mentionCompletions.length > 0
				? "mention"
				: null;
	const menuItems =
		menuKind === "slash"
			? slashMenuItems.map((command) => ({
					description: command.description,
					label: `/${command.name}${command.argHint ? ` ${command.argHint}` : ""}`,
					value: command.name,
				}))
			: mentionCompletions.map((completion) => ({
					description: completion.endsWith("/")
						? "Browse directory"
						: "Attach file",
					label: completion,
					value: completion,
				}));
	const menuOpen = menuItems.length > 0 && !menuDismissed;
	const menuSelIdx = Math.min(menuSel, Math.max(0, menuItems.length - 1));

	useEffect(() => {
		if (dismissNextMenuRef.current) {
			dismissNextMenuRef.current = false;
			setMenuDismissed(true);
			return;
		}
		setMenuDismissed(false);
	}, [inputValue]);

	// Last applied clear-screen request (see ReplState.clearScreenSeq).
	const clearSeqRef = useRef(0);
	const clearAndBanner = `\x1b[2J\x1b[3J\x1b[H${
		greeting.length > 0 ? `${greeting.join("\n")}\n` : ""
	}`;

	// Subscribe to controller state updates
	useEffect(() => {
		const unsubscribe = controller.onUpdate((state: ReplState) => {
			const { pendingCommits, clearScreenLines, clearScreenSeq, ...nextLive } =
				state;
			const clearRequested = clearScreenSeq > clearSeqRef.current;
			// A clear-only publication must not schedule a second React frame after
			// writeStdout has already restored the composer. The bridge does not
			// mutate live panel/stream state in clearTranscript(), so retaining the
			// current snapshot is exact and keeps the clear to one terminal frame.
			setRenderState((previous) => ({
				live: clearRequested ? previous.live : nextLive,
				transcript:
					pendingCommits.length > 0
						? [...previous.transcript, ...pendingCommits]
						: previous.transcript,
			}));
			setPrompt(controller.buildPrompt());

			// /new: wipe the terminal and redraw the banner in the SAME
			// Ink-owned write. Writing the clear first and appending a new <Static>
			// banner in a later React render sends the composer twice (once restored
			// by write(), once after the Static append), which recreates the stacked
			// frame failure on terminals that miss an erase sequence.
			if (clearRequested) {
				clearSeqRef.current = clearScreenSeq;
				// Ink must remain the sole owner of its cursor bookkeeping. useStdout
				// clears/restores the dynamic frame around the write; writing directly
				// to process.stdout strands composers in some terminal emulators.
				writeStdout(
					`${clearAndBanner}${
						clearScreenLines.length > 0
							? `${clearScreenLines.join("\n")}\n`
							: ""
					}`,
				);
			}
		});
		return unsubscribe;
	}, [clearAndBanner, controller, writeStdout]);

	// Keyboard handling: escape → menu nav → exit/clear → history.
	useInput((input, key) => {
		const activeOwner = currentOwner();
		if (activeOwner === "decision_detail" || activeOwner === "queue_detail") {
			if (key.escape) changeInteraction({ type: "back" });
			else if (key.ctrl && input === "o" && activeOwner === "decision_detail")
				changeInteraction({ type: "inspect_decision" });
			else if (key.ctrl && input === "q" && activeOwner === "queue_detail")
				changeInteraction({ type: "inspect_queue", entries: [] });
			return;
		}
		if (key.ctrl && input === "o" && (questionPrompt || approvalPrompt)) {
			changeInteraction({ type: "inspect_decision" });
			return;
		}
		if (key.ctrl && input === "q" && activeOwner === "composer") {
			changeInteraction({
				type: "inspect_queue",
				entries: queueRef.current.list(),
			});
			return;
		}
		if (activeOwner === "question_editor") {
			if (key.escape) changeInteraction({ type: "back" });
			// Every editing key, including arrows, digits and Enter, belongs to TextInput.
			return;
		}
		if (activeOwner === "question_choices" && questionPrompt) {
			if (questionPrompt.resolving) return;
			const count = questionPrompt.options.length + 1;
			const freeTextIndex = count - 1;
			if (key.escape) {
				controller.dismissQuestion();
			} else if (key.upArrow) {
				const next = (questionSelRef.current - 1 + count) % count;
				questionSelRef.current = next;
				setQuestionSel(next);
				if (next === freeTextIndex)
					changeInteraction({ type: "edit_question" });
			} else if (key.downArrow) {
				const next = (questionSelRef.current + 1) % count;
				questionSelRef.current = next;
				setQuestionSel(next);
				if (next === freeTextIndex)
					changeInteraction({ type: "edit_question" });
			} else if (questionSelRef.current === freeTextIndex && key.return) {
				// Selecting the editor consumes Enter, even if its mounted handler sees
				// the same event later in this input burst.
				questionEntrySubmitBlockedRef.current = true;
				queueMicrotask(() => {
					questionEntrySubmitBlockedRef.current = false;
				});
				changeInteraction({ type: "edit_question" });
			} else if (
				questionSelRef.current < questionPrompt.options.length &&
				key.return
			) {
				const selected = questionPrompt.options[questionSelRef.current];
				if (selected) void controller.respondQuestion(selected.value);
			} else if (
				!key.ctrl &&
				/^[1-9]$/.test(input) &&
				Number(input) <= questionPrompt.options.length &&
				questionSelRef.current !== freeTextIndex
			) {
				const selected = questionPrompt.options[Number(input) - 1];
				if (selected) void controller.respondQuestion(selected.value);
			}
			return;
		}

		// Approval is a true modal interaction. Ordinary prose (including the word
		// "approved") cannot leak through as a new Home turn while consent is due.
		if (activeOwner === "approval" && approvalPrompt) {
			if (approvalPrompt.resolving) return;
			const count = 3;
			if (key.escape) {
				controller.dismissApproval();
			} else if (key.upArrow) {
				const next = (approvalSelRef.current - 1 + count) % count;
				approvalSelRef.current = next;
				setApprovalSel(next);
			} else if (key.downArrow) {
				const next = (approvalSelRef.current + 1) % count;
				approvalSelRef.current = next;
				setApprovalSel(next);
			} else if (key.return) {
				if (approvalSelRef.current === 0)
					void controller.respondApproval("approve", false);
				if (approvalSelRef.current === 1)
					void controller.respondApproval("approve", true);
				if (approvalSelRef.current === 2)
					void controller.respondApproval("reject", false);
			}
			return;
		}

		// /sessions is modal: while the picker is open, the composer is absent and
		// every key belongs here. Enter must never leak into an empty message submit,
		// and Up/Down must never leak into command-history navigation.
		if (activeOwner === "sessions" && sessionPicker) {
			const count = sessionPicker.items.length;
			if (key.escape) {
				controller.dismissSessionPicker();
			} else if (key.upArrow && count > 0) {
				const next = (sessionPickerSelRef.current - 1 + count) % count;
				sessionPickerSelRef.current = next;
				setSessionPickerSel(next);
			} else if (key.downArrow && count > 0) {
				const next = (sessionPickerSelRef.current + 1) % count;
				sessionPickerSelRef.current = next;
				setSessionPickerSel(next);
			} else if ((key.pageUp || key.pageDown) && count > 0) {
				const next = Math.max(
					0,
					Math.min(
						count - 1,
						sessionPickerSelRef.current +
							(key.pageDown ? pickerVisibleRows : -pickerVisibleRows),
					),
				);
				sessionPickerSelRef.current = next;
				setSessionPickerSel(next);
			} else if (key.return) {
				const selected = sessionPicker.items[sessionPickerSelRef.current];
				if (selected) void controller.selectSession(selected.id);
			}
			return;
		}

		if (key.pageUp || key.pageDown) {
			setLiveOffset((previous) =>
				Math.max(
					0,
					Math.min(
						Math.max(0, liveHeight - liveRows),
						previous +
							(key.pageDown ? Math.max(1, liveRows) : -Math.max(1, liveRows)),
					),
				),
			);
			return;
		}

		// Esc: most-locally-relevant action wins. Closing an open menu beats
		// interrupting a run beats doing nothing.
		if (key.escape) {
			if (menuOpen) {
				// Close the menu view without touching the typed input —
				// structurally mirrors what Tab does (dismiss the menu) but
				// inserts no completion.
				setMenuDismissed(true);
				setMenuSel(0);
			} else if (controller.foregroundRun()) {
				const queued = queueRef.current.takeNext();
				if (queued) {
					refreshQueue();
					setRenderState((previous) => ({
						...previous,
						transcript: [
							...previous.transcript,
							{
								id: nextId(),
								speaker: "you",
								lines: [`${queued}  [steered]`],
							},
						],
					}));
					void controller.steerForeground(queued).then((sent) => {
						if (!sent) {
							queueRef.current.restoreNext(queued);
							refreshQueue();
						}
					});
				} else if (queueRef.current.armCancel()) {
					refreshQueue();
				} else {
					queueRef.current.disarmCancel();
					refreshQueue();
					void controller.interruptForeground();
				}
			}
			return;
		}
		// Slash-command menu navigation takes priority over history while open.
		if (menuOpen && contentRowsRef.current <= 1 && key.upArrow) {
			setMenuSel(Math.max(0, menuSelIdx - 1));
			return;
		}
		if (menuOpen && contentRowsRef.current <= 1 && key.downArrow) {
			setMenuSel(Math.min(menuItems.length - 1, menuSelIdx + 1));
			return;
		}
		if (menuOpen && key.tab) {
			const sel = menuItems[menuSelIdx];
			if (sel) {
				if (menuKind === "mention" && !sel.value.endsWith("/")) {
					dismissNextMenuRef.current = true;
				}
				setInputValue(
					menuKind === "slash"
						? `/${sel.value} `
						: replaceMentionCompletion(inputValue, sel.value),
				);
				setMenuSel(0);
			}
			return;
		}
		if (key.ctrl && input === "g") {
			controller.cycleActivityMode();
			return;
		}
		if (key.ctrl && input === "c") {
			// Ctrl-C in idle REPL: clear input if non-empty, otherwise exit
			if (inputValue.length > 0) {
				setInputValue("");
				continuationRef.current = [];
				resetReverseSearch();
			} else {
				setExitPending(true);
			}
		} else if (key.ctrl && input === "d") {
			// Ctrl-D quits when the line is empty (as the banner advertises).
			if (inputValue.length === 0) setExitPending(true);
		} else if (key.ctrl && input === "l") {
			// Clear + banner are one Ink-owned write so write() restores the dynamic
			// composer exactly once after the new static canvas.
			writeStdout(clearAndBanner);
			resetReverseSearch();
		} else if (key.ctrl && input === "r") {
			const query = reverseSearchQueryRef.current ?? inputValue;
			const before =
				reverseSearchBeforeRef.current ?? historyRef.current.length;
			const match = findPreviousHistoryMatch(historyRef.current, query, before);
			reverseSearchQueryRef.current = query;
			if (match) {
				reverseSearchBeforeRef.current = match.index;
				setInputValue(match.value);
				setReverseSearchStatus(
					`Ctrl-R · ${query || "history"} · match ${match.index + 1}/${historyRef.current.length}`,
				);
			} else {
				setReverseSearchStatus(
					`Ctrl-R · no earlier match for ${query ? `“${query}”` : "history"}`,
				);
			}
		} else if (
			key.upArrow &&
			!inputValueRef.current.includes("\n") &&
			contentRowsRef.current <= 1
		) {
			resetReverseSearch();
			// Recall older history; stash the in-progress draft on the first ↑.
			const h = historyRef.current;
			if (h.length === 0) return;
			const idx =
				historyIdx === -1 ? h.length - 1 : Math.max(0, historyIdx - 1);
			if (historyIdx === -1) draftRef.current = inputValue;
			setHistoryIdx(idx);
			setInputValue(h[idx] ?? "");
		} else if (
			key.downArrow &&
			!inputValueRef.current.includes("\n") &&
			contentRowsRef.current <= 1
		) {
			resetReverseSearch();
			// Walk toward newer history; past the newest entry, restore the draft.
			if (historyIdx === -1) return;
			const h = historyRef.current;
			const next = historyIdx + 1;
			if (next >= h.length) {
				setHistoryIdx(-1);
				setInputValue(draftRef.current);
			} else {
				setHistoryIdx(next);
				setInputValue(h[next] ?? "");
			}
		}
	});

	// Exit when flagged
	useEffect(() => {
		if (!exitPending) return;
		const run = async () => {
			if (controller.shouldExit()) {
				exit();
				return;
			}
			// Wait for in-flight runs before exiting
			await controller.waitAll().catch(() => {});
			exit();
		};
		void run();
	}, [exitPending, controller, exit]);

	const handleSubmit = useCallback(
		async (
			value: string,
			options: { bypassQueue?: boolean; origin?: "queued" | "parallel" } = {},
		) => {
			if (submittingRef.current || currentOwner() !== "composer") return;
			resetReverseSearch();
			// Menu-aware Enter: with the slash menu open and a PARTIAL command typed
			// ("/" or "/se"), Enter executes the highlighted item instead of
			// submitting the raw prefix (which would only produce "Unknown
			// command"). An exactly-typed command submits as typed, args intact.
			let submitted = value;
			if (menuKind === "slash" && menuOpen && menuPartial !== null) {
				const sel = menuItems[menuSelIdx];
				const exact = menuItems.some((c) => c.value === menuPartial);
				if (sel && !exact) {
					submitted = `/${sel.value}`;
				}
			}
			const trimmed = submitted.trim();
			setInputValue("");
			setMenuSel(0);

			// Handle backslash continuation
			if (trimmed.endsWith("\\")) {
				continuationRef.current.push(trimmed.slice(0, -1));
				return;
			}

			// Compose multiline if there was a continuation
			let line: string;
			if (continuationRef.current.length > 0) {
				continuationRef.current.push(trimmed);
				line = continuationRef.current.join("\n");
				continuationRef.current = [];
			} else {
				line = trimmed;
			}

			if (!line) return;
			let dispatchLine = line;
			let origin = options.origin;
			if (line === "/parallel" || line.startsWith("/parallel ")) {
				const parallelMessage = line.slice("/parallel".length).trim();
				if (!parallelMessage) {
					setRenderState((previous) => ({
						...previous,
						transcript: [
							...previous.transcript,
							{
								id: nextId(),
								speaker: "output",
								lines: ["Usage: /parallel <message>"],
							},
						],
					}));
					return;
				}
				dispatchLine = parallelMessage;
				origin = "parallel";
			}

			// Record in history (dedup consecutive) and reset the browse cursor.
			const hist = historyRef.current;
			if (hist[hist.length - 1] !== line) {
				hist.push(line);
				appendReplHistory(line);
			}
			setHistoryIdx(-1);
			draftRef.current = "";

			// A second ordinary message is a follow-up, not an accidental sibling
			// Home run. Keep it visible in a bounded queue; /parallel is the explicit
			// escape hatch when the operator really wants concurrent inference.
			if (
				!options.bypassQueue &&
				origin !== "parallel" &&
				!dispatchLine.startsWith("/") &&
				controller.foregroundRun()
			) {
				if (!queueRef.current.enqueue(dispatchLine)) {
					setInputValue(dispatchLine);
				}
				refreshQueue();
				return;
			}

			// Echo conversational input into scrollback. Slash commands are controls:
			// their result is the useful transcript item, and echoing the command first
			// forces an avoidable second composer relocation around every operation.
			if (shouldEchoSubmittedLine(dispatchLine)) {
				setRenderState((previous) => ({
					...previous,
					transcript: [
						...previous.transcript,
						{
							id: nextId(),
							speaker: "you",
							lines: dispatchLine
								.split("\n")
								.map((part, index) =>
									index === 0 && origin ? `${part}  [${origin}]` : part,
								),
						},
					],
				}));
			}

			submittingRef.current = true;
			try {
				const result = await controller.dispatch(dispatchLine);
				if (result === "exit") {
					setExitPending(true);
					return;
				}
				if (result === "handled" || result === "dispatched") {
					setPrompt(controller.buildPrompt());
					return;
				}
				// Blocking result: array of output lines to commit to transcript
				if (Array.isArray(result) && result.length > 0) {
					const item: TranscriptItem = {
						id: nextId(),
						speaker: "output",
						lines: result,
					};
					setRenderState((previous) => ({
						...previous,
						transcript: [...previous.transcript, item],
					}));
				}
				setPrompt(controller.buildPrompt());
			} finally {
				submittingRef.current = false;
			}
		},
		// Menu state is read at submit time (menu-aware Enter above), so it must
		// be in the deps — a stale closure would complete against an old listing.
		[
			controller,
			menuKind,
			menuOpen,
			menuPartial,
			menuItems,
			menuSelIdx,
			refreshQueue,
			resetReverseSearch,
		],
	);

	// Drain one queued follow-up only after the previous Home run has genuinely
	// left the registry. This preserves conversational order without blocking the
	// composer or launching hidden parallel turns.
	useEffect(() => {
		if (
			submittingRef.current ||
			currentOwner() !== "composer" ||
			questionPrompt ||
			approvalPrompt ||
			controller.foregroundRun() ||
			queueRef.current.size === 0
		) {
			return;
		}
		const next = queueRef.current.takeNext();
		if (!next) return;
		refreshQueue();
		void handleSubmit(next, { bypassQueue: true, origin: "queued" });
	}, [
		approvalPrompt,
		controller,
		handleSubmit,
		panelStates,
		questionPrompt,
		refreshQueue,
		thinkingSince,
		interactionMode,
	]);

	const pickerStart = sessionPicker
		? Math.max(
				0,
				Math.min(
					sessionPickerSel - Math.floor(pickerVisibleRows / 2),
					sessionPicker.items.length - pickerVisibleRows,
				),
			)
		: 0;
	const modalOpen = owner !== "composer";
	const composerRows = Math.max(1, Math.min(contentRows, 4, dynamicRows - 2));
	const statusRows =
		Number(connection !== "connected") + Number(Boolean(reverseSearchStatus));
	const menuRows = modalOpen
		? 0
		: Math.min(
				menuItems.length,
				Math.max(0, dynamicRows - composerRows - 2 - statusRows),
			);
	const auxiliaryRows = modalOpen
		? 0
		: Math.max(
				0,
				dynamicRows - composerRows - 2 - statusRows - (menuOpen ? menuRows : 0),
			);
	const queueRows =
		queuedMessages.length > 0 || queueRef.current.cancelArmed
			? Math.min(auxiliaryRows, 4)
			: 0;
	const liveRows = Math.max(0, auxiliaryRows - queueRows);
	useLayoutEffect(() => {
		setLiveOffset((previous) =>
			Math.min(previous, Math.max(0, liveHeight - liveRows)),
		);
	}, [liveHeight, liveRows]);
	const decisionRows = Math.max(1, dynamicRows - 2);
	const questionChoices = questionPrompt
		? [
				...questionPrompt.options.map(
					(option, index) => `${index + 1}. ${option.label}`,
				),
				"Type your own answer",
			]
		: [];
	const approvalChoices = approvalPrompt
		? [
				"Approve once",
				`Always allow ${approvalPrompt.scopeLabel} this session`,
				"Reject",
			]
		: [];
	const questionFreeText = Boolean(questionPrompt && questionEditing);
	const decisionSummaryRows =
		Number(decisionRows >= 5) +
		Number(Boolean(approvalPrompt?.reason) && decisionRows >= 7) +
		Number(Boolean(approvalPrompt) && decisionRows >= 8);
	const choiceRows = Math.max(
		1,
		Math.min(
			questionPrompt ? questionChoices.length : approvalChoices.length,
			decisionRows - 2 - decisionSummaryRows - (questionFreeText ? 3 : 0),
		),
	);
	const choiceOffset = Math.max(
		0,
		(questionPrompt ? questionSel : approvalSel) - choiceRows + 1,
	);
	const queueDetailText =
		interactionMode.kind === "queue_detail"
			? interactionMode.entries
					.map(
						(message, index) =>
							`Queued draft ${index + 1}/${interactionMode.entries.length}\n\n${message}`,
					)
					.join("\n\n")
			: "";
	const queuePreviewRows = Math.max(
		0,
		queueRows - 1 - Number(queuedMessages.length > Math.max(0, queueRows - 1)),
	);
	const queueHidden = Math.max(0, queuedMessages.length - queuePreviewRows);
	const detailText = questionPrompt
		? [questionPrompt.prompt, ...questionChoices].join("\n\n")
		: approvalPrompt
			? [
					`${approvalPrompt.targetLabel} needs approval`,
					approvalPrompt.detail,
					approvalPrompt.reason ? `Why: ${approvalPrompt.reason}` : "",
					`Scope: ${approvalPrompt.scopeLabel} (${approvalPrompt.scope})`,
					`Run ${approvalPrompt.homeRunId}`,
					...approvalChoices,
				]
					.filter(Boolean)
					.join("\n\n")
			: "";

	return (
		<Box flexDirection="column">
			{/* Committed transcript — ink writes these ONCE to stdout scrollback.
			    marginTop gives one blank line between committed turns (Static items
			    are laid out through Yoga like any Box, so margins render as blank
			    lines in scrollback); the banner stays flush at the top. */}
			<Static items={transcript}>
				{(item: TranscriptItem, index: number) => (
					<Box
						key={item.id}
						flexDirection="column"
						marginTop={
							item.speaker === "banner" ||
							(item.speaker === "output" &&
								transcript[index - 1]?.speaker === "output")
								? 0
								: 1
						}
					>
						{item.speaker === "banner" ? (
							item.lines.map((line, i) => (
								<Text
									key={`${item.id}-${i}`}
									wrap="truncate"
									aria-label={screenReader ? line : undefined}
								>
									{line}
								</Text>
							))
						) : item.speaker === "output" ? (
							item.lines.map((line, i) => (
								<Text key={`${item.id}-${i}`}>{line}</Text>
							))
						) : (
							<CommittedTurn item={item} />
						)}
					</Box>
				)}
			</Static>

			{/* Reserve the active interaction before allocating live/queued activity. */}
			<Box
				flexDirection="column"
				maxHeight={screenReader ? undefined : dynamicRows}
				overflow={screenReader ? undefined : "hidden"}
			>
				<Box
					flexDirection="column"
					maxHeight={screenReader ? undefined : auxiliaryRows}
					overflow={screenReader ? undefined : "hidden"}
					flexShrink={0}
				>
					{/* Live area (panel / spinner / liveness banner):
				    one blank line of separation above the composer when visible. */}
					{panelStates.length > 0 || thinkingSince !== null ? (
						<Box
							flexDirection="column"
							maxHeight={screenReader ? undefined : liveRows}
							overflow={screenReader ? undefined : "hidden"}
							contentOffsetY={screenReader ? 0 : liveOffset}
							flexShrink={0}
						>
							<Box
								ref={liveContentRef}
								flexDirection="column"
								marginBottom={1}
								flexShrink={0}
							>
								{/* Live activity panel */}
								<InkLivePanel
									states={panelStates}
									frameIndex={frameIndex}
									now={now}
									activityMode={activityMode}
								/>

								{/* Pending "thinking" spinner — dead air between submit + first output */}
								{thinkingSince !== null && panelStates.length === 0 ? (
									screenReader ? (
										<Text>
											{liveness === "stuck"
												? "This turn looks stuck"
												: liveness === "slow"
													? "Still working"
													: `${thinkingLabel}…`}
										</Text>
									) : liveness === "stuck" ? (
										<Text color={THEME_HEX.warn} wrap="truncate">
											⚠ This turn looks stuck
											<Text color={THEME_HEX.faint}>
												{" "}
												· ↑ then Enter to resend
											</Text>
										</Text>
									) : liveness === "slow" ? (
										<Text color={THEME_HEX.accent} wrap="truncate">
											{`${FRAMES[frameIndex % FRAMES.length]} Still working… `}
											<Text color={THEME_HEX.faint}>
												{`(${formatTurnDuration(livenessElapsedMs)})`}
											</Text>
										</Text>
									) : (
										<Text color={THEME_HEX.accent} wrap="truncate">
											{`${FRAMES[frameIndex % FRAMES.length]} ${thinkingLabel}… `}
											<Text color={THEME_HEX.faint}>
												{`(${formatDuration(now - thinkingSince)})`}
											</Text>
										</Text>
									)
								) : null}
							</Box>
						</Box>
					) : null}

					{queuedMessages.length > 0 || queueRef.current.cancelArmed ? (
						<Box
							flexDirection="column"
							maxHeight={screenReader ? undefined : queueRows}
							overflow={screenReader ? undefined : "hidden"}
							flexShrink={0}
						>
							<Box flexDirection="column" flexShrink={0}>
								{queuedMessages.length > 0 ? (
									<Text color={THEME_HEX.faint} wrap="truncate">
										{`Queued ${queuedMessages.length}/${MESSAGE_QUEUE_LIMIT} · Ctrl-Q inspect`}
									</Text>
								) : null}
								{queueHidden > 0 && !screenReader ? (
									<Text
										color={THEME_HEX.faint}
										wrap="truncate"
									>{`${queueHidden} hidden · full drafts in inspector`}</Text>
								) : null}
								{(screenReader
									? queuedMessages
									: queuedMessages.slice(0, queuePreviewRows)
								).map((message, index) => (
									<Text key={`${index}-${message}`} wrap="truncate">
										<Text color={THEME_HEX.accent}>{`  ${index + 1}. `}</Text>
										{message}
									</Text>
								))}
								{queueRef.current.cancelArmed ? (
									<Text color={THEME_HEX.warn}>
										Esc again to cancel the active run
									</Text>
								) : null}
							</Box>
						</Box>
					) : null}
				</Box>

				{queueInspecting ? (
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor={THEME_HEX.faint}
						paddingX={1}
						flexShrink={0}
					>
						<DecisionDetail
							text={queueDetailText}
							height={decisionRows}
							screenReader={screenReader}
							backHint="Ctrl-Q/Esc back"
						/>
					</Box>
				) : null}

				{/* /sessions selector — dynamic/modal, never committed to scrollback. */}
				{sessionPicker ? (
					<Box flexDirection="column" marginBottom={1}>
						<Text bold>Resume a session</Text>
						{pickerStart > 0 ? (
							<Text color={THEME_HEX.faint}> ↑ more</Text>
						) : null}
						<Box
							flexDirection="column"
							height={Math.min(pickerVisibleRows, sessionPicker.items.length)}
							overflow="hidden"
							contentOffsetY={pickerStart}
						>
							<Box flexDirection="column" flexShrink={0}>
								{sessionPicker.items.map((item, index) => {
									const selected = index === sessionPickerSel;
									const current =
										item.id === sessionPicker.currentConversationId;
									const when = item.lastMessageAt
										? item.lastMessageAt.slice(0, 16).replace("T", " ")
										: "";
									return (
										<Text
											key={item.id}
											wrap="truncate"
											color={selected ? THEME_HEX.accent : undefined}
										>
											{`${selected ? "›" : " "} ${item.title}`}
											<Text color={THEME_HEX.faint}>
												{`${current ? "  · current" : ""}${when ? `  · ${when}` : ""}`}
											</Text>
										</Text>
									);
								})}
							</Box>
						</Box>
						{pickerStart + pickerVisibleRows < sessionPicker.items.length ? (
							<Text color={THEME_HEX.faint}> ↓ more</Text>
						) : null}
						<Text color={THEME_HEX.faint}>
							↑/↓ move · PgUp/PgDn page · Enter resume · Esc cancel
						</Text>
					</Box>
				) : null}

				{questionPrompt || approvalPrompt ? (
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor={questionPrompt ? THEME_HEX.accent : THEME_HEX.warn}
						paddingX={1}
						flexShrink={0}
					>
						{inspecting ? (
							<DecisionDetail
								text={detailText}
								height={decisionRows}
								screenReader={screenReader}
							/>
						) : (
							<>
								<Text bold wrap="truncate">
									{questionPrompt
										? questionPrompt.resolving
											? "Sending your answer…"
											: "Home needs your input"
										: `${approvalPrompt!.targetLabel} needs approval${approvalPrompt!.resolving ? " · resolving…" : ""}`}
								</Text>
								{screenReader ? (
									<Text>{detailText}</Text>
								) : decisionRows >= 5 ? (
									<Text wrap="truncate">
										{(
											questionPrompt?.prompt ??
											approvalPrompt?.detail ??
											""
										).replace(/\s*\n\s*/g, " ")}
									</Text>
								) : null}
								{approvalPrompt?.reason &&
								decisionRows >= 7 &&
								!screenReader ? (
									<Text
										wrap="truncate"
										color={THEME_HEX.faint}
									>{`Why: ${approvalPrompt.reason.replace(/\s*\n\s*/g, " ")}`}</Text>
								) : null}
								{approvalPrompt && decisionRows >= 8 && !screenReader ? (
									<Text
										color={THEME_HEX.faint}
										wrap="truncate"
									>{`Run ${approvalPrompt.homeRunId}`}</Text>
								) : null}
								<Box
									flexDirection="column"
									height={screenReader ? undefined : choiceRows}
									overflow={screenReader ? undefined : "hidden"}
									contentOffsetY={screenReader ? 0 : choiceOffset}
								>
									<Box flexDirection="column" flexShrink={0}>
										{(questionPrompt ? questionChoices : approvalChoices).map(
											(label, index) => (
												<Text
													key={index}
													wrap="truncate"
													aria-label={`${index === (questionPrompt ? questionSel : approvalSel) ? "Selected: " : ""}${label}`}
													color={
														index ===
														(questionPrompt ? questionSel : approvalSel)
															? THEME_HEX.accent
															: undefined
													}
												>{`${index === (questionPrompt ? questionSel : approvalSel) ? "›" : " "} ${label.replace(/\s*\n\s*/g, " ")}`}</Text>
											),
										)}
									</Box>
								</Box>
								{questionPrompt && !questionPrompt.resolving ? (
									<Box
										display={questionEditing ? "flex" : "none"}
										borderStyle="round"
										borderColor={THEME_HEX.faint}
										paddingX={1}
									>
										<TextInput
											maxRows={1}
											value={questionDraft}
											onChange={(value) => {
												if (currentOwner() === "question_editor")
													setQuestionDraft(value);
											}}
											onSubmit={(answer) => {
												if (
													currentOwner() !== "question_editor" ||
													questionEntrySubmitBlockedRef.current ||
													questionPrompt.resolving
												)
													return;
												const trimmed = answer.trim();
												if (!trimmed) return;
												setQuestionDraft("");
												void controller.respondQuestion(trimmed);
											}}
											isInputActive={() => currentOwner() === "question_editor"}
											placeholder="Answer Home"
										/>
									</Box>
								) : null}
								<Text color={THEME_HEX.faint} wrap="truncate">
									{questionPrompt
										? questionEditing
											? "Ctrl-O inspect · Esc choices · Enter answer"
											: "Ctrl-O inspect · ↑/↓ move · number/Enter select · Esc leave unanswered"
										: "Ctrl-O inspect scope/details · ↑/↓ move · Enter select · Esc leave pending"}
								</Text>
							</>
						)}
					</Box>
				) : null}

				{/* Slash-command and @file typeahead menu */}
				{menuOpen && !modalOpen ? (
					<Box
						flexDirection="column"
						marginLeft={2}
						height={screenReader ? undefined : menuRows}
						overflow={screenReader ? undefined : "hidden"}
						contentOffsetY={Math.max(0, menuSelIdx - menuRows + 1)}
					>
						<Box flexDirection="column" flexShrink={0}>
							{menuItems.map((c, i) => (
								<Text
									key={c.label}
									wrap="truncate"
									color={i === menuSelIdx ? THEME_HEX.accent : THEME_HEX.faint}
								>
									{`${i === menuSelIdx ? "›" : " "} ${c.label}`}
									<Text color={THEME_HEX.faint}>{`  ${c.description}`}</Text>
								</Text>
							))}
						</Box>
					</Box>
				) : null}

				{/* Connection indicator — hidden while healthy, sticky on drop */}
				{connection !== "connected" ? (
					<Text
						wrap="truncate"
						color={connection === "lost" ? THEME_HEX.danger : THEME_HEX.warn}
					>
						{`● ${CONNECTION_STATUS_COPY[connection]}`}
					</Text>
				) : null}

				{/* Reverse-search feedback is transient and belongs with the active
				    interaction, not in a permanently repainted status footer. */}
				{reverseSearchStatus ? (
					<Text color={THEME_HEX.faint} wrap="truncate">
						{reverseSearchStatus}
					</Text>
				) : null}

				{/* Keep the controlled composer as the final dynamic rows. Decorative
				    status text below it forced every keystroke to traverse and repaint a
				    full-width footer on terminals without synchronized-output support.
				    Workspace/gateway identity already lives in the write-once banner;
				    connection failures remain visible immediately above the composer. */}
				{!modalOpen ? (
					<Box borderStyle="round" borderColor={THEME_HEX.faint} paddingX={1}>
						<Text color={THEME_HEX.accent} wrap="truncate">
							{prompt}
						</Text>
						<TextInput
							maxRows={Math.max(1, Math.min(4, dynamicRows - 2))}
							onContentRowsChange={handleContentRowsChange}
							isInputActive={() => currentOwner() === "composer"}
							value={inputValue}
							onChange={handleInputChange}
							onSubmit={handleSubmit}
							placeholder="Send a message  ·  /help  ·  @path"
						/>
					</Box>
				) : null}
			</Box>
		</Box>
	);
}
