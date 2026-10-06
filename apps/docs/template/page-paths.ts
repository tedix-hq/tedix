export type DocsEntryPath = "/index" | "/readme";

type StaticPath = {
	params: { slug?: string | string[] };
};

/** Keep the selected source entry for Markdown generation but omit its duplicate HTML page. */
export function filterEntryAliasStaticPaths<T extends StaticPath>(
	paths: T[],
	entryPath: DocsEntryPath,
): T[] {
	const entrySlug = entryPath.slice(1);
	return paths.filter((path) => {
		const slug = path.params.slug;
		const normalized = Array.isArray(slug) ? slug.join("/") : slug;
		// Nimbus 0.15 represents the primary collection's root entry with an
		// empty rest parameter. Tedix owns `/` with its custom homepage, so omit
		// both that route shape and the older explicit entry alias.
		return (
			typeof normalized === "string" &&
			normalized.length > 0 &&
			normalized.toLowerCase() !== entrySlug
		);
	});
}
