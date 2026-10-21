import type { DeckAskKind } from "../schemas/attention";
import type { DecisionEnvelope } from "../schemas/os-decision-deck";
import { calendarDay } from "./card-schedule";
import defaults from "../assets/deck-pipeline.v1.json";
import { classifyDeckAsk } from "./deck-qualification";
import type { DeckPipelineConfig } from "../schemas/deck-pipeline";

export const DECK_ASK_KINDS = [
	"task",
	"send",
	"decide",
	"approve_draft",
	"answer",
	"consent",
] as const satisfies readonly DeckAskKind[];

export const DECK_ASK_LABELS: Record<DeckAskKind, string> = {
	task: "Task for you",
	send: "Send",
	decide: "Decide",
	approve_draft: "Approve draft",
	answer: "Answer",
	consent: "Consent",
};

type AskSource = {
	kind: string;
	label?: string;
	decision?: DecisionEnvelope | null;
	factory?: { draft?: string | null } | null;
	request?: {
		subject?: string;
		prompt?: string;
		metadata?: Record<string, unknown> | null;
		expiresAt?: string | null;
	} | null;
};

/** Derived from typed card data: card kind, decision effects and factory draft text. */
export function deckAskKind(
	card: AskSource,
	qualification?: DeckPipelineConfig["qualification"],
): DeckAskKind {
	const response = classifyDeckAsk(
		{
			kind: card.kind,
			subject: card.request?.subject ?? card.label,
			prompt: card.request?.prompt,
			metadata: card.request?.metadata,
			decision: card.decision,
		},
		qualification,
	);
	if (response.responseKind === "task") return "task";
	const effects = card.decision?.protectedEffects ?? [];
	if (
		card.kind === "approval" ||
		effects.includes("consent") ||
		Boolean(card.request?.metadata?.localImport)
	)
		return "consent";
	if (card.kind === "outbound" || effects.includes("message")) return "send";
	if (card.factory?.draft?.trim() || card.decision?.preview?.body.trim())
		return "approve_draft";
	if (card.kind === "question")
		return response.responseKind === "choice" ? "decide" : "answer";
	return "decide";
}

export function hasReviewTargetDeadline(metadata: Record<string, unknown>) {
	return (
		metadata.deadlineOrigin === "review_target" ||
		(typeof metadata.deadlineBasis === "string" &&
			/\b(?:triage|review target)\b/i.test(metadata.deadlineBasis))
	);
}

/** A review/triage target is scheduling metadata, never a source deadline. */
export function sourceInteractionDeadline(
	dueAt: string | null | undefined,
	metadata: Record<string, unknown> = {},
): string | null {
	if (hasReviewTargetDeadline(metadata)) return null;
	return dueAt && Number.isFinite(Date.parse(dueAt)) ? dueAt : null;
}

/** Source due dates and explicit decision/approval expiries; request lifetime defaults are separate. */
export function deckCardDeadline(card: {
	dueAt?: string | null;
	decision?: { expiresAt?: string } | null;
	runtimeApproval?: { expiresAt?: string | null } | null;
	request?: { expiresAt?: string | null } | null;
}): string | null {
	const values = [
		card.dueAt,
		card.decision?.expiresAt,
		card.runtimeApproval?.expiresAt,
	].filter(
		(value): value is string =>
			typeof value === "string" && Number.isFinite(Date.parse(value)),
	);
	return values.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

/** A date-only deadline stays current through that whole day in the viewer's timezone. */
export function deadlineOverdue(
	deadline: string | null | undefined,
	now: Date,
	timeZone?: string,
): boolean {
	if (!deadline) return false;
	if (/^\d{4}-\d{2}-\d{2}$/.test(deadline))
		return deadline < calendarDay(now, timeZone);
	const at = Date.parse(deadline);
	return Number.isFinite(at) && at < now.getTime();
}

export function draftedNotSent(
	card: { askKind: DeckAskKind; requestedAt?: string | null },
	now: Date,
	staleDraftHours: number,
): boolean {
	const at = Date.parse(card.requestedAt ?? "");
	return (
		card.askKind === "send" &&
		Number.isFinite(at) &&
		now.getTime() - at >= staleDraftHours * 3_600_000
	);
}

/** The ask's own expiry passed: the event is over, so the card is expired, not overdue. */
export function deckCardExpired(
	card: {
		decision?: { expiresAt?: string } | null;
		runtimeApproval?: { expiresAt?: string | null } | null;
		request?: { expiresAt?: string | null } | null;
	},
	now: Date,
): boolean {
	return [
		card.decision?.expiresAt,
		card.runtimeApproval?.expiresAt,
		card.request?.expiresAt,
	].some((value) => {
		const at = Date.parse(value ?? "");
		return Number.isFinite(at) && at <= now.getTime();
	});
}

/** The card's Work Item finished or was cancelled, so the ask was handled. */
export function deckCardHandled(card: {
	workItem?: { disposition?: string | null } | null;
}): boolean {
	const disposition = card.workItem?.disposition;
	return disposition === "completed" || disposition === "cancelled";
}

/** Withdrawal is different from an ordinary actionable missed deadline. */
export function deckCardStale(
	card: {
		dueAt?: string | null;
		decision?: { expiresAt?: string } | null;
		request?: {
			subject?: string;
			prompt?: string;
			expiresAt?: string | null;
			metadata?: Record<string, unknown> | null;
		} | null;
		workItem?: { disposition?: string | null } | null;
	},
	now: Date,
	config: DeckPipelineConfig["qualification"] = defaults.qualification,
	timeZone?: string,
) {
	if (!config.enabled) return false;
	if (config.blockedDispositions.includes(card.workItem?.disposition ?? ""))
		return true;
	const metadata = card.request?.metadata;
	const face = metadata?.cardPresentation;
	const faceBody =
		face &&
		typeof face === "object" &&
		"body" in face &&
		typeof face.body === "string"
			? face.body
			: "";
	const text = [
		card.request?.subject,
		card.request?.prompt,
		typeof metadata?.cardContent === "string" ? metadata.cardContent : "",
		faceBody,
	]
		.filter(Boolean)
		.join("\n");
	return (
		deadlineOverdue(deckCardDeadline(card), now, timeZone) &&
		new RegExp(config.stalePattern, "iu").test(text)
	);
}

/** One derivation for every Deck surface: API projection, OS rows and MCP view. */
export function deckAsk(
	card: AskSource & {
		dueAt?: string | null;
		requestedAt?: string | null;
		runtimeApproval?: { expiresAt?: string | null } | null;
		workItem?: { disposition?: string | null } | null;
	},
	now: Date,
	options: {
		timeZone?: string;
		staleDraftHours?: number;
		qualification?: DeckPipelineConfig["qualification"];
	} = {},
) {
	const response = classifyDeckAsk(
		{
			kind: card.kind,
			subject: card.request?.subject ?? card.label,
			prompt: card.request?.prompt,
			metadata: card.request?.metadata,
			decision: card.decision,
		},
		options.qualification,
	);
	const askKind = deckAskKind(card, options.qualification);
	const deadline = deckCardDeadline(card);
	const handled = deckCardHandled(card);
	const expired =
		!handled &&
		(deckCardExpired(card, now) ||
			deckCardStale(card, now, options.qualification, options.timeZone));
	const actionable =
		!handled &&
		!expired &&
		(response.responseKind !== "task" || response.ownerTask !== null);
	return {
		askKind,
		...response,
		actionable,
		deadline,
		// Overdue only while the ask can still be acted on.
		overdue: actionable && deadlineOverdue(deadline, now, options.timeZone),
		...(handled ? { handled } : {}),
		...(expired ? { expired } : {}),
		draftedNotSent: draftedNotSent(
			{ askKind, requestedAt: card.requestedAt },
			now,
			options.staleDraftHours ?? 24,
		),
	};
}
