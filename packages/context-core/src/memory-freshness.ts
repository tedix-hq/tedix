import type { Observation } from "./types";

export function memorySourceReferences(text: string): string[] {
	return [
		...new Set(
			(
				text.match(
					/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
				) ?? []
			).map((id) => id.toLowerCase()),
		),
	];
}

/** Unclassified observations are evidence about a past turn, never live state. */
export function observationNeedsVerification(observation: {
	type: string;
	verifyBeforeUse?: boolean;
	content?: string;
}): boolean {
	if (observation.verifyBeforeUse === true) return true;
	if (
		memorySourceReferences(observation.content ?? "").length > 0 &&
		/\b(?:work|approvals?|deadlines?)\b/i.test(observation.content ?? "")
	)
		return true;
	if (
		["preference", "procedural", "pattern", "decision"].includes(
			observation.type,
		)
	)
		return false;
	if (/\b(?:work|approval|deadline)\b/i.test(observation.content ?? ""))
		return true;
	return observation.verifyBeforeUse !== false;
}

export function observationFreshness(
	observation: Observation,
): Record<string, unknown> {
	return {
		verifyBeforeUse: observationNeedsVerification(observation),
		observedAt: `${observation.date}T${observation.time}:00Z`,
		sourceRefs: memorySourceReferences(
			[observation.content, ...observation.details].join("\n"),
		),
		...(observation.expiresAt ? { expiresAt: observation.expiresAt } : {}),
	};
}
