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
		}));
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

export function workspaceInitials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
	return (
		words.map((word) => word[0]?.toLocaleUpperCase() ?? "").join("") || "W"
	);
}
