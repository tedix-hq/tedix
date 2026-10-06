/** A semantic ordering may only permute rows already admitted to discovery. */
export interface DiscoveryRankingEntry {
	namespace: string;
	tool: string;
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
): Promise<{ entries: T[]; usedJev: boolean }> {
	if (!rank || query.length < 10 || query.length > 2000)
		return { entries, usedJev: false };
	const candidates: DiscoveryRankingCandidate[] = [];
	const positions: number[] = [];
	const byId = new Map<string, T>();
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
		if (candidates.length === MAX_JEV_CANDIDATES) break;
	}
	if (candidates.length < 2) return { entries, usedJev: false };
	try {
		const result = await rank({ query, candidates });
		const rankedIds = result.rankedIds;
		if (!rankedIds?.length || rankedIds.length > candidates.length)
			return { entries, usedJev: false };
		const seen = new Set<string>();
		for (const id of rankedIds) {
			if (!byId.has(id) || seen.has(id)) return { entries, usedJev: false };
			seen.add(id);
		}
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
