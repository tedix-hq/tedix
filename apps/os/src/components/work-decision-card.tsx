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
	FACE_WAIT_MS,
} from "@/components/deck-presentation-context";
import {
	DecisionLearningContext,
	DecisionLearningWhy,
} from "@/components/decision-learning-context";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
} from "@/components/kumo/alert-dialog";
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
import { useDecisionMotion } from "@/components/use-decision-motion";
import { Button } from "@/components/kumo/button";
import { Loader } from "@/components/kumo/loader";
import { Skeleton } from "@/components/kumo/skeleton";
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
import { useOsFormattingPreferences } from "@/lib/format";
import { relativeTime, absoluteTime } from "@/lib/time";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import {
	decisionCardActionLabel,
	renderDecisionCardDates,
	renderCardDateText,
} from "@tedix/api-contract/utils/decision-card-copy";
import {
	DecisionProposalBody,
	DecisionProposalHeading,
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
}

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

/*
 * The Button adapter resolves Kumo's primary label color through an inline
 * `--color-white`, which no stylesheet rule can outrank. A disabled secondary
 * action trades the accent pairing for the muted pairing feed-deck.css paints;
 * a disabled primary keeps its label color on a lighter primary fill.
 */
const DISABLED_ACTION_LABEL = {
	"--color-white": "var(--muted-foreground)",
} as CSSProperties;

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
		? renderDecisionCardDates(
				faceState.presentation,
				faceState.dates,
				faceState.now,
				faceState.timeZone,
			)
		: null;
	const [sourceRead, setSourceRead] = useState(false);
	// The headline is always real text: the short summary's ask when it exists,
	// otherwise the original request title. Never a status word.
	const heading = decisionProposalTitle(
		face?.title ?? (renderCardDateText(title) || "Review this request?"),
	);
	const faceWaiting = !!faceState && !face && !faceState.unavailable;
	const [faceSlow, setFaceSlow] = useState(false);
	const [faceRetries, setFaceRetries] = useState(0);
	// The wait restarts per card (title) and per retry.
	useEffect(() => {
		if (!faceWaiting) return;
		setFaceSlow(false);
		const timer = setTimeout(() => setFaceSlow(true), FACE_WAIT_MS);
		return () => clearTimeout(timer);
	}, [faceWaiting, faceRetries, title]);
	// Only the summary is loading; everything else on the card is real now.
	const faceFallback =
		!!faceState && !face && (!!faceState.unavailable || faceSlow);
	const faceSkeleton = faceWaiting && !faceSlow;
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
		if (!attention || exposureSent.current || (faceSkeleton && !sourceRead))
			return;
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
	}, [attention, faceSkeleton, sourceRead]);
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
	// A loading summary never blocks the decision: the headline and original
	// request are real now, so actions stay live until a choice is submitted.
	const busy = pending || saving || disabled || saved || revising;
	const submit = async (
		action: DecisionCardAction,
		reason?: string,
		confirmed = false,
	) => {
		if (
			busy ||
			action.disabled ||
			inFlight.current ||
			(confirmed && action.confirmDisabled)
		)
			return;
		if (action.id === editAction?.id && draft === body && !hasEdits) return;
		if (action.confirm && !confirmed) {
			setConfirmation(action);
			return;
		}
		const finalBody =
			action.intent === "reject"
				? action.label
				: kind === "question"
					? answer.trim()
					: draft.trim();
		if (containsCardSecret([finalBody, feedback, reason])) {
			setError(CARD_SECRET_MESSAGE);
			return;
		}
		if (secureConnection) {
			setError("Use connection settings to update credentials.");
			return;
		}
		if (
			kind === "question" &&
			action.intent !== "reject" &&
			!finalBody &&
			action.id !== feedbackAction?.id
		)
			return;
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
				});
			};
			const result = await (optimistic && !revisionEdit
				? optimistic(write)
				: write());
			if (revisionEdit) {
				setEditing(false);
				toast.success("Version saved for review");
				return;
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
			toast.success(decisionText("Decision saved"));
			await departure;
			setSaved(true);
			if (!optimistic) onNext?.();
		} catch (cause) {
			motion.cancelExit();
			setError(
				cause instanceof Error
					? cause.message
					: decisionText("Your decision could not be saved. Try again."),
			);
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
	const choose = (action: DecisionCardAction | undefined) => {
		if (!action || action.disabled || busy) return;
		if (section.current?.closest(".fd-deck")) motion.pulse();
		if (kind === "outbound" && action.intent === "reject") setReasonsOpen(true);
		else void submit(action);
	};
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
					setSourceRead(true);
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
					const action = actions.find(
						(action) =>
							action.intent ===
							(event.key.toLowerCase() === "d" ? "delegate" : "later"),
					);
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
								<span>Tedix</span>
							) : (
								<ProposerChip name={askedBy} actor={actor} />
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
				<CardContent>
					<div className="fd-card-body grid grid-cols-1 gap-4">
						{deckNotice}
						{submittingActor && (
							<>
								{!faceState &&
									(submittingActor.type === "external_agent" ||
										submittingActor.contributor) && (
										<WorkSourceProvenance
											actor={submittingActor}
											name={askedBy}
											source={contributionSource}
										/>
									)}
								<DecisionContextSection
									sectionId="provenance"
									title="Source provenance"
								>
									<WorkSourceProvenance
										actor={submittingActor}
										name={askedBy}
										source={contributionSource}
										details
									/>
								</DecisionContextSection>
							</>
						)}
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
								<div className="grid gap-3">
									{face ? (
										<div className="fd-face-enter grid gap-3">
											{"context" in face && <Text>{face.context}</Text>}
											<Text className="fd-card-summary">
												<strong>If yes:</strong> {withoutIfYes(face.body)}
											</Text>
											<Text className="fd-recommendation">
												{face.recommendation}
												{faceState.confidence !== null &&
													` · ${Math.round(faceState.confidence * 100)}% sure`}
											</Text>
											{"stakes" in face && face.stakes && (
												<Text className="fd-stakes">{face.stakes}</Text>
											)}
										</div>
									) : faceFallback ? (
										<div className="fd-face-enter fd-face-fallback grid gap-2">
											{content ?? <DecisionProposalBody body={body || title} />}
											<div
												role="status"
												className="fd-face-note"
												data-face-fallback
											>
												<span>
													{decisionText(
														"Summary unavailable — showing the original request",
													)}
												</span>
												{faceState.retry && (
													<Button
														variant="ghost"
														size="sm"
														className="fd-face-retry"
														disabled={faceState.retrying}
														onClick={() => {
															setFaceRetries((count) => count + 1);
															faceState.retry?.();
														}}
													>
														{faceState.retrying ? (
															<>
																<Loader aria-hidden="true" size="sm" />
																{decisionText("Retrying…")}
															</>
														) : (
															decisionText("Retry")
														)}
													</Button>
												)}
											</div>
										</div>
									) : (
										<div
											role="status"
											aria-busy="true"
											className="fd-face-skeleton"
											data-face-pending
										>
											<Skeleton aria-hidden="true" className="w-full" />
											<Skeleton aria-hidden="true" className="w-11/12" />
											<Skeleton aria-hidden="true" className="w-3/5" />
											<span className="fd-face-writing">
												<Loader aria-hidden="true" size="sm" />
												{decisionText("Writing a short summary…")}
											</span>
										</div>
									)}
									{!faceFallback && (
										<FeedDeckDisclosure
											title={rail ? "Original request" : OS_COPY.feed.details}
										>
											<Text weight="semibold">{title}</Text>
											{content ??
												(body ? <DecisionProposalBody body={body} /> : null)}
										</FeedDeckDisclosure>
									)}
								</div>
							) : (
								(content ??
								(body ? <DecisionProposalBody body={body} /> : null))
							)}
						</div>
						{identifiers.length > 0 && (
							<DecisionContextSection
								sectionId="source"
								title="Identifiers and source"
							>
								<div className="fd-identifiers">
									{identifiers.map((id) => (
										<code key={id} className="fd-identifier" title={id}>
											{id}
										</code>
									))}
								</div>
							</DecisionContextSection>
						)}
						{secureConnection && (
							<Button
								variant="outline"
								render={<a href="/account/connections" />}
							>
								Open connection settings
							</Button>
						)}
						{revision && !secureConnection && (
							<FeedDeckDisclosure
								title="Card revisions"
								open={revisionsOpen}
								onOpenChange={setRevisionsOpen}
							>
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
									agentName={askedBy}
									disabled={disabled || pending || saving || saved}
									onRevising={setRevising}
									cardRef={section}
									onOpen={() => {
										if (rail) rail.openSection("details");
										else setRevisionsOpen(true);
									}}
								/>
							</FeedDeckDisclosure>
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
									rows={3}
									aria-label={decisionText("Your answer")}
									placeholder={decisionText("Your answer…")}
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
						{saved ? (
							<Text role="label" tone="secondary">
								{decisionText("Decision saved")}
							</Text>
						) : (
							<>
								{actions.some((action) => action.description) && (
									<FeedDeckDisclosure
										className="fd-action-details"
										title={OS_COPY.feedDeckVisual.choices}
									>
										{actions
											.filter((action) => action.description)
											.map((action) => (
												<p key={action.id}>
													<strong>{action.label}.</strong> {action.description}
												</p>
											))}
									</FeedDeckDisclosure>
								)}
								{reasonsOpen && reject ? (
									<div
										className="flex flex-wrap gap-2"
										aria-label={decisionText("Why not this?")}
									>
										{["wrong tone", "wrong facts", "not now", "don't send"].map(
											(reason) => (
												<Button
													key={reason}
													variant="outline"
													disabled={busy}
													onClick={() => void submit(reject, reason)}
												>
													{reason}
												</Button>
											),
										)}
									</div>
								) : null}
								<AlertDialog
									open={Boolean(confirmation)}
									onOpenChange={(open) => {
										if (!open && !saving) setConfirmation(null);
									}}
								>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>
												{decisionText("Confirm decision")}
											</AlertDialogTitle>
											<AlertDialogDescription>
												{confirmation?.confirm}
											</AlertDialogDescription>
										</AlertDialogHeader>
										{confirmation?.confirmContent}
										<AlertDialogFooter>
											<Button
												variant="ghost"
												disabled={busy}
												onClick={() => setConfirmation(null)}
											>
												{decisionText("Go back")}
											</Button>
											<Button
												disabled={busy || confirmation?.confirmDisabled}
												onClick={() => {
													if (confirmation)
														void submit(confirmation, undefined, true);
												}}
											>
												{decisionText("Confirm")}
											</Button>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
								{!disabled && !secureConnection ? (
									<DecisionContextSection title="Feedback">
										<div className="fd-feedback">
											<Button
												variant="ghost"
												disabled={busy}
												onClick={() => setFeedbackOpen(!feedbackOpen)}
											>
												{decisionText("Give feedback")}
											</Button>
											{feedbackOpen ? (
												<Textarea
													aria-label={decisionText("Optional feedback")}
													placeholder={decisionText(
														"What should change? (optional)",
													)}
													rows={2}
													value={feedback}
													onChange={(event) => setFeedback(event.target.value)}
												/>
											) : null}
											{feedbackOpen && feedbackAction ? (
												<Button
													className="mt-2"
													disabled={busy || !feedback.trim()}
													onClick={() => void submit(feedbackAction)}
												>
													{feedbackAction.label}
												</Button>
											) : null}
										</div>
									</DecisionContextSection>
								) : null}
							</>
						)}
						{error ? (
							<p role="alert" className="text-kumo-danger">
								{error}
							</p>
						) : null}
						{!rail && (why || learnedWhy) && <div ref={setWhyTarget} />}
					</div>
				</CardContent>
				{!saved && !secureConnection && (
					<CardFooter ref={footer}>
						{" "}
						<div
							data-decision-actions
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
									const label = decisionCardActionLabel(
										face,
										action.id,
										action.intent,
										action.label,
									);
									const shortcut = ACTION_SHORTCUTS[action.intent ?? ""];
									const inactive =
										busy ||
										action.disabled ||
										(kind === "question" &&
											action.intent !== "reject" &&
											!answer.trim()) ||
										(editing && !draft.trim());
									const control = (
										<Button
											data-decision-intent={action.intent}
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
											variant={
												action === approve
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
									<Button
										variant="outline"
										className="min-h-11"
										disabled={busy}
										onClick={() => setEditing(!editing)}
									>
										{editing ? decisionText("Preview") : decisionText("Change")}
									</Button>
								</DecisionContextSection>
							) : null}
							{!actions.some((action) => action.intent === "later") &&
								deckFooter}
							{deckCuration}
							<div className="fd-card-why">
								{why || learnedWhy ? (
									rail ? (
										<DecisionContextSection
											sectionId="why"
											title={decisionText("Why this")}
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
											<CollapsibleTrigger>
												{decisionText("Why this?")}
											</CollapsibleTrigger>
											{whyTarget &&
												createPortal(
													<CollapsibleContent className="pt-3 text-kumo-subtle">
														{why}
														{learnedWhy && (
															<DecisionLearningWhy explanation={learnedWhy} />
														)}
													</CollapsibleContent>,
													whyTarget,
												)}
										</Collapsible>
									)
								) : null}
							</div>
						</div>
					</CardFooter>
				)}
			</FeedDeckCard>
		</section>
	);
}
