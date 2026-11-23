/** A semantic ordering may only permute rows already admitted to discovery. */
export interface DiscoveryRankingEntry {
	namespace: string;
	tool: string;
	/** Lexical relevance from codemode-discovery; rows arrive sorted by it. */
	score?: number;
	meta: unknown;
}

export interface DiscoveryRankingCandidate {
	id: string;
	kind: "tool" | "skill";
	description: string;
}

export type DiscoveryRanker = (input: {
	query: string;
	candidates: DiscoveryRankingCandidate[];
}) => Promise<{ rankedIds: string[] | null }>;

const MAX_JEV_CANDIDATES = 12;
const MAX_DESCRIPTION_CHARS = 400;
// A lexical leader this far ahead of the runner-up already answers the query.
const CLEAR_WINNER_RATIO = 1.5;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;

// Isolate-level memo of validated judgments. The key binds the organization,
// the normalized query and the exact candidate list, so a hit replays the
// same permutation of the same rows. Failures are never stored.
const judgmentCache = new Map<
	string,
	{ rankedIds: string[]; expiresAt: number }
>();

async function judgmentKey(
	organizationId: string,
	query: string,
	candidates: DiscoveryRankingCandidate[],
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify(candidates.map((c) => [c.id, c.kind, c.description])),
		),
	);
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return JSON.stringify([
		organizationId,
		query.toLowerCase().replace(/\s+/g, " ").trim(),
		hash,
	]);
}

function cachedJudgment(key: string): string[] | null {
	const hit = judgmentCache.get(key);
	if (!hit) return null;
	if (hit.expiresAt <= Date.now()) {
		judgmentCache.delete(key);
		return null;
	}
	return hit.rankedIds;
}

function storeJudgment(key: string, rankedIds: string[]): void {
	judgmentCache.delete(key);
	judgmentCache.set(key, {
		rankedIds: [...rankedIds],
		expiresAt: Date.now() + CACHE_TTL_MS,
	});
	while (judgmentCache.size > CACHE_MAX_ENTRIES) {
		const oldest = judgmentCache.keys().next().value;
		if (oldest === undefined) break;
		judgmentCache.delete(oldest);
	}
}

function hasClearWinner(scores: (number | undefined)[]): boolean {
	const [top, second] = scores;
	if (typeof top !== "number" || typeof second !== "number") return false;
	if (!Number.isFinite(top) || !Number.isFinite(second) || top <= 0)
		return false;
	return top >= second * CLEAR_WINNER_RATIO;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function comparable(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Rank only an authorized lexical shortlist. Model output never adds a row,
 * changes authorization, or hides results: omitted candidates keep their
 * original order and rows outside the shortlist retain their slots.
 */
export async function rerankDiscoveryShortlist<T extends DiscoveryRankingEntry>(
	entries: T[],
	query: string,
	rank: DiscoveryRanker | undefined,
	organizationId?: string,
): Promise<{ entries: T[]; usedJev: boolean }> {
	if (!rank || query.length < 10 || query.length > 2000)
		return { entries, usedJev: false };
	const candidates: DiscoveryRankingCandidate[] = [];
	const positions: number[] = [];
	const byId = new Map<string, T>();
	const scores: (number | undefined)[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		const meta = record(entry.meta);
		const kind = meta?.kind === "skill" ? "skill" : "tool";
		// Recorded org skills come from the tenant-scoped API library. D1 tool
		// rows must carry an affirmative result from the scope decision.
		if (kind !== "skill" && meta?.authorized !== true) continue;
		if (
			kind === "skill" &&
			(entry.namespace !== "skills" || meta?.authorized === false)
		)
			continue;
		const id = `${entry.namespace}.${entry.tool}`;
		if (id.length > 200 || byId.has(id)) continue;
		if (
			comparable(query) === comparable(id) ||
			comparable(query) === comparable(entry.tool) ||
			(typeof meta?.callable === "string" &&
				comparable(query) === comparable(meta.callable))
		) {
			return { entries, usedJev: false };
		}
		const description = [meta?.name, meta?.description]
			.filter((part): part is string => typeof part === "string")
			.join("\n")
			.slice(0, MAX_DESCRIPTION_CHARS)
			.trim();
		if (!description) continue;
		positions.push(index);
		byId.set(id, entry);
		candidates.push({ id, kind, description });
		scores.push(entry.score);
		if (candidates.length === MAX_JEV_CANDIDATES) break;
	}
	if (candidates.length < 2 || hasClearWinner(scores))
		return { entries, usedJev: false };
	try {
		const key = organizationId
			? await judgmentKey(organizationId, query, candidates)
			: undefined;
		const cached = key ? cachedJudgment(key) : null;
		const rankedIds = cached ?? (await rank({ query, candidates })).rankedIds;
		if (!rankedIds?.length || rankedIds.length > candidates.length)
			return { entries, usedJev: false };
		const seen = new Set<string>();
		for (const id of rankedIds) {
			if (!byId.has(id) || seen.has(id)) return { entries, usedJev: false };
			seen.add(id);
		}
		if (key && !cached) storeJudgment(key, rankedIds);
		const reordered = [
			...rankedIds.map((id) => byId.get(id)!),
			...candidates
				.filter((candidate) => !seen.has(candidate.id))
				.map((c) => byId.get(c.id)!),
		];
		const next = [...entries];
		for (let index = 0; index < positions.length; index++) {
			next[positions[index]!] = reordered[index]!;
		}
		return { entries: next, usedJev: true };
	} catch {
		return { entries, usedJev: false };
	}
}
