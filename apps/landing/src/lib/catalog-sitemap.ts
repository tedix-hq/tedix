export async function getCatalogSitemapSlugs(
	list: (input: { limit: number; offset: number }) => Promise<{
		apps: { slug: string | null; connectorType?: string | null }[];
		total: number;
	}>,
): Promise<string[]> {
	const limit = 200;
	const concurrency = 8;
	const first = await list({ limit, offset: 0 });
	const apps = [...first.apps];

	// Serial catalog enrichment made the full sitemap exceed crawler timeouts.
	// Bound the fan-out and reject any failed page instead of publishing a subset.
	for (
		let offset = limit;
		offset < first.total;
		offset += limit * concurrency
	) {
		const offsets = Array.from(
			{
				length: Math.min(
					concurrency,
					Math.ceil((first.total - offset) / limit),
				),
			},
			(_, index) => offset + index * limit,
		);
		const pages = await Promise.all(
			offsets.map((pageOffset) => list({ limit, offset: pageOffset })),
		);
		for (const page of pages) apps.push(...page.apps);
	}

	return [
		...new Set(
			apps
				.filter(
					(app) => app.slug && app.connectorType !== "FIRST_PARTY_ECOSYSTEM",
				)
				.map((app) => app.slug as string),
		),
	];
}
