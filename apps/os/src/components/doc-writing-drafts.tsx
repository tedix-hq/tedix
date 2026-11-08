import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { DocumentContent } from "@/lib/output-models";
import type { AppRuntimeDraft } from "@/lib/app-runtime-host";

type DocDraft = { revision: number; content: DocumentContent };
const Drafts = createContext<{
	documents: Map<string, DocDraft>;
	apps: Map<string, AppRuntimeDraft>;
} | null>(null);

/** Ephemeral drafts live only as long as the authenticated workspace panel. */
export function DocWritingDraftProvider({
	children,
	scope = "current",
}: {
	children: ReactNode;
	scope?: string;
}) {
	const drafts = useMemo(
		() => ({
			documents: new Map<string, DocDraft>(),
			apps: new Map<string, AppRuntimeDraft>(),
		}),
		[scope],
	);
	return <Drafts.Provider value={drafts}>{children}</Drafts.Provider>;
}

export function useDocWritingDrafts() {
	return useContext(Drafts)?.documents ?? null;
}

export function useAppRuntimeDrafts() {
	return useContext(Drafts)?.apps ?? null;
}
