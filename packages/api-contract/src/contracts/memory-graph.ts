import "@orpc/openapi/extensions/route";
/**
 * Memory Graph Contract
 * oRPC contract for the knowledge graph API.
 *
 * Minimal surface — 3 core operations + domain management.
 * Designed for MCP memory server consumption.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { JsonValueSchema } from "../schemas/common";
import {
	CuriosityItemSchema,
	CuriositySourceSchema,
	DomainSchema,
	EdgeSchema,
	ExpertiseLevelSchema,
	FactSchema,
	FactTypeSchema,
	GapSeveritySchema,
	MemoryFeedbackSignalSchema,
	MemoryHealthSchema,
	MemoryReviewStatusSchema,
	MemoryScopeSchema,
	MemoryUsePolicySchema,
	PrioritySchema,
	RelationTypeSchema,
	SearchResultSchema,
	VisibilitySchema,
} from "../schemas/memory-graph";

// ============================================================================
// Contract
// ============================================================================

const GraphGdsMaintenanceTaskStatusSchema = z.enum([
	"queued",
	"running",
	"cancel_requested",
	"completed",
	"failed",
	"cancelled",
]);

const GraphGdsMaintenanceTaskSchema = z.object({
	id: z.string().min(1),
	workflowId: z.string().min(1),
	status: GraphGdsMaintenanceTaskStatusSchema,
	createdAt: z.string(),
	lastUpdatedAt: z.string(),
	pollWith: z.literal("tasks/get"),
	pollIntervalMs: z.number().int().positive(),
	result: z
		.object({
			operation: z.literal("gds_refresh"),
			organizationId: z.string(),
			watermark: z.number().int().nonnegative(),
			epoch: z.string().min(1),
		})
		.nullable(),
	error: z.string().nullable(),
});

const GraphMetaSchema = z.object({
	graphConfigured: z.boolean(),
	graphHealthy: z.boolean(),
	projectionState: z.enum(["disabled", "catching_up", "ready", "degraded"]),
	projectionReady: z.boolean(),
	projectionReason: z.string().nullable(),
	persistedWatermark: z.number().int().nonnegative(),
	gdsWatermark: z.number().int().nonnegative(),
	degraded: z.boolean(),
	source: z.enum(["neo4j", "none"]),
});

export const GraphProjectionCoverageDiagnosticSchema = z.object({
	authority: z.literal("d1"),
	gateStatus: z.enum([
		"passing",
		"failing",
		"unavailable",
		"insufficient_data",
	]),
	passesGate: z.boolean(),
	checkedAt: z.string(),
	sampleLimit: z.number().int().positive(),
	sampleSize: z.number().int().nonnegative(),
	projectedCount: z.number().int().nonnegative(),
	missingCount: z.number().int().nonnegative(),
	staleCount: z.number().int().nonnegative(),
	overdueCount: z.number().int().nonnegative(),
	sampleCoverageRatio: z.number().min(0).max(1).nullable(),
	newestCanonicalAt: z.string().nullable(),
	newestProjectedAt: z.string().nullable(),
	maxObservedLagMs: z.number().nonnegative().nullable(),
	thresholds: z.object({
		minSampleCoverageRatio: z.number().min(0).max(1),
		maxProjectionLagMs: z.number().int().positive(),
	}),
	facts: z.array(
		z.object({
			factId: z.string(),
			canonicalUpdatedAt: z.string().nullable(),
			projectedUpdatedAt: z.string().nullable(),
			lagMs: z.number().nonnegative().nullable(),
			status: z.enum([
				"current",
				"within_lag_allowance",
				"missing_overdue",
				"stale_overdue",
			]),
		}),
	),
});

export const MemoryGraphHealthOutputSchema = z.object({
	healthy: z.boolean(),
	configured: z.boolean(),
	passesGate: z.boolean(),
	checkedAt: z.string(),
	projection: GraphProjectionCoverageDiagnosticSchema,
	edges: z.object({
		authority: z.literal("d1"),
		passesGate: z.boolean(),
		sampleSize: z.number().int().nonnegative(),
		projectedCount: z.number().int().nonnegative(),
		missingCount: z.number().int().nonnegative(),
		mismatchCount: z.number().int().nonnegative(),
		sampleCoverageRatio: z.number().min(0).max(1).nullable(),
		edges: z.array(
			z.object({
				edgeId: z.string(),
				sourceFactId: z.string(),
				targetFactId: z.string(),
				relationType: z.string(),
				status: z.enum(["current", "missing", "mismatched"]),
			}),
		),
	}),
	lifecycle: z.object({
		authority: z.literal("d1"),
		passesGate: z.boolean(),
		sampleSize: z.number().int().nonnegative(),
		projectedCount: z.number().int().nonnegative(),
		missingCount: z.number().int().nonnegative(),
		mismatchCount: z.number().int().nonnegative(),
		facts: z.array(
			z.object({
				factId: z.string(),
				canonicalValidTo: z.string().nullable(),
				projectedValidTo: z.string().nullable(),
				canonicalArchivedAt: z.string().nullable(),
				projectedArchivedAt: z.string().nullable(),
				status: z.enum(["current", "missing", "mismatched"]),
			}),
		),
	}),
	managedCounts: z.object({
		authority: z.literal("d1"),
		passesGate: z.boolean(),
		canonical: z.record(z.string(), z.number().int().nonnegative()),
		projected: z.record(z.string(), z.number().int().nonnegative()),
		mismatches: z.array(
			z.object({
				kind: z.string(),
				canonicalCount: z.number().int().nonnegative(),
				projectedCount: z.number().int().nonnegative(),
				delta: z.number().int(),
			}),
		),
	}),
	schema: z.object({
		version: z.string(),
		constraints: z.array(z.string()),
		complete: z.boolean(),
	}),
	readiness: z
		.object({
			state: z.enum(["disabled", "catching_up", "ready", "degraded"]),
			reason: z.string().nullable(),
			persistedWatermark: z.number().int().nonnegative(),
			gdsWatermark: z.number().int().nonnegative(),
			projectionEpoch: z.string().nullable(),
			gdsEpoch: z.string().nullable(),
			nodeMismatchCount: z.number().int().nonnegative().nullable(),
			edgeMismatchCount: z.number().int().nonnegative().nullable(),
			lifecycleMismatchCount: z.number().int().nonnegative().nullable(),
			repairId: z.string().nullable(),
			repairPhase: z
				.enum([
					"domains",
					"facts",
					"edges",
					"tedis",
					"decisions",
					"decision_predecessors",
					"knowledge_entries",
					"skills",
					"tedi_expertise",
					"capabilities",
					"capability_links",
					"entities",
					"entity_resolutions",
					"projects",
					"work_items",
					"work_item_sources",
					"sweep",
					"complete",
				])
				.nullable(),
			repairCursor: z.string().nullable(),
			repairHighWater: z.number().int().nonnegative().nullable(),
			repairStartedAt: z.string().nullable(),
			lastCertifiedAt: z.string().nullable(),
		})
		.nullable(),
	backlog: z.object({
		cursor: z.number().int().nonnegative(),
		highWaterSequence: z.number().int().nonnegative(),
		pendingCount: z.number().int().nonnegative(),
		retryCount: z.number().int().nonnegative(),
		poisonedCount: z.number().int().nonnegative(),
		oldestPendingAt: z.string().nullable(),
	}),
});

export const MemoryGraphSyncDrainOutputSchema = z.object({
	batches: z.number().int().nonnegative(),
	processed: z.number().int().nonnegative(),
	blocked: z.string().nullable(),
	budgetExhausted: z.boolean(),
});

export const MemoryGraphSearchInputSchema = z
	.object({
		query: z
			.string()
			.min(1)
			.optional()
			.describe("Natural language search query"),
		topicKey: z
			.string()
			.min(1)
			.optional()
			.describe("Exact topic key lookup for stateful memory baselines"),
		tediId: z
			.string()
			.optional()
			.describe("Filter to specific tedi (also applies visibility rules)"),
		domain: z.string().optional().describe("Filter by domain name"),
		visibility: VisibilitySchema.optional().describe(
			"Filter by visibility level",
		),
		factType: FactTypeSchema.optional(),
		priority: PrioritySchema.optional().describe("Filter by priority level"),
		minConfidence: z.number().min(0).max(1).optional().default(0.3),
		topK: z.number().min(1).max(50).optional().default(10),
		includeRelated: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include related facts via graph edges"),
		includeGraphAnchors: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				"Include graph-anchor facts that are normally excluded from recall",
			),
	})
	.refine(
		(input) =>
			Boolean(input.query?.trim().length) ||
			Boolean(input.topicKey?.trim().length),
		{
			message: "Provide query or topicKey",
			path: ["query"],
		},
	);

export const MemoryGraphReviewInputSchema = z
	.object({
		factId: z.string().min(1).describe("Fact to review"),
		tediId: z
			.string()
			.optional()
			.describe(
				"Tedi performing the review; injected by aggregate tedi tools.",
			),
		reviewStatus: MemoryReviewStatusSchema.optional(),
		usePolicy: MemoryUsePolicySchema.optional(),
		priority: PrioritySchema.optional(),
		visibility: VisibilitySchema.optional(),
		topicKey: z.string().min(1).optional(),
		archived: z
			.boolean()
			.optional()
			.describe("Set true to soft-archive the fact, false to unarchive it."),
		reason: z
			.string()
			.trim()
			.min(1)
			.max(2000)
			.optional()
			.describe("Short audit reason for the lifecycle update."),
	})
	.refine(
		(input) =>
			input.reviewStatus !== undefined ||
			input.usePolicy !== undefined ||
			input.priority !== undefined ||
			input.visibility !== undefined ||
			input.topicKey !== undefined ||
			input.archived !== undefined ||
			input.reason !== undefined,
		{
			message: "Provide at least one lifecycle field",
			path: ["reviewStatus"],
		},
	);

const MemoryGraphAuditInputSchema = z.object({
	tediId: z
		.string()
		.optional()
		.describe("Tedi whose brain should be audited; defaults to caller tedi."),
	scope: z
		.enum(["self", "org", "visible", "all"])
		.optional()
		.describe(
			"self=this tedi's facts; org=org/shared facts; visible=self+org/shared; all=all org facts.",
		),
	topicKeyState: z.enum(["any", "missing", "present"]).optional(),
	reviewStatus: MemoryReviewStatusSchema.optional(),
	priority: PrioritySchema.optional(),
	usePolicy: MemoryUsePolicySchema.optional(),
	factType: FactTypeSchema.optional(),
	status: z.enum(["probation", "active"]).optional(),
	sourceSessionId: z.string().optional(),
	sourcePrefix: z.string().optional(),
	producer: z.string().optional(),
	search: z.string().optional(),
	includeArchived: z.boolean().optional(),
	limit: z.number().int().positive().max(100).optional(),
	offset: z.number().int().min(0).optional(),
	orderBy: z.enum(["created_desc", "updated_desc"]).optional(),
});

const MemoryGraphAuditFactSchema = z.object({
	id: z.string(),
	tediId: z.string().nullable(),
	contentPreview: z.string(),
	summary: z.string().nullable(),
	factType: z.string(),
	confidence: z.number(),
	status: z.string().nullable(),
	source: z.string().nullable(),
	sourceSessionId: z.string().nullable(),
	topicKey: z.string().nullable(),
	memoryScope: z.string().nullable(),
	usePolicy: z.string().nullable(),
	reviewStatus: z.string().nullable(),
	metadata: z.unknown(),
	producer: z.string().nullable(),
	sourceKind: z.string().nullable(),
	priority: z.string().nullable(),
	visibility: z.string().nullable(),
	promotedFrom: z.string().nullable(),
	promotedAt: z.string().nullable(),
	archivedAt: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});

const MemoryGraphAuditOutputSchema = z.object({
	ok: z.literal(true),
	filters: z.record(z.string(), JsonValueSchema),
	counts: z.object({
		total: z.number(),
		activePendingMissingTopicKey: z.number(),
		byReviewStatus: z.record(z.string(), z.number()),
		byPriority: z.record(z.string(), z.number()),
		byFactType: z.record(z.string(), z.number()),
		byProducer: z.record(z.string(), z.number()),
	}),
	facts: z.array(MemoryGraphAuditFactSchema),
	nextOffset: z.number().nullable(),
});

export const memoryGraphContract = oc.route({ tags: ["memory-graph"] }).router({
	// ---- Search (the main entry point) ----
	search: oc
		.route({ method: "POST", path: "/memory/search", tags: ["memory-graph"] })
		.input(MemoryGraphSearchInputSchema)
		.output(
			z.object({
				results: z.array(SearchResultSchema),
				totalFacts: z.number(),
				query: z.string(),
			}),
		),

	// ---- Audit (read-only exact memory fact inspection) ----
	audit: oc
		.route({ method: "POST", path: "/memory/audit", tags: ["memory-graph"] })
		.input(MemoryGraphAuditInputSchema)
		.output(MemoryGraphAuditOutputSchema),

	// ---- Learn (store new knowledge) ----
	learn: oc
		.route({ method: "POST", path: "/memory/learn", tags: ["memory-graph"] })
		.input(
			z.object({
				content: z.string().min(1).describe("The knowledge to store"),
				summary: z
					.string()
					.optional()
					.describe("Short summary for quick recall"),
				domain: z
					.string()
					.describe("Knowledge domain (e.g., drizzle, product)"),
				factType: FactTypeSchema,
				tediId: z.string().optional().describe("Scope to specific tedi"),
				visibility: VisibilitySchema.optional().describe(
					"Visibility level (auto-set if omitted: private when tediId present, org when not)",
				),
				confidence: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.default(0.8)
					.describe("Confidence level 0.0-1.0 (default 0.8)"),
				priority: PrioritySchema.optional().describe(
					"Priority level: core (protected from decay), active (default), background (deprioritized)",
				),
				source: z
					.string()
					.optional()
					.describe(
						"Structured source URI: doc://docs/mcp/runtime.md, api://klarna/search, conversation://session-123",
					),
				sourceSessionId: z.string().optional(),
				sourceUrl: z.string().optional(),
				sourceHash: z
					.string()
					.optional()
					.describe(
						"SHA-256 hash of source content at learn time (for staleness detection)",
					),
				topicKey: z
					.string()
					.optional()
					.describe(
						"Stable key for state facts that should supersede stale versions",
					),
				memoryScope: MemoryScopeSchema.optional(),
				usePolicy: MemoryUsePolicySchema.optional(),
				reviewStatus: MemoryReviewStatusSchema.optional(),
				metadata: z.record(z.string(), z.unknown()).optional(),
				// Optional: link to existing facts
				relatedTo: z
					.array(
						z.object({
							factId: z.string(),
							relationType: RelationTypeSchema,
							context: z.string().optional(),
						}),
					)
					.optional()
					.describe("Create edges to existing facts"),
			}),
		)
		.output(
			z.object({
				fact: FactSchema,
				edges: z.array(EdgeSchema),
				embeddingId: z.string().nullable().optional(),
				invalidated: z
					.array(
						z.object({
							factId: z.string(),
							summary: z.string().nullable(),
						}),
					)
					.optional()
					.describe(
						"Facts that were auto-invalidated because this new fact contradicts them",
					),
				deduplicated: z
					.boolean()
					.optional()
					.describe(
						"True if the content was an exact duplicate and the existing fact was boosted instead",
					),
			}),
		),

	// ---- Reflect (trigger consolidation) ----
	reflect: oc
		.route({ method: "POST", path: "/memory/reflect", tags: ["memory-graph"] })
		.input(
			z.object({
				tediId: z.string().optional(),
				scope: z
					.enum(["full", "recent", "domain"])
					.optional()
					.default("recent"),
				domain: z.string().optional().describe("Required if scope=domain"),
			}),
		)
		.output(
			z.object({
				factsReviewed: z.number(),
				edgesCreated: z.number(),
				factsArchived: z.number(),
				confidenceUpdated: z.number(),
				summary: z.string(),
			}),
		),

	// ---- Domain management ----
	listDomains: oc
		.route({
			method: "GET",
			path: "/memory/domains",
			tags: ["memory-graph"],
		})
		.output(z.object({ domains: z.array(DomainSchema) })),

	// ---- Assemble context ----
	assemble: oc
		.route({ method: "POST", path: "/memory/assemble", tags: ["memory-graph"] })
		.input(
			z.object({
				query: z
					.string()
					.min(1)
					.describe("Natural language query to assemble context for"),
				tediId: z
					.string()
					.min(1)
					.describe("Tedi whose scoped memory context is assembled"),
				maxTokens: z.number().min(100).max(32000).optional().default(4000),
				domains: z
					.array(z.string())
					.optional()
					.describe("Filter by domain names"),
				factTypes: z
					.array(FactTypeSchema)
					.optional()
					.describe("Filter by fact types"),
			}),
		)
		.output(
			z.object({
				context: z
					.string()
					.describe("Structured context block ready for LLM consumption"),
				factCount: z.number(),
				sources: z.array(
					z.object({
						factId: z.string(),
						domain: z.string(),
						confidence: z.number(),
					}),
				),
			}),
		),

	// ---- Expertise ----
	expertise: oc
		.route({
			method: "POST",
			path: "/memory/expertise",
			tags: ["memory-graph"],
		})
		.input(
			z.object({
				tediId: z
					.string()
					.optional()
					.describe(
						"Tedi to get expertise for (auto-inferred from auth token if omitted)",
					),
				domain: z.string().optional().describe("Filter to specific domain"),
			}),
		)
		.output(
			z.object({
				expertise: z.array(
					z.object({
						id: z.string(),
						tediId: z.string(),
						domainId: z.string(),
						domainName: z.string().nullable().optional(),
						factCount: z.number(),
						avgConfidence: z.number(),
						competenceScore: z
							.number()
							.describe(
								"Weighted competence score: AVG(confidence * usageBoost) per domain, where usageBoost = clamp(0.85, usageCount/max(1,accessCount), 1.3). Domains with high-confidence, actively-used facts rank higher.",
							),
						expertiseLevel: ExpertiseLevelSchema,
						lastActivityAt: z.string().nullable().optional(),
						createdAt: z.string().nullable().optional(),
						updatedAt: z.string().nullable().optional(),
					}),
				),
			}),
		),

	// ---- Promote ----
	promote: oc
		.route({ method: "POST", path: "/memory/promote", tags: ["memory-graph"] })
		.input(
			z.object({
				factId: z.string().describe("Fact to promote"),
				visibility: VisibilitySchema.describe("Target visibility level"),
				priority: PrioritySchema.optional().describe(
					"Set priority level (core: max 20 per domain, protected from decay)",
				),
				topicKey: z.string().optional(),
				usePolicy: MemoryUsePolicySchema.optional(),
				reviewStatus: MemoryReviewStatusSchema.optional(),
			}),
		)
		.output(
			z.object({
				fact: FactSchema,
			}),
		),

	// ---- Review (update lifecycle fields without promotion) ----
	review: oc
		.route({ method: "POST", path: "/memory/review", tags: ["memory-graph"] })
		.input(MemoryGraphReviewInputSchema)
		.output(
			z.object({
				fact: FactSchema,
			}),
		),

	// ---- Reindex (admin: rebuild vector index from D1) ----
	reindex: oc
		.route({ method: "POST", path: "/memory/reindex", tags: ["memory-graph"] })
		.input(
			z.object({
				domain: z
					.string()
					.optional()
					.describe("Only reindex a specific domain"),
				tediId: z.string().optional().describe("Only reindex a specific tedi"),
				dryRun: z
					.boolean()
					.optional()
					.default(false)
					.describe("Count without actually reindexing"),
			}),
		)
		.output(
			z.object({
				indexed: z.number(),
				skipped: z.number(),
				errors: z.number(),
				durationMs: z.number(),
			}),
		),

	// ---- Stats ----
	stats: oc
		.route({ method: "GET", path: "/memory/stats", tags: ["memory-graph"] })
		.output(
			z.object({
				totalFacts: z.number(),
				totalEdges: z.number(),
				totalDomains: z.number(),
				factsByType: z.record(z.string(), z.number()),
				factsByDomain: z.record(z.string(), z.number()),
				avgConfidence: z.number(),
			}),
		),

	// ---- Gaps ----
	gaps: oc.route({ tags: ["memory-graph"] }).router({
		detect: oc
			.route({
				method: "POST",
				path: "/memory/gaps/detect",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					domain: z.string().describe("Domain to analyze for gaps"),
					tediId: z.string().optional(),
				}),
			)
			.output(
				z.object({
					gapsFound: z.array(FactSchema),
					domain: z.string(),
				}),
			),

		list: oc
			.route({
				method: "POST",
				path: "/memory/gaps/list",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					domain: z.string().optional(),
					severity: GapSeveritySchema.optional(),
					tediId: z.string().optional(),
					limit: z.number().optional(),
				}),
			)
			.output(z.object({ gaps: z.array(FactSchema) })),

		resolve: oc
			.route({
				method: "POST",
				path: "/memory/gaps/resolve",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					gapId: z.string(),
					resolvedByFactId: z.string(),
				}),
			)
			.output(z.object({ success: z.boolean() })),

		report: oc
			.route({
				method: "GET",
				path: "/memory/gaps/report",
				tags: ["memory-graph"],
			})
			.output(
				z.object({
					totalGaps: z.number(),
					resolvedGaps: z.number(),
					byDomain: z.record(z.string(), z.number()),
					bySeverity: z.record(z.string(), z.number()),
				}),
			),
	}),

	// ---- Health (extended) ----
	health: oc
		.route({ method: "GET", path: "/memory/health", tags: ["memory-graph"] })
		.output(MemoryHealthSchema),

	// ---- Link ----
	link: oc
		.route({ method: "POST", path: "/memory/link", tags: ["memory-graph"] })
		.input(
			z.object({
				mode: z.enum(["manual", "auto"]).default("manual"),
				// Manual mode
				sourceFactId: z.string().optional(),
				targetFactId: z.string().optional(),
				relationType: RelationTypeSchema.optional(),
				context: z.string().optional(),
				// Auto mode
				domain: z.string().optional(),
				dryRun: z.boolean().optional().default(false),
			}),
		)
		.output(
			z.object({
				edges: z.array(EdgeSchema).optional(),
				proposals: z
					.array(
						z.object({
							sourceFactId: z.string(),
							targetFactId: z.string(),
							relationType: RelationTypeSchema,
							context: z.string(),
						}),
					)
					.optional(),
			}),
		),

	// ---- Synthesize ----
	synthesize: oc
		.route({
			method: "POST",
			path: "/memory/synthesize",
			tags: ["memory-graph"],
		})
		.input(
			z.object({
				domain: z.string().describe("Domain to synthesize"),
				tediId: z.string().optional(),
			}),
		)
		.output(
			z.object({
				domain: z.string(),
				narrative: z.string(),
				factCount: z.number(),
				gapCount: z.number(),
			}),
		),

	// ---- Opine ----
	opine: oc
		.route({ method: "POST", path: "/memory/opine", tags: ["memory-graph"] })
		.input(
			z.object({
				question: z.string().describe("Question to form an opinion on"),
				tediId: z.string().optional(),
			}),
		)
		.output(
			z.object({
				opinion: FactSchema,
				stance: z.enum(["strong", "moderate", "uncertain", "conflicted"]),
				supportingCount: z.number(),
				contradictingCount: z.number(),
			}),
		),

	// ---- Feedback (retrieval→usage correlation) ----
	feedback: oc
		.route({ method: "POST", path: "/memory/feedback", tags: ["memory-graph"] })
		.input(
			z.object({
				factIds: z
					.array(z.string())
					.min(1)
					.max(50)
					.describe("IDs of facts to provide feedback on"),
				signal: MemoryFeedbackSignalSchema.describe(
					"Usage signal: used (fact influenced response), not_used (retrieved but unused), outdated (stale info), wrong (incorrect fact), failed (tool using this fact failed)",
				),
				tediId: z.string().optional().describe("Tedi providing feedback"),
				sessionId: z
					.string()
					.optional()
					.describe("Session where feedback was generated"),
			}),
		)
		.output(z.object({ updated: z.number() })),

	// ---- Graph DB queries (Neo4j-powered) ----
	graph: oc.route({ tags: ["memory-graph"] }).router({
		/** Get graph visualization data for dashboard rendering */
		visualization: oc
			.route({
				method: "GET",
				path: "/memory/graph/visualization",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					view: z
						.enum([
							"knowledge_map",
							"decision_trace",
							"expertise_radar",
							"cross_tedi",
						])
						.default("knowledge_map"),
					tediId: z.string().optional(),
					domainId: z.string().optional(),
					centerFactId: z
						.string()
						.optional()
						.describe(
							"Center the graph on a specific fact (neighborhood view)",
						),
					decisionId: z
						.string()
						.optional()
						.describe("Required for decision_trace view"),
					depth: z.number().min(1).max(5).optional().default(2),
					maxNodes: z.number().min(10).max(500).optional().default(100),
				}),
			)
			.output(
				z.object({
					nodes: z.array(
						z.object({
							id: z.string(),
							label: z.string(),
							type: z.enum([
								"fact",
								"decision",
								"domain",
								"tedi",
								"skill",
								"knowledge_entry",
							]),
							properties: z.record(z.string(), JsonValueSchema),
						}),
					),
					edges: z.array(
						z.object({
							source: z.string(),
							target: z.string(),
							type: z.string(),
							properties: z.record(z.string(), JsonValueSchema),
						}),
					),
					meta: GraphMetaSchema.optional(),
				}),
			),

		/** Find structurally similar facts via graph topology (FastRP embeddings) */
		similar: oc
			.route({
				method: "GET",
				path: "/memory/graph/similar",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					factId: z.string(),
					topK: z.number().min(1).max(50).optional().default(10),
				}),
			)
			.output(
				z.object({
					results: z.array(
						z.object({
							factId: z.string(),
							score: z.number(),
							source: z.enum(["structural", "semantic", "hybrid"]),
						}),
					),
					meta: GraphMetaSchema.optional(),
				}),
			),

		/** Find shortest path between two facts */
		path: oc
			.route({
				method: "GET",
				path: "/memory/graph/path",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					factIdA: z.string(),
					factIdB: z.string(),
					maxHops: z.number().min(1).max(10).optional().default(6),
				}),
			)
			.output(
				z.object({
					path: z
						.object({
							factIds: z.array(z.string()),
							relationTypes: z.array(z.string()),
							hops: z.number(),
						})
						.nullable(),
					meta: GraphMetaSchema.optional(),
				}),
			),

		/** Detect knowledge communities/clusters using Louvain community detection */
		communities: oc
			.route({
				method: "GET",
				path: "/memory/graph/communities",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					domainId: z.string().optional(),
					minSize: z.number().min(1).optional().default(2),
				}),
			)
			.output(
				z.object({
					communities: z.array(
						z.object({
							communityId: z.number(),
							factIds: z.array(z.string()),
							size: z.number(),
							dominantDomain: z.string().nullable(),
						}),
					),
					meta: GraphMetaSchema.optional(),
				}),
			),

		/** Get influence scores (PageRank) for facts */
		influence: oc
			.route({
				method: "GET",
				path: "/memory/graph/influence",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					domainId: z.string().optional(),
					topK: z.number().min(1).max(100).optional().default(20),
				}),
			)
			.output(
				z.object({
					scores: z.array(
						z.object({
							factId: z.string(),
							pageRank: z.number(),
							summary: z.string().nullable(),
							factType: z.string(),
						}),
					),
					meta: GraphMetaSchema.optional(),
				}),
			),

		/** Deep graph traversal from a starting fact */
		traverse: oc
			.route({
				method: "GET",
				path: "/memory/graph/traverse",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					startFactId: z.string(),
					maxDepth: z.number().min(1).max(5).optional().default(3),
					maxNodes: z.number().min(1).max(200).optional().default(80),
				}),
			)
			.output(
				z.object({
					facts: z.array(
						z.object({
							factId: z.string(),
							content: z.string(),
							summary: z.string().nullable(),
							factType: z.string(),
							confidence: z.number(),
							depth: z.number(),
						}),
					),
					edges: z.array(
						z.object({
							sourceFactId: z.string(),
							targetFactId: z.string(),
							relationType: z.string(),
							strength: z.number(),
							context: z.string().nullable(),
						}),
					),
					meta: GraphMetaSchema.optional(),
				}),
			),

		/** Get edges for a specific fact */
		edges: oc
			.route({
				method: "GET",
				path: "/memory/graph/edges",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					factId: z.string(),
					relationType: z.string().optional(),
					direction: z.enum(["in", "out", "both"]).optional().default("both"),
				}),
			)
			.output(
				z.object({
					edges: z.array(
						z.object({
							sourceFactId: z.string(),
							targetFactId: z.string(),
							relationType: z.string(),
							strength: z.number(),
							context: z.string().nullable(),
						}),
					),
					meta: GraphMetaSchema.optional(),
				}),
			),

		/** Trace causal chain for a decision (upstream evidence + downstream effects) */
		causalChain: oc
			.route({
				method: "GET",
				path: "/memory/graph/causal-chain",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					decisionId: z.string(),
					maxDepth: z.number().min(1).max(10).optional().default(5),
				}),
			)
			.output(
				z.object({
					decisionId: z.string(),
					nodes: z.array(
						z.object({
							id: z.string(),
							type: z.enum(["decision", "fact"]),
							label: z.string(),
							depth: z.number(),
						}),
					),
					edges: z.array(
						z.object({
							source: z.string(),
							target: z.string(),
							relationType: z.string(),
						}),
					),
					meta: GraphMetaSchema.optional(),
				}),
			),

		/** Find decisions with shared evidence (structural precedents) */
		similarDecisions: oc
			.route({
				method: "GET",
				path: "/memory/graph/similar-decisions",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					decisionId: z.string().optional(),
					category: z.string().optional(),
					tediId: z.string().optional(),
					topK: z.number().min(1).max(50).optional().default(10),
				}),
			)
			.output(
				z.object({
					decisions: z.array(
						z.object({
							decisionId: z.string(),
							action: z.string(),
							rationale: z.string(),
							outcomeStatus: z.string(),
							confidence: z.number(),
							score: z.number(),
						}),
					),
					meta: GraphMetaSchema.optional(),
				}),
			),

		/** Graph DB health check */
		health: oc
			.route({
				method: "GET",
				path: "/memory/graph/health",
				tags: ["memory-graph"],
			})
			.output(MemoryGraphHealthOutputSchema),

		/** Resume or restart the governed baseline repair, then drain its strict outbox prefix. */
		sync: oc
			.route({
				method: "POST",
				path: "/memory/graph/sync",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					orgId: z.string().uuid().optional(),
					pageSize: z.number().int().min(1).max(500).default(500),
					maxPages: z.number().int().min(1).max(50).default(10),
					drainBatches: z.number().int().min(1).max(20).default(5),
					restart: z.boolean().default(false),
				}),
			)
			.output(
				z.object({
					organizationId: z.string(),
					repair: z.object({
						id: z.string(),
						phase: z.enum([
							"domains",
							"facts",
							"edges",
							"tedis",
							"decisions",
							"decision_predecessors",
							"knowledge_entries",
							"skills",
							"tedi_expertise",
							"capabilities",
							"capability_links",
							"entities",
							"entity_resolutions",
							"projects",
							"work_items",
							"work_item_sources",
							"sweep",
							"complete",
						]),
						cursor: z.string().nullable(),
						highWaterSequence: z.number().int().nonnegative(),
						startedAt: z.string(),
						pagesProcessed: z.number().int().nonnegative(),
						domainsProjected: z.number().int().nonnegative(),
						factsProjected: z.number().int().nonnegative(),
						edgesProjected: z.number().int().nonnegative(),
						projectedByKind: z.record(
							z.string(),
							z.number().int().nonnegative(),
						),
					}),
					drain: MemoryGraphSyncDrainOutputSchema,
					readiness: MemoryGraphHealthOutputSchema.shape.readiness,
					backlog: MemoryGraphHealthOutputSchema.shape.backlog,
					passesGate: z.boolean(),
				}),
			),

		/** Graph maintenance operations (orphan cleanup, dedup detection, stats) */
		maintenance: oc
			.route({
				method: "POST",
				path: "/memory/graph/maintenance",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					operations: z
						.array(
							z.enum(["orphan_cleanup", "dedup_detection", "stats", "reindex"]),
						)
						.default(["stats"]),
					idempotencyKey: z
						.string()
						.min(8)
						.max(200)
						.optional()
						.describe(
							"Caller-stable key for duplicate-safe asynchronous GDS refresh dispatch",
						),
				}),
			)
			.output(
				z.object({
					orphansRemoved: z.number(),
					duplicatesFound: z.number(),
					gdsRefreshed: z.boolean(),
					gdsWatermark: z.number().int().nonnegative().nullable(),
					gdsEpoch: z.string().nullable(),
					task: GraphGdsMaintenanceTaskSchema.nullable(),
					deduplicated: z.boolean(),
					stats: z
						.object({
							totalNodes: z.number(),
							totalRelationships: z.number(),
							factCount: z.number(),
							domainCount: z.number(),
							tediCount: z.number(),
							decisionCount: z.number(),
						})
						.optional(),
				}),
			),
		maintenanceTaskStatus: oc
			.route({
				method: "GET",
				path: "/memory/graph/maintenance/task/status",
				tags: ["memory-graph"],
			})
			.input(z.object({ taskId: z.string().min(1) }))
			.output(GraphGdsMaintenanceTaskSchema),
		maintenanceTaskCancel: oc
			.route({
				method: "POST",
				path: "/memory/graph/maintenance/task/cancel",
				tags: ["memory-graph"],
			})
			.input(z.object({ taskId: z.string().min(1) }))
			.output(GraphGdsMaintenanceTaskSchema),
	}),

	// ---- Optimize (unified: curiosity + optimization signals) ----
	optimize: oc.route({ tags: ["memory-graph"] }).router({
		/** Scan for improvement opportunities — both curiosity suggestions and optimization signals. */
		scan: oc
			.route({
				method: "GET",
				path: "/memory/optimize/scan",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					tediId: z.string().optional(),
					domain: z
						.string()
						.optional()
						.describe("Focus scan on a specific domain"),
				}),
			)
			.output(
				z.object({
					signals: z.array(
						z.object({
							id: z.string(),
							type: z.string(),
							source: z.string(),
							domain: z.string(),
							evidence: z.array(z.string()),
							suggestedAction: z.string(),
							estimatedImpact: z.number(),
							estimatedEffort: z.number(),
							roi: z.number(),
							status: z.string(),
							createdAt: z.string().nullable().optional(),
						}),
					),
					curiosities: z.array(
						z.object({
							topic: z.string(),
							domain: z.string(),
							reason: z.string(),
							priority: z.number(),
						}),
					),
				}),
			),

		/** List all pending improvement items (curiosity queue + optimization backlog). */
		backlog: oc
			.route({
				method: "GET",
				path: "/memory/optimize/backlog",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					tediId: z.string().optional(),
					type: z
						.enum(["curiosity", "optimization", "all"])
						.optional()
						.default("all"),
					status: z
						.string()
						.optional()
						.describe(
							"Filter by status (queued/exploring/completed/deferred for curiosity, detected/proposed/approved/executing/completed/dismissed for optimization)",
						),
					limit: z.number().optional(),
				}),
			)
			.output(
				z.object({
					curiosityItems: z.array(CuriosityItemSchema),
					optimizationSignals: z.array(
						z.object({
							id: z.string(),
							type: z.string(),
							source: z.string(),
							domain: z.string(),
							evidence: z.array(z.string()),
							suggestedAction: z.string(),
							estimatedImpact: z.number(),
							estimatedEffort: z.number(),
							roi: z.number(),
							status: z.string(),
							createdAt: z.string().nullable().optional(),
						}),
					),
				}),
			),

		/** Execute improvement lifecycle: create curiosity items, get next, complete, execute optimization, review results. */
		execute: oc
			.route({
				method: "POST",
				path: "/memory/optimize/execute",
				tags: ["memory-graph"],
			})
			.input(
				z.object({
					action: z
						.enum([
							"create_curiosity",
							"next_curiosity",
							"complete_curiosity",
							"execute_signal",
							"review",
						])
						.describe("Lifecycle action to perform"),
					// For create_curiosity
					topic: z.string().optional(),
					domain: z.string().optional(),
					reason: z.string().optional(),
					tediId: z.string().optional(),
					priority: z.number().min(0).max(1).optional(),
					source: CuriositySourceSchema.optional(),
					// For complete_curiosity / execute_signal
					id: z.string().optional(),
					factsLearned: z.number().optional(),
					gapsFound: z.number().optional(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					item: CuriosityItemSchema.nullable().optional(),
					review: z
						.object({
							completed: z.number(),
							averageRoi: z.number(),
							topImprovements: z.array(
								z.object({
									id: z.string(),
									type: z.string(),
									domain: z.string(),
									suggestedAction: z.string(),
									roi: z.number(),
								}),
							),
						})
						.nullable()
						.optional(),
				}),
			),
	}),
});

// ============================================================================
// Re-exports (schemas live in ../schemas/memory-graph)
// ============================================================================

export type {
	CuriosityItem,
	CuriositySource,
	CuriosityStatus,
	Domain,
	Edge,
	ExpertiseLevel,
	Fact,
	FactType,
	GapDetectedBy,
	GapSeverity,
	MemoryHealth,
	Priority,
	RelationType,
	SearchResult,
	Visibility,
} from "../schemas/memory-graph";
export {
	CuriosityItemSchema,
	CuriositySourceSchema,
	CuriosityStatusSchema,
	DomainSchema,
	EdgeSchema,
	ExpertiseLevelSchema,
	FactSchema,
	FactTypeSchema,
	GapDetectedBySchema,
	GapSeveritySchema,
	MemoryHealthSchema,
	PrioritySchema,
	RelationTypeSchema,
	SearchResultSchema,
	VisibilitySchema,
} from "../schemas/memory-graph";
