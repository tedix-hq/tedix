/** Configuration required for an assigned operator to use a unified gateway's Work bridge. */
export function unifiedGatewayWorkBaselineIssues(
	app: { slug: string; metadata?: unknown },
	tediSlug: string,
): string[] {
	if (!app.slug.endsWith("-unified")) return [];
	const metadata = app.metadata;
	const config =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as { mcpConfig?: unknown }).mcpConfig
			: undefined;
	const mcpConfig =
		config && typeof config === "object" && !Array.isArray(config)
			? (config as Record<string, unknown>)
			: {};
	const toolScopes = mcpConfig.toolScopes;
	const work =
		toolScopes && typeof toolScopes === "object" && !Array.isArray(toolScopes)
			? (toolScopes as Record<string, unknown>).work
			: undefined;
	const scopes = Array.isArray(work) ? work : [];
	const issues: string[] = [];
	for (const scope of ["mcp:work.read", "mcp:work.write"]) {
		if (!scopes.includes(scope)) issues.push(`toolScopes.work lacks ${scope}`);
	}
	const aggregateTedis = mcpConfig.aggregateTedis;
	const hasBridge =
		Array.isArray(aggregateTedis) &&
		aggregateTedis.some(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				!Array.isArray(entry) &&
				entry.slug === tediSlug &&
				entry.surface !== "collaboration",
		);
	if (!hasBridge) issues.push(`aggregateTedis lacks a full ${tediSlug} bridge`);
	return issues;
}
