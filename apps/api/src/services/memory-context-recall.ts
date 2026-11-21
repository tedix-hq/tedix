import type { DbClient } from "@tedix/db/client";
import { hydrateRecall } from "@tedix/db/queries/memory-graph/hybrid-recall";
import {
	boundRecall,
	recallMemoryFacts,
	type HybridRecallResult,
} from "./memory-hybrid-recall";

type Params = Parameters<typeof recallMemoryFacts>[1];
type Candidate = Omit<HybridRecallResult, "fact">;
const cache = new Map<
	string,
	{
		expires: number;
		result: Promise<Candidate[]>;
	}
>();

/** Repeated server context skips search; current eligibility is checked on every hit. */
export async function recallContextMemoryFacts(
	db: DbClient,
	params: Params,
): Promise<HybridRecallResult[]> {
	const query = params.query
		.normalize("NFKC")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();
	if (!query || query.length > 4096 || params.now)
		return recallMemoryFacts(db, params);
	const { env, budgetMs, ...scope } = params;
	const key = JSON.stringify({
		...scope,
		query,
		domainIds: [...(params.domainIds ?? [])].sort(),
		factTypes: [...(params.factTypes ?? [])].sort(),
		ai: Boolean(env?.AI),
		semantic: Boolean(env?.AGENT_MEMORY),
	});
	const now = Date.now();
	for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
	const cached = cache.get(key);
	if (cached) {
		return boundRecall(
			async () => {
				const candidates = await cached.result;
				const facts = await hydrateRecall(
					db,
					params,
					candidates.map((row) => row.factId),
				);
				const byId = new Map(facts.map((fact) => [fact.id, fact]));
				return candidates.flatMap((row) => {
					const fact = byId.get(row.factId);
					return fact ? [{ ...structuredClone(row), fact }] : [];
				});
			},
			budgetMs ?? 750,
			[],
		);
	}
	if (cache.size >= 256) cache.delete(cache.keys().next().value!);
	const result = recallMemoryFacts(db, params);
	const entry = {
		expires: now + 180_000,
		result: result.then((rows) =>
			rows.map(({ fact: _fact, ...candidate }) => structuredClone(candidate)),
		),
	};
	cache.set(key, entry);
	try {
		const rows = await result;
		if (
			(!rows.length || rows.some((row) => row.provenance.fallback)) &&
			cache.get(key) === entry
		)
			cache.delete(key);
		return rows;
	} catch (error) {
		if (cache.get(key) === entry) cache.delete(key);
		throw error;
	} finally {
		// The initiating caller awaits result, while hits await the candidate copy.
		void entry.result.catch(() => undefined);
	}
}
