import {
	extractFactIdsFromEvidence,
	parseEvidencePayload,
} from "@tedix/api-contract/utils/fact-evidence";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export interface AutoCitedFact {
	factId: string;
	score: number;
	source?: string | null;
	domainName?: string | null;
}

export function buildRationaleEvidenceQuery(input: {
	action: string;
	rationale: string;
	category: string;
}): string {
	return [input.category, input.action, input.rationale]
		.map((value) => value.trim())
		.filter(Boolean)
		.join("\n")
		.slice(0, 1200);
}

export function mergeAutoCitedFactEvidence(
	evidence: unknown,
	facts: AutoCitedFact[],
	query: string,
	citedAt = new Date().toISOString(),
): Record<string, unknown> {
	const payload = parseEvidencePayload(evidence);
	const existingFactIds = extractFactIdsFromEvidence(payload);
	const seen = new Set(existingFactIds);
	const newFacts = facts.filter((fact) => {
		if (seen.has(fact.factId)) return false;
		seen.add(fact.factId);
		return true;
	});
	if (newFacts.length === 0) return payload;

	const brain = isRecord(payload.brain) ? payload.brain : {};
	return {
		...payload,
		factIds: Array.from(seen),
		brain: {
			...brain,
			autoCitations: {
				source: "memory_vector",
				query,
				citedAt,
				facts: newFacts,
			},
		},
	};
}
