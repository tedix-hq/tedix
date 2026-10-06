import {
	AUTHZ,
	ErrorCodes,
	createError,
	skipOutputValidation,
} from "../../orpc";
import {
	acquireGraphProjectionLease,
	getGraphProjectionBacklogStats,
	getGraphProjectionHighWater,
	getGraphProjectionReadState,
	releaseGraphProjectionLease,
	renewGraphProjectionLease,
	setGraphProjectionReadiness,
} from "@tedix/db/queries/graph-projection";
import {
	createCuriosityItem,
	getNextCuriosityItem,
	listCuriosityQueue,
	updateCuriosityStatus,
} from "@tedix/db/queries/memory-graph/curiosity";
import {
	createGraphWriter,
	getGraphClient,
} from "../../../integrations/graph-db/client";
import {
	createOptimizationSignal,
	getOptimizationBacklog,
	listOptimizationSignals,
	updateSignalStatus,
} from "@tedix/db/queries/memory-graph/optimization-signals";
import { getGapStats } from "@tedix/db/queries/memory-graph/gaps";
import { listDomains } from "@tedix/db/queries/memory-graph/domains";
import { requestGraphProjectionMaintenanceCancel } from "@tedix/db/queries/graph-projection-maintenance";
import { requireOrgId } from "../../org-scope";
import { searchFacts } from "@tedix/db/queries/memory-graph/fact-search";
import {
	assemble,
	audit,
	expertise,
	listDomainsProcedure,
	search,
	stats,
} from "./retrieval-learning";
import {
	gapsDetect,
	gapsList,
	gapsReport,
	gapsResolve,
	graphPath,
	graphSimilar,
	graphVisualization,
	health,
} from "./review-reasoning";
import {
	GraphGdsTask,
	authed,
	degradedGraphMeta,
	getCanonicalGraphFacts,
	getGraphReadState,
	graphGdsTaskForOrg,
	loadGraphProjectionCertification,
	loadGraphProjectionDrain,
	loadGraphProjectionEntities,
	loadGraphProjectionSchema,
	requireGraphMaintenanceAuthority,
	resolveSyncOrgId,
	runGraphQuery,
	startGraphGdsTask,
	toCuriosityStatus,
	toNumber,
	toOptimizationSignalStatus,
	validateGraphGdsMaintenanceRequest,
} from "./policy-operations";

export const graphCommunities = authed.graph.communities
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { graphClient, meta } = await getGraphReadState(context, {
			requiresGds: true,
		});
		if (meta.degraded || !graphClient)
			return {
				communities: [],
				meta,
			};
		try {
			const communities = await graphClient.getCommunities(orgId, {
				domainId: input.domainId,
				minSize: input.minSize,
			});
			const canonical = await getCanonicalGraphFacts(
				context,
				orgId,
				communities.flatMap((community) => community.factIds),
			);
			const allowed = new Set(canonical.map((fact) => fact.id));
			return {
				communities: communities
					.map((community) => {
						const factIds = community.factIds.filter((id) => allowed.has(id));
						return {
							...community,
							factIds,
							size: factIds.length,
						};
					})
					.filter((community) => community.size >= (input.minSize ?? 2)),
				meta,
			};
		} catch (e) {
			console.warn("[GraphDB] getCommunities handler failed:", e);
			return {
				communities: [],
				meta: degradedGraphMeta(meta),
			};
		}
	});

export const graphInfluence = authed.graph.influence
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { graphClient, meta } = await getGraphReadState(context, {
			requiresGds: true,
		});
		if (meta.degraded || !graphClient)
			return {
				scores: [],
				meta,
			};
		try {
			const scores = await graphClient.getInfluenceScores(orgId, {
				domainId: input.domainId,
				topK: input.topK,
			});
			const canonical = await getCanonicalGraphFacts(
				context,
				orgId,
				scores.map((score) => score.factId),
			);
			const allowed = new Set(canonical.map((fact) => fact.id));
			return {
				scores: scores.filter((score) => allowed.has(score.factId)),
				meta,
			};
		} catch (e) {
			console.warn("[GraphDB] getInfluenceScores handler failed:", e);
			return {
				scores: [],
				meta: degradedGraphMeta(meta),
			};
		}
	});

export const graphTraverse = authed.graph.traverse
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { graphClient, meta } = await getGraphReadState(context);
		if (meta.degraded || !graphClient) {
			return {
				facts: [],
				edges: [],
				meta,
			};
		}
		try {
			const result = await graphClient.traverse(
				input.startFactId,
				orgId,
				input.maxDepth,
				input.maxNodes,
			);
			const canonical = await getCanonicalGraphFacts(context, orgId, [
				...result.facts.keys(),
			]);
			const facts = canonical.map((fact) => ({
				factId: fact.id,
				content: fact.content,
				summary: fact.summary,
				factType: fact.factType,
				confidence: fact.confidence,
				depth: result.facts.get(fact.id)?.depth ?? 0,
			}));
			const allowed = new Set(facts.map((fact) => fact.factId));
			return {
				facts,
				edges: result.edges.filter(
					(edge) =>
						allowed.has(edge.sourceFactId) && allowed.has(edge.targetFactId),
				),
				meta,
			};
		} catch (e) {
			console.warn("[GraphDB] traverse handler failed:", e);
			return {
				facts: [],
				edges: [],
				meta: degradedGraphMeta(meta),
			};
		}
	});

export const graphEdges = authed.graph.edges
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { graphClient, meta } = await getGraphReadState(context);
		if (meta.degraded || !graphClient)
			return {
				edges: [],
				meta,
			};
		try {
			const edges = await graphClient.getEdges(input.factId, orgId, {
				relationType: input.relationType,
				direction: input.direction,
			});
			const canonical = await getCanonicalGraphFacts(
				context,
				orgId,
				edges.flatMap((edge) => [edge.sourceFactId, edge.targetFactId]),
			);
			const allowed = new Set(canonical.map((fact) => fact.id));
			return {
				edges: edges.filter(
					(edge) =>
						allowed.has(edge.sourceFactId) && allowed.has(edge.targetFactId),
				),
				meta,
			};
		} catch (e) {
			console.warn("[GraphDB] getEdges handler failed:", e);
			return {
				edges: [],
				meta: degradedGraphMeta(meta),
			};
		}
	});

export const graphCausalChain = authed.graph.causalChain
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { graphClient, meta } = await getGraphReadState(context);
		if (meta.degraded || !graphClient) {
			return {
				decisionId: input.decisionId,
				nodes: [],
				edges: [],
				meta,
			};
		}
		try {
			const chain = await graphClient.getCausalChain(
				input.decisionId,
				orgId,
				input.maxDepth,
			);
			const factNodeIds = chain.nodes
				.filter((node) => node.type === "fact")
				.map((node) => node.id);
			const canonical = await getCanonicalGraphFacts(
				context,
				orgId,
				factNodeIds,
			);
			const allowedFacts = new Set(canonical.map((fact) => fact.id));
			const nodes = chain.nodes.filter(
				(node) => node.type !== "fact" || allowedFacts.has(node.id),
			);
			const allowedNodes = new Set(nodes.map((node) => node.id));
			return {
				...chain,
				nodes,
				edges: chain.edges.filter(
					(edge) =>
						allowedNodes.has(edge.source) && allowedNodes.has(edge.target),
				),
				meta,
			};
		} catch (e) {
			console.warn("[GraphDB] getCausalChain handler failed:", e);
			return {
				decisionId: input.decisionId,
				nodes: [],
				edges: [],
				meta: degradedGraphMeta(meta),
			};
		}
	});

export const graphSimilarDecisions = authed.graph.similarDecisions
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { graphClient, meta } = await getGraphReadState(context);
		if (meta.degraded || !graphClient)
			return {
				decisions: [],
				meta,
			};
		if (input.decisionId) {
			try {
				// Find decisions with shared evidence
				const { findDecisionsWithSharedEvidence } =
					await import("../../../integrations/graph-db/queries/decisions");
				const records = await runGraphQuery(
					context,
					findDecisionsWithSharedEvidence(input.decisionId, orgId, input.topK),
				);
				return {
					decisions: records.map((r) => ({
						decisionId: r.decisionId as string,
						action: r.action as string,
						rationale: r.rationale as string,
						outcomeStatus: r.outcomeStatus as string,
						confidence: toNumber(r.confidence),
						score: toNumber(r.sharedFacts) / 10,
					})),
					meta,
				};
			} catch (e) {
				console.warn(
					"[GraphDB] findDecisionsWithSharedEvidence handler failed:",
					e,
				);
				return {
					decisions: [],
					meta: degradedGraphMeta(meta),
				};
			}
		}

		// General precedent search
		try {
			const decisions = await graphClient.findSimilarDecisions("", orgId, {
				category: input.category,
				tediId: input.tediId,
				topK: input.topK,
			});
			return {
				decisions,
				meta,
			};
		} catch (e) {
			console.warn("[GraphDB] findSimilarDecisions handler failed:", e);
			return {
				decisions: [],
				meta: degradedGraphMeta(meta),
			};
		}
	});

export const graphHealth = authed.graph.health
	.use(AUTHZ.tedisRead)
	.handler(async ({ context }) => {
		const orgId = requireOrgId(context);
		const { graphProjectionReadAdmission, inspectGraphProjection } =
			await loadGraphProjectionCertification();
		const inspection = await inspectGraphProjection({
			db: context.db,
			env: context.env,
			organizationId: orgId,
		});
		const admission = graphProjectionReadAdmission({
			inspection,
		});
		return {
			healthy: inspection.transportHealthy,
			configured: inspection.configured,
			passesGate: admission.allowed && inspection.parityPasses,
			checkedAt: inspection.checkedAt,
			projection: inspection.facts,
			edges: inspection.edges,
			lifecycle: inspection.lifecycle,
			managedCounts: inspection.managedCounts,
			schema: inspection.schema,
			readiness: inspection.readiness,
			backlog: inspection.backlog,
		};
	});

// =============================================================================
// GOVERNED BASELINE REPAIR + STRICT OUTBOX DRAIN
// =============================================================================

export const graphSync = authed.graph.sync
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		requireGraphMaintenanceAuthority(context);
		const orgId = resolveSyncOrgId(context, input.orgId);
		const env = context.env;
		const writer = createGraphWriter(env);
		const healthy =
			(await getGraphClient(env)
				?.isHealthy()
				.catch(() => false)) ?? false;
		if (!writer || !healthy) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				writer ? "Graph DB is not healthy" : "Graph DB is not configured",
			);
		}
		const {
			drainGraphProjectionOrganization,
			GRAPH_PROJECTION_REPAIR_CLEANUP_D1_QUERY_BUDGET,
			GraphProjectionRepairQueryBudgetError,
			planPostRepairGraphProjectionDrain,
			repairGraphProjectionCore,
		} = await loadGraphProjectionDrain();
		const { hydrateMemoryEntityProjectionEvent } =
			await loadGraphProjectionEntities();
		const {
			ensureGraphProjectionSchema,
			readGraphProjectionSchemaState,
			sweepGraphProjectionRepair,
		} = await loadGraphProjectionSchema();
		await ensureGraphProjectionSchema(env);
		const repairLeaseToken = crypto.randomUUID();
		const acquiredRepairLease = await acquireGraphProjectionLease(
			context.db,
			orgId,
			repairLeaseToken,
			5 * 60 * 1000,
		);
		if (!acquiredRepairLease) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Graph projection repair is already active for this organization",
			);
		}
		const baseline = await (async () => {
			try {
				// Read the generation and capture high-water only after fencing
				// ordinary drains. Everything acknowledged before this point is
				// included in the new baseline; later drains inherit the new epoch.
				const previous = await getGraphProjectionReadState(context.db, orgId);
				const startNewRepair =
					input.restart || !previous?.repairId || previous.repairPhase === null;
				const projectionEpoch = startNewRepair
					? crypto.randomUUID()
					: (previous?.projectionEpoch ?? crypto.randomUUID());
				const repairId = startNewRepair
					? crypto.randomUUID()
					: previous.repairId!;
				const startedAt = startNewRepair
					? new Date().toISOString()
					: (previous.repairStartedAt ?? new Date().toISOString());
				const highWaterSequence = startNewRepair
					? await getGraphProjectionHighWater(context.db, orgId)
					: (previous.repairHighWater ?? 0);
				const checkpoint = startNewRepair
					? {
							phase: "domains" as const,
							cursor: null,
						}
					: {
							phase: previous.repairPhase ?? ("domains" as const),
							cursor: previous.repairCursor,
						};
				await setGraphProjectionReadiness(context.db, {
					organizationId: orgId,
					state: "catching_up",
					reason: `baseline_repair:${repairId}`,
					projectionEpoch,
					gdsWatermark: startNewRepair ? 0 : undefined,
					gdsEpoch: startNewRepair ? null : undefined,
					repairId,
					repairPhase: checkpoint.phase,
					repairCursor: checkpoint.cursor,
					repairHighWater: highWaterSequence,
					repairStartedAt: startedAt,
				});
				let cleanupD1Queries = 0;
				const repair = await repairGraphProjectionCore({
					db: context.db,
					writer,
					organizationId: orgId,
					projectionEpoch,
					repairEpoch: repairId,
					checkpoint,
					pageSize: input.pageSize,
					maxPages: input.maxPages,
					beforePage: async (pageCheckpoint) => {
						if (pageCheckpoint.phase === "decision_predecessors") {
							const schema = await readGraphProjectionSchemaState(env);
							if (!schema.complete) {
								throw new Error(
									"Graph projection predecessor index is not online",
								);
							}
						}
						const renewed = await renewGraphProjectionLease(
							context.db,
							orgId,
							repairLeaseToken,
							5 * 60 * 1000,
						);
						if (!renewed) {
							throw new Error(
								"Graph projection repair lease was lost before page mutation",
							);
						}
					},
					sweepRepair: async (epoch) => {
						await sweepGraphProjectionRepair({
							env,
							organizationId: orgId,
							repairEpoch: epoch,
							projectionEpoch,
							beforeBatch: async () => {
								if (
									cleanupD1Queries >=
									GRAPH_PROJECTION_REPAIR_CLEANUP_D1_QUERY_BUDGET
								) {
									throw new GraphProjectionRepairQueryBudgetError(
										"Graph projection repair cleanup reached its D1 query budget",
									);
								}
								cleanupD1Queries++;
								const renewed = await renewGraphProjectionLease(
									context.db,
									orgId,
									repairLeaseToken,
									5 * 60 * 1000,
								);
								if (!renewed) {
									throw new Error(
										"Graph projection repair lease was lost during cleanup",
									);
								}
							},
						});
					},
					onCheckpoint: async (nextCheckpoint) => {
						const renewed = await renewGraphProjectionLease(
							context.db,
							orgId,
							repairLeaseToken,
							5 * 60 * 1000,
						);
						if (!renewed) {
							throw new Error(
								"Graph projection repair lease was lost before checkpoint",
							);
						}
						await setGraphProjectionReadiness(context.db, {
							organizationId: orgId,
							state: "catching_up",
							reason:
								nextCheckpoint.phase === "complete"
									? "baseline_complete_draining_outbox"
									: `baseline_repair:${repairId}`,
							projectionEpoch,
							repairId,
							repairPhase: nextCheckpoint.phase,
							repairCursor: nextCheckpoint.cursor,
							repairHighWater: highWaterSequence,
							repairStartedAt: startedAt,
						});
					},
				});
				return {
					repair,
					repairId,
					startedAt,
					highWaterSequence,
					projectionEpoch,
				};
			} finally {
				await releaseGraphProjectionLease(context.db, orgId, repairLeaseToken);
			}
		})();
		const { repair, repairId, startedAt, highWaterSequence, projectionEpoch } =
			baseline;
		let batches = 0;
		let processed = 0;
		let blocked: string | null = null;
		const drainPlan = planPostRepairGraphProjectionDrain({
			repairComplete: repair.checkpoint.phase === "complete",
			requestedBatches: input.drainBatches,
			requestedBatchSize: input.pageSize,
		});
		if (drainPlan.maxBatches > 0) {
			for (let attempt = 0; attempt < drainPlan.maxBatches; attempt++) {
				batches++;
				const result = await drainGraphProjectionOrganization({
					db: context.db,
					writer,
					organizationId: orgId,
					projectionEpoch,
					batchSize: drainPlan.batchSize,
					extensionHydrator: hydrateMemoryEntityProjectionEvent,
				});
				processed += result.processed;
				if (result.blocked) {
					blocked = result.blocked;
					break;
				}
				if (result.processed === 0) break;
			}
		}
		let backlog = await getGraphProjectionBacklogStats(context.db, orgId);
		const drainBudgetExhausted =
			repair.checkpoint.phase === "complete" &&
			!blocked &&
			batches === drainPlan.maxBatches &&
			drainPlan.maxBatches > 0 &&
			backlog.pendingCount > 0;
		let readiness = await getGraphProjectionReadState(context.db, orgId);
		let passesGate = false;
		if (
			repair.checkpoint.phase === "complete" &&
			!blocked &&
			backlog.pendingCount === 0 &&
			backlog.cursor >= backlog.highWaterSequence
		) {
			const { certifyGraphProjection, graphProjectionReadAdmission } =
				await loadGraphProjectionCertification();
			const inspection = await certifyGraphProjection({
				db: context.db,
				env,
				organizationId: orgId,
			});
			readiness = inspection.readiness;
			backlog = inspection.backlog;
			passesGate =
				graphProjectionReadAdmission({
					inspection,
				}).allowed && inspection.parityPasses;
		}
		return {
			organizationId: orgId,
			repair: {
				id: repairId,
				phase: repair.checkpoint.phase,
				cursor: repair.checkpoint.cursor,
				highWaterSequence,
				startedAt,
				pagesProcessed: repair.pagesProcessed,
				domainsProjected: repair.domainsProjected,
				factsProjected: repair.factsProjected,
				edgesProjected: repair.edgesProjected,
				projectedByKind: repair.projectedByKind,
			},
			drain: {
				batches,
				processed,
				blocked,
				budgetExhausted: drainBudgetExhausted,
			},
			readiness,
			backlog,
			passesGate,
		};
	});

// =============================================================================
// GRAPH MAINTENANCE (orphan cleanup, dedup detection, stats)
// =============================================================================

export const graphMaintenance = authed.graph.maintenance
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		requireGraphMaintenanceAuthority(context);
		validateGraphGdsMaintenanceRequest(input);
		const env = context.env;
		if (!getGraphClient(env)) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Graph DB is not configured",
			);
		}
		const orgId = requireOrgId(context);
		const runCypher = async (
			query: string,
			params: Record<string, unknown>,
		): Promise<Record<string, unknown>[]> => {
			const { runCypherWithParams } =
				await import("../../../integrations/graph-db/client");
			return runCypherWithParams(env, query, params);
		};
		let orphansRemoved = 0;
		let duplicatesFound = 0;
		let gdsRefreshed = false;
		let gdsWatermark: number | null = null;
		let gdsEpoch: string | null = null;
		let task: GraphGdsTask | null = null;
		let deduplicated = false;
		let stats:
			| {
					totalNodes: number;
					totalRelationships: number;
					factCount: number;
					domainCount: number;
					tediCount: number;
					decisionCount: number;
			  }
			| undefined;
		for (const op of input.operations) {
			switch (op) {
				case "orphan_cleanup": {
					const result = await runCypher(
						`MATCH (f:Fact {orgId: $orgId}) WHERE NOT (f)-[]-() AND f.archivedAt IS NOT NULL
						 DETACH DELETE f
						 RETURN count(f) AS removed`,
						{
							orgId,
						},
					);
					orphansRemoved = toNumber(result[0]?.removed);
					break;
				}
				case "dedup_detection": {
					const result = await runCypher(
						`MATCH (a:Fact {orgId: $orgId}), (b:Fact {orgId: $orgId})
						 WHERE a.id < b.id AND a.content = b.content
						 RETURN count(*) AS duplicates`,
						{
							orgId,
						},
					);
					duplicatesFound = toNumber(result[0]?.duplicates);
					break;
				}
				case "stats": {
					const nodeResults = await runCypher(
						`MATCH (n {orgId: $orgId})
						 RETURN labels(n)[0] AS label, count(n) AS count`,
						{
							orgId,
						},
					);
					const relResult = await runCypher(
						`MATCH (source {orgId: $orgId})-[r]->(target {orgId: $orgId})
						 RETURN count(r) AS totalRelationships`,
						{
							orgId,
						},
					);
					const labelCounts: Record<string, number> = {};
					for (const row of nodeResults) {
						const label = String(row.label ?? "unknown");
						labelCounts[label] = toNumber(row.count);
					}
					stats = {
						totalNodes: Object.values(labelCounts).reduce((s, c) => s + c, 0),
						totalRelationships: toNumber(relResult[0]?.totalRelationships),
						factCount: labelCounts.Fact ?? 0,
						domainCount: labelCounts.Domain ?? 0,
						tediCount: labelCounts.Tedi ?? 0,
						decisionCount: labelCounts.Decision ?? 0,
					};
					break;
				}
				case "reindex": {
					if (!task) {
						const started = await startGraphGdsTask(
							context,
							input.idempotencyKey!,
						);
						task = started.task;
						deduplicated = started.deduplicated;
					}
					if (task.status === "completed" && task.result) {
						gdsRefreshed = true;
						gdsWatermark = task.result.watermark;
						gdsEpoch = task.result.epoch;
					}
					break;
				}
			}
		}
		return {
			orphansRemoved,
			duplicatesFound,
			stats,
			gdsRefreshed,
			gdsWatermark,
			gdsEpoch,
			task,
			deduplicated,
		};
	});

export const graphMaintenanceTaskStatus = authed.graph.maintenanceTaskStatus
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		requireGraphMaintenanceAuthority(context);
		return graphGdsTaskForOrg(context, input.taskId);
	});

export const graphMaintenanceTaskCancel = authed.graph.maintenanceTaskCancel
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		requireGraphMaintenanceAuthority(context);
		const organizationId = requireOrgId(context);
		const before = await graphGdsTaskForOrg(context, input.taskId);
		if (
			before.status === "completed" ||
			before.status === "failed" ||
			before.status === "cancelled"
		) {
			return before;
		}
		await requestGraphProjectionMaintenanceCancel(
			context.db,
			context.env.ENVIRONMENT,
			organizationId,
			input.taskId,
			"Canceled by operator",
		);
		return graphGdsTaskForOrg(context, input.taskId);
	});

// Helper: run a raw Cypher query using graph-db driver

export // =============================================================================
// OPTIMIZE (unified: curiosity + optimization signals)
// =============================================================================

const optimizeScan = authed.optimize.scan
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const tediId = input.tediId;

		// --- Optimization signals ---
		const signals: Array<{
			id: string;
			type: string;
			source: string;
			domain: string;
			evidence: string[];
			suggestedAction: string;
			estimatedImpact: number;
			estimatedEffort: number;
			roi: number;
			status: string;
			createdAt: string | null;
		}> = [];
		const domains = await listDomains(context.db, orgId);

		// Detect confidence mismatches
		for (const domain of domains) {
			if (input.domain && domain.name !== input.domain) continue;
			const facts = await searchFacts(context.db, {
				orgId,
				domainId: domain.id,
				limit: 100,
			});
			if (facts.length >= 10) {
				const avgConf =
					facts.reduce((s, f) => s + f.confidence, 0) / facts.length;
				if (avgConf < 0.5) {
					const signal = await createOptimizationSignal(context.db, {
						id: crypto.randomUUID(),
						tediId: tediId ?? "org",
						organizationId: orgId,
						type: "confidence_mismatch",
						source: "self_detected",
						domain: domain.name,
						evidence: [
							`${facts.length} facts with avg confidence ${(avgConf * 100).toFixed(0)}%`,
						],
						suggestedAction: `Review and verify facts in "${domain.name}" — many facts but low confidence suggests outdated or unreliable knowledge`,
						estimatedImpact: 0.7,
						estimatedEffort: 0.4,
						roi: 1.75,
					});
					signals.push({
						id: signal.id,
						type: signal.type,
						source: signal.source,
						domain: signal.domain,
						evidence: signal.evidence,
						suggestedAction: signal.suggestedAction,
						estimatedImpact: signal.estimatedImpact,
						estimatedEffort: signal.estimatedEffort,
						roi: signal.roi,
						status: signal.status,
						createdAt: signal.createdAt,
					});
				}
			}
		}

		// Detect high gap counts
		const gapStats = await getGapStats(context.db, orgId);
		for (const [domainName, gapCount] of Object.entries(gapStats.byDomain)) {
			if (input.domain && domainName !== input.domain) continue;
			if (gapCount >= 3) {
				const signal = await createOptimizationSignal(context.db, {
					id: crypto.randomUUID(),
					tediId: tediId ?? "org",
					organizationId: orgId,
					type: "understanding_gap",
					source: "self_detected",
					domain: domainName,
					evidence: [`${gapCount} active knowledge gaps in "${domainName}"`],
					suggestedAction: `Prioritize gap resolution in "${domainName}" — ${gapCount} gaps indicate systematic knowledge deficit`,
					estimatedImpact: 0.8,
					estimatedEffort: 0.6,
					roi: 1.33,
				});
				signals.push({
					id: signal.id,
					type: signal.type,
					source: signal.source,
					domain: signal.domain,
					evidence: signal.evidence,
					suggestedAction: signal.suggestedAction,
					estimatedImpact: signal.estimatedImpact,
					estimatedEffort: signal.estimatedEffort,
					roi: signal.roi,
					status: signal.status,
					createdAt: signal.createdAt,
				});
			}
		}

		// --- Curiosity suggestions (low-coverage domains) ---
		const curiosities: Array<{
			topic: string;
			domain: string;
			reason: string;
			priority: number;
		}> = [];
		for (const domain of domains) {
			if (input.domain && domain.name !== input.domain) continue;
			const facts = await searchFacts(context.db, {
				orgId,
				domainId: domain.id,
				limit: 1,
			});
			if (facts.length === 0) {
				curiosities.push({
					topic: `Explore ${domain.name}`,
					domain: domain.name,
					reason: `Zero facts in domain "${domain.name}" — complete blind spot`,
					priority: 0.9,
				});
			}
		}
		curiosities.sort((a, b) => b.priority - a.priority);
		return {
			signals,
			curiosities: curiosities.slice(0, 10),
		};
	});

export const optimizeBacklog = authed.optimize.backlog
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		// Curiosity items
		const curiosityStatus = toCuriosityStatus(input.status);
		const optimizationStatus = toOptimizationSignalStatus(input.status);
		const curiosityItems =
			input.type === "all" || input.type === "curiosity"
				? await listCuriosityQueue(context.db, orgId, {
						tediId: input.tediId,
						status: curiosityStatus,
						limit: input.limit,
					})
				: [];

		// Optimization signals
		const optimizationSignals =
			input.type === "all" || input.type === "optimization"
				? await (optimizationStatus
						? listOptimizationSignals(context.db, orgId, {
								tediId: input.tediId,
								status: optimizationStatus,
								limit: input.limit,
							})
						: getOptimizationBacklog(context.db, orgId, {
								tediId: input.tediId,
								limit: input.limit,
							}))
				: [];
		return {
			curiosityItems,
			optimizationSignals: optimizationSignals.map((s) => ({
				id: s.id,
				type: s.type,
				source: s.source,
				domain: s.domain,
				evidence: s.evidence,
				suggestedAction: s.suggestedAction,
				estimatedImpact: s.estimatedImpact,
				estimatedEffort: s.estimatedEffort,
				roi: s.roi,
				status: s.status,
				createdAt: s.createdAt,
			})),
		};
	});

export const optimizeExecute = authed.optimize.execute
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		switch (input.action) {
			case "create_curiosity": {
				if (!input.topic || !input.domain || !input.reason || !input.tediId) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"create_curiosity requires topic, domain, reason, and tediId",
					);
				}
				const item = await createCuriosityItem(context.db, {
					id: crypto.randomUUID(),
					tediId: input.tediId,
					organizationId: orgId,
					topic: input.topic,
					domain: input.domain,
					reason: input.reason,
					priority: input.priority ?? 0.5,
					source: input.source ?? "human_request",
				});
				return {
					success: true,
					item,
					review: null,
				};
			}
			case "next_curiosity": {
				const item = await getNextCuriosityItem(
					context.db,
					orgId,
					input.tediId,
				);
				return {
					success: true,
					item: item ?? null,
					review: null,
				};
			}
			case "complete_curiosity": {
				if (!input.id) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"complete_curiosity requires id",
					);
				}
				await updateCuriosityStatus(context.db, input.id, "completed", {
					factsLearned: input.factsLearned,
					gapsFound: input.gapsFound,
				});
				return {
					success: true,
					item: null,
					review: null,
				};
			}
			case "execute_signal": {
				if (!input.id) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"execute_signal requires id",
					);
				}
				await updateSignalStatus(context.db, input.id, "executing");
				return {
					success: true,
					item: null,
					review: null,
				};
			}
			case "review": {
				const completed = await listOptimizationSignals(context.db, orgId, {
					tediId: input.tediId,
					status: "completed",
				});
				const avgRoi =
					completed.length > 0
						? completed.reduce((s, c) => s + c.roi, 0) / completed.length
						: 0;
				return {
					success: true,
					item: null,
					review: {
						completed: completed.length,
						averageRoi: avgRoi,
						topImprovements: completed
							.sort((a, b) => b.roi - a.roi)
							.slice(0, 5)
							.map((s) => ({
								id: s.id,
								type: s.type,
								domain: s.domain,
								suggestedAction: s.suggestedAction,
								roi: s.roi,
							})),
					},
				};
			}
			default:
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Unknown action: ${input.action}`,
				);
		}
	});

// =============================================================================
// ROUTER EXPORT
// =============================================================================

export const searchRoute = skipOutputValidation(search);

export const auditRoute = skipOutputValidation(audit);

export const listDomainsRoute = skipOutputValidation(listDomainsProcedure);

export const expertiseRoute = skipOutputValidation(expertise);

export const statsRoute = skipOutputValidation(stats);

export const assembleRoute = skipOutputValidation(assemble);

export const gapsRoute = {
	detect: gapsDetect,
	list: skipOutputValidation(gapsList),
	resolve: gapsResolve,
	report: skipOutputValidation(gapsReport),
};

export const healthRoute = skipOutputValidation(health);

export const graphRoute = {
	visualization: skipOutputValidation(graphVisualization),
	similar: skipOutputValidation(graphSimilar),
	path: skipOutputValidation(graphPath),
	communities: skipOutputValidation(graphCommunities),
	influence: skipOutputValidation(graphInfluence),
	traverse: skipOutputValidation(graphTraverse),
	edges: skipOutputValidation(graphEdges),
	causalChain: skipOutputValidation(graphCausalChain),
	similarDecisions: skipOutputValidation(graphSimilarDecisions),
	health: skipOutputValidation(graphHealth),
	sync: graphSync,
	maintenance: graphMaintenance,
	maintenanceTaskStatus: graphMaintenanceTaskStatus,
	maintenanceTaskCancel: graphMaintenanceTaskCancel,
};

export const optimizeRoute = {
	scan: optimizeScan,
	backlog: skipOutputValidation(optimizeBacklog),
	execute: optimizeExecute,
};
