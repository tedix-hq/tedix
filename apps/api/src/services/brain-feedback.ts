import type { MemoryFeedbackSignal } from "@tedix/api-contract/constants/enums";
import {
	extractFactIdsFromEvidence,
	type FactEvidencePayload,
	parseEvidencePayload as parseSharedEvidencePayload,
} from "@tedix/api-contract/utils/fact-evidence";
import type { DbClient } from "@tedix/db/client";
import { recordFactUsage } from "@tedix/db/queries/memory-graph/facts";

export type EvidencePayload = FactEvidencePayload;

type FactFeedbackSignal = Extract<
	MemoryFeedbackSignal,
	"used" | "not_used" | "failed"
>;

export function parseEvidencePayload(evidence: unknown): EvidencePayload {
	return parseSharedEvidencePayload(evidence) as EvidencePayload;
}

function explicitFactIds(
	evidence: EvidencePayload,
	keys: Array<keyof EvidencePayload>,
): string[] {
	const ids = new Set<string>();
	for (const key of keys) {
		for (const factId of extractFactIdsFromEvidence({
			[key]: evidence[key],
		})) {
			ids.add(factId);
		}
	}
	return Array.from(ids);
}

export function feedbackSignalsFromEvidence(
	evidence: EvidencePayload,
	outcomeStatus: string,
): Array<{ factIds: string[]; signal: FactFeedbackSignal }> {
	const allFactIds = extractFactIdsFromEvidence(evidence);
	if (allFactIds.length === 0) return [];

	if (outcomeStatus === "failure") {
		return [{ factIds: allFactIds, signal: "failed" }];
	}

	const explicitFailed = explicitFactIds(evidence, ["failedFactIds"]);
	const explicitUsed = explicitFactIds(evidence, ["usedFactIds"]);
	const explicitNotUsed = explicitFactIds(evidence, [
		"ignoredFactIds",
		"notUsedFactIds",
	]);
	if (
		explicitFailed.length > 0 ||
		explicitUsed.length > 0 ||
		explicitNotUsed.length > 0
	) {
		const claimed = new Set([
			...explicitFailed,
			...explicitUsed,
			...explicitNotUsed,
		]);
		const remaining =
			outcomeStatus === "success"
				? allFactIds.filter((factId) => !claimed.has(factId))
				: [];
		return [
			explicitFailed.length > 0
				? { factIds: explicitFailed, signal: "failed" as const }
				: null,
			explicitUsed.length > 0
				? { factIds: explicitUsed, signal: "used" as const }
				: null,
			remaining.length > 0
				? { factIds: remaining, signal: "used" as const }
				: null,
			explicitNotUsed.length > 0
				? { factIds: explicitNotUsed, signal: "not_used" as const }
				: null,
		].filter(
			(item): item is { factIds: string[]; signal: FactFeedbackSignal } =>
				Boolean(item),
		);
	}

	return [{ factIds: allFactIds, signal: "used" }];
}

export async function emitFactFeedbackForOutcome(
	db: DbClient,
	evidence: unknown,
	outcomeStatus: string,
): Promise<number> {
	const payload = parseEvidencePayload(evidence);

	let updated = 0;
	for (const { factIds, signal } of feedbackSignalsFromEvidence(
		payload,
		outcomeStatus,
	)) {
		updated += await recordFactUsage(db, factIds, signal);
	}
	return updated;
}
