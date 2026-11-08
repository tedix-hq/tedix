import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { DocumentContent } from "@/lib/output-models";

type DocDraft = { revision: number; content: DocumentContent };
const Drafts = createContext<Map<string, DocDraft> | null>(null);

/** Ephemeral drafts live only as long as the authenticated workspace panel. */
export function DocWritingDraftProvider({
	children,
	scope = "current",
}: {
	children: ReactNode;
	scope?: string;
}) {
	const drafts = useMemo(() => new Map<string, DocDraft>(), [scope]);
	return <Drafts.Provider value={drafts}>{children}</Drafts.Provider>;
}

export function useDocWritingDrafts() {
	return useContext(Drafts);
}
