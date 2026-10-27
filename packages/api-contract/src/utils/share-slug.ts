/**
 * The readable suffix in a permanent share address: `/s/<id>/<slug>`. The id
 * alone resolves the link; the slug only makes a copied address tell people
 * what it opens, so an empty title or one with no ASCII characters degrades
 * to no suffix rather than a mangled one.
 */
export function osShareTitleSlug(title: string | null | undefined): string {
	if (!title) return "";
	return title
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 60)
		.replace(/-+$/, "");
}
