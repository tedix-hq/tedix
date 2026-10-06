/**
 * Neo4j context-graph projection: the read client and the GraphWriter.
 *
 * Uses the Neo4j HTTP Query API (/db/{database}/query/v2) instead of
 * the Bolt protocol. This is REQUIRED for Cloudflare Workers because
 * Workers cannot open TCP sockets (which neo4j-driver's Bolt needs).
 *
 * The Query API is GA on all AuraDB tiers since 2024.
 * Reference: https://neo4j.com/docs/query-api/current/
 *
 * Usage:
 *   const { client, writer } = createNeo4jGraphClient({ uri, user, password });
 */

import * as algoQueries from "./queries/algorithms";
import * as decisionQueries from "./queries/decisions";
import * as factQueries from "./queries/facts";
import { MIN_EXPLANATION_FACT_CONFIDENCE } from "./queries/quality";
import * as traversalQueries from "./queries/traversal";
import * as vizQueries from "./queries/visualization";
import type { GraphWriter } from "./sync";
import type {
	CausalChain,
	Community,
	GraphCapabilityLink,
	GraphDbConfig,
	GraphDecision,
	GraphEdge,
	GraphEntity,
	GraphEntityResolution,
	GraphFact,
	GraphPath,
	GraphSyncEdge,
	GraphVisualizationData,
	InfluenceScore,
	SimilarDecision,
	SimilarFact,
	TraversalResult,
	VisualizationParams,
} from "./types";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const FACT_RELATION_TYPES = new Set([
	"caused_by",
	"contradicts",
	"supersedes",
	"applies_to",
	"learned_from",
	"requires",
	"related_to",
	"promoted_from",
]);

/**
 * A tenant refresh owns only a bounded amount of stale GDS catalog cleanup.
 * Listing one extra row detects overflow while each retry still makes progress.
 */
const MAX_STALE_GDS_PROJECTIONS_PER_REFRESH = 32;

function factRelationshipType(relationType: string): string {
	if (!FACT_RELATION_TYPES.has(relationType)) {
		throw new Error(`Unknown fact relation type: ${relationType}`);
	}
	return relationType.toUpperCase();
}

function graphFactParams(fact: GraphFact): Record<string, unknown> {
	return {
		id: fact.id,
		orgId: fact.orgId,
		tediId: fact.tediId,
		domainId: fact.domainId,
		content: fact.content,
		summary: fact.summary,
		factType: fact.factType,
		confidence: fact.confidence,
		validTo: fact.validTo,
		archivedAt: fact.archivedAt,
		priority: fact.priority,
		visibility: fact.visibility,
		accessCount: fact.accessCount,
		usageCount: fact.usageCount,
		createdAt: fact.createdAt,
		updatedAt: fact.updatedAt,
		projectionEpoch: fact.projectionEpoch ?? null,
		projectionRepairEpoch: fact.projectionRepairEpoch ?? null,
	};
}

function graphEdgeParams(edge: GraphSyncEdge): Record<string, unknown> {
	return {
		id: edge.id,
		orgId: edge.orgId,
		sourceFactId: edge.sourceFactId,
		targetFactId: edge.targetFactId,
		relationType: edge.relationType,
		strength: edge.strength,
		context: edge.context,
		updatedAt: edge.updatedAt,
		projectionEpoch: edge.projectionEpoch ?? null,
		projectionRepairEpoch: edge.projectionRepairEpoch ?? null,
	};
}

/**
 * Node label per capability-link entity kind. Enum-checked before Cypher
 * interpolation — never interpolate a raw caller string as a label.
 */
const CAPABILITY_LINK_LABELS: Record<
	GraphCapabilityLink["entityKind"],
	string
> = {
	skill: "Skill",
	app: "App",
	tedi: "Tedi",
	external_agent: "ExternalAgent",
	objective: "Objective",
};

type ProjectionNodeLabel =
	| "Fact"
	| "Domain"
	| "Tedi"
	| "ExternalAgent"
	| "Decision"
	| "Outcome"
	| "KnowledgeEntry"
	| "Skill"
	| "Capability"
	| "App"
	| "Objective"
	| "ApprovalRequest"
	| "Entity"
	| "EntityResolution"
	| "EntityResolutionDecision"
	| "Project"
	| "WorkItem"
	| "WorkItemSource";

function capabilityLinkLabel(
	entityKind: GraphCapabilityLink["entityKind"],
): ProjectionNodeLabel {
	const label = CAPABILITY_LINK_LABELS[entityKind];
	if (!label) {
		throw new Error(`Unknown capability link entity kind: ${entityKind}`);
	}
	return label as ProjectionNodeLabel;
}

// ============================================================================
// HTTP Query API Client
// ============================================================================

interface HttpClient {
	endpoint: string;
	headers: Record<string, string>;
	database: string;
}

interface QueryApiError {
	code?: string;
	message?: string;
	gqlStatus?: string;
	statusDescription?: string;
}

function queryApiErrorMessage(value: unknown): string {
	if (!isRecord(value)) return String(value);
	const error = value as QueryApiError;
	const code =
		typeof error.code === "string"
			? error.code
			: typeof error.gqlStatus === "string"
				? error.gqlStatus
				: undefined;
	const message =
		typeof error.message === "string"
			? error.message
			: typeof error.statusDescription === "string"
				? error.statusDescription
				: undefined;
	return [code, message].filter(Boolean).join(": ") || "unknown query error";
}

/**
 * Convert Neo4j connection URI to HTTPS endpoint for Query API.
 * neo4j+s://xxx.databases.neo4j.io → https://xxx.databases.neo4j.io
 * bolt+s://xxx → https://xxx
 * https://xxx → https://xxx (passthrough)
 */
function createHttpClient(config: GraphDbConfig): HttpClient {
	let baseUrl = config.uri;
	baseUrl = baseUrl.replace(/^neo4j\+s:\/\//, "https://");
	baseUrl = baseUrl.replace(/^neo4j\+ssc:\/\//, "https://");
	baseUrl = baseUrl.replace(/^neo4j:\/\//, "http://");
	baseUrl = baseUrl.replace(/^bolt\+s:\/\//, "https://");
	baseUrl = baseUrl.replace(/^bolt:\/\//, "http://");

	const database = config.database ?? "neo4j";
	const endpoint = `${baseUrl}/db/${database}/query/v2`;

	const credentials = btoa(`${config.user}:${config.password}`);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Basic ${credentials}`,
	};

	return { endpoint, headers, database };
}

/**
 * Run a Cypher query via the Neo4j HTTP Query API.
 * Returns rows as Record<string, unknown>[] mapped from fields+values.
 */
async function runQuery(
	http: HttpClient,
	cypher: string,
	params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
	// Convert undefined values to null — JSON.stringify strips undefined keys,
	// but Neo4j Query API expects all referenced $params to be present.
	const sanitizedParams: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		sanitizedParams[key] = value === undefined ? null : value;
	}

	const body = JSON.stringify({
		statement: cypher,
		parameters: sanitizedParams,
	});

	const res = await fetch(http.endpoint, {
		method: "POST",
		headers: http.headers,
		body,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Neo4j Query API ${res.status}: ${text}`);
	}

	let json: unknown;
	try {
		json = await res.json();
	} catch {
		throw new Error("Neo4j Query API returned invalid JSON");
	}
	if (!isRecord(json)) {
		throw new Error("Neo4j Query API returned a malformed response");
	}

	// Query API v2 reports Cypher failures in a 202 response body, so inspect
	// errors before attempting to read data.
	if (Array.isArray(json.errors) && json.errors.length > 0) {
		throw new Error(
			`Neo4j Query API error: ${json.errors
				.map(queryApiErrorMessage)
				.join("; ")}`,
		);
	}

	const data = json.data;
	if (
		!isRecord(data) ||
		!Array.isArray(data.fields) ||
		!data.fields.every((field) => typeof field === "string") ||
		!Array.isArray(data.values) ||
		!data.values.every(Array.isArray)
	) {
		throw new Error("Neo4j Query API returned malformed query data");
	}
	const fields = data.fields as string[];
	const values = data.values as unknown[][];
	if (values.some((row) => row.length !== fields.length)) {
		throw new Error("Neo4j Query API returned malformed query data");
	}

	return values.map((row) => {
		const record: Record<string, unknown> = {};
		for (let i = 0; i < fields.length; i++) {
			record[fields[i]!] = row[i];
		}
		return record;
	});
}

// ============================================================================
// Factory
// ============================================================================

export function createNeo4jGraphClient(config: GraphDbConfig) {
	const http = createHttpClient(config);

	async function adoptUnownedLegacyNodes(
		nodes: Array<{
			label: ProjectionNodeLabel;
			id: string | null | undefined;
			orgId: string;
		}>,
	): Promise<void> {
		const byLabel = new Map<
			ProjectionNodeLabel,
			Map<string, { id: string; orgId: string }>
		>();
		for (const node of nodes) {
			if (!node.id) continue;
			const group = byLabel.get(node.label) ?? new Map();
			const existing = group.get(node.id);
			if (existing && existing.orgId !== node.orgId) {
				throw new Error(
					`Neo4j legacy ${node.label} identity ${node.id} spans organizations`,
				);
			}
			group.set(node.id, {
				id: node.id,
				orgId: node.orgId,
			});
			byLabel.set(node.label, group);
		}
		for (const [label, group] of byLabel) {
			await runQuery(
				http,
				`
				UNWIND $nodes AS item
				OPTIONAL MATCH (legacy:${label} {id: item.id})
				WHERE legacy.orgId IS NULL
				SET legacy.orgId = item.orgId
				`,
				{ nodes: [...group.values()] },
			);
		}
	}

	async function run<T>(
		queryObj: { query: string; params: Record<string, unknown> },
		mapper: (records: Record<string, unknown>[]) => T,
	): Promise<T> {
		const records = await runQuery(http, queryObj.query, queryObj.params);
		return mapper(records);
	}

	function decisionBatchParams(decision: GraphDecision) {
		const { evidence, ...context } = decision;
		return {
			...context,
			objectiveId: decision.objectiveId ?? null,
			approvalRequestId: decision.approvalRequestId ?? null,
			completedAt: decision.completedAt ?? null,
			outcomeId: `${decision.id}:outcome`,
			evidenceFactIds: parseEvidenceFactIds(evidence),
			projectionEpoch: decision.projectionEpoch ?? null,
			projectionRepairEpoch: decision.projectionRepairEpoch ?? null,
		};
	}

	async function rebuildDecisionPredecessors(
		decisions: GraphDecision[],
	): Promise<void> {
		if (decisions.length === 0) return;
		const items = decisions.map(decisionBatchParams);
		const records = await runQuery(
			http,
			`
			UNWIND $decisions AS item
			MATCH (d:Decision {orgId: item.orgId, id: item.id})
			OPTIONAL MATCH (d)-[stale:PRECEDED_BY]->()
			DELETE stale
			WITH DISTINCT d, item
			CALL {
				WITH d, item
				OPTIONAL MATCH (prev:Decision {
					orgId: item.orgId,
					tediId: item.tediId,
					category: item.category
				})
				WHERE prev.id <> item.id AND prev.createdAt < item.createdAt
				WITH prev
				ORDER BY prev.createdAt DESC, prev.id DESC
				LIMIT 1
				RETURN prev AS expected
			}
			FOREACH (_ IN CASE WHEN expected IS NOT NULL THEN [1] ELSE [] END |
				MERGE (d)-[precededBy:PRECEDED_BY]->(expected)
				SET precededBy.projectionEpoch =
						coalesce(item.projectionEpoch, precededBy.projectionEpoch),
					precededBy.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, precededBy.projectionRepairEpoch))
			WITH d, expected
			OPTIONAL MATCH (d)-[:PRECEDED_BY]->(actual:Decision)
			WITH d, expected, collect(actual.id) AS actualIds
			RETURN count(d) AS written,
				sum(CASE
					WHEN expected IS NULL AND size(actualIds) = 0 THEN 1
					WHEN expected IS NOT NULL
						AND size(actualIds) = 1
						AND actualIds[0] = expected.id
						THEN 1
					ELSE 0
				END) AS verified
			`,
			{ decisions: items },
		);
		const written = toNumber(records[0]?.written);
		const verified = toNumber(records[0]?.verified);
		if (written !== decisions.length || verified !== decisions.length) {
			throw new Error(
				`Neo4j decision predecessor batch verification failed: expected ${decisions.length}, wrote ${written}, verified ${verified}`,
			);
		}
	}

	// ========================================================================
	// GraphClient Implementation
	// ========================================================================

	const client = {
		async findStructurallySimilar(
			factId: string,
			orgId: string,
			topK = 10,
		): Promise<SimilarFact[]> {
			return run(
				factQueries.findStructurallySimilar(factId, orgId, topK),
				(records) =>
					records.map((r) => ({
						factId: r.factId as string,
						score: toNumber(r.score),
						source: "structural" as const,
					})),
			);
		},

		async findSimilarDecisions(
			_query: string,
			orgId: string,
			options?: { category?: string; tediId?: string; topK?: number },
		): Promise<SimilarDecision[]> {
			return run(decisionQueries.findPrecedents(orgId, options), (records) =>
				records.map((r) => ({
					decisionId: r.decisionId as string,
					action: r.action as string,
					rationale: r.rationale as string,
					outcomeStatus: r.outcomeStatus as string,
					confidence: toNumber(r.confidence),
					score: toNumber(r.evidenceCount) / 10,
				})),
			);
		},

		async findPath(
			factIdA: string,
			factIdB: string,
			orgId: string,
			maxHops = 6,
		): Promise<GraphPath | null> {
			return run(
				traversalQueries.shortestPath(factIdA, factIdB, orgId, maxHops),
				(records) => {
					if (records.length === 0) return null;
					const r = records[0]!;
					return {
						factIds: r.factIds as string[],
						relationTypes: r.relationTypes as string[],
						hops: toNumber(r.hops),
					};
				},
			);
		},

		async getCausalChain(
			decisionId: string,
			orgId: string,
			maxDepth = 5,
		): Promise<CausalChain> {
			return run(
				decisionQueries.getCausalChain(decisionId, orgId, maxDepth),
				(records) => {
					if (records.length === 0) {
						return { decisionId, nodes: [], edges: [] };
					}
					const r = records[0]!;
					const upstream = (r.upstreamNodes ?? []) as Array<{
						id: string;
						type: string;
						label: string;
						depth: number;
					}>;
					const downstream = (r.downstreamNodes ?? []) as Array<{
						id: string;
						type: string;
						label: string;
						depth: number;
					}>;
					const rawEdges = (r.edges ?? []) as Array<{
						sourceFactId?: string;
						targetFactId?: string;
						relationType?: string;
					}>;
					const edgeMap = new Map<
						string,
						{ source: string; target: string; relationType: string }
					>();
					for (const edge of rawEdges) {
						if (!edge.sourceFactId || !edge.targetFactId) continue;
						const relationType = edge.relationType ?? "related_to";
						const key = `${edge.sourceFactId}:${relationType}:${edge.targetFactId}`;
						edgeMap.set(key, {
							source: edge.sourceFactId,
							target: edge.targetFactId,
							relationType,
						});
					}
					const nodes = [...upstream, ...downstream].filter((n) => n.id);
					return {
						decisionId,
						nodes: nodes.map((n) => ({
							id: n.id,
							type: n.type as "decision" | "fact",
							label: n.label ?? "",
							depth: toNumber(n.depth),
						})),
						edges: [...edgeMap.values()],
					};
				},
			);
		},

		async traverse(
			startFactId: string,
			orgId: string,
			maxDepth: number,
			maxNodes = 100,
		): Promise<TraversalResult> {
			return run(
				traversalQueries.deepTraversal(startFactId, orgId, maxDepth, maxNodes),
				(records) => {
					const facts = new Map<string, { fact: GraphFact; depth: number }>();
					if (records.length === 0) return { facts, edges: [] };

					const r = records[0]!;
					const rawFacts = (r.facts ?? []) as Array<Record<string, unknown>>;
					const rawEdges = (r.edges ?? []) as Array<Record<string, unknown>>;

					for (const fact of rawFacts) {
						const factId = fact.factId as string | undefined;
						if (!factId) continue;
						facts.set(factId, {
							fact: {
								id: factId,
								orgId,
								tediId: fact.tediId as string | null,
								domainId: fact.domainId as string | null,
								content: fact.content as string,
								summary: fact.summary as string | null,
								factType: fact.factType as string,
								confidence: toNumber(fact.confidence),
								validTo: fact.validTo as string | null,
								archivedAt: fact.archivedAt as string | null,
								priority: fact.priority as string | null,
								visibility: null,
								accessCount: 0,
								usageCount: 0,
								createdAt: null,
								updatedAt: null,
							},
							depth: toNumber(fact.depth),
						});
					}

					const edges = rawEdges
						.filter((edge) => edge.sourceFactId && edge.targetFactId)
						.map((edge) => ({
							sourceFactId: edge.sourceFactId as string,
							targetFactId: edge.targetFactId as string,
							relationType: edge.relationType as GraphEdge["relationType"],
							strength: toNumber(edge.strength),
							context: edge.context as string | null,
						}));

					return { facts, edges };
				},
			);
		},

		async getEdges(
			factId: string,
			orgId: string,
			options?: { relationType?: string; direction?: "in" | "out" | "both" },
		): Promise<GraphEdge[]> {
			return run(factQueries.getEdges(factId, orgId, options), (records) =>
				records.map((r) => ({
					sourceFactId: r.sourceFactId as string,
					targetFactId: r.targetFactId as string,
					relationType: r.relationType as GraphEdge["relationType"],
					strength: toNumber(r.strength),
					context: r.context as string | null,
				})),
			);
		},

		/** Reads persisted community assignments; never creates, runs, or drops a GDS projection. */
		async getCommunities(
			orgId: string,
			options?: { domainId?: string; minSize?: number },
		): Promise<Community[]> {
			try {
				return await run(
					{
						query: `
							MATCH (f:Fact {orgId: $orgId})
							WHERE f.communityId IS NOT NULL
								AND f.archivedAt IS NULL
								AND f.validTo IS NULL
								AND f.confidence >= $minFactConfidence
								AND ($domainId IS NULL OR f.domainId = $domainId)
							WITH f.communityId AS communityId,
								collect(f.id) AS factIds,
								count(*) AS size
							WHERE size >= $minSize
							RETURN communityId, factIds, size,
								null AS dominantDomain
							ORDER BY size DESC
						`,
						params: {
							orgId,
							domainId: options?.domainId ?? null,
							minSize: options?.minSize ?? 2,
							minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
						},
					},
					(records) =>
						records.map((r) => ({
							communityId: toNumber(r.communityId),
							factIds: r.factIds as string[],
							size: toNumber(r.size),
							dominantDomain: r.dominantDomain as string | null,
						})),
				);
			} catch (e) {
				// Persisted assignments are optional; callers degrade when absent.
				console.warn("[GraphDB] persisted community read failed:", e);
				return [];
			}
		},

		/** Reads persisted PageRank scores; never creates, runs, or drops a GDS projection. */
		async getInfluenceScores(
			orgId: string,
			options?: { domainId?: string; topK?: number },
		): Promise<InfluenceScore[]> {
			const topK = options?.topK ?? 20;

			try {
				return await run(
					{
						query: `
							MATCH (f:Fact {orgId: $orgId})
							WHERE f.pageRank IS NOT NULL
								AND f.archivedAt IS NULL
								AND f.validTo IS NULL
								AND f.confidence >= $minFactConfidence
								AND ($domainId IS NULL OR f.domainId = $domainId)
							RETURN f.id AS factId, f.pageRank AS pageRank,
								f.summary AS summary, f.factType AS factType
							ORDER BY f.pageRank DESC
							LIMIT $topK
						`,
						params: {
							orgId,
							topK,
							domainId: options?.domainId ?? null,
							minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
						},
					},
					(records) =>
						records.map((r) => ({
							factId: r.factId as string,
							pageRank: toNumber(r.pageRank),
							summary: r.summary as string | null,
							factType: r.factType as string,
						})),
				);
			} catch (e) {
				console.warn("[GraphDB] persisted PageRank read failed:", e);
				return [];
			}
		},

		/** Controlled maintenance mutation: refresh persisted GDS-derived properties. */
		async refreshStructuralEmbeddings(
			orgId: string,
			options?: {
				epoch?: string;
				sourceWatermark?: number;
				/** Unique to one lease-owning maintenance attempt. */
				attemptKey?: string;
				beforeStep?: () => Promise<void>;
			},
		): Promise<void> {
			const sanitizeGraphComponent = (value: string) =>
				value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 96);
			const attemptKey = sanitizeGraphComponent(
				options?.attemptKey ??
					`${options?.epoch ?? "unstamped"}-${options?.sourceWatermark ?? 0}`,
			);
			const graphPrefix = `fact-refresh-${sanitizeGraphComponent(orgId)}-`;
			const graphName = `${graphPrefix}${attemptKey}`;

			// The tenant lease is asserted before catalog inspection and every
			// stale drop. The query is prefix-scoped, and the returned names are
			// checked again before use so an unexpected catalog response cannot
			// turn into cross-tenant mutation.
			await options?.beforeStep?.();
			const staleGraphNames = await run(
				algoQueries.listProjectionsByPrefix(
					graphPrefix,
					graphName,
					MAX_STALE_GDS_PROJECTIONS_PER_REFRESH + 1,
				),
				(records) => records.map((record) => record.graphName),
			);
			for (const staleGraphName of staleGraphNames) {
				if (
					typeof staleGraphName !== "string" ||
					!staleGraphName.startsWith(graphPrefix) ||
					staleGraphName === graphName
				) {
					throw new Error(
						`Neo4j GDS catalog returned an unsafe stale projection for tenant prefix ${graphPrefix}`,
					);
				}
			}
			for (const staleGraphName of staleGraphNames.slice(
				0,
				MAX_STALE_GDS_PROJECTIONS_PER_REFRESH,
			)) {
				await options?.beforeStep?.();
				await run(
					algoQueries.dropProjection(staleGraphName as string),
					() => {},
				);
			}
			if (staleGraphNames.length > MAX_STALE_GDS_PROJECTIONS_PER_REFRESH) {
				throw new Error(
					`Neo4j GDS stale projection cleanup removed ${MAX_STALE_GDS_PROJECTIONS_PER_REFRESH} graphs for tenant prefix ${graphPrefix}; retry required before refresh`,
				);
			}

			const pipeline = algoQueries.getRefreshPipeline(orgId, {
				...options,
				graphName,
			});
			const cleanup = pipeline.at(-1);
			const mutationSteps = pipeline.slice(0, -1);
			let primaryError: unknown;
			try {
				for (const step of mutationSteps) {
					// Lease/assertion failures must never be treated like an
					// ignorable stale-projection cleanup. dropProjection(...,
					// false) already handles the genuinely absent-graph case.
					await options?.beforeStep?.();
					await run({ query: step.query, params: step.params }, () => {});
				}
			} catch (error) {
				primaryError = error;
			}

			let cleanupError: unknown;
			if (cleanup) {
				try {
					await run({ query: cleanup.query, params: cleanup.params }, () => {});
				} catch (error) {
					cleanupError = error;
				}
			}
			if (primaryError !== undefined) {
				if (cleanupError !== undefined) {
					console.warn(
						`[GraphDB] Failed to drop GDS projection ${graphName}:`,
						cleanupError,
					);
				}
				throw primaryError;
			}
			if (cleanupError !== undefined) throw cleanupError;
		},

		async refreshCommunities(_orgId: string): Promise<void> {
			// Community persistence is part of the combined controlled refresh
			// run by refreshStructuralEmbeddings().
		},

		async getVisualization(
			params: VisualizationParams,
		): Promise<GraphVisualizationData> {
			if (params.centerFactId) {
				return run(
					factQueries.getNeighborhoodSimple(
						params.centerFactId,
						params.depth ?? 2,
						params.orgId,
					),
					(records) => {
						const nodes = records.map((r) => ({
							id: r.factId as string,
							label: (r.summary ?? r.factType) as string,
							type: "fact" as const,
							properties: {
								factType: r.factType,
								confidence: r.confidence,
								priority: r.priority,
								depth: r.depth,
							},
						}));
						return { nodes, edges: [] };
					},
				);
			}

			return run(
				vizQueries.knowledgeMap({
					orgId: params.orgId,
					tediId: params.tediId,
					domainId: params.domainId,
					maxNodes: params.maxNodes,
				}),
				(records) => {
					if (records.length === 0) return { nodes: [], edges: [] };
					const r = records[0]!;
					// Filter out null entries from OPTIONAL MATCH (domain/edge can be null)
					const rawNodes = (r.nodes ?? []) as GraphVisualizationData["nodes"];
					const rawEdges = (r.edges ?? []) as GraphVisualizationData["edges"];
					return {
						nodes: rawNodes.filter((n) => n.id != null),
						edges: rawEdges.filter((e) => e.source != null && e.target != null),
					};
				},
			);
		},

		async isHealthy(): Promise<boolean> {
			try {
				await runQuery(http, "RETURN 1 AS ok");
				return true;
			} catch {
				return false;
			}
		},

		async close(): Promise<void> {
			// No persistent connections with HTTP transport — nothing to close
		},
	};

	// ========================================================================
	// GraphWriter Implementation (for sync consumer)
	// ========================================================================

	const writer: GraphWriter = {
		async upsertFact(fact) {
			await adoptUnownedLegacyNodes([
				{ label: "Fact", id: fact.id, orgId: fact.orgId },
				{ label: "Domain", id: fact.domainId, orgId: fact.orgId },
				{ label: "Tedi", id: fact.tediId, orgId: fact.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (f:Fact {id: $id, orgId: $orgId})
				SET f.tediId = $tediId,
					f.domainId = $domainId,
					f.content = $content,
					f.summary = $summary,
					f.factType = $factType,
					f.confidence = $confidence,
					f.validTo = $validTo,
					f.archivedAt = $archivedAt,
					f.priority = $priority,
					f.visibility = $visibility,
					f.accessCount = $accessCount,
					f.usageCount = $usageCount,
					f.createdAt = $createdAt,
					f.updatedAt = $updatedAt,
					f.projectionEpoch = coalesce($projectionEpoch, f.projectionEpoch),
					f.projectionRepairEpoch = coalesce($projectionRepairEpoch, f.projectionRepairEpoch)
				WITH f
				OPTIONAL MATCH (f)-[managed:IN_DOMAIN|OWNED_BY]->()
				DELETE managed
				WITH DISTINCT f
				// Link to domain
				FOREACH (_ IN CASE WHEN $domainId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:Domain {id: $domainId, orgId: $orgId})
					SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (f)-[inDomain:IN_DOMAIN]->(d)
					SET inDomain.projectionEpoch = coalesce($projectionEpoch, inDomain.projectionEpoch),
						inDomain.projectionRepairEpoch = coalesce($projectionRepairEpoch, inDomain.projectionRepairEpoch))
				// Link to tedi
				FOREACH (_ IN CASE WHEN $tediId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (t:Tedi {id: $tediId, orgId: $orgId})
					SET t.projectionEpoch = coalesce($projectionEpoch, t.projectionEpoch),
						t.projectionRepairEpoch = coalesce($projectionRepairEpoch, t.projectionRepairEpoch)
					MERGE (f)-[ownedBy:OWNED_BY]->(t)
					SET ownedBy.projectionEpoch = coalesce($projectionEpoch, ownedBy.projectionEpoch),
						ownedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, ownedBy.projectionRepairEpoch))
				`,
				graphFactParams(fact),
			);
		},

		async upsertFacts(facts) {
			if (facts.length === 0) return;
			const projectedFacts = facts.map(graphFactParams);
			if (
				projectedFacts.some(
					(fact) =>
						typeof fact.projectionEpoch !== "string" ||
						fact.projectionEpoch.length === 0,
				)
			) {
				throw new Error(
					"Neo4j verified fact batches require a stable projectionEpoch",
				);
			}
			await runQuery(
				http,
				`
				UNWIND $facts AS item
				OPTIONAL MATCH (legacyFact:Fact {id: item.id})
				WHERE legacyFact.orgId IS NULL
				SET legacyFact.orgId = item.orgId
				WITH item
				OPTIONAL MATCH (legacyDomain:Domain {id: item.domainId})
				WHERE item.domainId IS NOT NULL AND legacyDomain.orgId IS NULL
				SET legacyDomain.orgId = item.orgId
				WITH item
				OPTIONAL MATCH (legacyTedi:Tedi {id: item.tediId})
				WHERE item.tediId IS NOT NULL AND legacyTedi.orgId IS NULL
				SET legacyTedi.orgId = item.orgId
				`,
				{ facts: projectedFacts },
			);
			await runQuery(
				http,
				`
				UNWIND $facts AS row
				MERGE (f:Fact {id: row.id, orgId: row.orgId})
				SET f.tediId = row.tediId,
					f.domainId = row.domainId,
					f.content = row.content,
					f.summary = row.summary,
					f.factType = row.factType,
					f.confidence = row.confidence,
					f.validTo = row.validTo,
					f.archivedAt = row.archivedAt,
					f.priority = row.priority,
					f.visibility = row.visibility,
					f.accessCount = row.accessCount,
					f.usageCount = row.usageCount,
					f.createdAt = row.createdAt,
					f.updatedAt = row.updatedAt,
					f.projectionEpoch = coalesce(row.projectionEpoch, f.projectionEpoch),
					f.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, f.projectionRepairEpoch)
				WITH row, f
				OPTIONAL MATCH (f)-[managed:IN_DOMAIN|OWNED_BY]->()
				DELETE managed
				WITH DISTINCT row, f
				FOREACH (_ IN CASE WHEN row.domainId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:Domain {id: row.domainId, orgId: row.orgId})
					SET d.projectionEpoch = coalesce(row.projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (f)-[inDomain:IN_DOMAIN]->(d)
					SET inDomain.projectionEpoch = coalesce(row.projectionEpoch, inDomain.projectionEpoch),
						inDomain.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, inDomain.projectionRepairEpoch))
				FOREACH (_ IN CASE WHEN row.tediId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (t:Tedi {id: row.tediId, orgId: row.orgId})
					SET t.projectionEpoch = coalesce(row.projectionEpoch, t.projectionEpoch),
						t.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, t.projectionRepairEpoch)
					MERGE (f)-[ownedBy:OWNED_BY]->(t)
					SET ownedBy.projectionEpoch = coalesce(row.projectionEpoch, ownedBy.projectionEpoch),
						ownedBy.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, ownedBy.projectionRepairEpoch))
				`,
				{ facts: projectedFacts },
			);
			const records = await runQuery(
				http,
				`
				UNWIND $facts AS item
				MATCH (f:Fact {
					id: item.id,
					orgId: item.orgId,
					projectionEpoch: item.projectionEpoch
				})
				RETURN count(f) AS written
				`,
				{ facts: projectedFacts },
			);
			const written = toNumber(records[0]?.written);
			if (written !== facts.length) {
				throw new Error(
					`Neo4j fact batch verification failed: expected ${facts.length}, wrote ${written}`,
				);
			}
		},

		async upsertEdge(edge) {
			const relType = factRelationshipType(edge.relationType);
			const params = graphEdgeParams(edge);
			await runQuery(
				http,
				`
				MATCH (source:Fact {id: $sourceFactId, orgId: $orgId})
				MATCH (target:Fact {id: $targetFactId, orgId: $orgId})
				OPTIONAL MATCH (source)-[existing:${relType}]->(target)
				WITH source, target, existing
				ORDER BY elementId(existing)
				WITH source, target, collect(existing) AS existingRelationships
				FOREACH (duplicate IN tail(existingRelationships) | DELETE duplicate)
				WITH source, target
				MERGE (source)-[r:${relType}]->(target)
				SET r.id = $id,
					r.orgId = $orgId,
					r.strength = $strength,
					r.context = $context,
					r.relationType = $relationType,
					r.updatedAt = $updatedAt,
					r.projectionEpoch = coalesce($projectionEpoch, r.projectionEpoch),
					r.projectionRepairEpoch = coalesce($projectionRepairEpoch, r.projectionRepairEpoch)
				`,
				params,
			);
			const records = await runQuery(
				http,
				`
				MATCH (source:Fact {id: $sourceFactId, orgId: $orgId})
					-[r:${relType}]->
					(target:Fact {id: $targetFactId, orgId: $orgId})
				WHERE r.id = $id
					AND r.orgId = $orgId
					AND r.relationType = $relationType
					AND r.strength = $strength
					AND (r.context = $context OR (r.context IS NULL AND $context IS NULL))
					AND (r.updatedAt = $updatedAt OR (r.updatedAt IS NULL AND $updatedAt IS NULL))
					AND (
						r.projectionEpoch = $projectionEpoch
						OR (r.projectionEpoch IS NULL AND $projectionEpoch IS NULL)
					)
					AND (
						r.projectionRepairEpoch = $projectionRepairEpoch
						OR (
							r.projectionRepairEpoch IS NULL
							AND $projectionRepairEpoch IS NULL
						)
					)
				RETURN count(r) AS written
				`,
				params,
			);
			const written = toNumber(records[0]?.written);
			if (written !== 1) {
				throw new Error(
					`Neo4j ${relType} verification failed: expected 1, wrote ${written}`,
				);
			}
		},

		async upsertEdges(edges) {
			if (edges.length === 0) return;
			if (
				edges.some(
					(edge) =>
						typeof edge.projectionEpoch !== "string" ||
						edge.projectionEpoch.length === 0,
				)
			) {
				throw new Error(
					"Neo4j verified edge batches require a stable projectionEpoch",
				);
			}
			const byType = new Map<string, GraphSyncEdge[]>();
			for (const edge of edges) {
				const relType = factRelationshipType(edge.relationType);
				const group = byType.get(relType) ?? [];
				group.push(edge);
				byType.set(relType, group);
			}
			// Cypher cannot parameterize relationship labels. The allowlisted
			// relation groups bound a page to at most eight HTTP calls.
			for (const [relType, group] of byType) {
				const projectedEdges = group.map(graphEdgeParams);
				await runQuery(
					http,
					`
					UNWIND $edges AS row
					MATCH (source:Fact {id: row.sourceFactId, orgId: row.orgId})
					MATCH (target:Fact {id: row.targetFactId, orgId: row.orgId})
					OPTIONAL MATCH (source)-[existing:${relType}]->(target)
					WITH row, source, target, existing
					ORDER BY elementId(existing)
					WITH row, source, target, collect(existing) AS existingRelationships
					FOREACH (duplicate IN tail(existingRelationships) | DELETE duplicate)
					WITH row, source, target
					MERGE (source)-[r:${relType}]->(target)
					SET r.id = row.id,
						r.orgId = row.orgId,
						r.strength = row.strength,
						r.context = row.context,
						r.relationType = row.relationType,
						r.updatedAt = row.updatedAt,
						r.projectionEpoch = coalesce(row.projectionEpoch, r.projectionEpoch),
						r.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, r.projectionRepairEpoch)
					`,
					{ edges: projectedEdges },
				);
				const records = await runQuery(
					http,
					`
					UNWIND $edges AS row
					MATCH (source:Fact {id: row.sourceFactId, orgId: row.orgId})
						-[r:${relType}]->
						(target:Fact {id: row.targetFactId, orgId: row.orgId})
					WHERE r.id = row.id
						AND r.orgId = row.orgId
						AND r.relationType = row.relationType
						AND r.strength = row.strength
						AND (r.context = row.context OR (r.context IS NULL AND row.context IS NULL))
						AND (r.updatedAt = row.updatedAt OR (r.updatedAt IS NULL AND row.updatedAt IS NULL))
						AND r.projectionEpoch = row.projectionEpoch
						AND (
							r.projectionRepairEpoch = row.projectionRepairEpoch
							OR (
								r.projectionRepairEpoch IS NULL
								AND row.projectionRepairEpoch IS NULL
							)
						)
					RETURN count(r) AS written
					`,
					{ edges: projectedEdges },
				);
				const written = toNumber(records[0]?.written);
				if (written !== group.length) {
					throw new Error(
						`Neo4j ${relType} batch verification failed: expected ${group.length}, wrote ${written}`,
					);
				}
			}
		},

		async upsertDomain(domain) {
			await adoptUnownedLegacyNodes([
				{ label: "Domain", id: domain.id, orgId: domain.orgId },
				{ label: "Domain", id: domain.parentId, orgId: domain.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (d:Domain {id: $id, orgId: $orgId})
				SET d.name = $name,
					d.parentId = $parentId,
					d.description = $description,
					d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
					d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
				WITH d
				OPTIONAL MATCH ()-[managed:PARENT_OF]->(d)
				DELETE managed
				WITH DISTINCT d
				FOREACH (_ IN CASE WHEN $parentId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (parent:Domain {id: $parentId, orgId: $orgId})
					SET parent.projectionEpoch = coalesce($projectionEpoch, parent.projectionEpoch),
						parent.projectionRepairEpoch = coalesce($projectionRepairEpoch, parent.projectionRepairEpoch)
					MERGE (parent)-[parentOf:PARENT_OF]->(d)
					SET parentOf.projectionEpoch = coalesce($projectionEpoch, parentOf.projectionEpoch),
						parentOf.projectionRepairEpoch = coalesce($projectionRepairEpoch, parentOf.projectionRepairEpoch))
				`,
				{
					id: domain.id,
					orgId: domain.orgId,
					name: domain.name,
					parentId: domain.parentId,
					description: domain.description,
					projectionEpoch: domain.projectionEpoch ?? null,
					projectionRepairEpoch: domain.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertTedi(tedi) {
			await adoptUnownedLegacyNodes([
				{ label: "Tedi", id: tedi.id, orgId: tedi.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (t:Tedi {id: $id, orgId: $orgId})
				SET t.slug = $slug,
					t.name = $name,
					t.projectionEpoch = coalesce($projectionEpoch, t.projectionEpoch),
					t.projectionRepairEpoch = coalesce($projectionRepairEpoch, t.projectionRepairEpoch)
				`,
				{
					id: tedi.id,
					orgId: tedi.orgId,
					slug: tedi.slug,
					name: tedi.name,
					projectionEpoch: tedi.projectionEpoch ?? null,
					projectionRepairEpoch: tedi.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertDecisionContexts(decisions, options) {
			if (decisions.length === 0) return;
			if (
				options?.requireProjectionEpoch &&
				decisions.some(
					(decision) =>
						typeof decision.projectionEpoch !== "string" ||
						decision.projectionEpoch.length === 0,
				)
			) {
				throw new Error(
					"Neo4j baseline decision context requires a projection epoch",
				);
			}
			if (
				options?.requireRepairEpoch &&
				decisions.some(
					(decision) =>
						typeof decision.projectionRepairEpoch !== "string" ||
						decision.projectionRepairEpoch.length === 0,
				)
			) {
				throw new Error(
					"Neo4j baseline decision context requires a repair epoch",
				);
			}
			const items = decisions.map(decisionBatchParams);
			await adoptUnownedLegacyNodes(
				items.flatMap((decision) => [
					{
						label: "Decision" as const,
						id: decision.id,
						orgId: decision.orgId,
					},
					{
						label: "Tedi" as const,
						id: decision.tediId,
						orgId: decision.orgId,
					},
					{
						label: "Outcome" as const,
						id: decision.outcomeId,
						orgId: decision.orgId,
					},
					{
						label: "Objective" as const,
						id: decision.objectiveId,
						orgId: decision.orgId,
					},
					{
						label: "ApprovalRequest" as const,
						id: decision.approvalRequestId,
						orgId: decision.orgId,
					},
				]),
			);
			const records = await runQuery(
				http,
				`
				UNWIND $decisions AS item
				MERGE (d:Decision {id: item.id, orgId: item.orgId})
				SET d:Episode,
					d.tediId = item.tediId,
					d.action = item.action,
					d.rationale = item.rationale,
					d.category = item.category,
					d.confidence = item.confidence,
					d.outcomeStatus = item.outcomeStatus,
					d.objectiveId = item.objectiveId,
					d.approvalRequestId = item.approvalRequestId,
					d.createdAt = item.createdAt,
					d.completedAt = item.completedAt,
					d.projectionEpoch =
						coalesce(item.projectionEpoch, d.projectionEpoch),
					d.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, d.projectionRepairEpoch)
				WITH d, item
				OPTIONAL MATCH (d)-[managed:DECIDED_BY|COMPLETED_AS|SERVES_OBJECTIVE|GATED_BY|INFORMED_BY|USED|IGNORED]->()
				DELETE managed
				WITH DISTINCT d, item
				MERGE (t:Tedi {id: item.tediId, orgId: item.orgId})
				SET t.projectionEpoch =
						coalesce(item.projectionEpoch, t.projectionEpoch),
					t.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, t.projectionRepairEpoch)
				MERGE (d)-[decidedBy:DECIDED_BY]->(t)
				SET decidedBy.projectionEpoch =
						coalesce(item.projectionEpoch, decidedBy.projectionEpoch),
					decidedBy.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, decidedBy.projectionRepairEpoch)
				WITH d, item
				MERGE (o:Outcome {id: item.outcomeId, orgId: item.orgId})
				SET o.tediId = item.tediId,
					o.decisionId = item.id,
					o.status = item.outcomeStatus,
					o.completedAt = item.completedAt,
					o.updatedAt = datetime(),
					o.projectionEpoch =
						coalesce(item.projectionEpoch, o.projectionEpoch),
					o.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, o.projectionRepairEpoch)
				MERGE (d)-[completedAs:COMPLETED_AS]->(o)
				SET completedAs.projectionEpoch =
						coalesce(item.projectionEpoch, completedAs.projectionEpoch),
					completedAs.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, completedAs.projectionRepairEpoch)
				WITH d, item
				FOREACH (_ IN CASE WHEN item.objectiveId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (objective:Objective {
						id: item.objectiveId,
						orgId: item.orgId
					})
					SET objective.projectionEpoch =
							coalesce(item.projectionEpoch, objective.projectionEpoch),
						objective.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, objective.projectionRepairEpoch)
					MERGE (d)-[servesObjective:SERVES_OBJECTIVE]->(objective)
					SET servesObjective.projectionEpoch =
							coalesce(item.projectionEpoch, servesObjective.projectionEpoch),
						servesObjective.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, servesObjective.projectionRepairEpoch))
				FOREACH (_ IN CASE WHEN item.approvalRequestId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (approval:ApprovalRequest {
						id: item.approvalRequestId,
						orgId: item.orgId
					})
					SET approval.tediId = item.tediId,
						approval.projectionEpoch =
							coalesce(item.projectionEpoch, approval.projectionEpoch),
						approval.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, approval.projectionRepairEpoch)
					MERGE (d)-[gatedBy:GATED_BY]->(approval)
					SET gatedBy.projectionEpoch =
							coalesce(item.projectionEpoch, gatedBy.projectionEpoch),
						gatedBy.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, gatedBy.projectionRepairEpoch))
				WITH d, item
				CALL {
					WITH d, item
					UNWIND item.evidenceFactIds AS factId
					MATCH (f:Fact {id: factId, orgId: item.orgId})
					MERGE (d)-[informedBy:INFORMED_BY]->(f)
					SET informedBy.projectionEpoch =
							coalesce(item.projectionEpoch, informedBy.projectionEpoch),
						informedBy.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, informedBy.projectionRepairEpoch)
					RETURN count(*) AS informedCount
				}
				RETURN count(DISTINCT d) AS written
				`,
				{ decisions: items },
			);
			const written = toNumber(records[0]?.written);
			if (written !== decisions.length) {
				throw new Error(
					`Neo4j decision batch write failed: expected ${decisions.length}, wrote ${written}`,
				);
			}
			const verification = await runQuery(
				http,
				`
				UNWIND $decisions AS item
				MATCH (d:Decision {id: item.id, orgId: item.orgId})
				MATCH (d)-[decidedBy:DECIDED_BY]->(t:Tedi {
					id: item.tediId,
					orgId: item.orgId
				})
				MATCH (d)-[completedAs:COMPLETED_AS]->(o:Outcome {
					id: item.outcomeId,
					orgId: item.orgId
				})
				RETURN
					sum(CASE
						WHEN d:Episode
							AND o.decisionId = item.id
							AND o.tediId = item.tediId
							AND o.status = item.outcomeStatus
							AND (
								item.projectionEpoch IS NULL
								OR (
									d.projectionEpoch = item.projectionEpoch
									AND t.projectionEpoch = item.projectionEpoch
									AND o.projectionEpoch = item.projectionEpoch
									AND decidedBy.projectionEpoch = item.projectionEpoch
									AND completedAs.projectionEpoch = item.projectionEpoch
								)
							)
							AND (
								item.projectionRepairEpoch IS NULL
								OR (
									d.projectionRepairEpoch = item.projectionRepairEpoch
									AND t.projectionRepairEpoch = item.projectionRepairEpoch
									AND o.projectionRepairEpoch =
										item.projectionRepairEpoch
									AND decidedBy.projectionRepairEpoch =
										item.projectionRepairEpoch
									AND completedAs.projectionRepairEpoch =
										item.projectionRepairEpoch
								)
							)
							THEN 1
						ELSE 0
					END) AS verified
				`,
				{ decisions: items },
			);
			const verified = toNumber(verification[0]?.verified);
			if (verified !== decisions.length) {
				throw new Error(
					`Neo4j decision batch verification failed: expected ${decisions.length}, wrote ${written}, verified ${verified}`,
				);
			}
		},

		async upsertDecisions(decisions) {
			await writer.upsertDecisionContexts?.(decisions);
			await rebuildDecisionPredecessors(decisions);
		},

		rebuildDecisionPredecessors,

		async upsertDecision(decision) {
			const outcomeId = `${decision.id}:outcome`;

			await adoptUnownedLegacyNodes([
				{ label: "Decision", id: decision.id, orgId: decision.orgId },
				{ label: "Tedi", id: decision.tediId, orgId: decision.orgId },
				{ label: "Outcome", id: outcomeId, orgId: decision.orgId },
				{
					label: "Objective",
					id: decision.objectiveId,
					orgId: decision.orgId,
				},
				{
					label: "ApprovalRequest",
					id: decision.approvalRequestId,
					orgId: decision.orgId,
				},
			]);
			await runQuery(
				http,
				`
				MERGE (d:Decision {id: $id, orgId: $orgId})
				SET d:Episode,
					d.tediId = $tediId,
					d.action = $action,
					d.rationale = $rationale,
					d.category = $category,
					d.confidence = $confidence,
					d.outcomeStatus = $outcomeStatus,
					d.objectiveId = $objectiveId,
					d.approvalRequestId = $approvalRequestId,
					d.createdAt = $createdAt,
					d.completedAt = $completedAt,
					d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
					d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
				WITH d
				OPTIONAL MATCH (d)-[managed:DECIDED_BY|COMPLETED_AS|SERVES_OBJECTIVE|GATED_BY|INFORMED_BY|USED|IGNORED]->()
				DELETE managed
				WITH DISTINCT d
				// Link to tedi
				MERGE (t:Tedi {id: $tediId, orgId: $orgId})
				SET t.projectionEpoch = coalesce($projectionEpoch, t.projectionEpoch),
					t.projectionRepairEpoch = coalesce($projectionRepairEpoch, t.projectionRepairEpoch)
				MERGE (d)-[decidedBy:DECIDED_BY]->(t)
				SET decidedBy.projectionEpoch = coalesce($projectionEpoch, decidedBy.projectionEpoch),
					decidedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, decidedBy.projectionRepairEpoch)
				WITH d
				// Decision episodes always carry an outcome node, even while pending.
				MERGE (o:Outcome {id: $outcomeId, orgId: $orgId})
				SET o.tediId = $tediId,
					o.decisionId = $id,
					o.status = $outcomeStatus,
					o.completedAt = $completedAt,
					o.updatedAt = datetime(),
					o.projectionEpoch = coalesce($projectionEpoch, o.projectionEpoch),
					o.projectionRepairEpoch = coalesce($projectionRepairEpoch, o.projectionRepairEpoch)
				MERGE (d)-[completedAs:COMPLETED_AS]->(o)
				SET completedAs.projectionEpoch = coalesce($projectionEpoch, completedAs.projectionEpoch),
					completedAs.projectionRepairEpoch = coalesce($projectionRepairEpoch, completedAs.projectionRepairEpoch)
				WITH d
				// Link objective and approval context when present.
				FOREACH (_ IN CASE WHEN $objectiveId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (obj:Objective {id: $objectiveId, orgId: $orgId})
					SET obj.projectionEpoch = coalesce($projectionEpoch, obj.projectionEpoch),
						obj.projectionRepairEpoch = coalesce($projectionRepairEpoch, obj.projectionRepairEpoch)
					MERGE (d)-[servesObjective:SERVES_OBJECTIVE]->(obj)
					SET servesObjective.projectionEpoch = coalesce($projectionEpoch, servesObjective.projectionEpoch),
						servesObjective.projectionRepairEpoch = coalesce($projectionRepairEpoch, servesObjective.projectionRepairEpoch))
				FOREACH (_ IN CASE WHEN $approvalRequestId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (approval:ApprovalRequest {id: $approvalRequestId, orgId: $orgId})
					SET approval.tediId = $tediId,
						approval.projectionEpoch = coalesce($projectionEpoch, approval.projectionEpoch),
						approval.projectionRepairEpoch = coalesce($projectionRepairEpoch, approval.projectionRepairEpoch)
					MERGE (d)-[gatedBy:GATED_BY]->(approval)
					SET gatedBy.projectionEpoch = coalesce($projectionEpoch, gatedBy.projectionEpoch),
						gatedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, gatedBy.projectionRepairEpoch))
				// Parse evidence and link to facts
				WITH d
				CALL {
					WITH d
					UNWIND $evidenceFactIds AS factId
					MATCH (f:Fact {id: factId, orgId: $orgId})
					MERGE (d)-[informedBy:INFORMED_BY]->(f)
					SET informedBy.projectionEpoch = coalesce($projectionEpoch, informedBy.projectionEpoch),
						informedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, informedBy.projectionRepairEpoch)
					RETURN count(*) AS informedCount
				}
				RETURN d.id AS decisionId
				`,
				{
					id: decision.id,
					tediId: decision.tediId,
					orgId: decision.orgId,
					action: decision.action,
					rationale: decision.rationale,
					category: decision.category,
					confidence: decision.confidence,
					outcomeStatus: decision.outcomeStatus,
					objectiveId: decision.objectiveId ?? null,
					approvalRequestId: decision.approvalRequestId ?? null,
					createdAt: decision.createdAt,
					completedAt: decision.completedAt,
					outcomeId,
					evidenceFactIds: parseEvidenceFactIds(decision.evidence),
					projectionEpoch: decision.projectionEpoch ?? null,
					projectionRepairEpoch: decision.projectionRepairEpoch ?? null,
				},
			);

			// Link to preceding decision (same tedi + category)
			await runQuery(
				http,
				`
				MATCH (d:Decision {id: $id, orgId: $orgId})
				OPTIONAL MATCH (d)-[managed:PRECEDED_BY]->()
				DELETE managed
				WITH DISTINCT d
				OPTIONAL MATCH (prev:Decision {tediId: $tediId, category: $category, orgId: $orgId})
				WHERE prev.id <> $id AND prev.createdAt < $createdAt
				WITH d, prev ORDER BY prev.createdAt DESC LIMIT 1
				FOREACH (_ IN CASE WHEN prev IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d)-[precededBy:PRECEDED_BY]->(prev)
					SET precededBy.projectionEpoch = coalesce($projectionEpoch, precededBy.projectionEpoch),
						precededBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, precededBy.projectionRepairEpoch))
				`,
				{
					id: decision.id,
					orgId: decision.orgId,
					tediId: decision.tediId,
					category: decision.category,
					createdAt: decision.createdAt,
					projectionEpoch: decision.projectionEpoch ?? null,
					projectionRepairEpoch: decision.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertKnowledgeEntry(entry) {
			await adoptUnownedLegacyNodes([
				{
					label: "KnowledgeEntry",
					id: entry.id,
					orgId: entry.orgId,
				},
				{ label: "Domain", id: entry.domainId, orgId: entry.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (ke:KnowledgeEntry {id: $id, orgId: $orgId})
				SET ke.tediId = $tediId,
					ke.domainId = $domainId,
					ke.title = $title,
					ke.entryType = $entryType,
					ke.confidence = $confidence,
					ke.revision = $revision,
					ke.projectionEpoch = coalesce($projectionEpoch, ke.projectionEpoch),
					ke.projectionRepairEpoch = coalesce($projectionRepairEpoch, ke.projectionRepairEpoch)
				WITH ke
				OPTIONAL MATCH (ke)-[managed:SYNTHESIZED_FROM|IN_DOMAIN]->()
				DELETE managed
				WITH DISTINCT ke
				// Link to source facts
				CALL {
					WITH ke
					UNWIND $sourceFactIds AS factId
					MATCH (f:Fact {id: factId, orgId: $orgId})
					MERGE (ke)-[synthesizedFrom:SYNTHESIZED_FROM]->(f)
					SET synthesizedFrom.projectionEpoch = coalesce($projectionEpoch, synthesizedFrom.projectionEpoch),
						synthesizedFrom.projectionRepairEpoch = coalesce($projectionRepairEpoch, synthesizedFrom.projectionRepairEpoch)
					RETURN count(*) AS sourceCount
				}
				// Link to domain
				FOREACH (_ IN CASE WHEN $domainId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:Domain {id: $domainId, orgId: $orgId})
					SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (ke)-[inDomain:IN_DOMAIN]->(d)
					SET inDomain.projectionEpoch = coalesce($projectionEpoch, inDomain.projectionEpoch),
						inDomain.projectionRepairEpoch = coalesce($projectionRepairEpoch, inDomain.projectionRepairEpoch))
				`,
				{
					id: entry.id,
					orgId: entry.orgId,
					tediId: entry.tediId,
					domainId: entry.domainId,
					title: entry.title,
					entryType: entry.entryType,
					confidence: entry.confidence,
					revision: entry.revision ?? 0,
					sourceFactIds: entry.sourceFactIds ?? [],
					projectionEpoch: entry.projectionEpoch ?? null,
					projectionRepairEpoch: entry.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertSkill(skill) {
			await adoptUnownedLegacyNodes([
				{ label: "Skill", id: skill.id, orgId: skill.orgId },
				{ label: "Domain", id: skill.domainId, orgId: skill.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (s:Skill {id: $id, orgId: $orgId})
				SET s.tediId = $tediId,
					s.domainId = $domainId,
					s.title = $title,
					s.slug = $slug,
					s.successCount = $successCount,
					s.failureCount = $failureCount,
					s.revision = $revision,
					s.projectionEpoch = coalesce($projectionEpoch, s.projectionEpoch),
					s.projectionRepairEpoch = coalesce($projectionRepairEpoch, s.projectionRepairEpoch)
				WITH s
				OPTIONAL MATCH (s)-[managed:OPERATES_IN]->()
				DELETE managed
				WITH DISTINCT s
				FOREACH (_ IN CASE WHEN $domainId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:Domain {id: $domainId, orgId: $orgId})
					SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (s)-[operatesIn:OPERATES_IN]->(d)
					SET operatesIn.projectionEpoch = coalesce($projectionEpoch, operatesIn.projectionEpoch),
						operatesIn.projectionRepairEpoch = coalesce($projectionRepairEpoch, operatesIn.projectionRepairEpoch))
				`,
				{
					id: skill.id,
					orgId: skill.orgId,
					tediId: skill.tediId,
					domainId: skill.domainId,
					title: skill.title,
					slug: skill.slug ?? null,
					successCount: skill.successCount ?? 0,
					failureCount: skill.failureCount ?? 0,
					revision: skill.revision,
					projectionEpoch: skill.projectionEpoch ?? null,
					projectionRepairEpoch: skill.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertCapability(capability) {
			await adoptUnownedLegacyNodes([
				{
					label: "Capability",
					id: capability.id,
					orgId: capability.orgId,
				},
				{
					label: "Capability",
					id: capability.parentId,
					orgId: capability.orgId,
				},
			]);
			await runQuery(
				http,
				`
				MERGE (c:Capability {id: $id, orgId: $orgId})
				SET c.name = $name,
					c.slug = $slug,
					c.parentId = $parentId,
					c.valueStream = $valueStream,
					c.paceLayer = $paceLayer,
					c.maturityScore = $maturityScore,
					c.status = $status,
					c.projectionEpoch = coalesce($projectionEpoch, c.projectionEpoch),
					c.projectionRepairEpoch = coalesce($projectionRepairEpoch, c.projectionRepairEpoch)
				WITH c
				OPTIONAL MATCH ()-[managed:PARENT_OF]->(c)
				DELETE managed
				WITH DISTINCT c
				FOREACH (_ IN CASE WHEN $parentId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (parent:Capability {id: $parentId, orgId: $orgId})
					SET parent.projectionEpoch = coalesce($projectionEpoch, parent.projectionEpoch),
						parent.projectionRepairEpoch = coalesce($projectionRepairEpoch, parent.projectionRepairEpoch)
					MERGE (parent)-[parentOf:PARENT_OF]->(c)
					SET parentOf.projectionEpoch = coalesce($projectionEpoch, parentOf.projectionEpoch),
						parentOf.projectionRepairEpoch = coalesce($projectionRepairEpoch, parentOf.projectionRepairEpoch))
				`,
				{
					id: capability.id,
					orgId: capability.orgId,
					name: capability.name,
					slug: capability.slug,
					parentId: capability.parentId,
					valueStream: capability.valueStream,
					paceLayer: capability.paceLayer,
					maturityScore: capability.maturityScore,
					status: capability.status,
					projectionEpoch: capability.projectionEpoch ?? null,
					projectionRepairEpoch: capability.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertCapabilityLink(link) {
			const label = capabilityLinkLabel(link.entityKind);
			await adoptUnownedLegacyNodes([
				{
					label: "Capability",
					id: link.capabilityId,
					orgId: link.orgId,
				},
				{ label, id: link.entityId, orgId: link.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (c:Capability {id: $capabilityId, orgId: $orgId})
				SET c.projectionEpoch = coalesce($projectionEpoch, c.projectionEpoch),
					c.projectionRepairEpoch = coalesce($projectionRepairEpoch, c.projectionRepairEpoch)
				MERGE (e:${label} {id: $entityId, orgId: $orgId})
				SET e.projectionEpoch = coalesce($projectionEpoch, e.projectionEpoch),
					e.projectionRepairEpoch = coalesce($projectionRepairEpoch, e.projectionRepairEpoch)
				MERGE (e)-[r:SUPPORTS]->(c)
				SET r.orgId = $orgId,
					r.updatedAt = datetime(),
					r.projectionEpoch = coalesce($projectionEpoch, r.projectionEpoch),
					r.projectionRepairEpoch = coalesce($projectionRepairEpoch, r.projectionRepairEpoch)
				`,
				{
					capabilityId: link.capabilityId,
					entityId: link.entityId,
					orgId: link.orgId,
					projectionEpoch: link.projectionEpoch ?? null,
					projectionRepairEpoch: link.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertEntity(entity: GraphEntity) {
			await runQuery(
				http,
				`
				MERGE (e:Entity {id: $id, orgId: $orgId})
				SET e.entityType = $entityType,
					e.displayName = $displayName,
					e.normalizedName = $normalizedName,
					e.status = $status,
					e.mergedIntoEntityId = $mergedIntoEntityId,
					e.version = $version,
					e.updatedAt = $updatedAt,
					e.projectionEpoch = coalesce($projectionEpoch, e.projectionEpoch),
					e.projectionRepairEpoch = coalesce($projectionRepairEpoch, e.projectionRepairEpoch)
				WITH e
				OPTIONAL MATCH (e)-[managed:MERGED_INTO]->()
				DELETE managed
				WITH DISTINCT e
				FOREACH (_ IN CASE WHEN $mergedIntoEntityId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (target:Entity {id: $mergedIntoEntityId, orgId: $orgId})
					SET target.projectionEpoch = coalesce($projectionEpoch, target.projectionEpoch),
						target.projectionRepairEpoch = coalesce($projectionRepairEpoch, target.projectionRepairEpoch)
					MERGE (e)-[mergedInto:MERGED_INTO]->(target)
					SET mergedInto.projectionEpoch = coalesce($projectionEpoch, mergedInto.projectionEpoch),
						mergedInto.projectionRepairEpoch = coalesce($projectionRepairEpoch, mergedInto.projectionRepairEpoch))
				`,
				{
					id: entity.id,
					orgId: entity.orgId,
					entityType: entity.entityType,
					displayName: entity.displayName,
					normalizedName: entity.normalizedName,
					status: entity.status,
					mergedIntoEntityId: entity.mergedIntoEntityId,
					version: entity.version,
					updatedAt: entity.updatedAt,
					projectionEpoch: entity.projectionEpoch ?? null,
					projectionRepairEpoch: entity.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertEntityResolution(resolution: GraphEntityResolution) {
			await runQuery(
				http,
				`
				MERGE (r:EntityResolution {id: $id, orgId: $orgId})
				SET r.mentionId = $mentionId,
					r.factId = $factId,
					r.entityId = $entityId,
					r.decisionId = $decisionId,
					r.confidence = $confidence,
					r.validFrom = $validFrom,
					r.validTo = $validTo,
					r.status = $status,
					r.projectionEpoch = coalesce($projectionEpoch, r.projectionEpoch),
					r.projectionRepairEpoch = coalesce($projectionRepairEpoch, r.projectionRepairEpoch)
				WITH r
				OPTIONAL MATCH (r)-[managed:RESOLVES_TO|SUPPORTED_BY|DECIDED_IN]->()
				DELETE managed
				WITH DISTINCT r
				MATCH (e:Entity {id: $entityId, orgId: $orgId})
				SET e.projectionEpoch = coalesce($projectionEpoch, e.projectionEpoch),
					e.projectionRepairEpoch = coalesce($projectionRepairEpoch, e.projectionRepairEpoch)
				MERGE (r)-[resolvesTo:RESOLVES_TO]->(e)
				SET resolvesTo.projectionEpoch = coalesce($projectionEpoch, resolvesTo.projectionEpoch),
					resolvesTo.projectionRepairEpoch = coalesce($projectionRepairEpoch, resolvesTo.projectionRepairEpoch)
				WITH r
				FOREACH (_ IN CASE WHEN $factId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (f:Fact {id: $factId, orgId: $orgId})
					SET f.projectionEpoch = coalesce($projectionEpoch, f.projectionEpoch),
						f.projectionRepairEpoch = coalesce($projectionRepairEpoch, f.projectionRepairEpoch)
					MERGE (r)-[supportedBy:SUPPORTED_BY]->(f)
					SET supportedBy.projectionEpoch = coalesce($projectionEpoch, supportedBy.projectionEpoch),
						supportedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, supportedBy.projectionRepairEpoch))
				FOREACH (_ IN CASE WHEN $decisionId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:EntityResolutionDecision {id: $decisionId, orgId: $orgId})
					SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (r)-[decidedIn:DECIDED_IN]->(d)
					SET decidedIn.projectionEpoch = coalesce($projectionEpoch, decidedIn.projectionEpoch),
						decidedIn.projectionRepairEpoch = coalesce($projectionRepairEpoch, decidedIn.projectionRepairEpoch))
				`,
				{
					id: resolution.id,
					orgId: resolution.orgId,
					mentionId: resolution.mentionId,
					factId: resolution.factId,
					entityId: resolution.entityId,
					decisionId: resolution.decisionId,
					confidence: resolution.confidence,
					validFrom: resolution.validFrom,
					validTo: resolution.validTo,
					status: resolution.status,
					projectionEpoch: resolution.projectionEpoch ?? null,
					projectionRepairEpoch: resolution.projectionRepairEpoch ?? null,
				},
			);
		},

		async deleteCapability(id, orgId) {
			await runQuery(
				http,
				"MATCH (c:Capability {id: $id, orgId: $orgId}) DETACH DELETE c",
				{ id, orgId },
			);
		},

		async deleteCapabilityLink(link) {
			const label = capabilityLinkLabel(link.entityKind);
			await runQuery(
				http,
				`
				MATCH (e:${label} {id: $entityId, orgId: $orgId})-[r:SUPPORTS]->(c:Capability {id: $capabilityId, orgId: $orgId})
				DELETE r
				`,
				{
					capabilityId: link.capabilityId,
					entityId: link.entityId,
					orgId: link.orgId,
				},
			);
		},

		async deleteFact(id, orgId) {
			await runQuery(
				http,
				"MATCH (f:Fact {id: $id, orgId: $orgId}) DETACH DELETE f",
				{ id, orgId },
			);
		},

		async deleteEdge(sourceFactId, targetFactId, relationType, orgId) {
			const relType = factRelationshipType(relationType);
			await runQuery(
				http,
				`
				MATCH (a:Fact {id: $sourceFactId, orgId: $orgId})-[r:${relType}]->(b:Fact {id: $targetFactId, orgId: $orgId})
				DELETE r
				`,
				{ sourceFactId, targetFactId, orgId },
			);
		},

		async deleteDomain(id, orgId) {
			await runQuery(
				http,
				"MATCH (d:Domain {id: $id, orgId: $orgId}) DETACH DELETE d",
				{ id, orgId },
			);
		},

		async deleteTedi(id, orgId) {
			await runQuery(
				http,
				"MATCH (t:Tedi {id: $id, orgId: $orgId}) DETACH DELETE t",
				{ id, orgId },
			);
		},

		async deleteDecision(id, orgId) {
			await runQuery(
				http,
				"MATCH (d:Decision {id: $id, orgId: $orgId}) DETACH DELETE d",
				{ id, orgId },
			);
		},

		async deleteKnowledgeEntry(id, orgId) {
			await runQuery(
				http,
				"MATCH (ke:KnowledgeEntry {id: $id, orgId: $orgId}) DETACH DELETE ke",
				{ id, orgId },
			);
		},

		async deleteSkill(id, orgId) {
			await runQuery(
				http,
				"MATCH (s:Skill {id: $id, orgId: $orgId}) DETACH DELETE s",
				{ id, orgId },
			);
		},

		async upsertProject(project) {
			await adoptUnownedLegacyNodes([
				{ label: "Project", id: project.id, orgId: project.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (p:Project {id: $id, orgId: $orgId})
				SET p.key = $key,
					p.name = $name,
					p.status = $status,
					p.leadTediId = $leadTediId,
					p.objectiveId = $objectiveId,
					p.projectionEpoch = coalesce($projectionEpoch, p.projectionEpoch),
					p.projectionRepairEpoch = coalesce($projectionRepairEpoch, p.projectionRepairEpoch)
				WITH p
				OPTIONAL MATCH (p)-[managed:PURSUES]->()
				DELETE managed
				WITH DISTINCT p
				FOREACH (_ IN CASE WHEN $objectiveId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (o:Objective {id: $objectiveId, orgId: $orgId})
					MERGE (p)-[pursues:PURSUES]->(o)
					SET pursues.projectionEpoch = coalesce($projectionEpoch, pursues.projectionEpoch),
						pursues.projectionRepairEpoch = coalesce($projectionRepairEpoch, pursues.projectionRepairEpoch))
				`,
				{
					id: project.id,
					orgId: project.orgId,
					key: project.key,
					name: project.name,
					status: project.status,
					leadTediId: project.leadTediId ?? null,
					objectiveId: project.objectiveId ?? null,
					projectionEpoch: project.projectionEpoch ?? null,
					projectionRepairEpoch: project.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertWorkItem(item) {
			await adoptUnownedLegacyNodes([
				{ label: "WorkItem", id: item.id, orgId: item.orgId },
				{ label: "Tedi", id: item.assigneeTediId, orgId: item.orgId },
			]);
			// IN_PROJECT / CHILD_OF / ASSIGNED_TO are managed edges: deleted and
			// rebuilt each upsert so a re-parent or re-assign never leaves the old
			// edge behind. Same discipline as OPERATES_IN on Skill.
			await runQuery(
				http,
				`
				MERGE (w:WorkItem {id: $id, orgId: $orgId})
				SET w.title = $title,
					w.workKind = $workKind,
					w.disposition = $disposition,
					w.priority = $priority,
					w.projectId = $projectId,
					w.assigneeTediId = $assigneeTediId,
					w.objectiveId = $objectiveId,
					w.projectionEpoch = coalesce($projectionEpoch, w.projectionEpoch),
					w.projectionRepairEpoch = coalesce($projectionRepairEpoch, w.projectionRepairEpoch)
				WITH w
				OPTIONAL MATCH (w)-[managed:IN_PROJECT|CHILD_OF|ASSIGNED_TO]->()
				DELETE managed
				WITH DISTINCT w
				FOREACH (_ IN CASE WHEN $projectId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (p:Project {id: $projectId, orgId: $orgId})
					MERGE (w)-[inProject:IN_PROJECT]->(p)
					SET inProject.projectionEpoch = coalesce($projectionEpoch, inProject.projectionEpoch),
						inProject.projectionRepairEpoch = coalesce($projectionRepairEpoch, inProject.projectionRepairEpoch))
				WITH DISTINCT w
				FOREACH (_ IN CASE WHEN $parentWorkItemId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (parent:WorkItem {id: $parentWorkItemId, orgId: $orgId})
					MERGE (w)-[childOf:CHILD_OF]->(parent)
					SET childOf.projectionEpoch = coalesce($projectionEpoch, childOf.projectionEpoch),
						childOf.projectionRepairEpoch = coalesce($projectionRepairEpoch, childOf.projectionRepairEpoch))
				WITH DISTINCT w
				FOREACH (_ IN CASE WHEN $assigneeTediId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (t:Tedi {id: $assigneeTediId, orgId: $orgId})
					MERGE (w)-[assigned:ASSIGNED_TO]->(t)
					SET assigned.projectionEpoch = coalesce($projectionEpoch, assigned.projectionEpoch),
						assigned.projectionRepairEpoch = coalesce($projectionRepairEpoch, assigned.projectionRepairEpoch))
				`,
				{
					id: item.id,
					orgId: item.orgId,
					title: item.title,
					workKind: item.workKind,
					disposition: item.disposition,
					priority: item.priority,
					projectId: item.projectId ?? null,
					parentWorkItemId: item.parentWorkItemId ?? null,
					assigneeTediId: item.assigneeTediId ?? null,
					objectiveId: item.objectiveId ?? null,
					projectionEpoch: item.projectionEpoch ?? null,
					projectionRepairEpoch: item.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertWorkItemSource(source) {
			await adoptUnownedLegacyNodes([
				{ label: "WorkItemSource", id: source.id, orgId: source.orgId },
			]);
			// SOURCE_FOR points at whichever owner the row carries; both may be set,
			// which is a real relationship (the same page attached to a project and
			// to one specific item), not a duplicate.
			await runQuery(
				http,
				`
				MERGE (s:WorkItemSource {id: $id, orgId: $orgId})
				SET s.provider = $provider,
					s.externalId = $externalId,
					s.kind = $kind,
					s.state = $state,
					s.title = $title,
					s.externalUrl = $externalUrl,
					s.projectionEpoch = coalesce($projectionEpoch, s.projectionEpoch),
					s.projectionRepairEpoch = coalesce($projectionRepairEpoch, s.projectionRepairEpoch)
				WITH s
				OPTIONAL MATCH (s)-[managed:SOURCE_FOR]->()
				DELETE managed
				WITH DISTINCT s
				FOREACH (_ IN CASE WHEN $projectId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (p:Project {id: $projectId, orgId: $orgId})
					MERGE (s)-[sourceForProject:SOURCE_FOR]->(p)
					SET sourceForProject.projectionEpoch = coalesce($projectionEpoch, sourceForProject.projectionEpoch),
						sourceForProject.projectionRepairEpoch = coalesce($projectionRepairEpoch, sourceForProject.projectionRepairEpoch))
				WITH DISTINCT s
				FOREACH (_ IN CASE WHEN $workItemId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (w:WorkItem {id: $workItemId, orgId: $orgId})
					MERGE (s)-[sourceForItem:SOURCE_FOR]->(w)
					SET sourceForItem.projectionEpoch = coalesce($projectionEpoch, sourceForItem.projectionEpoch),
						sourceForItem.projectionRepairEpoch = coalesce($projectionRepairEpoch, sourceForItem.projectionRepairEpoch))
				`,
				{
					id: source.id,
					orgId: source.orgId,
					provider: source.provider,
					externalId: source.externalId,
					kind: source.kind,
					state: source.state,
					title: source.title ?? null,
					externalUrl: source.externalUrl ?? null,
					projectId: source.projectId ?? null,
					workItemId: source.workItemId ?? null,
					projectionEpoch: source.projectionEpoch ?? null,
					projectionRepairEpoch: source.projectionRepairEpoch ?? null,
				},
			);
		},

		async deleteProject(id, orgId) {
			await runQuery(
				http,
				"MATCH (p:Project {id: $id, orgId: $orgId}) DETACH DELETE p",
				{ id, orgId },
			);
		},

		async deleteWorkItem(id, orgId) {
			await runQuery(
				http,
				"MATCH (w:WorkItem {id: $id, orgId: $orgId}) DETACH DELETE w",
				{ id, orgId },
			);
		},

		async deleteWorkItemSource(id, orgId) {
			await runQuery(
				http,
				"MATCH (s:WorkItemSource {id: $id, orgId: $orgId}) DETACH DELETE s",
				{ id, orgId },
			);
		},

		async deleteEntity(id, orgId) {
			await runQuery(
				http,
				"MATCH (e:Entity {id: $id, orgId: $orgId}) DETACH DELETE e",
				{ id, orgId },
			);
		},

		async revokeEntityResolution(id, orgId, validTo) {
			await runQuery(
				http,
				`
				MATCH (r:EntityResolution {id: $id, orgId: $orgId})
				SET r.status = 'revoked',
					r.validTo = $validTo,
					r.revokedAt = $validTo
				`,
				{ id, orgId, validTo },
			);
		},

		async upsertTediExpertise(
			tediId,
			domainId,
			level,
			avgConfidence,
			orgId,
			projectionRepairEpoch,
			projectionEpoch,
		) {
			await adoptUnownedLegacyNodes([
				{ label: "Tedi", id: tediId, orgId },
				{ label: "Domain", id: domainId, orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (t:Tedi {id: $tediId, orgId: $orgId})
				SET t.projectionEpoch = coalesce($projectionEpoch, t.projectionEpoch),
					t.projectionRepairEpoch = coalesce($projectionRepairEpoch, t.projectionRepairEpoch)
				MERGE (d:Domain {id: $domainId, orgId: $orgId})
				SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
					d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
				MERGE (t)-[e:EXPERT_IN]->(d)
				SET e.orgId = $orgId,
					e.level = $level,
					e.avgConfidence = $avgConfidence,
					e.updatedAt = datetime(),
					e.projectionEpoch = coalesce($projectionEpoch, e.projectionEpoch),
					e.projectionRepairEpoch = coalesce($projectionRepairEpoch, e.projectionRepairEpoch)
				`,
				{
					tediId,
					domainId,
					level,
					avgConfidence,
					orgId,
					projectionEpoch: projectionEpoch ?? null,
					projectionRepairEpoch: projectionRepairEpoch ?? null,
				},
			);
		},

		async deleteTediExpertise(tediId, domainId, orgId) {
			await runQuery(
				http,
				`
				MATCH (t:Tedi {id: $tediId, orgId: $orgId})-[e:EXPERT_IN]->(d:Domain {id: $domainId, orgId: $orgId})
				DELETE e
				`,
				{ tediId, domainId, orgId },
			);
		},
	};

	return { client, writer };
}

/** The Neo4j read client; the only graph read implementation. */
export type GraphClient = ReturnType<typeof createNeo4jGraphClient>["client"];

// ============================================================================
// Parameterized HTTP transport for API callers
// ============================================================================

/**
 * Run parameterized Cypher via the HTTP Query API.
 * Used by the API router for visualization/traversal queries.
 */
export async function runCypherWithParams(
	config: GraphDbConfig,
	cypher: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	const http = createHttpClient(config);
	return runQuery(http, cypher, params);
}

// ============================================================================
// Helpers
// ============================================================================

/** Safely convert values to JS number. */
function toNumber(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "number") return value;
	return Number(value) || 0;
}

/**
 * Parse evidence JSON string to extract fact IDs.
 * Evidence format varies — could be JSON object or stringified array.
 */
function parseEvidenceFactIds(evidence: string): string[] {
	try {
		const parsed = JSON.parse(evidence);
		if (Array.isArray(parsed))
			return parsed.filter((x) => typeof x === "string");
		if (typeof parsed === "object" && parsed !== null) {
			if (Array.isArray(parsed.factIds)) return parsed.factIds;
			if (Array.isArray(parsed.facts))
				return parsed.facts.map((f: { id?: string }) => f.id).filter(Boolean);
			if (Array.isArray(parsed.retrievedFacts)) {
				return parsed.retrievedFacts
					.map((f: { id?: string; factId?: string }) => f.id ?? f.factId)
					.filter(Boolean);
			}
		}
		return [];
	} catch {
		return [];
	}
}
