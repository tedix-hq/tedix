import type {
	RankDiscoveryInput,
	RankDiscoveryOutput,
} from "@tedix/api-contract/schemas/jev";
import type { EmbeddedPortableToolRanking } from "@tedix/chat-transport/embedded-contract";

const CALLABLE = /^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/;
const EXECUTION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_RANKING: EmbeddedPortableToolRanking = {
	rankedIds: null,
	receipt: null,
};

/** Advisory only: browser route context can narrow signed callables, never add one. */
export async function rankSignedPortableTools(input: {
	query: string;
	callables: readonly string[];
	signedCallables: readonly string[];
	rank: (
		request: RankDiscoveryInput,
	) => Promise<
		Pick<
			RankDiscoveryOutput,
			"rankedIds" | "usagePersistence" | "executionAttempts"
		>
	>;
}): Promise<EmbeddedPortableToolRanking> {
	if (
		typeof input.query !== "string" ||
		input.query.trim().length < 3 ||
		input.query.length > 2_000 ||
		!Array.isArray(input.callables) ||
		input.callables.length < 2 ||
		input.callables.length > 12
	)
		return NO_RANKING;
	const signed = new Set(input.signedCallables);
	const callables = [
		...new Set(
			input.callables.filter(
				(name) =>
					typeof name === "string" && CALLABLE.test(name) && signed.has(name),
			),
		),
	];
	if (callables.length < 2) return NO_RANKING;
	const query = input.query.trim();
	if (callables.includes(query))
		return {
			rankedIds: [query, ...callables.filter((name) => name !== query)],
			receipt: null,
		};
	try {
		const result = await input.rank({
			query,
			candidates: callables.map((name) => ({
				id: name,
				kind: "tool",
				// Only signed identifiers reach Jev; browser-authored descriptions and
				// page context cannot affect the candidate set or leak through it.
				description: name.replace(/[._]/g, " "),
			})),
		});
		const attempt = result.executionAttempts[0];
		const receipt =
			attempt &&
			EXECUTION_ID.test(attempt.executionId) &&
			result.usagePersistence !== "not_dispatched"
				? {
						executionId: attempt.executionId,
						usagePersistence: result.usagePersistence,
					}
				: null;
		const ranked = result.rankedIds;
		return {
			rankedIds:
				result.usagePersistence === "persisted" &&
				receipt &&
				Array.isArray(ranked) &&
				ranked.length === callables.length &&
				new Set(ranked).size === ranked.length &&
				ranked.every((name) => callables.includes(name))
					? ranked
					: null,
			receipt,
		};
	} catch {
		return NO_RANKING;
	}
}
