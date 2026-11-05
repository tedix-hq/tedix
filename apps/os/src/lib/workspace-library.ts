import type {
	OsWorkspace,
	OsWorkspacePreference,
} from "@tedix/api-contract/schemas/os-workspaces";

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
		.sort(
			(left, right) =>
				Number(right.preference?.favorite ?? false) -
					Number(left.preference?.favorite ?? false) ||
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

export function formatWorkspaceLastOpened(value: string | null): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return `Opened ${new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		year:
			date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
	}).format(date)}`;
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
