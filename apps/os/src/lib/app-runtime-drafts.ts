import type { AppRuntimeFiles } from "@tedix/api-contract/schemas/os-app-runtime";
import {
	type OsAppDraftContent,
	OsAppDraftContentSchema,
	type OsCollaborationProposal,
	type OsGadgetManifest,
} from "@tedix/api-contract/schemas/os-workspaces";
import { canonicalJsonText } from "@/lib/diff/canonical-json";

/**
 * Drafts of a runtime app: open or approved collaboration proposals on the
 * gadget whose content carries the next manifest and the full set of files.
 * A proposal without files (a settings-only suggestion) is not a draft and
 * stays with the generic suggested-changes list.
 */
export type AppDraft = {
	proposal: OsCollaborationProposal;
	content: OsAppDraftContent;
};

export const APP_DRAFT_STATUSES: OsCollaborationProposal["status"][] = [
	"open",
	"accepted",
];

export function appDraftContent(
	proposal: OsCollaborationProposal,
): OsAppDraftContent | null {
	if (proposal.documentType !== "gadget") return null;
	const parsed = OsAppDraftContentSchema.safeParse(proposal.content);
	return parsed.success ? parsed.data : null;
}

/** True for a proposal the app's Drafts view shows instead of the generic list. */
export function isAppDraftProposal(proposal: OsCollaborationProposal): boolean {
	return appDraftContent(proposal) !== null;
}

export function appDraftsFrom(
	proposals: readonly OsCollaborationProposal[],
): AppDraft[] {
	const drafts: AppDraft[] = [];
	for (const proposal of proposals) {
		if (proposal.status !== "open" && proposal.status !== "accepted") continue;
		const content = appDraftContent(proposal);
		if (content) drafts.push({ proposal, content });
	}
	return drafts;
}

export type AppDraftFileChange = {
	path: string;
	kind: "added" | "changed" | "removed";
	before: string;
	after: string;
};

export const APP_MANIFEST_PATH = "manifest.json";

/**
 * What a draft changes against the live revision, file by file: the manifest
 * first, then the app's files in name order. Unchanged files are left out.
 */
export function appDraftFileChanges(
	live: { manifest: OsGadgetManifest; files: AppRuntimeFiles | null },
	draft: OsAppDraftContent,
): AppDraftFileChange[] {
	const changes: AppDraftFileChange[] = [];
	const manifestBefore = canonicalJsonText(live.manifest);
	const manifestAfter = canonicalJsonText(draft.manifest);
	if (manifestBefore !== manifestAfter)
		changes.push({
			path: APP_MANIFEST_PATH,
			kind: "changed",
			before: manifestBefore,
			after: manifestAfter,
		});
	const liveFiles: Record<string, string> = live.files ?? {};
	const draftFiles: Record<string, string> = draft.files;
	const paths = [
		...new Set([...Object.keys(liveFiles), ...Object.keys(draftFiles)]),
	].sort();
	for (const path of paths) {
		const before = liveFiles[path];
		const after = draftFiles[path];
		if (before === after) continue;
		changes.push({
			path,
			kind:
				before === undefined
					? "added"
					: after === undefined
						? "removed"
						: "changed",
			before: before ?? "",
			after: after ?? "",
		});
	}
	return changes;
}

export const APP_DRAFT_SOURCE_LABELS: Record<
	OsCollaborationProposal["sourceKind"],
	string
> = {
	user: "Code",
	chat: "Chat",
	run: "Skill run",
	agent_session: "Coding agent",
};
