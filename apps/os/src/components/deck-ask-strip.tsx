import type { DeckAskKind } from "@tedix/api-contract/schemas/attention";
import { useOsFormattingPreferences } from "@/lib/format";
import { shortDeadline } from "@/lib/time";
import { OS_COPY } from "@/shared/os-copy";

/**
 * The current card's state and its one date that matters, as quiet text for
 * the Deck's single meta line. Any other date stays in Details.
 */
export function DeckAskStrip({
	card,
	expiresAt,
}: {
	card?: {
		askKind: DeckAskKind;
		deadline: string | null;
		overdue: boolean;
		handled?: boolean;
		expired?: boolean;
		draftedNotSent: boolean;
		/** The shared priority; its reason leads the line. */
		priority?: { reason: string; factor: string; band: string };
	};
	/** Shown only when the card has no deadline of its own. */
	expiresAt?: string | null;
}) {
	useOsFormattingPreferences();
	if (!card) return null;
	const ask = OS_COPY.decisionDeck.ask;
	// A deadline reason is the due line, in the viewer's own date format.
	const datedReason =
		card.priority?.factor === "deadline" || card.priority?.factor === "overdue";
	const parts = [
		!card.expired && !card.handled && !datedReason
			? card.priority?.reason
			: null,
		card.expired
			? ask.expired
			: card.handled
				? ask.handled
				: card.deadline
					? card.overdue
						? ask.overdueSince(shortDeadline(card.deadline))
						: ask.due(shortDeadline(card.deadline))
					: expiresAt
						? ask.expires(shortDeadline(expiresAt))
						: null,
		card.draftedNotSent ? ask.draftedNotSent : null,
	].filter(Boolean);
	if (!parts.length) return null;
	return (
		<span
			className="fd-deck-ask"
			data-deck-ask={card.askKind}
			data-priority-band={card.priority?.band}
			data-priority-factor={card.priority?.factor}
			data-overdue={card.overdue && !card.expired && !card.handled}
		>
			{parts.join(" · ")}
		</span>
	);
}
