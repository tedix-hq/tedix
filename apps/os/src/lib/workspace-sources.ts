import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";

/** The fields a Connected sources card reads from a workspace resource. */
export type WorkspaceSource = Pick<
	OsWorkspaceResource,
	| "id"
	| "name"
	| "providerId"
	| "resourceType"
	| "providerResourceId"
	| "connectionScope"
	| "metadata"
>;

/** Where a source's Open goes: a Tedix file, an outside page, or nowhere. */
export type SourceTarget =
	| { kind: "output"; outputId: string }
	| { kind: "link"; href: string; external: boolean }
	| null;

/** "google_sheets" → "Google Sheets"; brand casing where words alone are wrong. */
export function sourceLabel(value: string) {
	if (value === "github") return "GitHub";
	return value
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** The type chip: what kind of thing this is, in one word where possible. */
export function sourceTypeLabel(resourceType: string) {
	const type = resourceType.toLowerCase();
	if (/(^|[_-])account$/.test(type)) return "Account";
	if (type === "sheet" || type === "spreadsheet") return "Spreadsheet";
	return sourceLabel(resourceType);
}

/** The muted line: whose account it is, or where it comes from. */
export function sourceOrigin(
	source: Pick<WorkspaceSource, "providerId" | "connectionScope">,
	providerName: string,
) {
	if (source.providerId === "tedix") return "Tedix · made in this organization";
	return source.connectionScope === "user"
		? `${providerName} · your own account`
		: `${providerName} · shared organization account`;
}

function httpUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === "https:" || url.protocol === "http:"
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

/**
 * What Open does for a source. A Tedix file opens in the workspace; a stored
 * web address or a provider page we can name from its id opens in a new tab;
 * an outside account opens its Connections page.
 */
export function sourceTarget(source: WorkspaceSource): SourceTarget {
	const provider = source.providerId.toLowerCase();
	const type = source.resourceType.toLowerCase();
	const id = source.providerResourceId.trim();
	if (provider === "tedix") {
		return type === "output" ? { kind: "output", outputId: id } : null;
	}
	const stored =
		httpUrl(source.metadata.url) ??
		httpUrl(source.metadata.webUrl) ??
		httpUrl(source.metadata.webViewLink) ??
		httpUrl(id);
	if (stored) return { kind: "link", href: stored, external: true };
	const fullName = source.metadata.githubFullName ?? id;
	if (
		provider === "github" &&
		type === "repository" &&
		typeof fullName === "string" &&
		/^[\w.-]+\/[\w.-]+$/.test(fullName)
	) {
		return {
			kind: "link",
			href: `https://github.com/${fullName}`,
			external: true,
		};
	}
	if (provider.includes("notion") && /^[0-9a-f-]{32,36}$/i.test(id)) {
		return {
			kind: "link",
			href: `https://www.notion.so/${id.replaceAll("-", "")}`,
			external: true,
		};
	}
	if (provider.includes("google") && /^[\w-]{20,}$/.test(id)) {
		const path =
			type === "spreadsheet" || type === "sheet"
				? "spreadsheets"
				: type === "document"
					? "document"
					: null;
		if (path) {
			return {
				kind: "link",
				href: `https://docs.google.com/${path}/d/${id}`,
				external: true,
			};
		}
	}
	return {
		kind: "link",
		href:
			source.connectionScope === "user"
				? "/account/connections"
				: "/admin/connections",
		external: false,
	};
}
