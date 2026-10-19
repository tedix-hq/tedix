/** Original targets remain separate from the generated dispatch Work's ownership. */
export async function resolveDelegationWorkContext(
	source: string,
	resolve: (prefix: string) => Promise<
		Array<{
			id: string;
			title: string;
			description: string | null;
			acceptanceContract: unknown;
			comments?: Array<{ id: string; body: string; truncated: boolean }>;
		}>
	>,
) {
	const references = [
		...new Set(
			[
				...source.matchAll(
					/\bwork(?:\s+item)?\s*(?:#|:)?\s+([a-f\d]{8}(?:-[a-f\d-]{1,28})?)\b|\/work\/items\/([a-f\d-]{8,36})\b/gi,
				),
			].map((match) => (match[1] ?? match[2])!.toLowerCase()),
		),
	];
	if (references.length > 8)
		throw new Error(
			"Delegation preflight failed: at most eight original Work targets can be hydrated",
		);
	return Promise.all(
		references.map(async (prefix) => {
			const candidates = await resolve(prefix);
			if (candidates.length !== 1)
				throw new Error(
					`Delegation preflight failed: original Work ${prefix} ${candidates.length ? `is ambiguous; candidates: ${candidates.map((item) => item.id).join(", ")}` : "was not found in this organization"}. Never invent a UUID`,
				);
			return candidates[0]!;
		}),
	);
}
