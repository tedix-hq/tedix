import { createContext, type ReactNode } from "react";

export const DeckRemainingContext = createContext<
	((count: number) => void) | undefined
>(undefined);
export const DeckFooterContext = createContext<ReactNode>(null);
