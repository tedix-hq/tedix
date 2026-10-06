import { extractFactIdsFromEvidence } from "@tedix/api-contract/utils/fact-evidence";

export function extractFactIdsFromFlywheelEvidence(
	evidence: unknown,
): string[] {
	return extractFactIdsFromEvidence(evidence);
}
