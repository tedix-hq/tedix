/**
 * memory_learn writer with priority gating, content-hash deduplication,
 * task-relevance filtering, and rate-limited entity-to-graph promotion.
 * Callers supply platform I/O, persistent dedup state, and optional metrics.
 */

import type { MemorySourceEvidence } from "@tedix/api-contract/schemas/memory-graph";
import type {
	ObservationPriority,
	EntityType,
	Observation,
} from "@tedix/context-core/types";
import type { DedupStore } from "./dedup-types.js";
import { sha256Hex16 } from "./hash.js";
import type { PlatformClient } from "./platform-client.js";

const PRIORITY_CONFIDENCE: Record<string, number> = {
	high: 0.9,
	medium: 0.7,
	low: 0.5,
};

const TYPE_TO_FACT_TYPE: Record<string, string> = {
	decision: "decision",
	technical: "technical",
	preference: "preference",
	procedural: "procedural",
	pattern: "pattern",
	error: "technical",
	episode: "episode",
};

const MAX_ENTITY_LEARNS_PER_CYCLE = 5;

const ENTITY_TYPE_TO_DOMAIN: Record<EntityType, string> = {
	person: "people",
	tool: "tools",
	service: "services",
	api: "apis",
	organization: "organizations",
	domain: "__dynamic__",
};

/**
 * Content hash for cross-session bridge dedup. PERSISTED framing (DedupStore
 * keys) — do not change the prefix or normalization.
 */
export function observationHash(obs: Observation): string {
	return sha256Hex16(`${obs.type}:${obs.content.toLowerCase().trim()}`);
}

/**
 * Content hash for entity dedup — prevents re-learning the same entity.
 * PERSISTED framing (DedupStore keys) — do not change.
 */
export function entityHash(type: string, name: string): string {
	return sha256Hex16(`entity:${type}:${name.toLowerCase().trim()}`);
}

/** Check if an observation is relevant to the current task via keyword overlap. */
function isRelevantToTask(obs: Observation, currentTask: string): boolean {
	if (!currentTask) return true;
	if (obs.priority === "high") return true;

	const taskWords = new Set(
		currentTask
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 3),
	);
	const obsWords = obs.content.toLowerCase().split(/\s+/);
	const overlap = obsWords.filter((w) => taskWords.has(w)).length;

	return overlap >= 1 || obs.type === "decision" || obs.type === "error";
}

function isTurnProcedureObservation(obs: Observation): boolean {
	const text = [obs.content, ...obs.details].join(" ").slice(0, 2000);
	return [
		/\b(active|current)\s+.*\bbaseline\b.*\bretriev/i,
		/\bbaseline\s+memory(?:\s+graph)?\s+lookup\b.*\b(?:returned|found)\b.*\bconfirmed\s+fact\b/i,
		/\b(?:only\s+)?tool(?:s)?\s+used\b/i,
		/\bexecuted\s+tedix\./i,
		/\bpreserved\s+read[-\s]*only\s+behavior\b/i,
		/\bread[-\s]*only\b.*\b(?:check|listing|overview)\b.*\bsucceeded\b/i,
		/\bchecks?\s+(?:both\s+)?succeeded\s+without\s+mutation\b/i,
		/\bno\s+mutation\s+was\s+performed\b/i,
		/\breturned\s+ok=true\b/i,
		/\btedix\.(?:learn_memory_graph|create_rationale_records|complete_rationale_records|delete_rationale_records|list_rationale_records)\b/i,
		/\bdelegated\s+(?:a\s+)?(?:narrow\s+)?(?:rationale|memory|brain)\s+hygiene\b/i,
		/\b(?:home\s+)?delegated\s+(?:a\s+)?(?:tedix\s+)?memory\s+cleanup\s+request\b/i,
		/\binstructed\s+to\s+clean\s+up\b.*\bmemory\s+facts?\b/i,
		/\bcleanup\s+request\s+was\s+reported\s+as\s+completed\s+successfully\b/i,
		/\bcompleted\s+(?:the\s+)?requested\s+cleanup\b/i,
		/\brequested\s+cleanup\s+state\b/i,
		/\bcompleted\s+(?:the\s+)?requested\s+rationale\s+(?:record\s+)?(?:mutation|update)\b/i,
		/\breturned\s+(?:a\s+)?successful\s+completion\s+payload\b/i,
		/\bdo\s+not\s+create\s+(?:memory\s+facts?|rationale\s+records?)\b/i,
		/\bno\s+new\s+(?:memory\s+facts?|rationale\s+records?)\b.*\bcreated\b/i,
		/\bwithout\s+creating\s+new\s+(?:memory\s+facts?|rationale\s+records?)\b/i,
		/\bmutation\s+limits?\s+explicitly\s+forbade\b/i,
		/\bwork\s+item\s+was\s+owned\s+directly\b.*\bprogress\s+comments\b/i,
		/\bwrite\s+exactly\s+one\b.*\b(?:memory\s+fact|evidence\s+memory|rationale\s+record)\b/i,
		/\bcreate\s+and\s+close\s+exactly\s+one\b.*\brationale\b/i,
		/\bdo\s+not\s+create\s+or\s+promote\s+org[-\s]*wide\s+facts?\b/i,
	].some((pattern) => pattern.test(text));
}

export interface BridgeMetrics {
	total: number;
	/** Successful API calls, including server-side deduplication. */
	bridged: number;
	apiDeduplicated: number;
	deduped: number;
	gated: number;
	prioritySkipped: number;
	procedureSkipped: number;
	offTopicSkipped: number;
	failed: number;
	entitiesBridged: number;
}

export type BridgeMetricsCallback = (input: BridgeMetrics) => void;

export interface BridgeOptions {
	observations: Observation[];
	minPriority: ObservationPriority;
	platform: PlatformClient;
	dedup: DedupStore;
	currentTask?: string;
	/** The bounded turn the Observer saw; request-only evidence for the quality judgment. */
	sourceEvidence?: MemorySourceEvidence;
	/** Optional callback for bridge metrics. */
	onMetrics?: BridgeMetricsCallback;
	/** Optional logger override. Defaults to console. */
	logger?: { log(msg: string): void; error(msg: string, err?: unknown): void };
}

const defaultLogger = {
	log: (msg: string) => console.log(msg),
	error: (msg: string, err?: unknown) =>
		console.error(msg, err instanceof Error ? err.message : (err ?? "")),
};

/**
 * Bridge observations to the platform brain.
 * Uses content hashing to prevent cross-session duplicate bridging.
 * Returns the number of observations successfully bridged.
 */
export async function bridgeObservations(
	options: BridgeOptions,
): Promise<number> {
	const {
		observations,
		minPriority,
		platform,
		dedup,
		currentTask,
		sourceEvidence,
		onMetrics,
		logger = defaultLogger,
	} = options;

	const priorityOrder = ["high", "medium", "low"];
	const minIndex = priorityOrder.indexOf(minPriority);

	let dedupedCount = 0;
	let gatedCount = 0;
	let prioritySkipped = 0;
	let procedureSkipped = 0;
	let offTopicSkipped = 0;

	const eligible: Observation[] = [];
	for (const obs of observations) {
		const obsIndex = priorityOrder.indexOf(obs.priority);
		if (obsIndex > minIndex) {
			prioritySkipped++;
			continue;
		}
		if (isTurnProcedureObservation(obs)) {
			gatedCount++;
			procedureSkipped++;
			logger.log(
				`[brain-bridge] gated turn-procedure observation: "${obs.content.slice(0, 50)}"`,
			);
			continue;
		}
		const hash = observationHash(obs);
		if (await dedup.has(hash)) {
			dedupedCount++;
			continue;
		}
		if (currentTask && !isRelevantToTask(obs, currentTask)) {
			gatedCount++;
			offTopicSkipped++;
			logger.log(
				`[brain-bridge] gated off-topic observation: "${obs.content.slice(0, 50)}"`,
			);
			continue;
		}
		eligible.push(obs);
	}

	if (eligible.length === 0) {
		onMetrics?.({
			total: observations.length,
			bridged: 0,
			apiDeduplicated: 0,
			deduped: dedupedCount,
			gated: gatedCount,
			prioritySkipped,
			procedureSkipped,
			offTopicSkipped,
			failed: 0,
			entitiesBridged: 0,
		});
		return 0;
	}

	const results = await Promise.allSettled(
		eligible.map((obs, index) => {
			const summary = obs.content;
			const content =
				obs.details.length > 0
					? `${obs.content}\n\n${obs.details.map((d) => `- ${d}`).join("\n")}`
					: obs.content;

			return platform.memoryLearn({
				summary,
				content,
				factType: TYPE_TO_FACT_TYPE[obs.type] ?? "technical",
				confidence: PRIORITY_CONFIDENCE[obs.priority] ?? 0.7,
				source: `observation://${obs.date}/${obs.time}/${index}`,
				memoryScope: "tedi",
				usePolicy: "can_use_as_evidence",
				reviewStatus: "pending",
				metadata: {
					producer: "afterTurn",
					sourceKind: "afterTurn",
					expectedUse: "turn evidence for future tedi recall",
					confidenceReason: `Observer emitted ${obs.type} observation at ${obs.priority} priority`,
					observationType: obs.type,
					observationPriority: obs.priority,
					observationDate: obs.date,
					observationTime: obs.time,
				},
				...(sourceEvidence ? { sourceEvidence } : {}),
			});
		}),
	);

	let bridged = 0;
	let apiDeduplicated = 0;
	const bridgedObservations: Observation[] = [];
	for (const [i, result] of results.entries()) {
		if (result.status === "fulfilled") {
			bridged++;
			if (result.value.deduplicated === true) apiDeduplicated++;
			bridgedObservations.push(eligible[i]!);
			await dedup.add(observationHash(eligible[i]!));
		} else {
			const summary = eligible[i]!.content;
			logger.error(
				`[brain-bridge] error for "${summary.slice(0, 50)}":`,
				result.reason,
			);
		}
	}

	if (bridged > 0) {
		logger.log(
			`[brain-bridge] Bridged ${bridged}/${eligible.length} observations to platform brain`,
		);
	}

	// Entity bridging ----------------------------------------------------------
	const entityBridged = await bridgeEntities({
		bridgedObservations,
		platform,
		dedup,
		logger,
	});

	if ((bridged > 0 || entityBridged > 0) && dedup.flush) {
		await dedup.flush();
	}

	if (entityBridged > 0) {
		logger.log(
			`[brain-bridge] Bridged ${entityBridged} entities to platform brain`,
		);
	}

	onMetrics?.({
		total: observations.length,
		bridged,
		apiDeduplicated,
		deduped: dedupedCount,
		gated: gatedCount,
		prioritySkipped,
		procedureSkipped,
		offTopicSkipped,
		failed: eligible.length - bridged,
		entitiesBridged: entityBridged,
	});

	return bridged;
}

interface BridgeEntitiesArgs {
	bridgedObservations: Observation[];
	platform: PlatformClient;
	dedup: DedupStore;
	logger: NonNullable<BridgeOptions["logger"]>;
}

async function bridgeEntities(args: BridgeEntitiesArgs): Promise<number> {
	const { bridgedObservations, platform, dedup, logger } = args;
	const withEntities = bridgedObservations.filter(
		(o) => o.entities && o.entities.length > 0,
	);
	if (bridgedObservations.length > 0) {
		logger.log(
			`[brain-bridge] Entity bridge: ${bridgedObservations.length} bridged obs, ${withEntities.length} have entities`,
		);
	}

	const entityMap = new Map<
		string,
		{ type: EntityType; name: string; observationSummaries: string[] }
	>();

	for (const obs of bridgedObservations) {
		if (!obs.entities || obs.entities.length === 0) continue;
		for (const entity of obs.entities) {
			const key = `${entity.type}:${entity.name.toLowerCase().trim()}`;
			const existing = entityMap.get(key);
			if (existing) {
				existing.observationSummaries.push(obs.content);
			} else {
				entityMap.set(key, {
					type: entity.type,
					name: entity.name,
					observationSummaries: [obs.content],
				});
			}
		}
	}

	if (entityMap.size === 0) return 0;

	let alreadyBridged = 0;
	const newEntities: Array<{
		type: EntityType;
		name: string;
		observationSummaries: string[];
	}> = [];
	for (const entry of entityMap.values()) {
		const hash = entityHash(entry.type, entry.name);
		if (await dedup.has(hash)) {
			alreadyBridged++;
			continue;
		}
		newEntities.push(entry);
		if (newEntities.length >= MAX_ENTITY_LEARNS_PER_CYCLE) break;
	}

	logger.log(
		`[brain-bridge] Entity bridge: ${entityMap.size} unique entities, ${alreadyBridged} already bridged, ${newEntities.length} to learn`,
	);

	if (newEntities.length === 0) return 0;

	const entityResults = await Promise.allSettled(
		newEntities.map((entity) => {
			const count = entity.observationSummaries.length;
			const domain =
				ENTITY_TYPE_TO_DOMAIN[entity.type] === "__dynamic__"
					? entity.name.toLowerCase().trim()
					: ENTITY_TYPE_TO_DOMAIN[entity.type];
			const content = `Entity of type ${entity.type} mentioned in ${count} observation(s):\n${entity.observationSummaries
				.map((s) => `- ${s}`)
				.join("\n")}`;

			const normalizedName = entity.name.toLowerCase().trim();
			const hash = entityHash(entity.type, entity.name);
			return platform.memoryLearn({
				summary: `${entity.type}: ${entity.name}`,
				content,
				factType: "technical",
				confidence: 0.55,
				source: `entity://${entity.type}/${hash}`,
				topicKey: `entity:${entity.type}:${normalizedName.replace(/\s+/g, "-")}`,
				memoryScope: "graph",
				usePolicy: "do_not_inject_automatically",
				reviewStatus: "evidence_only",
				priority: "background",
				visibility: "private",
				domains: [domain],
				metadata: {
					producer: "entity-extraction",
					sourceKind: "entity-extraction",
					expectedUse: "graph node anchor for context graph traversal",
					confidenceReason:
						"Entity mention extracted from bridged observations; not a validated fact.",
					entityType: entity.type,
					entityName: entity.name,
					entityMentionCount: count,
				},
			});
		}),
	);

	let learned = 0;
	let failed = 0;
	for (const [i, result] of entityResults.entries()) {
		const entity = newEntities[i]!;
		if (result.status === "fulfilled") {
			learned++;
			await dedup.add(entityHash(entity.type, entity.name));
		} else {
			failed++;
			logger.log(
				`[brain-bridge] Entity bridge error for "${entity.type}: ${entity.name}": ${
					result.reason instanceof Error
						? result.reason.message
						: String(result.reason)
				}`,
			);
		}
	}

	logger.log(
		`[brain-bridge] Entity bridge result: ${learned} learned, ${failed} failed out of ${newEntities.length}`,
	);
	return learned;
}
