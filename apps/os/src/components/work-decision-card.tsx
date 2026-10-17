import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogFooter,
} from "@/components/kumo/alert-dialog";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { Textarea } from "@/components/kumo/textarea";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import { relativeTime, absoluteTime } from "@/lib/time";

export type DecisionCardKind =
	| "outbound"
	| "proposal"
	| "question"
	| "approval"
	| "decision";
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
	intent?: "approve" | "reject";
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
	at,
	why,
	body = "",
	content,
	actions = [],
	feedbackAction,
	editAction,
	suggestedAnswers = [],
	initialAnswer = "",
	pending = false,
	disabled = false,
	onDecision,
	onNext,
	onPrevious,
}: {
	kind: DecisionCardKind;
	title: string;
	askedBy: string;
	at?: string;
	why?: ReactNode;
	body?: string;
	content?: ReactNode;
	actions?: readonly DecisionCardAction[];
	feedbackAction?: DecisionCardAction;
	editAction?: DecisionCardAction;
	suggestedAnswers?: readonly string[];
	initialAnswer?: string;
	pending?: boolean;
	disabled?: boolean;
	onDecision: (feedback: DecisionCardFeedback) => Promise<unknown>;
	onNext?: () => void;
	onPrevious?: () => void;
}) {
	const [editing, setEditing] = useState(false);
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
		try {
			await onDecision({
				action: action.id,
				signal:
					action.id === feedbackAction?.id
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
			setSaved(true);
			setConfirmation(null);
			toast.success("Got it — your feedback helps me learn.");
			onNext?.();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Your decision could not be saved. Try again.",
			);
		} finally {
			inFlight.current = false;
			setSaving(false);
		}
	};
	const approve = actions.find((action) => action.intent === "approve");
	const reject = actions.find((action) => action.intent === "reject");
	const choose = (action: DecisionCardAction | undefined) => {
		if (!action || action.disabled || busy) return;
		if (kind === "outbound" && action.intent === "reject") setReasonsOpen(true);
		else void submit(action);
	};
	return (
		<section
			aria-label={title}
			tabIndex={0}
			className="min-w-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
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
			<Card tone="raised">
				<CardHeader>
					<CardDescription className="flex flex-wrap items-center gap-2">
						<span>{askedBy}</span>
						{at ? (
							<time dateTime={at} title={absoluteTime(at)}>
								· {relativeTime(at)}
							</time>
						) : null}
					</CardDescription>
					<CardTitle className="text-xl leading-snug">{title}</CardTitle>
				</CardHeader>
				<CardContent className="grid gap-4">
					{editing ? (
						<Textarea
							aria-label="Edit draft"
							rows={8}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							disabled={busy}
						/>
					) : (
						(content ??
						(body ? (
							<p className="m-0 whitespace-pre-wrap break-words leading-relaxed">
								{body}
							</p>
						) : null))
					)}
					{kind === "question" && !disabled && !saved ? (
						<div className="grid gap-3">
							{suggestedAnswers.length ? (
								<div
									className="flex flex-wrap gap-2"
									aria-label="Suggested answers"
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
								aria-label="Your answer"
								placeholder="Your answer…"
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
							Decision saved
						</Text>
					) : (
						<>
							<div
								className={
									kind === "decision"
										? "grid gap-3 sm:grid-cols-2"
										: "flex flex-wrap gap-2"
								}
							>
								{actions.map((action) => (
									<Button
										key={action.id}
										className={
											kind === "decision"
												? "h-auto min-h-20 whitespace-normal text-left"
												: "min-h-11 grow sm:grow-0"
										}
										variant={
											action.intent === "approve" ? "default" : "outline"
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
											"Saving…"
										) : (
											<span className="grid gap-1">
												<span>{action.label}</span>
												{action.description ? (
													<span className="font-normal text-kumo-subtle">
														{action.description}
													</span>
												) : null}
											</span>
										)}
									</Button>
								))}
								{editing && editAction ? (
									<Button
										disabled={busy || !draft.trim() || draft === body}
										onClick={() => void submit(editAction)}
									>
										{editAction.label}
									</Button>
								) : null}
								{kind === "outbound" && !disabled ? (
									<Button
										variant="outline"
										className="min-h-11"
										disabled={busy}
										onClick={() => setEditing(!editing)}
									>
										{editing ? "Preview" : "Change"}
									</Button>
								) : null}
							</div>
							{reasonsOpen && reject ? (
								<div
									className="flex flex-wrap gap-2"
									aria-label="Why not this?"
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
									<AlertDialogTitle>Confirm decision</AlertDialogTitle>
									<AlertDialogDescription>
										{confirmation?.confirm}
									</AlertDialogDescription>
									{confirmation?.confirmContent}
									<AlertDialogFooter>
										<Button
											variant="ghost"
											disabled={busy}
											onClick={() => setConfirmation(null)}
										>
											Go back
										</Button>
										<Button
											disabled={busy || confirmation?.confirmDisabled}
											onClick={() => {
												if (confirmation)
													void submit(confirmation, undefined, true);
											}}
										>
											Confirm
										</Button>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
							{!disabled ? (
								<div>
									<Button
										variant="ghost"
										disabled={busy}
										onClick={() => setFeedbackOpen(!feedbackOpen)}
									>
										Give feedback
									</Button>
									{feedbackOpen ? (
										<Textarea
											aria-label="Optional feedback"
											placeholder="What should change? (optional)"
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
							) : null}
						</>
					)}
					{error ? (
						<p role="alert" className="text-kumo-danger">
							{error}
						</p>
					) : null}
					{why ? (
						<details>
							<summary className="cursor-pointer text-kumo-subtle">
								Why this?
							</summary>
							<div className="pt-3 text-kumo-subtle">{why}</div>
						</details>
					) : null}
				</CardContent>
			</Card>
		</section>
	);
}
