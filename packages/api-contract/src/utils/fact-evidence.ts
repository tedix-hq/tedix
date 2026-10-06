import { isRecord } from "./is-record";

export interface FactEvidencePayload extends Record<string, unknown> {
	factIds?: unknown;
	usedFactIds?: unknown;
	ignoredFactIds?: unknown;
	notUsedFactIds?: unknown;
	failedFactIds?: unknown;
}

const FACT_ID_KEYS = new Set([
	"factId",
	"fact_id",
	"memoryFactId",
	"memory_fact_id",
]);

const FACT_ID_COLLECTION_KEYS = new Set([
	"factIds",
	"fact_ids",
	"memoryFactIds",
	"memory_fact_ids",
	"retrievedFactIds",
	"retrieved_fact_ids",
	"usedFactIds",
	"used_fact_ids",
	"ignoredFactIds",
	"ignored_fact_ids",
	"notUsedFactIds",
	"not_used_fact_ids",
	"failedFactIds",
	"failed_fact_ids",
]);

const FACT_EVIDENCE_CONTAINER_KEYS = new Set([
	"facts",
	"retrievedFacts",
	"retrieved_facts",
	"sources",
	"evidence",
	"provenance",
	"metadata",
	"brain",
	"memory",
	"factAttributions",
]);

const TRUSTED_FACT_RECORD_CONTAINERS = new Set([
	"facts",
	"retrievedFacts",
	"retrieved_facts",
	"sources",
	"factAttributions",
]);

function parseJsonObject(value: unknown): Record<string, unknown> {
	if (!value) return {};
	if (isRecord(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function addFactId(ids: Set<string>, value: unknown): void {
	if (typeof value === "string" && value.trim().length > 0) {
		ids.add(value.trim());
	}
}

function collectFactIds(
	value: unknown,
	ids: Set<string>,
	depth = 0,
	trustedFactRecord = false,
): void {
	if (depth > 8 || value == null) return;

	if (typeof value === "string") {
		const parsed = parseJsonObject(value);
		if (Object.keys(parsed).length > 0) {
			collectFactIds(parsed, ids, depth + 1, trustedFactRecord);
		}
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectFactIds(item, ids, depth + 1, trustedFactRecord);
		}
		return;
	}

	if (!isRecord(value)) return;

	for (const [key, child] of Object.entries(value)) {
		if (FACT_ID_KEYS.has(key) || (trustedFactRecord && key === "id")) {
			addFactId(ids, child);
			continue;
		}
		if (FACT_ID_COLLECTION_KEYS.has(key)) {
			if (Array.isArray(child)) {
				for (const item of child) {
					typeof item === "string"
						? addFactId(ids, item)
						: collectFactIds(item, ids, depth + 1, true);
				}
			} else {
				collectFactIds(child, ids, depth + 1, true);
			}
			continue;
		}
		if (FACT_EVIDENCE_CONTAINER_KEYS.has(key)) {
			collectFactIds(
				child,
				ids,
				depth + 1,
				TRUSTED_FACT_RECORD_CONTAINERS.has(key),
			);
		}
	}
}

export function parseEvidencePayload(evidence: unknown): FactEvidencePayload {
	return parseJsonObject(evidence) as FactEvidencePayload;
}

export function extractFactIdsFromEvidence(evidence: unknown): string[] {
	const ids = new Set<string>();
	collectFactIds(evidence, ids);
	return Array.from(ids);
}

export function hasFactEvidence(evidence: unknown): boolean {
	return extractFactIdsFromEvidence(evidence).length > 0;
}
