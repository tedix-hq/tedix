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
	};
	/** Shown only when the card has no deadline of its own. */
	expiresAt?: string | null;
}) {
	useOsFormattingPreferences();
	if (!card) return null;
	const ask = OS_COPY.decisionDeck.ask;
	const parts = [
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
			data-overdue={card.overdue && !card.expired && !card.handled}
		>
			{parts.join(" · ")}
		</span>
	);
}
