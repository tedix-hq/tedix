import {
	DecisionContextSection,
	DecisionRailContext,
} from "@/components/decision-context-rail";
import type {
	WorkActorReference,
	WorkContributionSource,
} from "@tedix/api-contract/schemas/os-work-actor";
import {
	DeckCurationContext,
	DeckFooterContext,
	DeckNoticeContext,
	CardFaceContext,
} from "@/components/deck-presentation-context";
import { decideForMeMode } from "@tedix/api-contract/utils/decision-card-preferences";
import {
	DecisionLearningContext,
	DecisionLearningWhy,
} from "@/components/decision-learning-context";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { errorMessage, orpcErrorCode } from "@/lib/orpc-error";
import { createPortal } from "react-dom";
import { QueryClientContext } from "@tanstack/react-query";
import {
	CardRevisionPanel,
	type CardRevisionTarget,
} from "@/components/card-revision-panel";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
	credentialCard,
} from "@tedix/api-contract/utils/card-secrets";
import { decisionLearningKey } from "@/lib/decision-deck";
import { DecisionAttentionContext } from "@/components/decision-attention-context";
import { OptimisticDeckDecisionContext } from "@/lib/optimistic-deck-decision";
import {
	DeckCardAgentContext,
	useAgentRegistration,
	type DeckCardAgentOutcome,
} from "@/lib/deck-card-agent";
import {
	Fragment,
	useContext,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from "react";
import {
	FeedDeckCard,
	FeedDeckDisclosure,
	ProposerChip,
	ProposerContext,
	ShortcutTooltip,
} from "@/components/feed-deck-primitives";
import { WorkSourceProvenance } from "@/components/work-source-provenance";
import {
	plainAskerName,
	plainDecisionSource,
	plainDecisionText,
} from "@/lib/plain-decision-text";
import { workDue } from "@/lib/work-detail";
import { useDecisionMotion } from "@/components/use-decision-motion";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { DotsThree } from "@phosphor-icons/react";
import {
	CardContent,
	CardFooter,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Textarea } from "@/components/kumo/textarea";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import {
	formatCardPresentationDates,
	osTimeZone,
	useOsFormattingPreferences,
} from "@/lib/format";
import { relativeTime, absoluteTime } from "@/lib/time";
import { useMoreBelow } from "@/lib/use-more-below";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import {
	decisionCardActionLabel,
	renderDecisionCardDates,
	renderCardDateText,
	withoutListPrefix,
} from "@tedix/api-contract/utils/decision-card-copy";
import {
	DecisionProposalBody,
	DecisionProposalHeading,
	InlineMarkdown,
	decisionProposalTitle,
	decisionIdentifiers,
} from "@/components/decision-proposal-body";

export type DecisionCardKind =
	| "outbound"
	| "proposal"
	| "question"
	| "approval"
	| "decision"
	| "adr";
export type DecisionCardSignal =
	| "approve-as-is"
	| "edited"
	| "reason"
	| "free-text"
	| "rejected"
	| "answer";
export interface DecisionCardAction {
	id: string;
	label: string;
	intent?: "approve" | "reject" | "delegate" | "later";
	primary?: boolean;
	confirm?: string;
	confirmContent?: ReactNode;
	confirmDisabled?: boolean;
	disabled?: boolean;
	description?: string;
}
export interface DecisionCardFeedback {
	action: string;
	signal: DecisionCardSignal;
	body: string;
	originalBody?: string;
	reason?: string;
	feedback?: string;
	/** Set on the retry after a stale-card refusal: answer against the newer note. */
	reviewedChangesThrough?: string;
}

const OUTBOUND_REJECT_REASONS = [
	"wrong tone",
	"wrong facts",
	"not now",
	"don't send",
] as const;

/** The card's keydown handler below owns these keys; the tooltips only show them. */
const ACTION_SHORTCUTS: Record<string, { key: string; aria: string }> = {
	approve: { key: "→", aria: "ArrowRight" },
	reject: { key: "←", aria: "ArrowLeft" },
	later: { key: "L", aria: "L" },
	delegate: { key: "D", aria: "D" },
};

/** The card already labels the consequence "If yes:", so the sentence must not repeat it. */
function withoutIfYes(body: string) {
	const rest = body.replace(/^\s*If yes[,:]?\s*/i, "");
	return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const QUESTION_WORD = /^(?:who|whom|whose|what|which|when|where|why|how)\b/i;
/** Asks that need typed input even when phrased as an instruction. */
const INPUT_VERB =
	/^(?:choose|pick|select|set|name|enter|provide|give|share|write|describe|list|suggest|specify|tell|draft|add)\b/i;
const PREPOSITION = /^(?:to|for|with|on|in|at|by|from|into|onto|of)$/i;
const AUXILIARY =
	/^(?:is|are|am|was|were|should|shall|can|could|do|does|did|will|would|may|might|must|has|have|had)\b/i;

/**
 * A short summary always asks one question. It is a yes/no decision unless it
 * opens with a question word, asks for input or offers alternatives. A yes/no
 * primary states what yes does instead of asking for typed text.
 */
function yesNoAnswerLabel(
	face: { title: string; actionLabels?: Record<string, string> },
	action: DecisionCardAction,
): string | null {
	const labels = face.actionLabels ?? {};
	const given =
		(Object.hasOwn(labels, action.id) ? labels[action.id] : undefined) ??
		(action.intent && Object.hasOwn(labels, action.intent)
			? labels[action.intent]
			: undefined);
	if (given) return given;
	const ask = face.title.trim().replace(/\?+$/, "").trim();
	if (
		!ask ||
		QUESTION_WORD.test(ask) ||
		INPUT_VERB.test(ask) ||
		/\bor\b/i.test(ask)
	)
		return null;
	const words = ask.split(/\s+/);
	if (AUXILIARY.test(ask) || words.length > 4) return decisionText("Yes");
	// "Keep dark-factory private" -> "Keep private": the verb and its result.
	if (words.length <= 2) return ask;
	return PREPOSITION.test(words.at(-2)!)
		? decisionText("Yes")
		: `${words[0]} ${words.at(-1)}`;
}

/** "Decide for me" may pick on its own only when the writer is at least this sure. */
const AUTO_DECIDE_CONFIDENCE = 0.8;
const AUTO_DECIDE_SECONDS = 5;

/** Row controls the phone overflow menu presses on the person's behalf. */
const QUIET_CONTROLS = {
	later: "[data-deck-later]",
	notUseful: "[data-deck-not-useful] > button",
	why: ".fd-card-why button",
} as const;

/*
 * The Button adapter resolves Kumo's primary label color through an inline
 * `--color-white`, which no stylesheet rule can outrank. A disabled secondary
 * action trades the accent pairing for the muted pairing feed-deck.css paints;
 * a disabled primary keeps its label color on a lighter primary fill.
 */
const DISABLED_ACTION_LABEL = {
	"--color-white": "var(--muted-foreground)",
} as CSSProperties;

type SubmitStatus =
	| "saved"
	| "confirming"
	| "unavailable"
	| "unchanged"
	| "invalid"
	| "empty"
	| "failed";

/**
 * A stale-card refusal the person can recover from: the linked task has a
 * newer note. Answering again with its time binds the answer to that version.
 */
function staleDecisionChange(
	cause: unknown,
): { through: string; note?: string } | null {
	if (orpcErrorCode(cause) !== "CONFLICT") return null;
	const data = (cause as { data?: unknown }).data;
	if (!data || typeof data !== "object") return null;
	const { reason, reviewedChangesThrough, note } = data as Record<
		string,
		unknown
	>;
	return reason === "newer_comment" &&
		typeof reviewedChangesThrough === "string"
		? {
				through: reviewedChangesThrough,
				...(typeof note === "string" ? { note } : {}),
			}
		: null;
}

/** Plain-English failure text for a decision write, with the next step. */
function decisionFailureText(cause: unknown): string {
	const code = orpcErrorCode(cause);
	if (code === "FORBIDDEN" || code === "UNAUTHORIZED")
		return decisionText(
			"You don't have permission to make this decision. Ask the owner of the originating Work or an organization admin for access.",
		);
	// Server reasons can quote agent notes; the person sees the first sentence.
	const reason = plainDecisionText(errorMessage(cause, ""))
		.split(/(?<=[.!?])\s/)[0]!
		.slice(0, 200);
	const next =
		code === "CONFLICT"
			? "This card changed since you opened it. Review the latest version and decide again."
			: "Check your connection and try again.";
	return [
		decisionText("Your decision was not saved."),
		reason &&
		reason !== code &&
		!/^(conflict|internal server error)$/i.test(reason)
			? reason.replace(/\.?$/, ".")
			: "",
		decisionText(next),
	]
		.filter(Boolean)
		.join(" ");
}

const SUBMIT_REFUSALS: Record<
	Exclude<SubmitStatus, "saved" | "confirming">,
	string
> = {
	unavailable: "The card is saving, closed or this option is unavailable.",
	unchanged: "The draft has no changes to save.",
	invalid: "The card refused this answer; its message explains why.",
	empty: "Fill the answer first.",
	failed: "The decision could not be saved; the card shows the error.",
};

/** Shared review surface. Callers own authorization, persistence and provider effects. */
export function WorkDecisionCard({
	kind,
	title,
	askedBy,
	actor,
	source,
	at,
	why,
	body = "",
	content,
	actions = [],
	feedbackAction,
	editAction,
	allowEdits = true,
	editContent,
	hasEdits = false,
	suggestedAnswers = [],
	initialAnswer = "",
	revisionTarget,
	connectionSettings = false,
	rejectReasons,
	pending = false,
	disabled = false,
	onDecision,
	onDecisionSettled,
	onNext,
	onPrevious,
}: {
	kind: DecisionCardKind;
	title: string;
	askedBy: string;
	actor?: WorkActorReference;
	source?: WorkContributionSource;
	at?: string;
	why?: ReactNode;
	body?: string;
	content?: ReactNode;
	actions?: readonly DecisionCardAction[];
	feedbackAction?: DecisionCardAction;
	editAction?: DecisionCardAction;
	allowEdits?: boolean;
	editContent?: ReactNode;
	hasEdits?: boolean;
	suggestedAnswers?: readonly string[];
	initialAnswer?: string;
	revisionTarget?: CardRevisionTarget;
	connectionSettings?: boolean;
	/** One-tap reasons a reject asks for; outbound cards always ask. */
	rejectReasons?: readonly string[];
	pending?: boolean;
	disabled?: boolean;
	autoFocus?: boolean;
	onDecision: (feedback: DecisionCardFeedback) => Promise<unknown>;
	onDecisionSettled?: () => void;
	onNext?: () => void;
	onPrevious?: () => void;
}) {
	useOsFormattingPreferences();
	const faceState = useContext(CardFaceContext);
	const face = faceState?.presentation
		? formatCardPresentationDates(
				renderDecisionCardDates(
					faceState.presentation,
					faceState.dates,
					faceState.now,
					faceState.timeZone ?? osTimeZone(),
				),
			)
		: null;
	// The headline is always real text: the short summary's ask when it exists,
	// otherwise the original request title. Never a status word or list number.
	const heading = decisionProposalTitle(
		plainDecisionText(
			withoutListPrefix(face?.title ?? renderCardDateText(title)),
		) || "Review this request?",
	);
	const asker = plainAskerName(askedBy);
	const cardType = faceState?.cardType ?? kind;
	const cardPreferences = faceState?.preferences;
	const compact = cardPreferences?.density === "compact";
	const decideMode = decideForMeMode(cardPreferences, cardType);
	// The Deck's progress line already states the due date.
	const dueAt = faceState?.dueInHeader ? undefined : faceState?.dates?.[0];
	const due = dueAt ? workDue(dueAt, faceState?.now) : "";
	const stakes = face && "stakes" in face ? face.stakes : undefined;
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [stale, setStale] = useState<{
		through: string;
		note?: string;
		action: DecisionCardAction;
		reason?: string;
	} | null>(null);
	const [changeRequest, setChangeRequest] = useState(0);
	const queryClient = useContext(QueryClientContext);
	const revision = revisionTarget;
	const secureConnection =
		connectionSettings || credentialCard(`${title} ${body}`);
	const identifiers = decisionIdentifiers(`${title} ${body}`);
	const deckFooter = useContext(DeckFooterContext);
	const deckCuration = useContext(DeckCurationContext);
	const deckNotice = useContext(DeckNoticeContext);
	const proposer = useContext(ProposerContext);
	const submittingActor = actor ?? proposer.actor;
	const contributionSource = source ?? proposer.source;
	const footer = useRef<HTMLDivElement>(null);
	const cardBody = useMoreBelow<HTMLDivElement>();
	useEffect(() => {
		const node = footer.current;
		if (!node) return;
		const update = () =>
			section.current?.style.setProperty(
				"--fd-footer-height",
				`${node.getBoundingClientRect().height}px`,
			);
		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();
		return () => observer.disconnect();
	}, []);
	const rail = useContext(DecisionRailContext);
	const attention = useContext(DecisionAttentionContext);
	const optimistic = useContext(OptimisticDeckDecisionContext);
	const learnedWhy = useContext(DecisionLearningContext);
	const shownAt = useRef(performance.now());
	const exposureSent = useRef(false);
	const detailsOpened = useRef(false);
	useEffect(() => {
		if (!attention || exposureSent.current) return;
		const report = () => {
			const node = section.current;
			if (
				!node ||
				exposureSent.current ||
				document.visibilityState !== "visible"
			)
				return;
			const box = node.getBoundingClientRect();
			if (
				box.width <= 0 ||
				box.height <= 0 ||
				box.bottom <= 0 ||
				box.top >= window.innerHeight
			)
				return;
			exposureSent.current = true;
			shownAt.current = performance.now();
			attention({ action: "shown", signal: "shown", elapsedMs: 0 });
		};
		const observer =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver(report);
		if (section.current) observer?.observe(section.current);
		document.addEventListener("visibilitychange", report);
		report();
		return () => {
			observer?.disconnect();
			document.removeEventListener("visibilitychange", report);
		};
	}, [attention]);
	const motion = useDecisionMotion();
	const section = motion.surface;
	const [editing, setEditing] = useState(false);
	const [whyOpen, setWhyOpen] = useState(false);
	const [whyTarget, setWhyTarget] = useState<HTMLDivElement | null>(null);
	const [draft, setDraft] = useState(body);
	const [revising, setRevising] = useState(false);
	const [revisionsOpen, setRevisionsOpen] = useState(false);
	useEffect(() => {
		if (!editing) setDraft(body);
	}, [body, editing]);
	const [answer, setAnswer] = useState(initialAnswer);
	const [feedbackOpen, setFeedbackOpen] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [reasonsOpen, setReasonsOpen] = useState(false);
	const [confirmationId, setConfirmationId] = useState<string | null>(null);
	const confirmation =
		actions.find((action) => action.id === confirmationId) ?? null;
	const setConfirmation = (action: DecisionCardAction | null) =>
		setConfirmationId(action?.id ?? null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const inFlight = useRef(false);
	const touch = useRef<{ x: number; y: number } | null>(null);
	const answerAction = actions.find(
		(action) => action.intent === "approve" && !action.disabled,
	);
	const yesNoLabel =
		kind === "question" &&
		face &&
		answerAction &&
		!suggestedAnswers.length &&
		!initialAnswer.trim()
			? yesNoAnswerLabel(face, answerAction)
			: null;
	// A yes/no question still takes a typed answer; typing one replaces "Yes".
	const yesNo = Boolean(yesNoLabel) && !answer.trim();
	// With a face the row names outcomes: do it, Change…, Not now, Decide for
	// me. Several real alternatives stay as they are; each one is an outcome.
	const outcomeRow =
		!!faceState &&
		actions.filter(
			(action) =>
				!["reject", "later", "delegate"].includes(action.intent ?? ""),
		).length <= 1;
	const delegateAction = actions.find(
		(action) => action.intent === "delegate" && !action.disabled,
	);
	const recommendedIntent =
		face && "recommendedIntent" in face ? face.recommendedIntent : undefined;
	const recommended = recommendedIntent
		? actions.find(
				(action) => action.intent === recommendedIntent && !action.disabled,
			)
		: undefined;
	const decideAction = delegateAction ?? recommended;
	const suggested = decideMode === "suggest" ? recommended : undefined;
	// A decline keeps its outcome name; the old "No / Not needed" reads as "Decline".
	const actionLabel = (action: DecisionCardAction) =>
		decisionCardActionLabel(
			face,
			action.id,
			action.intent,
			action.intent === "reject" && action.label === "No / Not needed"
				? decisionText("Decline")
				: action.intent === "later" && outcomeRow
					? decisionText("Not now")
					: action.intent === "delegate" && outcomeRow
						? decisionText("Decide for me")
						: action.label,
		);
	// On phones the Deck row keeps the primary and the secondary; these move to "⋯".
	// In an outcome row a decline always lives in "⋯"; swipe left and ← still decline.
	// In an outcome row a decline stays in view; on phones it moves to "⋯".
	const overflowActions = outcomeRow
		? actions.filter(
				(action) => action.intent === "reject" && action !== suggested,
			)
		: actions.filter(
				(action) =>
					action.intent === "later" ||
					(action.intent === "delegate" && !action.disabled && !rail),
			);
	const [autoStopped, setAutoStopped] = useState(false);
	const autoAction =
		decideMode === "auto" &&
		!autoStopped &&
		recommended &&
		!recommended.confirm &&
		kind !== "outbound" &&
		(faceState?.confidence ?? 0) >= AUTO_DECIDE_CONFIDENCE
			? recommended
			: undefined;
	const [autoSeconds, setAutoSeconds] = useState(AUTO_DECIDE_SECONDS);
	const [quiet, setQuiet] = useState({
		later: false,
		notUseful: false,
		why: false,
	});
	const quietControl = (name: keyof typeof QUIET_CONTROLS) =>
		footer.current?.querySelector<HTMLElement>(QUIET_CONTROLS[name]) ?? null;
	// A loading summary never blocks the decision: the headline and original
	// request are real now, so actions stay live until a choice is submitted.
	const busy = pending || saving || disabled || saved || revising;
	const submit = async (
		action: DecisionCardAction,
		reason?: string,
		confirmed = false,
		reviewedChangesThrough?: string,
	): Promise<SubmitStatus> => {
		if (
			busy ||
			action.disabled ||
			inFlight.current ||
			(confirmed && action.confirmDisabled)
		)
			return "unavailable";
		if (action.id === editAction?.id && draft === body && !hasEdits)
			return "unchanged";
		if (action.confirm && !confirmed) {
			setError("");
			setConfirmation(action);
			return "confirming";
		}
		const finalBody =
			action.intent === "reject"
				? action.label
				: kind === "question"
					? yesNo && face
						? `${decisionText("Yes")}: ${face.title.replace(/\?+$/, "")}`
						: answer.trim()
					: draft.trim();
		if (containsCardSecret([finalBody, feedback, reason])) {
			setError(CARD_SECRET_MESSAGE);
			return "invalid";
		}
		if (secureConnection) {
			setError("Use connection settings to update credentials.");
			return "invalid";
		}
		if (
			kind === "question" &&
			action.intent !== "reject" &&
			!finalBody &&
			action.id !== feedbackAction?.id
		)
			return "empty";
		inFlight.current = true;
		setSaving(true);
		setError("");
		const revisionEdit = action.id === editAction?.id;
		const departure =
			!revisionEdit && !optimistic && section.current?.closest(".fd-deck")
				? motion.exit(action.intent)
				: undefined;
		try {
			const decidedAt = Date.now();
			const readDetails = detailsOpened.current;
			const elapsedMs = Math.max(
				0,
				Math.round(performance.now() - shownAt.current),
			);
			const write = async () => {
				if (revisionEdit && revision && kind !== "outbound") {
					const { osApi } = await import("@/lib/api");
					const { osQuery } = await import("@/lib/os-query-options");
					const history = await osApi.workInteractions.cardHistory({
						requestId: revision.requestId,
					});
					const result = await osApi.workInteractions.reviseCard({
						requestId: revision.requestId,
						expectedRequestVersion: revision.version,
						expectedRevision: history.revisions.at(-1)?.revision ?? 0,
						body: finalBody,
					});
					await queryClient?.invalidateQueries({
						queryKey: osQuery.workInteractions.key(),
					});
					return result;
				}
				return onDecision({
					action: action.id,
					signal:
						action.id === editAction?.id
							? "edited"
							: action.id === feedbackAction?.id
								? "free-text"
								: reason
									? "reason"
									: action.intent === "reject"
										? "rejected"
										: draft !== body
											? "edited"
											: feedback.trim()
												? "free-text"
												: kind === "question"
													? "answer"
													: "approve-as-is",
					body: finalBody || action.label,
					...(draft !== body ? { originalBody: body } : {}),
					...(reason ? { reason } : {}),
					...(feedback.trim() ? { feedback: feedback.trim() } : {}),
					...(reviewedChangesThrough ? { reviewedChangesThrough } : {}),
				});
			};
			const result = await (optimistic && !revisionEdit
				? optimistic(write, { errorShownInline: true })
				: write());
			if (revisionEdit) {
				setEditing(false);
				toast.success("Version saved for review");
				return "saved";
			}
			attention?.({
				learningClientEventId: decisionLearningKey(result),
				action: action.id,
				intent: action.id === editAction?.id ? "change" : action.intent,
				signal:
					action.intent === "reject"
						? "rejected"
						: draft !== body ||
							  hasEdits ||
							  (kind === "question" &&
									Boolean(initialAnswer) &&
									answer.trim() !== initialAnswer.trim())
							? "edited"
							: "accepted",
				elapsedMs,
				decidedAt,
				detailsOpened: readDetails,
			});
			setConfirmation(null);
			setStale(null);
			toast.success(decisionText("Decision saved"));
			await departure;
			setSaved(true);
			if (!optimistic) onNext?.();
			return "saved";
		} catch (cause) {
			motion.cancelExit();
			const change = staleDecisionChange(cause);
			// The same refusal again means newer changes: show them, never loop.
			if (change && change.through !== reviewedChangesThrough) {
				setConfirmation(null);
				setStale({ ...change, action, reason });
				setError("");
			} else {
				setStale(null);
				setError(decisionFailureText(cause));
			}
			return "failed";
		} finally {
			inFlight.current = false;
			setSaving(false);
			onDecisionSettled?.();
		}
	};
	const approve =
		editing && editAction
			? editAction
			: actions.find(
					(action) => action.intent === "approve" && !action.disabled,
				);
	const reject = actions.find((action) => action.intent === "reject");
	const reasons = rejectReasons?.length
		? rejectReasons
		: kind === "outbound"
			? OUTBOUND_REJECT_REASONS
			: [];
	const choose = (action: DecisionCardAction | undefined) => {
		if (!action || action.disabled || busy) return;
		if (section.current?.closest(".fd-deck")) motion.pulse();
		if (reasons.length > 0 && action.intent === "reject") setReasonsOpen(true);
		else void submit(action);
	};
	// "Auto when confident": a visible countdown the person can stop, never a silent pick.
	const autoId = autoAction && !busy && !editing ? autoAction.id : null;
	useEffect(() => {
		if (!autoId) return;
		setAutoSeconds(AUTO_DECIDE_SECONDS);
		const timer = setInterval(
			() => setAutoSeconds((seconds) => Math.max(0, seconds - 1)),
			1000,
		);
		return () => clearInterval(timer);
	}, [autoId]);
	const chooseRef = useRef(choose);
	chooseRef.current = choose;
	useEffect(() => {
		if (autoId && autoSeconds === 0) {
			setAutoStopped(true);
			chooseRef.current(actions.find((action) => action.id === autoId));
		}
		// Fires once when the countdown reaches zero.
	}, [autoSeconds]);
	const [stagedOptionId, setStagedOptionId] = useState<string | null>(null);
	const staged = actions.find((action) => action.id === stagedOptionId);
	const agentField =
		kind === "question"
			? "answer"
			: allowEdits && editAction && !secureConnection
				? "draft"
				: null;
	const agentAction = (id: string) =>
		actions.find((action) => action.id === id) ??
		(editAction?.id === id ? editAction : undefined);
	const unknownOption = (id: string): DeckCardAgentOutcome => ({
		ok: false,
		error: `Unknown option "${id}". Options: ${actions.map((action) => action.id).join(", ")}.`,
	});
	const agentSlots = useContext(DeckCardAgentContext);
	useAgentRegistration(agentSlots?.card, {
		kind,
		field: agentField,
		value:
			agentField === "answer" ? answer : agentField === "draft" ? draft : "",
		suggestedAnswers,
		actions: [...actions, ...(editing && editAction ? [editAction] : [])].map(
			(action) => ({
				id: action.id,
				label: action.label,
				...(action.intent ? { intent: action.intent } : {}),
				needsConfirmation: Boolean(action.confirm),
				disabled: Boolean(action.disabled),
			}),
		),
		stagedOptionId,
		busy,
		fill(text) {
			if (busy) return { ok: false, error: "The card is saving or closed." };
			if (agentField === "answer") {
				// A typed answer replaces the yes/no "Yes: <title>" body.
				setAnswer(text);
			} else if (agentField === "draft") {
				setEditing(true);
				setDraft(text);
			} else
				return {
					ok: false,
					error: "This card has no answer or draft to fill.",
				};
			return { ok: true, status: "filled" };
		},
		stage(id) {
			const action = agentAction(id);
			if (!action) return unknownOption(id);
			if (action.disabled || busy)
				return { ok: false, error: `"${action.label}" is unavailable now.` };
			setStagedOptionId(action.id);
			return { ok: true, status: "staged" };
		},
		unstage() {
			setStagedOptionId(null);
		},
		async submit(id) {
			const action = agentAction(id);
			if (!action) return unknownOption(id);
			setStagedOptionId(null);
			const status = await submit(action);
			return status === "saved" || status === "confirming"
				? { ok: true, status }
				: {
						ok: false,
						error: SUBMIT_REFUSALS[status],
					};
		},
	});
	const buttonLabel = (action: DecisionCardAction) =>
		yesNoLabel && action === answerAction && answer.trim()
			? decisionText("Send answer")
			: yesNo && yesNoLabel && action === answerAction
				? yesNoLabel
				: actionLabel(action);
	const whyNow =
		face && "context" in face && face.context
			? plainDecisionText(face.context)
			: "";
	// Only a Change… button the person can see on the card earns a line.
	const draftEditable =
		allowEdits && (kind === "outbound" || Boolean(editAction));
	const changeOffered =
		!disabled &&
		(draftEditable
			? !rail
			: outcomeRow &&
				((Boolean(revision) && !secureConnection) || Boolean(feedbackAction)));
	// "Your tedi" reads "your tedi" inside a sentence.
	const askerInText = /^Your\b/.test(asker) ? `y${asker.slice(1)}` : asker;
	const effectOf = (action: DecisionCardAction) =>
		action.description
			? plainDecisionText(action.description)
			: action.intent === "approve" && kind === "question" && answer.trim()
				? decisionText(`Sends your answer to ${askerInText}.`)
				: action.intent === "approve" && face
					? plainDecisionText(withoutIfYes(face.body))
					: action.intent === "reject"
						? decisionText(`Tells ${askerInText} no. Nothing else changes.`)
						: action.intent === "later"
							? decisionText("Skips it for now; it comes back next visit.")
							: undefined;
	const outcomes: [string, string][] =
		faceState && face && !compact && !saved
			? [
					...actions.flatMap((action): [string, string][] => {
						const effect =
							action.disabled || action.intent === "delegate"
								? undefined
								: effectOf(action);
						return effect ? [[buttonLabel(action), effect]] : [];
					}),
					...(changeOffered
						? ([
								[
									decisionText("Change"),
									decisionText(
										`Tell ${askerInText} what to change; the card stays open.`,
									),
								],
							] as [string, string][])
						: []),
					...(deckFooter && !actions.some((action) => action.intent === "later")
						? ([
								[
									decisionText("Snooze or Not now"),
									decisionText("Hides the card for now; nothing is decided."),
								],
							] as [string, string][])
						: []),
				]
			: [];
	return (
		<section
			ref={section}
			aria-label={heading}
			tabIndex={0}
			className="fd-decision min-w-0 rounded-xl"
			style={motion.style}
			data-dragging={motion.dragging}
			data-direction={motion.direction}
			data-exiting={motion.exiting}
			onPointerDown={(event) => {
				if (!busy && !confirmation && section.current?.closest(".fd-deck"))
					motion.start(event);
			}}
			onPointerMove={motion.move}
			onPointerCancel={() => {
				touch.current = null;
				motion.reset();
			}}
			onClickCapture={(event) => {
				if (
					(event.target as HTMLElement).closest(
						"summary, [data-slot=collapsible-trigger], .fd-card-details",
					)
				) {
					detailsOpened.current = true;
					attention?.({
						action: "details",
						signal: "opened_details",
						elapsedMs: 0,
					});
				}
			}}
			onPointerLeave={motion.reset}
			onPointerUp={(event) => {
				const direction = motion.end(event);
				if (direction) {
					touch.current = null;
					if (!confirmation) choose(direction > 0 ? approve : reject);
				}
			}}
			onKeyDown={(event) => {
				if (
					(event.target as HTMLElement).closest(
						"input, textarea, button, a, summary, [contenteditable=true]",
					) ||
					event.metaKey ||
					event.ctrlKey ||
					event.altKey ||
					confirmation
				)
					return;
				if (
					event.key.toLowerCase() === "e" &&
					allowEdits &&
					editAction &&
					!busy
				) {
					event.preventDefault();
					setEditing((value) => !value);
				}
				if (event.key === "?" && why) {
					event.preventDefault();
					if (rail) rail.openSection("shortcuts");
					else setWhyOpen((value) => !value);
				}
				if (["d", "l"].includes(event.key.toLowerCase())) {
					event.preventDefault();
					const action =
						event.key.toLowerCase() === "d"
							? decideAction
							: actions.find((action) => action.intent === "later");
					if (action) choose(action);
					else if (event.key.toLowerCase() === "l" && !busy) onNext?.();
				}
				if (event.key === "j" || event.key === "k") {
					event.preventDefault();
					(event.key === "j" ? onNext : onPrevious)?.();
				}
				if (event.key === "Enter" || event.key === "ArrowRight") {
					event.preventDefault();
					choose(approve);
				}
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					choose(reject);
				}
			}}
			onTouchStart={(event) => {
				if (
					(event.target as HTMLElement).closest(
						"input, textarea, button, a, summary",
					)
				)
					return;
				const point = event.touches[0];
				if (point) touch.current = { x: point.clientX, y: point.clientY };
			}}
			onTouchEnd={(event) => {
				const start = touch.current;
				touch.current = null;
				const end = event.changedTouches[0];
				if (!start || !end || confirmation) return;
				const dx = end.clientX - start.x;
				const dy = end.clientY - start.y;
				if (Math.abs(dx) >= 90 && Math.abs(dx) > Math.abs(dy) * 2)
					choose(dx > 0 ? approve : reject);
			}}
		>
			<FeedDeckCard>
				<CardHeader>
					<CardDescription className="flex flex-wrap items-center gap-2">
						<span className="flex min-w-0 items-center">
							{faceState ? (
								<span>{asker}</span>
							) : (
								<ProposerChip name={asker} actor={actor} />
							)}
							{at ? (
								<time dateTime={at} title={absoluteTime(at)}>
									&nbsp;· {relativeTime(at)}
								</time>
							) : null}
						</span>
						{rail && (
							<Button
								variant="ghost"
								size="sm"
								className="fd-card-details"
								onClick={() => rail.openSection("details")}
							>
								{OS_COPY.feed.details}
							</Button>
						)}
					</CardDescription>
					<CardTitle className="text-xl leading-snug">
						<DecisionProposalHeading title={heading} />
					</CardTitle>
				</CardHeader>
				<CardContent ref={cardBody}>
					<div className="fd-card-body grid grid-cols-1 gap-4">
						{deckNotice}
						<div
							data-card-feedback-content
							aria-busy={revising}
							className={revising ? "opacity-60" : undefined}
							onPointerDown={(event) => {
								if (
									revision &&
									!secureConnection &&
									(event.pointerType === "touch" || event.pointerType === "pen")
								)
									event.stopPropagation();
							}}
						>
							{editing ? (
								<div className="grid gap-3">
									{editContent}
									<Textarea
										aria-label={decisionText("Edit draft")}
										rows={8}
										value={draft}
										onChange={(event) => setDraft(event.target.value)}
										disabled={busy}
									/>
								</div>
							) : faceState ? (
								<div className="fd-face grid gap-3">
									{(whyNow || due) && (
										<p className="fd-card-context" data-why-now>
											{due && (
												<strong
													className="fd-due"
													data-overdue={/overdue/.test(due) || undefined}
												>
													{due.charAt(0).toUpperCase() + due.slice(1)}
												</strong>
											)}
											{due && whyNow ? " · " : null}
											{whyNow && <InlineMarkdown text={whyNow} />}
										</p>
									)}
									{!face && (
										// No summary yet: the original ask, as written, right away.
										<div className="fd-face-original grid gap-2">
											{content ?? <DecisionProposalBody body={body || title} />}
										</div>
									)}
									{outcomes.length > 0 && (
										<dl
											className="fd-outcomes"
											aria-label={decisionText("What happens")}
										>
											{outcomes.map(([label, effect]) => (
												<div key={label}>
													<dt>{label}</dt>
													<dd>
														<InlineMarkdown text={effect} />
													</dd>
												</div>
											))}
										</dl>
									)}
									{autoAction && autoId && (
										<p role="status" className="fd-auto-decide">
											<span>
												{decisionText("Tedix picks")} “{actionLabel(autoAction)}
												” {decisionText("in")} {autoSeconds}s
											</span>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setAutoStopped(true)}
											>
												{decisionText("Stop")}
											</Button>
										</p>
									)}
									<FeedDeckDisclosure
										inline
										title={decisionText("Context")}
										open={detailsOpen}
										onOpenChange={setDetailsOpen}
									>
										<div className="grid min-w-0 gap-3 break-words">
											{face && (
												<Text className="fd-recommendation">
													<strong>{decisionText("Suggested:")}</strong>{" "}
													<InlineMarkdown text={face.recommendation} />
												</Text>
											)}
											{stakes && (
												<Text className="fd-stakes">
													<InlineMarkdown text={stakes} />
												</Text>
											)}
											{faceState.lastRelatedDecision && (
												<Text>
													<strong>{decisionText("Last time:")}</strong>{" "}
													{plainDecisionText(
														faceState.lastRelatedDecision.body,
													)}{" "}
													<time
														dateTime={faceState.lastRelatedDecision.decidedAt}
													>
														(
														{relativeTime(
															faceState.lastRelatedDecision.decidedAt,
														)}
														)
													</time>
												</Text>
											)}
											{face &&
												(content ??
													(body ? (
														<DecisionProposalBody
															body={plainDecisionSource(body)}
															inline
														/>
													) : null))}
										</div>
									</FeedDeckDisclosure>
								</div>
							) : (
								(content ??
								(body ? <DecisionProposalBody body={body} /> : null))
							)}
						</div>
						{secureConnection && (
							<Button
								variant="outline"
								render={<a href="/account/connections" />}
							>
								Open connection settings
							</Button>
						)}
						{revision && !secureConnection && (
							<Collapsible
								// Closed, it keeps its listeners but takes no row in the card.
								className={revisionsOpen ? undefined : "contents"}
								open={revisionsOpen}
								onOpenChange={setRevisionsOpen}
							>
								<CollapsibleDefaultContent keepMounted>
									<CardRevisionPanel
										key={revision.requestId}
										target={revision}
										contentKind={
											kind === "proposal"
												? "plan"
												: kind === "outbound"
													? "email"
													: "text"
										}
										agentName={asker}
										disabled={disabled || pending || saving || saved}
										onRevising={setRevising}
										cardRef={section}
										openRequest={changeRequest}
										onOpen={() => setRevisionsOpen(true)}
									/>
								</CollapsibleDefaultContent>
							</Collapsible>
						)}
						{kind === "question" && !secureConnection && !disabled && !saved ? (
							<div className="grid gap-3">
								{suggestedAnswers.length ? (
									<div
										className="flex flex-wrap gap-2"
										aria-label={decisionText("Suggested answers")}
									>
										{suggestedAnswers.map((suggestion) => (
											<Button
												key={suggestion}
												variant={answer === suggestion ? "default" : "outline"}
												disabled={busy}
												onClick={() => setAnswer(suggestion)}
											>
												{suggestion}
											</Button>
										))}
									</div>
								) : null}
								<Textarea
									className="fd-answer"
									data-optional={yesNoLabel ? "" : undefined}
									rows={yesNoLabel ? 1 : 3}
									aria-label={decisionText("Your answer")}
									placeholder={decisionText(
										yesNoLabel ? "Or write your own answer…" : "Your answer…",
									)}
									value={answer}
									disabled={busy}
									onChange={(event) => setAnswer(event.target.value)}
									onKeyDown={(event) => {
										if (
											event.key === "Enter" &&
											(event.metaKey || event.ctrlKey) &&
											!event.nativeEvent.isComposing &&
											approve
										) {
											event.preventDefault();
											void submit(approve);
										}
									}}
								/>
							</div>
						) : null}
						{staged && !saved ? (
							<p role="status" data-agent-staged-note>
								{decisionText("Prepared in chat:")} {staged.label}
							</p>
						) : null}
						{saved ? (
							<Text role="label" tone="secondary">
								{decisionText("Decision saved")}
							</Text>
						) : (
							<>
								{reasonsOpen && reject ? (
									<div
										className="flex flex-wrap gap-2"
										aria-label={decisionText("Why not this?")}
									>
										{reasons.map((reason) => (
											<Button
												key={reason}
												variant="outline"
												disabled={busy}
												onClick={() => void submit(reject, reason)}
											>
												{reason}
											</Button>
										))}
									</div>
								) : null}
								<ConfirmDialog
									open={Boolean(confirmation)}
									onOpenChange={(open) => {
										if (!open) setConfirmation(null);
									}}
									title={decisionText("Confirm decision")}
									description={confirmation?.confirm}
									cancelLabel={decisionText("Go back")}
									confirmLabel={decisionText("Confirm")}
									pendingLabel={decisionText("Confirming…")}
									retryLabel={decisionText("Try again")}
									isPending={saving}
									confirmDisabled={busy || confirmation?.confirmDisabled}
									error={error || undefined}
									onConfirm={() => {
										if (confirmation)
											void submit(confirmation, undefined, true);
									}}
								>
									{confirmation?.confirmContent}
								</ConfirmDialog>
								{feedbackOpen && !disabled && !secureConnection ? (
									<div className="fd-feedback grid gap-2">
										<Textarea
											autoFocus
											aria-label={decisionText("Optional feedback")}
											placeholder={decisionText(
												`What should ${askerInText} change? (optional)`,
											)}
											rows={2}
											value={feedback}
											onChange={(event) => setFeedback(event.target.value)}
										/>
										{feedbackAction ? (
											<Button
												className="w-fit"
												disabled={busy || !feedback.trim()}
												onClick={() => void submit(feedbackAction)}
											>
												{feedbackAction.label}
											</Button>
										) : null}
									</div>
								) : null}
							</>
						)}
						{stale && !saved ? (
							<div role="alert" className="fd-stale grid gap-2">
								<Text weight="semibold">
									{decisionText("Something changed since this was asked")}
								</Text>
								<Text>
									{decisionText(
										`${asker} added a newer note to the linked task. Read it, then save your answer against the latest version.`,
									)}
								</Text>
								{stale.note && (
									<blockquote className="fd-stale-note">
										<InlineMarkdown text={plainDecisionText(stale.note)} />
									</blockquote>
								)}
								<Button
									className="w-fit"
									disabled={busy}
									onClick={() =>
										void submit(stale.action, stale.reason, true, stale.through)
									}
								>
									{saving
										? decisionText("Saving…")
										: decisionText("Save with the latest version")}
								</Button>
							</div>
						) : null}
						{error ? (
							<p role="alert" className="text-kumo-danger">
								{error}
							</p>
						) : null}
						{!saved && (submittingActor || identifiers.length > 0 || body) ? (
							<FeedDeckDisclosure
								inline
								className="fd-agent-details"
								title={decisionText("Details for agents")}
							>
								<div className="grid min-w-0 gap-3 [overflow-wrap:anywhere]">
									{submittingActor && (
										<WorkSourceProvenance
											actor={submittingActor}
											name={askedBy}
											source={contributionSource}
											details
										/>
									)}
									{identifiers.length > 0 && (
										<div className="fd-identifiers">
											{identifiers.map((id) => (
												<code key={id} className="fd-identifier" title={id}>
													{id}
												</code>
											))}
										</div>
									)}
									{body && (
										<Text className="whitespace-pre-wrap break-all font-mono text-xs">
											{title === body ? body : `${title}\n\n${body}`}
										</Text>
									)}
								</div>
							</FeedDeckDisclosure>
						) : null}
						{!rail && (why || learnedWhy) && <div ref={setWhyTarget} />}
					</div>
				</CardContent>
				{!saved && !secureConnection && (
					<CardFooter ref={footer}>
						{" "}
						<div
							data-decision-actions
							data-outcome-row={outcomeRow || undefined}
							className={
								kind === "decision" ||
								kind === "adr" ||
								actions.some((action) => action.description)
									? "grid grid-cols-1 gap-3 sm:grid-cols-2"
									: "flex flex-wrap gap-2"
							}
						>
							{actions
								.filter(
									(action) =>
										!(action.intent === "delegate" && action.disabled) &&
										(!editing || !editAction || action.intent === "reject"),
								)
								.map((action) => {
									const label = buttonLabel(action);
									const shortcut = ACTION_SHORTCUTS[action.intent ?? ""];
									const inactive =
										busy ||
										action.disabled ||
										(kind === "question" &&
											!yesNo &&
											action.intent !== "reject" &&
											!answer.trim()) ||
										(editing && !draft.trim());
									const control = (
										<Button
											data-decision-intent={action.intent}
											data-agent-staged={
												action.id === stagedOptionId ? "" : undefined
											}
											data-deck-overflow={
												!outcomeRow && overflowActions.includes(action)
													? true
													: undefined
											}
											data-phone-overflow={
												outcomeRow && overflowActions.includes(action)
													? true
													: undefined
											}
											style={
												inactive && action !== approve
													? DISABLED_ACTION_LABEL
													: undefined
											}
											className={
												kind === "decision" ||
												kind === "adr" ||
												action.description
													? "h-auto min-h-20 w-full min-w-0 whitespace-normal text-left"
													: "min-h-11 grow sm:grow-0"
											}
											data-suggested={action === suggested || undefined}
											variant={
												(action === (suggested ?? approve) && !stale) ||
												action.id === stagedOptionId
													? "default"
													: action.intent === "reject"
														? "outline"
														: "ghost"
											}
											disabled={inactive}
											onClick={() => choose(action)}
										>
											{saving ? (
												decisionText("Saving…")
											) : (
												<span className="grid min-w-0 gap-1 whitespace-normal break-words">
													<span>{label}</span>
													{action.description && !faceState ? (
														<span
															className={
																action.intent === "approve"
																	? "fd-action-description font-normal opacity-90"
																	: "fd-action-description font-normal text-kumo-subtle"
															}
														>
															{action.description}
														</span>
													) : null}
												</span>
											)}
										</Button>
									);
									const button = shortcut ? (
										<ShortcutTooltip
											key={action.id}
											label={label}
											shortcut={shortcut.key}
											keyshortcuts={shortcut.aria}
										>
											{control}
										</ShortcutTooltip>
									) : (
										<Fragment key={action.id}>{control}</Fragment>
									);
									return action.intent === "delegate" && rail ? (
										<DecisionContextSection
											key={action.id}
											title="Delegate this choice"
										>
											{button}
										</DecisionContextSection>
									) : (
										button
									);
								})}
							{editing && editAction ? (
								<Button
									disabled={
										busy ||
										editAction.disabled ||
										!draft.trim() ||
										(draft === body && !hasEdits)
									}
									onClick={() => void submit(editAction)}
								>
									{editAction.label}
								</Button>
							) : null}
							{allowEdits &&
							(kind === "outbound" || editAction) &&
							!disabled ? (
								<DecisionContextSection title="Edit proposal">
									<ShortcutTooltip
										label={decisionText("Change…")}
										shortcut="E"
										keyshortcuts="E"
									>
										<Button
											variant="outline"
											className="min-h-11"
											disabled={busy}
											onClick={() => setEditing(!editing)}
										>
											{editing
												? decisionText("Preview")
												: outcomeRow
													? decisionText("Change…")
													: decisionText("Change")}
										</Button>
									</ShortcutTooltip>
								</DecisionContextSection>
							) : outcomeRow &&
							  !disabled &&
							  ((revision && !secureConnection) || feedbackAction) ? (
								// No editable draft: Change… asks for changes in a note.
								<Button
									variant="outline"
									className="min-h-11"
									data-card-change
									disabled={busy}
									onClick={() => {
										if (revision && !secureConnection) {
											setRevisionsOpen(true);
											setChangeRequest((value) => value + 1);
										} else setFeedbackOpen(true);
									}}
								>
									{decisionText("Change…")}
								</Button>
							) : null}
							{outcomeRow && !delegateAction && recommended ? (
								<ShortcutTooltip
									label={decisionText("Decide for me")}
									shortcut="D"
									keyshortcuts="D"
								>
									<Button
										variant="ghost"
										className="min-h-11"
										data-decide-for-me
										disabled={busy}
										onClick={() => choose(recommended)}
									>
										{decisionText("Decide for me")}
									</Button>
								</ShortcutTooltip>
							) : null}
							{!actions.some((action) => action.intent === "later") &&
								deckFooter}
							{deckCuration}
							<div className="fd-card-why">
								{why || learnedWhy ? (
									rail ? (
										<DecisionContextSection
											sectionId="why"
											title={decisionText("Why am I seeing this")}
											trigger
											defaultOpen
										>
											{why}
											{learnedWhy && (
												<DecisionLearningWhy explanation={learnedWhy} />
											)}
										</DecisionContextSection>
									) : (
										<Collapsible
											className="fd-why"
											open={whyOpen}
											onOpenChange={setWhyOpen}
										>
											<CollapsibleDefaultTrigger>
												{decisionText("Why am I seeing this?")}
											</CollapsibleDefaultTrigger>
											{whyTarget &&
												createPortal(
													<CollapsibleDefaultContent className="text-kumo-subtle">
														{why}
														{learnedWhy && (
															<DecisionLearningWhy explanation={learnedWhy} />
														)}
													</CollapsibleDefaultContent>,
													whyTarget,
												)}
										</Collapsible>
									)
								) : null}
							</div>
							{(overflowActions.length > 0 ||
								(!disabled && !secureConnection) ||
								deckFooter ||
								deckCuration ||
								why ||
								learnedWhy ||
								faceState?.onOpenSettings) && (
								<DropdownMenu
									onOpenChange={(open) => {
										if (open)
											setQuiet({
												later: Boolean(quietControl("later")),
												notUseful: Boolean(quietControl("notUseful")),
												why: Boolean(quietControl("why")),
											});
									}}
								>
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												size="icon"
												className="fd-action-more"
												aria-label={decisionText("More actions")}
												disabled={busy}
											/>
										}
									>
										<DotsThree aria-hidden weight="bold" size={20} />
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										{overflowActions.map((action) => (
											<DropdownMenuItem
												key={action.id}
												disabled={action.disabled}
												onClick={() => choose(action)}
											>
												{actionLabel(action)}
											</DropdownMenuItem>
										))}
										{revision && !secureConnection && (
											<DropdownMenuItem
												onClick={() => setRevisionsOpen((open) => !open)}
											>
												{decisionText(
													revisionsOpen
														? "Hide versions"
														: "Versions and changes",
												)}
											</DropdownMenuItem>
										)}
										{!disabled && !secureConnection && !feedbackOpen && (
											<DropdownMenuItem onClick={() => setFeedbackOpen(true)}>
												{decisionText("Give feedback")}
											</DropdownMenuItem>
										)}
										{quiet.later && !outcomeRow && (
											<DropdownMenuItem
												onClick={() => quietControl("later")?.click()}
											>
												{decisionText("Later")}
											</DropdownMenuItem>
										)}
										{quiet.notUseful &&
											!overflowActions.some(
												(action) =>
													actionLabel(action) ===
													OS_COPY.decisionDeck.notUseful.button,
											) && (
												<DropdownMenuItem
													onClick={() => quietControl("notUseful")?.click()}
												>
													{OS_COPY.decisionDeck.notUseful.button}
												</DropdownMenuItem>
											)}
										{quiet.why && (
											<DropdownMenuItem
												onClick={() => quietControl("why")?.click()}
											>
												{decisionText("Why am I seeing this")}
											</DropdownMenuItem>
										)}
										{faceState?.onOpenSettings && (
											<DropdownMenuItem onClick={faceState.onOpenSettings}>
												{decisionText("Card settings")}
											</DropdownMenuItem>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</div>
					</CardFooter>
				)}
			</FeedDeckCard>
		</section>
	);
}
