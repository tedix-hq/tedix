import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AppRuntimeDraft } from "@/lib/app-runtime-host";

const Drafts = createContext<Map<string, AppRuntimeDraft> | null>(null);

/** Unsaved app edits live only as long as the authenticated workspace panel. */
export function AppRuntimeDraftProvider({
	children,
	scope = "current",
}: {
	children: ReactNode;
	scope?: string;
}) {
	const drafts = useMemo(() => new Map<string, AppRuntimeDraft>(), [scope]);
	return <Drafts.Provider value={drafts}>{children}</Drafts.Provider>;
}

export function useAppRuntimeDrafts() {
	return useContext(Drafts);
}
