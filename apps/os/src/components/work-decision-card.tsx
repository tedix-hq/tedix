import {
	DecisionContextSection,
	DecisionRailContext,
} from "@/components/decision-context-rail";
import type { WorkActorReference } from "@tedix/api-contract/schemas/os-work-actor";
import {
	DeckFooterContext,
	DeckNoticeContext,
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
import { decisionLearningKey } from "@/lib/decision-deck";
import { DecisionAttentionContext } from "@/components/decision-attention-context";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
	FeedDeckCard,
	FeedDeckDisclosure,
	ProposerChip,
} from "@/components/feed-deck-primitives";
import { useDecisionMotion } from "@/components/use-decision-motion";
import { Button } from "@/components/kumo/button";
import {
	CardContent,
	CardFooter,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { Textarea } from "@/components/kumo/textarea";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import { relativeTime, absoluteTime } from "@/lib/time";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import {
	DecisionProposalBody,
	DecisionProposalHeading,
	decisionProposalTitle,
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

/** Shared review surface. Callers own authorization, persistence and provider effects. */
export function WorkDecisionCard({
	kind,
	title,
	askedBy,
	actor,
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
	pending = false,
	disabled = false,
	autoFocus = false,
	onDecision,
	onDecisionSettled,
	onNext,
	onPrevious,
}: {
	kind: DecisionCardKind;
	title: string;
	askedBy: string;
	actor?: WorkActorReference;
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
	pending?: boolean;
	disabled?: boolean;
	autoFocus?: boolean;
	onDecision: (feedback: DecisionCardFeedback) => Promise<unknown>;
	onDecisionSettled?: () => void;
	onNext?: () => void;
	onPrevious?: () => void;
}) {
	const heading = decisionProposalTitle(title);
	const deckFooter = useContext(DeckFooterContext);
	const deckNotice = useContext(DeckNoticeContext);
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
	const learnedWhy = useContext(DecisionLearningContext);
	const shownAt = useRef(performance.now());
	const exposureSent = useRef(false);
	useEffect(() => {
		if (!attention || exposureSent.current) return;
		exposureSent.current = true;
		attention({ action: "shown", signal: "shown", elapsedMs: 0 });
	}, [attention]);
	const motion = useDecisionMotion();
	const section = motion.surface;
	useEffect(() => {
		if (
			autoFocus &&
			!rail?.open &&
			!document.activeElement?.closest(
				"input, textarea, [contenteditable=true]",
			)
		)
			section.current?.focus({ preventScroll: true });
	}, [autoFocus, rail?.open]);
	const [editing, setEditing] = useState(false);
	const [whyOpen, setWhyOpen] = useState(false);
	const [whyTarget, setWhyTarget] = useState<HTMLDivElement | null>(null);
	const [draft, setDraft] = useState(body);
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
	const busy = pending || saving || disabled || saved;
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
		const finalBody = kind === "question" ? answer.trim() : draft.trim();
		if (kind === "question" && !finalBody && action.id !== feedbackAction?.id)
			return;
		inFlight.current = true;
		setSaving(true);
		setError("");
		const departure = section.current?.closest(".fd-deck")
			? motion.exit(action.intent)
			: undefined;
		try {
			const result = await onDecision({
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
				elapsedMs: Math.max(0, Math.round(performance.now() - shownAt.current)),
			});
			setConfirmation(null);
			toast.success(decisionText("Decision saved"));
			await departure;
			setSaved(true);
			onNext?.();
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
			aria-label={title}
			tabIndex={0}
			className="fd-decision min-w-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
			style={motion.style}
			data-dragging={motion.dragging}
			data-direction={motion.direction}
			data-exiting={motion.exiting}
			onPointerDown={(event) => {
				if (!busy && !confirmation && section.current?.closest(".fd-deck"))
					motion.start(event);
			}}
			onPointerMove={motion.move}
			onPointerCancel={motion.reset}
			onPointerLeave={motion.reset}
			onPointerUp={(event) => {
				const direction = motion.end(event);
				if (event.pointerType !== "touch" && !confirmation && direction)
					choose(direction > 0 ? approve : reject);
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
						<ProposerChip name={askedBy} actor={actor} />
						{at ? (
							<time dateTime={at} title={absoluteTime(at)}>
								· {relativeTime(at)}
							</time>
						) : null}
					</CardDescription>
					<CardTitle
						className="text-xl leading-snug"
						style={
							{
								"--fd-title-size": heading.length > 55 ? "2.2vw" : "3vw",
							} as React.CSSProperties
						}
					>
						<DecisionProposalHeading title={heading} />
					</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="fd-card-body grid grid-cols-1 gap-4">
						{deckNotice}
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
						) : (
							(content ?? (body ? <DecisionProposalBody body={body} /> : null))
						)}
						{heading !== title && (
							<DecisionContextSection title="Identifiers and source">
								<p className="fd-identifier">{title}</p>
							</DecisionContextSection>
						)}
						{kind === "question" && !disabled && !saved ? (
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
								<Input
									aria-label={decisionText("Your answer")}
									placeholder={decisionText("Your answer…")}
									value={answer}
									disabled={busy}
									onChange={(event) => setAnswer(event.target.value)}
									onKeyDown={(event) => {
										if (
											event.key === "Enter" &&
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
								{!disabled ? (
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
				{!saved && (
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
									const button = (
										<Button
											key={action.id}
											data-decision-intent={action.intent}
											className={
												kind === "decision" ||
												kind === "adr" ||
												action.description
													? "h-auto min-h-20 w-full min-w-0 whitespace-normal text-left"
													: "min-h-11 grow sm:grow-0"
											}
											variant={
												action.intent === "approve" ? "default" : "ghost"
											}
											disabled={
												busy ||
												action.disabled ||
												(kind === "question" && !answer.trim()) ||
												(editing && !draft.trim())
											}
											onClick={() => choose(action)}
										>
											{saving ? (
												decisionText("Saving…")
											) : (
												<span className="grid min-w-0 gap-1 whitespace-normal break-words">
													<span>
														{action.label}
														<kbd
															className="fd-action-key"
															aria-hidden="true"
															data-key={
																action.intent === "approve"
																	? "→"
																	: action.intent === "reject"
																		? "←"
																		: action.intent === "later"
																			? "L"
																			: "D"
															}
														/>
													</span>
													{action.description ? (
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
						</div>
					</CardFooter>
				)}
			</FeedDeckCard>
			<div className="fd-card-why">
				{why || learnedWhy ? (
					rail ? (
						<DecisionContextSection
							sectionId="why"
							title={decisionText("Why this")}
							trigger
						>
							{why}
							{learnedWhy && <DecisionLearningWhy explanation={learnedWhy} />}
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
		</section>
	);
}
