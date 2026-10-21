import type { ServerContext } from "./server-context";
import {
	getCachedSkillSummariesForApps,
	mapWithConcurrency,
} from "./skill-cache";

async function resolveReadableGuidanceSkillApps(
	agent: ServerContext,
): Promise<Map<string, string>> {
	const mcpConfig = agent.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const guidanceSlugs = mcpConfig?.guidanceSkillApps as string[] | undefined;
	const aggregateApps = mcpConfig?.aggregateApps as
		| Array<{ slug: string; prefix?: string }>
		| undefined;

	if (!guidanceSlugs?.length || !aggregateApps?.length) {
		return new Map();
	}

	const guidanceSet = new Set(guidanceSlugs);
	const prefixToSlug = new Map<string, string>();
	for (const entry of aggregateApps) {
		prefixToSlug.set(entry.prefix ?? entry.slug, entry.slug);
	}

	const sourceAppIdToAggregateSlug = new Map<string, string>();
	for (const [toolId, tool] of agent.loadedTools) {
		const config = tool.config as Record<string, unknown> | null;
		const sourceAppId = config?._sourceAppId as string | undefined;
		if (!sourceAppId) continue;
		const sepIdx = toolId.indexOf("__");
		if (sepIdx < 0) continue;
		const prefix = toolId.slice(0, sepIdx);
		const aggregateSlug = prefixToSlug.get(prefix);
		if (!aggregateSlug) continue;
		if (
			guidanceSet.has(aggregateSlug) &&
			!sourceAppIdToAggregateSlug.has(sourceAppId)
		) {
			sourceAppIdToAggregateSlug.set(sourceAppId, aggregateSlug);
		}
	}

	return sourceAppIdToAggregateSlug;
}

/**
 * Pre-enrich loadedTools descriptions with skill context from aggregated apps.
 * Must run before Code Mode catalog build so discover.search() includes skill guidance.
 * Builds toolSkillMap for both UUID-based and toolId-based lookups.
 */
export async function enrichToolsWithSkills(
	agent: ServerContext,
): Promise<void> {
	if (!agent.apiClient) return;

	// Collect unique source app IDs from aggregated tools
	const sourceAppIds = new Set<string>();
	for (const [, tool] of agent.loadedTools) {
		const config = tool.config as Record<string, unknown> | null;
		const sourceAppId = config?._sourceAppId as string | undefined;
		if (sourceAppId && sourceAppId !== agent.appId) {
			sourceAppIds.add(sourceAppId);
		}
	}
	if (sourceAppIds.size === 0) return;

	// Build UUID → toolId reverse map for skill-to-tool matching
	const uuidToToolId = new Map<string, string>();
	for (const [toolId, tool] of agent.loadedTools) {
		uuidToToolId.set(tool.id, toolId);
	}
	const readableGuidanceApps = await resolveReadableGuidanceSkillApps(agent);

	let enrichedCount = 0;
	// One batched call for every source app, not one `skills.listByApp` per app:
	// a cold apps/api invocation costs seconds of CPU because the `worker-app`
	// graph is evaluated per isolate, so a per-app fan-out creates one cold
	// isolate per app per aggregate rebuild.
	const batchedSummaries = await getCachedSkillSummariesForApps({
		apiClient: agent.apiClient,
		appIds: Array.from(sourceAppIds),
		orgId: agent.app?.organizationId,
		tediId: agent.callerIdentity?.tediId,
		limit: 50,
	});
	const enrichmentCounts = await mapWithConcurrency(
		Array.from(sourceAppIds),
		8,
		async (appId) => {
			let appEnrichedCount = 0;
			try {
				const summaries = batchedSummaries.get(appId) ?? [];
				for (const skill of summaries) {
					if (!skill.toolIds?.length) continue;
					const summary = skill.summary ?? skill.description ?? skill.title;
					const skillSlug = skill.slug ?? skill.id;
					const aggregateSlug = readableGuidanceApps.get(appId);
					const skillUri = aggregateSlug
						? `skill://${aggregateSlug}/${skillSlug}/SKILL.md`
						: null;
					const skillRef = skillUri
						? {
								id: skill.id,
								title: skill.title,
								uri: skillUri,
							}
						: null;

					for (const refId of skill.toolIds) {
						// Resolve: toolIds may contain UUIDs or string toolIds
						const resolvedToolId = uuidToToolId.get(refId) ?? refId;
						const tool = agent.loadedTools.get(resolvedToolId);
						if (!tool) continue;

						// Populate toolSkillMap only with resources this server will
						// actually register. Aggregate app skills are readable only when
						// the app is explicitly listed in guidanceSkillApps.
						if (skillRef) {
							const existing = agent.toolSkillMap.get(resolvedToolId) ?? [];
							existing.push(skillRef);
							agent.toolSkillMap.set(resolvedToolId, existing);
						}

						// Enrich tool description. Only advertise read_skill/resources
						// when the skill resource is registered on this server.
						const currentDesc = tool.description ?? "";
						if (!currentDesc.includes("📋 Skills")) {
							const readHint = skillUri
								? `\n\nUse read_skill({ skillId: "${skill.id}" }) when available, or mcp_read_resource({ uri: "${skillUri}" }) for the skill:// resource.`
								: `\n\nUse get_skill({ id: "${skill.id}" }) when available; this aggregate server does not register a skill:// resource for this source app.`;
							tool.description = `${currentDesc}\n\n📋 Skills (proven procedures for this tool):\n• ${skill.title}: ${summary}${readHint}`;
							appEnrichedCount++;
						}
					}
				}
			} catch (error) {
				console.warn(
					`[MCP] Failed to load skills for aggregated app ${appId}:`,
					error instanceof Error ? error.message : error,
				);
			}
			return appEnrichedCount;
		},
	);
	enrichedCount = enrichmentCounts.reduce((sum, count) => sum + count, 0);
	if (enrichedCount > 0) {
		console.log(
			`[MCP] Enriched ${enrichedCount} aggregated tool(s) with skill context from ${sourceAppIds.size} app(s)`,
		);
	}
}
