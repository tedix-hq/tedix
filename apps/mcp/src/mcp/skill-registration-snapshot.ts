import type { ServerContext } from "./server-context";
import { type SkillDocumentEntry } from "./skill-document";
import { StepBudgetExceededError } from "../lib/step-budget";
import { fetchSkillListWithBudget } from "./skill-cache";
import {
	readSkillSnapshot,
	releaseSkillSnapshotRevalidate,
	reserveSkillSnapshotRevalidate,
	type SkillSnapshotRead,
	skillSnapshotCacheKey,
	writeSkillSnapshot,
} from "./skill-snapshot-cache";

/**
 * Skill entry from D1 cognitive skill_entries table.
 */
type SkillIndexEntry = SkillDocumentEntry;

/** Deployment fingerprint for the skill-snapshot cache key — busts the key on
 * every deploy so a new skill contract never reuses an old snapshot. Mirrors the
 * aggregate-surface cache (`env.WORKER_VERSION?.id ?? env.GIT_SHA`). */
export function skillSnapshotFingerprint(env: ServerContext["env"]): string {
	return env.WORKER_VERSION?.id ?? env.GIT_SHA ?? "dev";
}

/**
 * Gather the app + guidance + org-library skill snapshot from D1. This is the
 * uncached, full-content fan-out (per-app list + guidance fan-out + org library)
 * that {@link loadCachedSkillSnapshot} fronts with an L1+L2 SWR cache — the
 * expensive work that used to run on every aggregate-gateway server build.
 */
async function populateSkillIndexFromD1(
	agent: ServerContext,
): Promise<Map<string, SkillIndexEntry>> {
	const skillIndex = new Map<string, SkillIndexEntry>();

	// Fetch D1 cognitive skills for this app (retry once on failure — D1 cold-start
	// can timeout, and a failed load leaves the Worker permanently without resources)
	const appIdsToTry = [agent.appId];
	// Skill inheritance: if the org app has no skills, fall back to the reference app
	if (agent.upstreamAppId) appIdsToTry.push(agent.upstreamAppId);

	const maxAttempts = 2;
	for (const targetAppId of appIdsToTry) {
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				// Skill-cache discipline (budget + breaker) on this direct list call,
				// so a stalled apps/api skills endpoint cannot hang tools/list
				// silently on the request path.
				const d1Result = await fetchSkillListWithBudget(
					"register_app_skills_list",
					targetAppId,
					() =>
						agent.apiClient.skills.listByApp({
							appId: targetAppId,
							tediId: agent.callerIdentity?.tediId,
						}),
				);
				// Breaker open: upstream known-unhealthy — serve without skills.
				if (!d1Result) break;

				for (const skill of d1Result.skills ?? []) {
					skillIndex.set(skill.id, {
						id: skill.id,
						title: skill.title,
						slug: skill.slug ?? null,
						summary: skill.summary ?? null,
						description: skill.description ?? null,
						content: skill.content,
						files:
							(skill as { files?: Record<string, string> | null }).files ??
							null,
						tags: skill.tags ?? null,
						toolIds: skill.toolIds ?? null,
						successCount: skill.successCount,
						revision: skill.revision,
						appId: skill.appId ?? null,
						audience: skill.audience ?? null,
						r2Path: skill.r2Path ?? null,
						updatedAt: skill.updatedAt ?? null,
						createdAt: skill.createdAt ?? null,
						source: "d1",
					});
				}
				break; // Success — exit retry loop
			} catch (error) {
				// A tripped budget already emitted its diagnosis line, and an
				// immediate retry of a full-budget timeout cannot succeed — the 1s
				// backoff below exists for fast D1 cold-start errors, not stalls.
				const budgetExceeded = error instanceof StepBudgetExceededError;
				const isLast = attempt === maxAttempts || budgetExceeded;
				console[isLast ? "warn" : "log"](
					`[MCP] ${isLast ? "Failed" : "Retrying"} D1 skill load (attempt ${attempt}/${maxAttempts}):`,
					error instanceof Error ? error.message : error,
				);
				if (budgetExceeded) break;
				if (!isLast) await new Promise((r) => setTimeout(r, 1000)); // 1s backoff
			}
		}
		if (skillIndex.size > 0) break; // Found skills — skip fallback
	}

	// Load skills from guidanceSkillApps — operator-curated aggregated apps whose
	// skills should surface as skill:// resources (tier 1 guidance) on this server.
	const mcpConfig = agent.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const guidanceSlugs = mcpConfig?.guidanceSkillApps as string[] | undefined;
	const aggregateApps = mcpConfig?.aggregateApps as
		| Array<{ slug: string; prefix?: string }>
		| undefined;

	if (guidanceSlugs?.length && aggregateApps?.length) {
		const prefixToSlug = new Map<string, string>();
		for (const entry of aggregateApps) {
			prefixToSlug.set(entry.prefix ?? entry.slug, entry.slug);
		}

		// Warn on guidanceSlugs that do not match an aggregateApps entry.
		const allKnownSlugs = new Set(aggregateApps.map((entry) => entry.slug));
		for (const guidanceSlug of guidanceSlugs) {
			if (!allKnownSlugs.has(guidanceSlug)) {
				console.warn(
					`[MCP] guidanceSkillApps entry "${guidanceSlug}" matches no aggregateApps slug ` +
						`Known: ${[...allKnownSlugs].join(", ")}`,
				);
			}
		}

		const slugToAppId = new Map<string, string>();
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
				guidanceSlugs.includes(aggregateSlug) &&
				!slugToAppId.has(aggregateSlug)
			) {
				slugToAppId.set(aggregateSlug, sourceAppId);
			}
		}

		let guidanceCount = 0;
		await Promise.all(
			Array.from(slugToAppId.entries()).map(async ([slug, appId]) => {
				try {
					// Same budget + breaker as the app-skill load above: guidance skills
					// are optional enrichment and must never stall the surface build.
					const result = await fetchSkillListWithBudget(
						"register_guidance_skills_list",
						appId,
						() =>
							agent.apiClient.skills.listByApp({
								appId,
								tediId: agent.callerIdentity?.tediId,
							}),
					);
					if (!result) return;
					for (const skill of result.skills ?? []) {
						if (skillIndex.has(skill.id)) continue;
						skillIndex.set(skill.id, {
							id: skill.id,
							title: skill.title,
							slug: skill.slug ?? null,
							summary: skill.summary ?? null,
							description: skill.description ?? null,
							content: skill.content,
							files:
								(skill as { files?: Record<string, string> | null }).files ??
								null,
							tags: skill.tags ?? null,
							toolIds: skill.toolIds ?? null,
							successCount: skill.successCount,
							revision: skill.revision,
							appId: skill.appId ?? null,
							audience: skill.audience ?? null,
							r2Path: skill.r2Path ?? null,
							updatedAt: skill.updatedAt ?? null,
							createdAt: skill.createdAt ?? null,
							source: "d1",
							appSlugOverride: slug,
						});
						guidanceCount++;
					}
				} catch (error) {
					console.warn(
						`[MCP] Failed to load guidance skills for ${slug}:`,
						error instanceof Error ? error.message : error,
					);
				}
			}),
		);
		if (guidanceCount > 0) {
			console.log(
				`[MCP] Loaded ${guidanceCount} guidance skill(s) from ${slugToAppId.size} app(s)`,
			);
		}
	}

	// Org-library skills (visibility "org", appId null) are the corpus agents
	// actually record and reuse — without this block the SEP-2640 surface served
	// only app-attached skills and the org library was invisible to conformant
	// hosts. Org skills mount at skill://<slug>/SKILL.md (no app prefix;
	// computeSkillPath already yields the bare slug for appId-null rows, so the
	// final path segment equals the frontmatter name as the SEP requires).
	// Stale/archived lifecycle states stay off the host surface. Draft stays
	// VISIBLE: in this corpus "draft" is the default recorded state and
	// active/proven are earned by usage (skill-promotion gate), so hiding
	// drafts hid nearly the whole org library.
	const ORG_SKILL_HIDDEN_LIFECYCLES = new Set(["stale", "archived"]);
	try {
		// Same budget + breaker: the org library is optional enrichment too.
		const orgResult = await fetchSkillListWithBudget(
			"register_org_skills_list",
			agent.appSlug,
			() =>
				agent.apiClient.skills.listByOrg({
					visibility: "org",
					limit: 200,
				}),
		);
		let orgCount = 0;
		for (const skill of orgResult?.entries ?? []) {
			if (skillIndex.has(skill.id)) continue;
			const lifecycle = (skill as { lifecycleState?: string | null })
				.lifecycleState;
			if (lifecycle && ORG_SKILL_HIDDEN_LIFECYCLES.has(lifecycle)) continue;
			skillIndex.set(skill.id, {
				id: skill.id,
				title: skill.title,
				slug: skill.slug ?? null,
				summary: skill.summary ?? null,
				description: skill.description ?? null,
				content: skill.content,
				files:
					(skill as { files?: Record<string, string> | null }).files ?? null,
				tags: skill.tags ?? null,
				toolIds: skill.toolIds ?? null,
				successCount: skill.successCount,
				revision: skill.revision,
				appId: null,
				audience: skill.audience ?? null,
				r2Path: skill.r2Path ?? null,
				updatedAt: skill.updatedAt ?? null,
				createdAt: skill.createdAt ?? null,
				source: "d1",
			});
			orgCount++;
		}
		if (orgCount > 0) {
			console.log(`[MCP] Loaded ${orgCount} org-library skill(s)`);
		}
	} catch (error) {
		console.warn(
			"[MCP] Failed to load org-library skills:",
			error instanceof Error ? error.message : error,
		);
	}

	return skillIndex;
}

/**
 * The skill snapshot behind an L1+L2 stale-while-revalidate cache
 * (skill-snapshot-cache.ts). On a fresh hit it returns the cached entries with
 * zero D1 I/O; on a stale hit it returns them and schedules one background
 * revalidate; on a miss it runs the live D1 fan-out and writes the cache. The
 * key is org- and tedi-partitioned (skills are personalized per tedi) and busts
 * on deploy. Fail-open: any cache error falls through to the live fan-out.
 */
export async function loadCachedSkillSnapshot(
	agent: ServerContext,
): Promise<Map<string, SkillIndexEntry>> {
	const mcpConfig = agent.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const guidanceSlugs = mcpConfig?.guidanceSkillApps as string[] | undefined;
	const cacheKey = skillSnapshotCacheKey({
		appId: agent.appId,
		upstreamAppId: agent.upstreamAppId,
		appSlug: agent.appSlug,
		orgId: agent.callerIdentity?.organizationId,
		tediId: agent.callerIdentity?.tediId,
		guidanceSlugs,
		fingerprint: skillSnapshotFingerprint(agent.env),
	});

	let cached: SkillSnapshotRead | null = null;
	try {
		cached = await readSkillSnapshot(cacheKey);
	} catch {
		// readSkillSnapshot is already fail-open; guard belt-and-suspenders.
		cached = null;
	}

	if (cached) {
		const skillIndex = new Map<string, SkillIndexEntry>();
		for (const entry of cached.entries) skillIndex.set(entry.id, entry);
		// Stale-while-revalidate: serve the cached snapshot now, refresh once in
		// the background (single-flight per key) so the next build is fresh.
		if (cached.stale && reserveSkillSnapshotRevalidate(cacheKey)) {
			const job = (async () => {
				try {
					const fresh = await populateSkillIndexFromD1(agent);
					await writeSkillSnapshot(cacheKey, [...fresh.values()]);
				} catch (error) {
					console.warn(
						`[MCP] skill snapshot revalidate failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				} finally {
					releaseSkillSnapshotRevalidate(cacheKey);
				}
			})();
			agent.ctx.waitUntil(job);
		}
		return skillIndex;
	}

	const skillIndex = await populateSkillIndexFromD1(agent);
	await writeSkillSnapshot(cacheKey, [...skillIndex.values()]);
	return skillIndex;
}
