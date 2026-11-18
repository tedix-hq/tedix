import type {
	OsWorkspace,
	OsWorkspacePreference,
} from "@tedix/api-contract/schemas/os-workspaces";

import { relativeTime } from "@/lib/time";

export type WorkspaceLibraryEntry = {
	workspace: OsWorkspace;
	preference: OsWorkspacePreference | null;
};

export type WorkspaceLibraryGroups = {
	favorites: WorkspaceLibraryEntry[];
	recent: WorkspaceLibraryEntry[];
	all: WorkspaceLibraryEntry[];
};

/** Derive presentation-only lists without ever changing workspace authority. */
export function groupWorkspaceLibrary(
	workspaces: OsWorkspace[],
	preferences: OsWorkspacePreference[],
	search: string,
): WorkspaceLibraryGroups {
	const preferenceById = new Map(
		preferences.map((preference) => [preference.workspaceId, preference]),
	);
	const normalizedSearch = search.trim().toLocaleLowerCase();
	const all = workspaces
		.filter((workspace) => {
			if (!normalizedSearch) return true;
			return `${workspace.name} ${workspace.description ?? ""}`
				.toLocaleLowerCase()
				.includes(normalizedSearch);
		})
		.map((workspace) => ({
			workspace,
			preference: preferenceById.get(workspace.id) ?? null,
		}))
		// Pinned first, then the most recently used, then by name.
		.sort(
			(left, right) =>
				Number(right.preference?.favorite ?? false) -
					Number(left.preference?.favorite ?? false) ||
				lastUsedMs(right) - lastUsedMs(left) ||
				left.workspace.name.localeCompare(right.workspace.name),
		);
	return {
		favorites: all.filter((entry) => entry.preference?.favorite),
		recent: all
			.filter((entry) => entry.preference?.lastOpenedAt)
			.sort((left, right) =>
				(right.preference?.lastOpenedAt ?? "").localeCompare(
					left.preference?.lastOpenedAt ?? "",
				),
			),
		all,
	};
}

/**
 * When a workspace was last used: when this person last opened it, or, for one
 * they never opened, when it last changed.
 */
export function workspaceLastUsedAt(
	entry: WorkspaceLibraryEntry,
): string | null {
	return entry.preference?.lastOpenedAt ?? entry.workspace.updatedAt ?? null;
}

function lastUsedMs(entry: WorkspaceLibraryEntry): number {
	const at = Date.parse(workspaceLastUsedAt(entry) ?? "");
	return Number.isNaN(at) ? 0 : at;
}

const DAY_MS = 86_400_000;

/**
 * A short "how long ago" for a workspace row: "3h ago" within a day, then
 * "yesterday" and "10 days ago", and the date once it is over a month old.
 */
export function formatWorkspaceLastUsed(
	value: string,
	now: Date = new Date(),
): string {
	const days = Math.floor((now.getTime() - Date.parse(value)) / DAY_MS);
	if (days === 1) return "yesterday";
	if (days > 1 && days <= 30) return `${days} days ago`;
	return relativeTime(value, now);
}

// A UUID, or a long token mixing letters and digits, such as a user id from
// a sign-in provider. Readable words never match.
const OPAQUE_ID =
	/\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=\w*\d)(?=\w*[A-Za-z])\w{20,})\b/i;

/**
 * Workspace descriptions are free text that agents sometimes stamp with the
 * owner's raw id, for example "Notes (tedix user <id>)". A person reading the
 * library gets the sentence without the id: a parenthetical that carries an id
 * is dropped whole, and a bare id is removed. Returns null when nothing
 * readable is left.
 */
export function workspaceDescriptionForDisplay(
	description: string | null | undefined,
): string | null {
	if (!description) return null;
	// Links stay whole: an id inside a URL is part of where it points.
	const cleaned = description
		.split(/(https?:\/\/\S+)/)
		.map((part, index) =>
			index % 2 === 1
				? part
				: part
						.replace(/\s*\(([^()]*)\)/g, (match, inner: string) =>
							OPAQUE_ID.test(inner) ? "" : match,
						)
						.replace(new RegExp(OPAQUE_ID.source, "gi"), ""),
		)
		.join("")
		.replace(/\s+([.,;:])/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim()
		.replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "");
	return cleaned || null;
}
