import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";
import { sourceInteractionDeadline } from "@tedix/api-contract/utils/deck-ask";

type Source = {
	id: string;
	version: number;
	dueAt?: string | null;
	metadata: Record<string, unknown>;
};

/** Canonical version plus projected deadline, independent of writing preferences. */
export async function cardPresentationSourceFingerprint(source: Source) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify({
				requestId: source.id,
				requestVersion: source.version,
				dueAt: sourceInteractionDeadline(source.dueAt, source.metadata),
			}),
		),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function bindCardPresentationSource(
	presentation: DecisionCardPresentation,
	source: Source,
): Promise<DecisionCardPresentation> {
	return presentation.version === 2
		? {
				...presentation,
				sourceFingerprint: await cardPresentationSourceFingerprint(source),
			}
		: presentation;
}
