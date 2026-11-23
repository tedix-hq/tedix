import type { ApiClient } from "../lib/api-client";
import { setBoundedExpiringCacheEntry } from "../lib/bounded-cache";
import { CACHE_TIER_BUDGET_MS, withStepBudget } from "../lib/step-budget";

type SkillPage = Awaited<ReturnType<ApiClient["skills"]["listByOrg"]>>;
const TTL_MS = 60_000;
const GENERATION_TTL_MS = 5_000;
const MAX_ORGS = 300;
const entries = new Map<
	string,
	{
		generation: string;
		expiresAt: number;
		value: Promise<SkillPage>;
	}
>();
const generations = new Map<
	string,
	{
		expiresAt: number;
		value: Promise<string>;
	}
>();

function markerKey(orgId: string): string {
	return `skill-discovery/v1/${encodeURIComponent(orgId)}`;
}

async function generationFor(
	env: CloudflareEnv,
	orgId: string,
): Promise<string> {
	const cached = generations.get(orgId);
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	const value = withStepBudget(
		"skill_discovery_generation_read",
		CACHE_TIER_BUDGET_MS,
		(async () => {
			if (!env.AGGREGATE_CACHE) return "local";
			const marker = await env.AGGREGATE_CACHE.get(markerKey(orgId));
			return marker ? await marker.text() : "initial";
		})(),
	);
	const entry = { value, expiresAt: Date.now() + GENERATION_TTL_MS };
	setBoundedExpiringCacheEntry(generations, orgId, entry, MAX_ORGS);
	try {
		return await value;
	} catch (error) {
		if (generations.get(orgId) === entry) generations.delete(orgId);
		throw error;
	}
}

/** Shared org-visible rows only. Authorization and tool projections stay request-local. */
export async function getCachedOrgSkillDiscovery(input: {
	apiClient: ApiClient;
	orgId: string | undefined;
	env: CloudflareEnv;
}): Promise<SkillPage> {
	const load = () =>
		input.apiClient.skills.listByOrg({
			visibility: "org",
			summary: true,
			limit: 200,
		});
	// An unresolved identity must never populate a shared organization bucket.
	if (!input.orgId) return load();
	let generation: string;
	try {
		generation = await generationFor(input.env, input.orgId);
	} catch {
		// An unavailable invalidation fence cannot authorize a cache hit.
		return load();
	}
	const orgId = input.orgId;
	const cached = entries.get(orgId);
	if (
		cached &&
		cached.generation === generation &&
		cached.expiresAt > Date.now()
	)
		return cached.value;
	const entry = { generation, expiresAt: Date.now() + TTL_MS, value: load() };
	setBoundedExpiringCacheEntry(entries, orgId, entry, MAX_ORGS);
	try {
		return await entry.value;
	} catch (error) {
		if (entries.get(orgId) === entry) entries.delete(orgId);
		throw error;
	}
}

/** R2 reaches every isolate; readers observe skill writes within five seconds. */
export async function invalidateOrgSkillDiscovery(
	env: CloudflareEnv,
	orgId: string,
): Promise<void> {
	const generation = crypto.randomUUID();
	if (env.AGGREGATE_CACHE) {
		await withStepBudget(
			"skill_discovery_generation_write",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_CACHE.put(markerKey(orgId), generation),
		);
	}
	entries.delete(orgId);
	setBoundedExpiringCacheEntry(
		generations,
		orgId,
		{
			value: Promise.resolve(generation),
			expiresAt: Date.now() + GENERATION_TTL_MS,
		},
		MAX_ORGS,
	);
}
