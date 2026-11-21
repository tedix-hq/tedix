import type { getCmsSiteBySlug } from "@tedix/db/queries/cms-sites";

type SiteConfig = NonNullable<
	NonNullable<Awaited<ReturnType<typeof getCmsSiteBySlug>>>["config"]
>;

export type PageCacheRevisions = Pick<
	SiteConfig,
	"pageCacheRevision" | "pageCacheSharedRevision" | "pageCacheEntryRevisions"
>;

export const NATIVE_PAGE_HEADER = "X-Tedix-Native-Page";
export const PAGE_REVISION_HEADER = "X-Tedix-Page-Revision";

/** Collisions evict extra entries; a fixed number of buckets bounds site config. */
export function nativePageBucket(id: string): number {
	let hash = 0;
	for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return (hash >>> 0) % 64;
}

export function pageRevisionFingerprint(
	headers: Headers,
	revisions: PageCacheRevisions,
): string {
	const id = headers.get(NATIVE_PAGE_HEADER);
	return JSON.stringify(
		id && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
			? [
					"native-body-v1",
					revisions.pageCacheSharedRevision ?? "0",
					revisions.pageCacheEntryRevisions?.[nativePageBucket(id)] ?? "0",
				]
			: ["all", revisions.pageCacheRevision ?? "0"],
	);
}

/** These fields are rendered only by the native page that declares its ID.
 * Other fields can change navigation, URL resolution, lists or translations. */
export function nativePageBodyChange(
	before: Record<string, unknown> | undefined,
	after: Record<string, unknown> | undefined,
): boolean {
	if (
		!before ||
		!after ||
		before.status !== "published" ||
		after.status !== "published"
	)
		return false;
	const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const field of fields) {
		if (Object.is(before[field], after[field])) continue;
		if (
			![
				"content",
				"live_revision_id",
				"draft_revision_id",
				"version",
				"updated_at",
			].includes(field)
		)
			return false;
	}
	return true;
}

/** Only a single-row native UPDATE is eligible; all unfamiliar SQL stays global. */
export function nativePageUpdateId(
	sql: string,
	params: unknown[] = [],
): string | undefined {
	if (/;|--|\/\*|\bor\b/i.test(sql)) return;
	const match =
		/^\s*update\s+"?ec_pages"?\s+set\s+[\s\S]+?\bwhere\s+"?id"?\s*=\s*\?(?=\s|$)/i.exec(
			sql,
		);
	if (!match) return;
	if (/\bselect\b|'/i.test(match[0].replaceAll("'published'", ""))) return;
	const id = params[(match[0].match(/\?/g)?.length ?? 0) - 1];
	if (typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) return id;
}

/** A newly inserted revision cannot change another native page's body. */
export function nativePageRevisionInsertId(
	sql: string,
	params: unknown[] = [],
): string | undefined {
	const match =
		/^\s*insert into "?revisions"?\s*\(([^)]+)\) values\s*\(([?,\s]+)\)\s*$/i.exec(
			sql,
		);
	if (!match) return;
	const columns = match[1]!
		.replaceAll('"', "")
		.split(",")
		.map((column) => column.trim());
	if (
		columns.length !== params.length ||
		!columns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column)) ||
		(match[2]!.match(/\?/g)?.length ?? 0) !== params.length
	)
		return;
	const id = params[columns.indexOf("entry_id")];
	if (
		params[columns.indexOf("collection")] === "pages" &&
		typeof id === "string" &&
		/^[a-zA-Z0-9_-]{1,128}$/.test(id)
	)
		return id;
}
