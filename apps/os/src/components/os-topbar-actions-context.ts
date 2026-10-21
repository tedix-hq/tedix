import { createContext, type RefObject } from "react";

export const OsTopbarActionsTargetContext =
	createContext<HTMLDivElement | null>(null);

/** Panels stay outside the menu so closing it cannot unmount an open panel. */
export const OsTopbarMenuContext = createContext<{
	target: HTMLDivElement | null;
	anchor: RefObject<HTMLButtonElement | null>;
} | null>(null);
