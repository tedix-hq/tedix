/**
 * Work Items a message refers to by id, so the tedi can read them without a
 * lookup. A reference is a hint: one that names no single Work Item in this
 * organization, or cannot be read, is left out and the message is still sent.
 * Original targets remain separate from the generated dispatch Work's ownership.
 */
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
	].slice(0, 8);
	const resolved = await Promise.all(
		references.map(async (prefix) => {
			const candidates = await resolve(prefix).catch(() => []);
			return candidates.length === 1 ? candidates[0]! : null;
		}),
	);
	return resolved.filter((item) => item !== null);
}
