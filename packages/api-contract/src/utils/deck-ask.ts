import type { DeckAskKind } from "../schemas/attention";
import type { DecisionEnvelope } from "../schemas/os-decision-deck";
import { calendarDay } from "./card-schedule";

export const DECK_ASK_KINDS = [
	"send",
	"decide",
	"approve_draft",
	"answer",
	"consent",
] as const satisfies readonly DeckAskKind[];

export const DECK_ASK_LABELS: Record<DeckAskKind, string> = {
	send: "Send",
	decide: "Decide",
	approve_draft: "Approve draft",
	answer: "Answer",
	consent: "Consent",
};

type AskSource = {
	kind: string;
	decision?: DecisionEnvelope | null;
	factory?: { draft?: string | null } | null;
	request?: { metadata?: Record<string, unknown> | null } | null;
};

/** Derived from typed card data: card kind, decision effects and factory draft text. */
export function deckAskKind(card: AskSource): DeckAskKind {
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
	if (card.kind === "question") return "answer";
	return "decide";
}

/** The earliest of the deadlines a card carries; date-only values sort before same-day times. */
export function deckCardDeadline(card: {
	dueAt?: string | null;
	decision?: { expiresAt?: string } | null;
	runtimeApproval?: { expiresAt?: string | null } | null;
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

/** One derivation for every Deck surface: API projection, OS rows and MCP view. */
export function deckAsk(
	card: AskSource & {
		dueAt?: string | null;
		requestedAt?: string | null;
		runtimeApproval?: { expiresAt?: string | null } | null;
	},
	now: Date,
	options: { timeZone?: string; staleDraftHours?: number } = {},
) {
	const askKind = deckAskKind(card);
	const deadline = deckCardDeadline(card);
	return {
		askKind,
		deadline,
		overdue: deadlineOverdue(deadline, now, options.timeZone),
		draftedNotSent: draftedNotSent(
			{ askKind, requestedAt: card.requestedAt },
			now,
			options.staleDraftHours ?? 24,
		),
	};
}
