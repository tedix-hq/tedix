import { createContext, type ReactNode } from "react";
import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";
import type {
	DecisionCardContextItem,
	DecisionCardPreferences,
} from "@tedix/api-contract/schemas/user-settings";

/**
 * The written card face. Without a presentation the card shows the original
 * ask as it is: there is no waiting or error face.
 */
export const CardFaceContext = createContext<{
	presentation: DecisionCardPresentation | null;
	confidence: number | null;
	dates?: readonly string[];
	now?: Date;
	timeZone?: string;
	/** The surrounding header already states the due date, so the strip omits it. */
	dueInHeader?: boolean;
	/** Decision class (or kind) that per-person card preferences are keyed by. */
	cardType?: string;
	preferences?: DecisionCardPreferences;
	/** Called once per decided card with the strip items it showed and those opened. */
	onContextUse?: (
		shown: readonly DecisionCardContextItem[],
		opened: readonly DecisionCardContextItem[],
	) => void;
	onOpenSettings?: () => void;
} | null>(null);

export const DeckRemainingContext = createContext<
	((count: number) => void) | undefined
>(undefined);
export const WorkToolbarTargetContext = createContext<HTMLDivElement | null>(
	null,
);

export const DeckFooterContext = createContext<ReactNode>(null);

/** Deck curation ("Not useful"), rendered inside the card's action row. */
export const DeckCurationContext = createContext<ReactNode>(null);

export const DeckNoticeContext = createContext<ReactNode>(null);
