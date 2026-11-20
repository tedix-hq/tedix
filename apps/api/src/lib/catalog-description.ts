interface DescriptionSource {
	seoDescription?: string | null;
	description?: string | null;
	modelDescription?: string | null;
	tools: Array<{ description?: string | null }>;
	storeListings: Array<{ storeDescription?: string | null }>;
}

function plainText(value: string | null | undefined): string {
	return (value ?? "")
		.replace(/\\[rnt]/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]*>/g, " ")
		.replace(/^[\t ]*#{1,6}\s+/gm, "")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Extract catalog copy without inventing capabilities or changing the source body. */
export function catalogSeoDescription(app: DescriptionSource): string | null {
	const existing = plainText(app.seoDescription);
	const existingLength = Array.from(existing).length;
	if (existingLength >= 120 && existingLength <= 160) return existing;

	const parts = new Set<string>();
	for (const value of [
		app.description,
		app.modelDescription,
		...app.tools.map((tool) => tool.description),
		...app.storeListings.map((listing) => listing.storeDescription),
	]) {
		const text = plainText(value);
		if (text) parts.add(text);
		const summary = [...parts].join(" ");
		const characters = Array.from(summary);
		if (characters.length < 120) continue;
		if (characters.length <= 160) return summary;
		const excerpt = characters.slice(0, 159).join("");
		const boundary = excerpt.lastIndexOf(" ");
		return `${(boundary >= 120 ? excerpt.slice(0, boundary) : excerpt).trimEnd()}…`;
	}

	// Sparse records keep their actual text rather than gaining filler or promises.
	return [...parts].join(" ") || existing || null;
}
