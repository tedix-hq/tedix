import { createContext, type ReactNode } from "react";

/** After this long without a short summary, a card or row shows the original request instead of a skeleton. */
export const FACE_WAIT_MS = 8000;
import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";

export const CardFaceContext = createContext<{
	presentation: DecisionCardPresentation | null;
	confidence: number | null;
	dates?: readonly string[];
	now?: Date;
	timeZone?: string;
	/** Generation failed or the read errored; the card shows the original request instead. */
	unavailable?: boolean;
	/** Re-reads the face. Offered as a quiet text button next to the fallback note. */
	retry?: () => void;
	retrying?: boolean;
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
