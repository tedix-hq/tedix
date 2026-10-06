/**
 * L1 (per-isolate) + L2 (Workers Cache API) stale-while-revalidate cache for the
 * `registerAppSkills` skill snapshot — the `SkillDocumentEntry[]` gathered from
 * D1 that becomes the server's skill:// resources, skills/list handler, and
 * list_skills/read_skill tools.
 *
 * WHY: `registerAppSkills` runs on every aggregate-gateway server build and,
 * unlike `tools/list` (which is served from a cached aggregate surface), it had
 * no cache tier. It (a) issues full-content `skills.listByApp`/`listByOrg` D1
 * fetches — including a per-guidance-app fan-out — and (b) re-renders every
 * skill through a serial SHA-256 digest loop. That takes seconds, which
 * dominates `resources/list` / `resources/templates/list` / `prompts/list` and
 * pushed a delegated tedi's Code-Mode connect past its connect timeout. Caching
 * the gathered snapshot collapses that to cache-hit latency for all but the
 * first build per key per colo.
 *
 * KEYING: the snapshot is org- and tedi-personalized. `listSkillsByApp` applies
 * `readableSkillCondition(tediId)` (org-visible skills plus that tedi's own) and
 * `applySupersedes` (tedi-specific overrides replace baseline), and the
 * org-library `listByOrg` is org-scoped. So the key MUST include orgId and
 * tediId or one tedi's private/superseding skills would leak to another — the
 * same partitioning the skill-summary cache enforces. The deployment
 * fingerprint busts the key on deploy (a new skill contract must not reuse an
 * old snapshot), mirroring the aggregate-surface cache.
 *
 * STALENESS: SWR like the aggregate surface — an entry is fresh within the soft
 * TTL and SERVED-STALE (with one background revalidate) between soft and hard.
 * A skill written mid-window surfaces within the soft TTL, the same lag the
 * tool-enrichment summary cache already accepts.
 *
 * FAIL-OPEN: every cache read/write is budgeted and swallows errors, so a wedged
 * or absent Cache API always falls through to the live D1 fan-out. Caching must
 * never break the build.
 */

import type { McpSkillEntry } from "@tedix/mcp-shared/skills";
import { setBoundedCacheEntry } from "../lib/bounded-cache";
import { CACHE_TIER_BUDGET_MS, withStepBudget } from "../lib/step-budget";
import type { SkillDocumentEntry } from "./skill-document";

export type SkillSnapshotEntry = SkillDocumentEntry;

/** Serve-fresh window. Matches the aggregate surface L1/L2 soft TTL. */
const SKILL_SNAPSHOT_SOFT_TTL_MS = 120_000;
/** Serve-stale ceiling. Beyond this an entry is discarded and rebuilt live. */
const SKILL_SNAPSHOT_HARD_TTL_MS = 600_000;
const SKILL_SNAPSHOT_L2_TTL_SECONDS = SKILL_SNAPSHOT_HARD_TTL_MS / 1000;
const MAX_SKILL_SNAPSHOT_CACHE_ENTRIES = 300;

// L1: in-memory per-isolate, lost on recycle. `cachedAt` drives soft/hard age.
const skillSnapshotL1 = new Map<
	string,
	{ entries: SkillSnapshotEntry[]; cachedAt: number }
>();
// SWR single-flight: at most one background revalidate per key at a time.
const skillSnapshotRevalidateInFlight = new Set<string>();

export interface SkillSnapshotCacheKeyInput {
	appId: string;
	upstreamAppId: string | undefined;
	appSlug: string;
	/** Org the apiClient authenticates as; listByApp/listByOrg are org-scoped. */
	orgId: string | undefined;
	/** Personalizes listByApp (readableSkillCondition + supersedes). */
	tediId: string | undefined;
	/** guidanceSkillApps config — different sets yield different snapshots. */
	guidanceSlugs: readonly string[] | undefined;
	/** Deployment fingerprint (WORKER_VERSION.id ?? GIT_SHA) — busts on deploy. */
	fingerprint: string;
}

export function skillSnapshotCacheKey(
	input: SkillSnapshotCacheKeyInput,
): string {
	return JSON.stringify({
		appId: input.appId,
		upstreamAppId: input.upstreamAppId ?? null,
		appSlug: input.appSlug,
		orgId: input.orgId ?? "no-org",
		tediId: input.tediId ?? "",
		guidanceSlugs: [...(input.guidanceSlugs ?? [])].sort(),
		fingerprint: input.fingerprint,
	});
}

// Compact, fixed-length hash for the L2 request URL — the raw key is a JSON blob
// that for large guidance sets could be long. cyrb53 (mirrors the aggregate
// cache's hashAggregateCacheKey); not a security hash, just a bounded cache key.
function hashSnapshotKey(key: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < key.length; i++) {
		const ch = key.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0))
		.toString(16)
		.padStart(14, "0");
}

function skillSnapshotL2Request(key: string): Request {
	return new Request(
		`https://skill-snapshot.mcp.tedix.internal/v1/${hashSnapshotKey(key)}`,
	);
}

export interface SkillSnapshotRead {
	entries: SkillSnapshotEntry[];
	/** True between soft and hard TTL — serve now, revalidate in the background. */
	stale: boolean;
}

/**
 * Read the snapshot from L1, then L2. Returns null on a miss or a
 * beyond-hard-TTL entry (forcing a live rebuild). Never throws — any Cache API
 * failure falls through to null.
 */
export async function readSkillSnapshot(
	key: string,
): Promise<SkillSnapshotRead | null> {
	const now = Date.now();
	const l1 = skillSnapshotL1.get(key);
	if (l1) {
		const age = now - l1.cachedAt;
		if (age < SKILL_SNAPSHOT_HARD_TTL_MS) {
			return { entries: l1.entries, stale: age >= SKILL_SNAPSHOT_SOFT_TTL_MS };
		}
		skillSnapshotL1.delete(key);
	}
	try {
		if (typeof caches === "undefined" || !caches.default) return null;
		const wrapped = await withStepBudget(
			"skill_snapshot_l2_read",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const hit = await caches.default.match(skillSnapshotL2Request(key));
				if (!hit) return null;
				return (await hit.json()) as {
					cachedAt?: number;
					entries?: SkillSnapshotEntry[];
				};
			})(),
			key,
		);
		if (!wrapped || !Array.isArray(wrapped.entries)) return null;
		const cachedAt =
			typeof wrapped.cachedAt === "number" ? wrapped.cachedAt : 0;
		const age = Date.now() - cachedAt;
		if (age >= SKILL_SNAPSHOT_HARD_TTL_MS) return null;
		// Promote to L1 preserving the true age so staleness stays consistent.
		setBoundedCacheEntry(
			skillSnapshotL1,
			key,
			{ entries: wrapped.entries, cachedAt },
			MAX_SKILL_SNAPSHOT_CACHE_ENTRIES,
		);
		return {
			entries: wrapped.entries,
			stale: age >= SKILL_SNAPSHOT_SOFT_TTL_MS,
		};
	} catch {
		// A budget trip already emitted its structured diagnosis line.
		return null;
	}
}

/**
 * Write the snapshot to L1 and L2. Never throws — a failed durable write leaves
 * L1 populated and the next build re-attempts L2.
 */
export async function writeSkillSnapshot(
	key: string,
	entries: SkillSnapshotEntry[],
): Promise<void> {
	const cachedAt = Date.now();
	setBoundedCacheEntry(
		skillSnapshotL1,
		key,
		{ entries, cachedAt },
		MAX_SKILL_SNAPSHOT_CACHE_ENTRIES,
	);
	try {
		if (typeof caches === "undefined" || !caches.default) return;
		await withStepBudget(
			"skill_snapshot_l2_write",
			CACHE_TIER_BUDGET_MS,
			caches.default.put(
				skillSnapshotL2Request(key),
				new Response(JSON.stringify({ cachedAt, entries }), {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": `max-age=${SKILL_SNAPSHOT_L2_TTL_SECONDS}`,
					},
				}),
			),
			key,
		);
	} catch {
		// swallow — never let the cache break the build
	}
}

/**
 * Reserve the single-flight slot for a background revalidate of `key`. Returns
 * false when a revalidate is already in flight (skip — no stampede). The caller
 * MUST call {@link releaseSkillSnapshotRevalidate} in a finally.
 */
export function reserveSkillSnapshotRevalidate(key: string): boolean {
	if (skillSnapshotRevalidateInFlight.has(key)) return false;
	skillSnapshotRevalidateInFlight.add(key);
	return true;
}

export function releaseSkillSnapshotRevalidate(key: string): void {
	skillSnapshotRevalidateInFlight.delete(key);
}

// ── Rendered-skills cache ─────────────────────────────────────────────────
// The snapshot cache above removes the D1 fan-out; this second tier removes the
// per-request render of the snapshot into `McpSkillEntry[]` (one SHA-256 over
// every skill body + attached file — the remaining cache-miss cost even after
// the digest render was bounded-parallelized). The rendered output is a pure
// function of (skill id+revision set, appSlug, the uuid→toolId map used for
// frontmatter/markdown, and the render code), so the key below captures all of
// those. A hit therefore only ever serves digests identical to what this
// request's resource-reads (which render with the live uuid→toolId) would
// produce — so resources/list and read_skill stay self-consistent. Same
// TTL/SWR/fail-open contract as the snapshot cache.

const renderedSkillsL1 = new Map<
	string,
	{ entries: McpSkillEntry[]; cachedAt: number }
>();
const renderedSkillsRevalidateInFlight = new Set<string>();

export interface RenderedSkillsCacheKeyInput {
	/** Deployment fingerprint (WORKER_VERSION.id ?? GIT_SHA) — busts the key when
	 * the render code changes on deploy. */
	fingerprint: string;
	appSlug: string;
	/** [skillId, revision] for every skill in the snapshot — captures skill
	 * identity + content version. */
	skillRevisions: ReadonlyArray<readonly [string, number | null]>;
	/** [toolUuid, toolId] entries of the uuid→toolId map used to render
	 * frontmatter/markdown — a changed tool surface must re-render. */
	toolIdMap: ReadonlyArray<readonly [string, string]>;
}

export function renderedSkillsCacheKey(
	input: RenderedSkillsCacheKeyInput,
): string {
	const skills = [...input.skillRevisions]
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([id, rev]) => `${id}:${rev ?? ""}`)
		.join(",");
	const tools = [...input.toolIdMap]
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([uuid, toolId]) => `${uuid}=${toolId}`)
		.join(",");
	// Hash the two potentially-large lists so the key stays bounded.
	return JSON.stringify({
		fingerprint: input.fingerprint,
		appSlug: input.appSlug,
		skills: hashSnapshotKey(skills),
		tools: hashSnapshotKey(tools),
	});
}

function renderedSkillsL2Request(key: string): Request {
	return new Request(
		`https://skill-rendered.mcp.tedix.internal/v1/${hashSnapshotKey(key)}`,
	);
}

export interface RenderedSkillsRead {
	entries: McpSkillEntry[];
	stale: boolean;
}

/** Read rendered skills from L1 then L2. Null on miss / beyond hard TTL. Never
 * throws — any Cache API failure falls through to a live render. */
export async function readRenderedSkills(
	key: string,
): Promise<RenderedSkillsRead | null> {
	const now = Date.now();
	const l1 = renderedSkillsL1.get(key);
	if (l1) {
		const age = now - l1.cachedAt;
		if (age < SKILL_SNAPSHOT_HARD_TTL_MS) {
			return { entries: l1.entries, stale: age >= SKILL_SNAPSHOT_SOFT_TTL_MS };
		}
		renderedSkillsL1.delete(key);
	}
	try {
		if (typeof caches === "undefined" || !caches.default) return null;
		const wrapped = await withStepBudget(
			"skill_rendered_l2_read",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const hit = await caches.default.match(renderedSkillsL2Request(key));
				if (!hit) return null;
				return (await hit.json()) as {
					cachedAt?: number;
					entries?: McpSkillEntry[];
				};
			})(),
			key,
		);
		if (!wrapped || !Array.isArray(wrapped.entries)) return null;
		const cachedAt =
			typeof wrapped.cachedAt === "number" ? wrapped.cachedAt : 0;
		const age = Date.now() - cachedAt;
		if (age >= SKILL_SNAPSHOT_HARD_TTL_MS) return null;
		setBoundedCacheEntry(
			renderedSkillsL1,
			key,
			{ entries: wrapped.entries, cachedAt },
			MAX_SKILL_SNAPSHOT_CACHE_ENTRIES,
		);
		return {
			entries: wrapped.entries,
			stale: age >= SKILL_SNAPSHOT_SOFT_TTL_MS,
		};
	} catch {
		return null;
	}
}

/** Write rendered skills to L1 + L2. Never throws. */
export async function writeRenderedSkills(
	key: string,
	entries: McpSkillEntry[],
): Promise<void> {
	const cachedAt = Date.now();
	setBoundedCacheEntry(
		renderedSkillsL1,
		key,
		{ entries, cachedAt },
		MAX_SKILL_SNAPSHOT_CACHE_ENTRIES,
	);
	try {
		if (typeof caches === "undefined" || !caches.default) return;
		await withStepBudget(
			"skill_rendered_l2_write",
			CACHE_TIER_BUDGET_MS,
			caches.default.put(
				renderedSkillsL2Request(key),
				new Response(JSON.stringify({ cachedAt, entries }), {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": `max-age=${SKILL_SNAPSHOT_L2_TTL_SECONDS}`,
					},
				}),
			),
			key,
		);
	} catch {
		// swallow — never let the cache break the build
	}
}

export function reserveRenderedSkillsRevalidate(key: string): boolean {
	if (renderedSkillsRevalidateInFlight.has(key)) return false;
	renderedSkillsRevalidateInFlight.add(key);
	return true;
}

export function releaseRenderedSkillsRevalidate(key: string): void {
	renderedSkillsRevalidateInFlight.delete(key);
}

/** Test-only: drop all in-memory cache + revalidation state. */
/** @internal */
export function __resetSkillSnapshotCache(): void {
	skillSnapshotL1.clear();
	skillSnapshotRevalidateInFlight.clear();
	renderedSkillsL1.clear();
	renderedSkillsRevalidateInFlight.clear();
}
