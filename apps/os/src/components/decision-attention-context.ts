import { createContext } from "react";

/** The Deck observes successful choices; each card still owns its action and receipt. */
export const DecisionAttentionContext = createContext<
	| ((choice: {
			learningClientEventId?: string;
			action: string;
			intent?: string;
			signal: string;
			elapsedMs: number;
			decidedAt?: number;
			detailsOpened?: boolean;
	  }) => void)
	| null
>(null);
