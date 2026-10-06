import "@orpc/openapi/extensions/route";
/**
 * Cognitive Stack Contract
 * oRPC contract for knowledge entries, skill entries, and muscle memory.
 *
 * DIFFERENT from:
 * - memory-graph.ts (facts/edges/domains — the raw knowledge graph)
 * - knowledge.ts (app knowledge base search — Firecrawl/Cloudflare AI Search)
 * - tedi-skills.ts (DELETED — R2 skills removed)
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	CognitiveVisibilitySchema,
	KnowledgeEntrySchema,
	KnowledgeEntryTypeSchema,
	MuscleMemoryKindSchema,
	MuscleMemoryOriginSchema,
	MuscleMemorySchema,
	SkillEntrySchema,
	SkillFolderPathSchema,
	SkillLifecycleStateSchema,
	SkillPaceLayerSchema,
	SkillPortfolioBalanceSchema,
	SkillPreconditionsSchema,
	SkillPromotionCandidateSchema,
	SkillRunSchema,
	SkillRunStatusSchema,
	SkillRunSummarySchema,
	SkillWorkflowRetryCandidateSchema,
	SkillScheduleSchema,
	SkillSummarySchema,
	SkillWorkflowArtifactSummarySchema,
	SkillWorkflowReliabilitySchema,
	SkillWorkflowRevisionSchema,
	SkillWorkflowStepSchema,
	SkillWorkflowToolCallSchema,
} from "../schemas/cognitive";
import { JsonValueSchema } from "../schemas/common";

// ============================================================================
// Contract
// ============================================================================

/**
 * One structured finding from the write-time skill validation gate
 * (`validateSkillInput`). Errors reject the write via BAD_REQUEST; warnings
 * are non-blocking and surfaced in record/improve/validate responses.
 */
const SkillValidationIssueSchema = z.object({
	code: z.string(),
	message: z.string(),
	path: z.string().optional(),
});

const SkillMutationWarningsSchema = z
	.array(SkillValidationIssueSchema)
	.optional()
	.describe(
		"Non-blocking write-time lint findings (validate mode did not reject the write)",
	);

const SkillRecordInputSchema = z.object({
	title: z.string().min(1),
	folderPath: SkillFolderPathSchema.optional().describe(
		"Optional catalog folder path. This is organizational metadata and never changes the skill slug or skill:// URI.",
	),
	description: z.string().optional(),
	sourceSkillId: z
		.string()
		.optional()
		.describe(
			"Lineage: canonical skill this entry is derived/copied from (cross-org copies should stamp this so fleet drift is enumerable)",
		),
	sourceRevision: z
		.number()
		.optional()
		.describe("Lineage: the source skill's revision at copy time"),
	content: z.string().describe("Full procedure markdown"),
	files: z
		.record(z.string(), z.string())
		.optional()
		.describe("Supporting files (path → content) for folder-style skills"),
	domain: z.string().optional().describe("Domain name (defaults to general)"),
	tediId: z.string().optional(),
	inputSchema: z.record(z.string(), z.unknown()).optional(),
	visibility: CognitiveVisibilitySchema.optional(),
	agentSkillsFormat: z.string().optional(),
	r2Path: z.string().optional(),
	appId: z.string().optional(),
	appSlug: z
		.string()
		.optional()
		.describe(
			"Human-friendly app slug — used to resolve appId for toolSlugs scope",
		),
	toolIds: z.union([z.array(z.string()), z.string()]).optional(),
	toolSlugs: z
		.array(z.string())
		.optional()
		.describe(
			"Human-friendly tool slugs (matches app_tools.tool_id). Resolved server-side to UUIDs and merged with toolIds. Requires appId or appSlug for resolution scope.",
		),
	summary: z.string().optional(),
	tags: z.union([z.array(z.string()), z.string()]).optional(),
	audience: z.array(z.string()).optional(),
	preconditions: SkillPreconditionsSchema.optional(),
	lifecycleState: SkillLifecycleStateSchema.optional().describe(
		"New skills must start as draft. Non-draft creation is rejected; use verified execution or an explicit human/operator promotion path.",
	),
	validate: z
		.enum(["error", "warn", "skip"])
		.optional()
		.default("error")
		.describe(
			"Validation gate: error throws on issues, warn logs and proceeds, skip bypasses validation",
		),
	force: z
		.boolean()
		.optional()
		.describe(
			"Bypass the near-duplicate gate. Creation is refused when an existing skill has an equivalent title — prefer improve_skills. Set force only for a genuinely distinct procedure.",
		),
});

/**
 * P5 decision hygiene: Klein-2007 premortem note required when a promotion
 * enters the record pace layer (crystallized) or mutates record-layer
 * content. Exported so MCP/aggregate surfaces can derive the exact shape.
 */
export const SkillPremortemSchema = z.object({
	failureModes: z
		.array(z.string().min(8).max(2000))
		.min(2)
		.max(12)
		.describe(
			"Premortem (Klein 2007): assume this promoted skill failed in 30 days — list at least two distinct ways it failed",
		),
	rollback: z
		.string()
		.min(8)
		.max(4000)
		.describe("How this promotion is rolled back when a failure mode fires"),
});

const SkillPremortemGateShape = {
	premortem: SkillPremortemSchema.optional(),
	skipPremortemReason: z
		.string()
		.min(8)
		.max(2000)
		.optional()
		.describe(
			"Operator-only premortem waiver (signed-in human or operator API key), logged into revisionReasoning; agent callers cannot skip",
		),
} as const;

const SkillImproveInputSchema = z.object({
	id: z.string(),
	tediId: z
		.string()
		.optional()
		.describe(
			"Attach an owning tedi to a tedi-less skill (required before the skill can own a native schedule). ATTACH-ONLY: changing an existing owner is rejected — ownership transfer is an authority change and needs a deliberate surface, not an edit field.",
		),
	slug: z
		.string()
		.min(1)
		.max(160)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.optional()
		.describe(
			"Immutable canonical SEP-2640 slug. It may be repeated unchanged by older clients, but renaming is rejected; use skills.move for catalog organization.",
		),
	title: z.string().optional(),
	content: z.string().optional(),
	files: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			"Supporting files (path → content) for folder-style skills. Full overwrite — caller sends the entire desired files map.",
		),
	description: z.string().optional(),
	domain: z.string().optional(),
	visibility: CognitiveVisibilitySchema.optional(),
	revisionReasoning: z.string().optional(),
	inputSchema: z.record(z.string(), z.unknown()).optional(),
	agentSkillsFormat: z.string().optional(),
	appId: z.string().optional(),
	appSlug: z
		.string()
		.optional()
		.describe(
			"Human-friendly app slug — used to resolve appId for toolSlugs scope",
		),
	toolIds: z.union([z.array(z.string()), z.string()]).optional(),
	toolSlugs: z
		.array(z.string())
		.optional()
		.describe(
			"Human-friendly tool slugs (matches app_tools.tool_id). Resolved server-side to UUIDs and merged with toolIds. Requires appId or appSlug for resolution scope.",
		),
	summary: z.string().optional(),
	tags: z.union([z.array(z.string()), z.string()]).optional(),
	audience: z.array(z.string()).optional(),
	preconditions: SkillPreconditionsSchema.optional(),
	lifecycleState: SkillLifecycleStateSchema.optional(),
	paceLayer: SkillPaceLayerSchema.optional().describe(
		"Manual pace-layer override. Auto-derived from lifecycle otherwise; requires force: true and human/operator authority, and is re-derived on the next lifecycle transition.",
	),
	force: z
		.boolean()
		.optional()
		.describe(
			"Human/operator override for execute-to-promote lifecycle gating. Requires user or API-key auth; rejected for agent-authenticated callers.",
		),
	validate: z
		.enum(["error", "warn", "skip"])
		.optional()
		.default("error")
		.describe(
			"Validation gate: error throws on issues, warn logs and proceeds, skip bypasses validation",
		),
	...SkillPremortemGateShape,
});

const SkillWorkflowLifecycleOutputSchema = z.object({
	runId: z.string(),
	status: SkillRunStatusSchema,
	engine: z.record(z.string(), JsonValueSchema).nullable().optional(),
	executionEpoch: z.number().int().min(0).optional(),
	restartId: z.string().optional(),
	restartAborted: z.boolean().optional(),
	deduplicated: z.boolean().optional(),
});

const SkillWorkflowRestartFromSchema = z.object({
	name: z.string().min(1),
	count: z.number().int().min(1).optional(),
	type: z.enum(["do", "sleep", "waitForEvent"]).optional(),
});

export const StatelessDestructiveConfirmationShape = {
	confirmDestructive: z
		.boolean()
		.optional()
		.describe(
			"Explicit confirmation for stateless MCP clients that cannot answer form elicitation",
		),
} as const;

export function destructiveAuditReason(description: string) {
	return z.string().min(1).max(4000).optional().describe(description);
}

const SkillWorkshopProposalRefSchema = z.object({
	id: z.string().optional(),
	slug: z.string().optional(),
});

const SkillWorkshopRecordInputSchema = SkillRecordInputSchema.extend({
	revisionReasoning: z
		.string()
		.optional()
		.describe("Why this proposal should exist"),
});

/**
 * Exact `propose_skill` (skills.proposeWorkshop) input shape. Exported so the
 * trajectory-mining composer tests can assert their payloads parse against
 * the real Workshop contract.
 */
export const SkillWorkshopProposeInputSchema =
	SkillWorkshopRecordInputSchema.omit({ lifecycleState: true });

/**
 * Trajectory mining (WS2): deterministic Agent Workflow Memory-style miner
 * over WS1 evidence-linked rationale episodes. Exported so the miner tests
 * and the aggregate MCP surface can validate/derive the exact tool schema.
 */
export const SkillsMineCandidatesInputSchema = z.object({
	tediId: z
		.string()
		.optional()
		.describe(
			"Scope mining to one tedi's runs and own the created proposals. Required unless dryRun.",
		),
	windowDays: z
		.number()
		.int()
		.min(1)
		.max(90)
		.optional()
		.describe("Episode lookback window in days (default 14)"),
	minSupport: z
		.number()
		.int()
		.min(3)
		.max(50)
		.optional()
		.describe(
			"Minimum DISTINCT successful runs a routine must recur in (floor 3)",
		),
	maxProposals: z
		.number()
		.int()
		.min(1)
		.max(10)
		.optional()
		.describe("Cap on Skill Workshop proposals created per run (default 3)"),
	dryRun: z
		.boolean()
		.optional()
		.describe("Mine and report patterns without creating proposals"),
});

const MinedPatternSchema = z.object({
	key: z.string(),
	tools: z.array(z.string()),
	support: z.number(),
	supportRunIds: z.array(z.string()),
});

export const SkillsMineCandidatesOutputSchema = z.object({
	episodesExamined: z.number(),
	runsExamined: z.number(),
	patterns: z.array(MinedPatternSchema),
	proposed: z.array(SkillEntrySchema),
	skipped: z.array(
		z.object({
			key: z.string(),
			reason: z.string(),
			skillId: z.string().optional(),
			toolNames: z.array(z.string()).optional(),
		}),
	),
});

const SkillWorkshopReviseInputSchema = SkillImproveInputSchema.extend({
	revisionReasoning: z.string().optional().describe("Revision reason"),
});

const SkillWorkshopChangeSchema = z.object({
	code: z.string(),
	field: z.string(),
	before: z.unknown().optional(),
	after: z.unknown().optional(),
	note: z.string().optional(),
});

const SkillWorkshopReviewSchema = z.object({
	id: z.string(),
	applied: z.boolean(),
	changes: z.array(SkillWorkshopChangeSchema),
	entry: SkillEntrySchema.nullable(),
});

const SkillWorkflowImprovementGovernanceSchema = z.object({
	state: z.enum(["pending_human_activation", "activated"]),
	baselineRunId: z.string(),
	baselineSkillId: z.string(),
	baselineRevision: z.number().int().min(0),
	baselineWorkflowSha256: z.string(),
	candidateWorkflowSha256: z.string(),
	humanActivationRequired: z.literal(true),
	certificationRunId: z.string().nullable().optional(),
	certificationPassed: z.boolean(),
});

const SkillWorkflowImprovementValidationSchema = z.object({
	valid: z.boolean(),
	errors: z.array(SkillValidationIssueSchema),
	warnings: z.array(SkillValidationIssueSchema),
});

// ---- Knowledge Entries ----
export const knowledgeContract = oc.route({ tags: ["knowledge"] }).router({
	synthesize: oc
		.route({
			method: "POST",
			path: "/knowledge/synthesize",
			tags: ["cognitive"],
		})
		.input(
			z.object({
				title: z.string().min(1),
				content: z.string().min(1),
				entryType: KnowledgeEntryTypeSchema,
				domain: z.string().describe("Domain name"),
				tediId: z.string().optional(),
				sourceFactIds: z.array(z.string()).optional(),
				confidence: z.number().min(0).max(1).optional().default(0.8),
				visibility: CognitiveVisibilitySchema.optional(),
				tags: z.array(z.string()).optional(),
			}),
		)
		.output(z.object({ entry: KnowledgeEntrySchema })),

	opine: oc
		.route({ method: "POST", path: "/knowledge/opine", tags: ["cognitive"] })
		.input(
			z.object({
				title: z.string().min(1),
				content: z.string().min(1).describe("The opinion content"),
				domain: z.string(),
				tediId: z.string().optional(),
				sourceFactIds: z.array(z.string()).optional(),
				confidence: z.number().min(0).max(1).optional().default(0.7),
				tags: z.array(z.string()).optional(),
			}),
		)
		.output(z.object({ entry: KnowledgeEntrySchema })),

	list: oc
		.route({ method: "POST", path: "/knowledge/list", tags: ["cognitive"] })
		.input(
			z.object({
				domain: z.string().optional(),
				tediId: z.string().optional(),
				entryType: KnowledgeEntryTypeSchema.optional(),
				query: z.string().optional().describe("Text search"),
				limit: z.number().optional(),
			}),
		)
		.output(z.object({ entries: z.array(KnowledgeEntrySchema) })),

	get: oc
		.route({ method: "GET", path: "/knowledge/get", tags: ["cognitive"] })
		.input(z.object({ id: z.string() }))
		.output(z.object({ entry: KnowledgeEntrySchema.nullable() })),
});

// ---- Skill Entries ----
export const skillsContract = oc.route({ tags: ["skills"] }).router({
	record: oc
		.route({ method: "POST", path: "/skills/record", tags: ["cognitive"] })
		.input(SkillRecordInputSchema)
		.output(
			z.object({
				entry: SkillEntrySchema,
				warnings: SkillMutationWarningsSchema,
			}),
		),

	improve: oc
		.route({ method: "POST", path: "/skills/improve", tags: ["cognitive"] })
		.input(SkillImproveInputSchema)
		.output(
			z.object({
				entry: SkillEntrySchema,
				warnings: SkillMutationWarningsSchema,
			}),
		),

	proposeWorkshop: oc
		.route({
			method: "POST",
			path: "/skills/workshop/propose",
			tags: ["cognitive"],
			summary: "Create a tedi-scoped Skill Workshop proposal",
			description:
				"Creates a tedi-scoped draft skill proposal. The proposal is not active org guidance until applyWorkshop promotes it into the baseline skill library.",
		})
		.input(SkillWorkshopProposeInputSchema)
		.output(z.object({ entry: SkillEntrySchema })),

	mineCandidates: oc
		.route({
			method: "POST",
			path: "/skills/mine-candidates",
			tags: ["cognitive"],
			summary:
				"Mine recurring tool-call routines into Skill Workshop proposals",
			description:
				"Deterministic trajectory miner (WS2): extracts recurring successful tool-call sequences from WS1 evidence-linked rationale episodes and creates tedi-scoped draft Skill Workshop proposals (with toolIds and run evidence) for routines that recur in >=3 distinct proof-carrying runs. Never auto-applies; apply_skill_proposal remains the disposer gate (human/apikey, or a tedi distinct from the proposal author).",
		})
		.input(SkillsMineCandidatesInputSchema)
		.output(SkillsMineCandidatesOutputSchema),

	portfolioBalance: oc
		.route({
			method: "GET",
			path: "/skills/portfolio-balance",
			tags: ["cognitive"],
			summary: "Pace-layer portfolio balance vs the 75/20/5 healthy envelope",
			description:
				"Read-only distribution of non-archived skills across the innovation/differentiation/record pace layers vs the ~75/20/5 healthy envelope (record-heavy), with a mechanical stagnation flag: all-innovation = churn without compounding, all-record = rigidity without learning. Org-wide by default — org-scoped skills have no tediId and a tedi filter silently misses them.",
		})
		.input(
			z.object({
				tediId: z
					.string()
					.optional()
					.describe(
						"Restrict to one tedi's skills. Omit for the org-wide portfolio (recommended).",
					),
			}),
		)
		.output(SkillPortfolioBalanceSchema),

	proposeWorkflowImprovement: oc
		.route({
			method: "POST",
			path: "/skills/workflow-improvements/propose",
			tags: ["cognitive"],
			summary:
				"Propose a validated workflow revision from observed run evidence",
			description:
				"Creates a tedi-owned draft against the exact skill revision observed by baselineRunId. It cannot activate itself.",
		})
		.input(
			z.object({
				baselineRunId: z.string().min(1),
				tediId: z.string().optional(),
				reason: z.string().min(1).max(4000),
				content: z.string().min(1).describe("Candidate SKILL.md content"),
				files: z
					.record(z.string(), z.string())
					.refine((files) => "scripts/workflow.ts" in files, {
						message: "files['scripts/workflow.ts'] is required",
					}),
				description: z.string().optional(),
				summary: z.string().optional(),
				tags: z.array(z.string()).optional(),
			}),
		)
		.output(
			z.object({
				proposal: SkillEntrySchema,
				validation: SkillWorkflowImprovementValidationSchema,
				governance: SkillWorkflowImprovementGovernanceSchema,
			}),
		),

	inspectWorkflowImprovement: oc
		.route({
			method: "GET",
			path: "/skills/workflow-improvements/inspect",
			tags: ["cognitive"],
			summary: "Inspect a workflow improvement proposal and its baseline",
		})
		.input(z.object({ id: z.string().min(1), tediId: z.string().optional() }))
		.output(
			z.object({
				proposal: SkillEntrySchema,
				baseline: SkillEntrySchema,
				validation: SkillWorkflowImprovementValidationSchema,
				stale: z.boolean(),
				governance: SkillWorkflowImprovementGovernanceSchema,
			}),
		),

	activateWorkflowImprovement: oc
		.route({
			method: "POST",
			path: "/skills/workflow-improvements/activate",
			tags: ["cognitive"],
			summary: "Human-activate a certified workflow improvement",
			description:
				"Updates the canonical baseline in place only when a human user activates it, the baseline revision is unchanged, and a candidate run reports passing correctness certification. Stateless clients must explicitly confirm this destructive activation.",
		})
		.input(
			z.object({
				...StatelessDestructiveConfirmationShape,
				id: z.string().min(1),
				certificationRunId: z.string().min(1),
				reason: z.string().min(1).max(4000),
			}),
		)
		.output(
			z.object({
				baseline: SkillEntrySchema,
				proposal: SkillEntrySchema,
				governance: SkillWorkflowImprovementGovernanceSchema,
			}),
		),

	inspectWorkshop: oc
		.route({
			method: "GET",
			path: "/skills/workshop/inspect",
			tags: ["cognitive"],
			summary: "Inspect a Skill Workshop proposal without mutation",
		})
		.input(SkillWorkshopProposalRefSchema)
		.output(
			z.object({
				entry: SkillEntrySchema,
				validation: z.object({
					valid: z.boolean(),
					errors: z.array(
						z.object({
							code: z.string(),
							message: z.string(),
							path: z.string().optional(),
						}),
					),
					warnings: z.array(
						z.object({
							code: z.string(),
							message: z.string(),
							path: z.string().optional(),
						}),
					),
				}),
				promotion: SkillWorkshopReviewSchema,
			}),
		),

	reviseWorkshop: oc
		.route({
			method: "PATCH",
			path: "/skills/workshop/revise",
			tags: ["cognitive"],
			summary: "Revise a pending Skill Workshop proposal",
		})
		.input(
			SkillWorkshopReviseInputSchema.omit({
				lifecycleState: true,
				// Revise always resets to draft (a demotion); the premortem gate
				// belongs to promote/apply/improve/crystallize.
				premortem: true,
				skipPremortemReason: true,
			}),
		)
		.output(z.object({ entry: SkillEntrySchema })),

	applyWorkshop: oc
		.route({
			method: "POST",
			path: "/skills/workshop/apply",
			tags: ["cognitive"],
			summary: "Apply a Skill Workshop proposal into the org skill library",
		})
		.input(
			SkillWorkshopProposalRefSchema.extend({
				visibility: CognitiveVisibilitySchema.optional().default("org"),
				lifecycleState: SkillLifecycleStateSchema.optional().describe(
					"Target lifecycle state. Defaults to active, while preserving proven/crystallized proposals.",
				),
				supersedesId: z.string().nullable().optional(),
				revisionReasoning: z
					.string()
					.optional()
					.describe("Reason this proposal is accepted into the org library"),
				...SkillPremortemGateShape,
			}),
		)
		.output(SkillWorkshopReviewSchema),

	rejectWorkshop: oc
		.route({
			method: "POST",
			path: "/skills/workshop/reject",
			tags: ["cognitive"],
			summary: "Reject a pending Skill Workshop proposal",
		})
		.input(
			z.object({
				id: z.string(),
				reason: z.string().min(1),
			}),
		)
		.output(z.object({ entry: SkillEntrySchema })),

	quarantineWorkshop: oc
		.route({
			method: "POST",
			path: "/skills/workshop/quarantine",
			tags: ["cognitive"],
			summary: "Quarantine a risky Skill Workshop proposal",
		})
		.input(
			z.object({
				id: z.string(),
				reason: z.string().min(1),
			}),
		)
		.output(z.object({ entry: SkillEntrySchema })),

	delete: oc
		.route({ method: "POST", path: "/skills/delete", tags: ["cognitive"] })
		.input(z.object({ id: z.string() }))
		.output(z.object({ success: z.boolean() })),

	get: oc
		.route({
			method: "GET",
			path: "/skills/get",
			tags: ["cognitive"],
			summary: "Get an organization skill for the control plane",
		})
		.input(z.object({ id: z.string() }))
		.output(z.object({ entry: SkillEntrySchema.nullable() })),

	move: oc
		.route({
			method: "POST",
			path: "/skills/move",
			tags: ["cognitive"],
			summary: "Move a skill within the catalog hierarchy",
		})
		.input(
			z.object({
				id: z.string(),
				folderPath: SkillFolderPathSchema.nullable().describe(
					"Destination catalog folder, or null for the catalog root. The immutable skill slug and URI are preserved.",
				),
			}),
		)
		.output(z.object({ entry: SkillEntrySchema })),

	listByOrg: oc
		.route({ method: "GET", path: "/skills/list-by-org", tags: ["cognitive"] })
		.input(
			z
				.object({
					limit: z.number().optional(),
					offset: z.number().optional(),
					query: z
						.string()
						.trim()
						.max(120)
						.optional()
						.describe(
							"Optional title, slug, description, or folder-path search",
						),
					folderPath: SkillFolderPathSchema.nullable()
						.optional()
						.describe(
							"Filter by catalog folder. Null selects the root; omit to search all folders.",
						),
					recursive: z
						.boolean()
						.optional()
						.describe("Include descendant folders when folderPath is set"),
					visibility: CognitiveVisibilitySchema.optional(),
					appId: z.string().optional(),
					domain: z.string().optional().describe("Filter by domain name"),
					tediId: z.string().optional().describe("Filter by tedi ID"),
					lifecycleState: SkillLifecycleStateSchema.optional().describe(
						"Filter by lifecycle state",
					),
					summary: z
						.boolean()
						.optional()
						.describe(
							"Compact projection for agent context budgets: truncates `content` to a short preview (marked with a read_skill pointer) and nulls `files`. Use read_skill for the full SKILL.md once you know which skill you need.",
						),
				})
				// Strict: see skillsContract.find — a silently dropped filter on a
				// collection read reads as an honest empty scope to the caller.
				.strict(),
		)
		.output(
			z.object({
				entries: z.array(SkillEntrySchema),
				total: z.number(),
			}),
		),

	listByApp: oc
		.route({ method: "GET", path: "/skills/list-by-app", tags: ["cognitive"] })
		.input(
			z
				.object({
					appId: z.string().optional(),
					appSlug: z.string().optional().describe("Human-friendly app slug"),
					tediId: z
						.string()
						.optional()
						.describe("Caller tedi ID for personalized skill resolution"),
					summaryOnly: z.boolean().optional(),
					slugs: z
						.array(z.string())
						.min(1)
						.max(50)
						.optional()
						.describe("Exact app-scoped skill slugs to return"),
					lifecycleState: SkillLifecycleStateSchema.optional().describe(
						"Filter by lifecycle state",
					),
					limit: z.number().optional(),
				})
				// Strict: see skillsContract.find — a silently dropped filter on a
				// collection read reads as an honest empty scope to the caller.
				.strict(),
		)
		.output(
			z.object({
				skills: z.array(SkillEntrySchema),
				summaries: z.array(SkillSummarySchema).optional(),
			}),
		),

	/**
	 * Batched {@link listByApp} for surfaces that enrich many apps at once.
	 *
	 * The MCP aggregate rebuild enriches ~40 apps and was issuing one
	 * `listByApp` per app. Each apps/api invocation pays a per-isolate startup
	 * cost, so that fan-out blew client timeouts.
	 * `summaryOnly` is implied — the fan-out only ever wanted summaries.
	 */
	listSummariesByApps: oc
		.route({
			method: "POST",
			path: "/skills/list-summaries-by-apps",
			tags: ["cognitive"],
		})
		.input(
			z.object({
				appIds: z.array(z.string()).min(1).max(200),
				tediId: z
					.string()
					.optional()
					.describe("Caller tedi ID for personalized skill resolution"),
				lifecycleState: SkillLifecycleStateSchema.optional(),
				limit: z.number().optional().describe("Per-app cap, not a total cap"),
			}),
		)
		.output(
			z.object({
				// Keyed by appId. Every requested id is present; apps with no
				// readable skills map to an empty array, so a caller can tell
				// "none" from "not asked for" without a second lookup.
				summariesByApp: z.record(z.string(), z.array(SkillSummarySchema)),
			}),
		),

	listPromotionCandidates: oc
		.route({
			method: "GET",
			path: "/skills/list-promotion-candidates",
			tags: ["cognitive"],
			summary:
				"List tedi-scoped skills that are eligible for org-library promotion review.",
		})
		.input(
			z.object({
				tediId: z
					.string()
					.optional()
					.describe(
						"Optional tedi ID. Omit to list candidates across the org.",
					),
				appId: z.string().optional(),
				appSlug: z.string().optional().describe("Human-friendly app slug"),
				lifecycleStates: z
					.array(SkillLifecycleStateSchema)
					.optional()
					.default(["active", "proven"])
					.describe("Candidate lifecycle states to include."),
				minSuccessCount: z
					.number()
					.min(0)
					.optional()
					.default(1)
					.describe("Minimum successful uses required for candidacy."),
				limit: z.number().min(1).max(200).optional().default(50),
				offset: z.number().min(0).optional().default(0),
			}),
		)
		.output(
			z.object({
				entries: z.array(SkillPromotionCandidateSchema),
				total: z.number(),
				limit: z.number(),
				offset: z.number(),
				minSuccessCount: z.number(),
				lifecycleStates: z.array(SkillLifecycleStateSchema),
			}),
		),

	auditLowQuality: oc
		.route({
			method: "POST",
			path: "/skills/audit-low-quality",
			tags: ["cognitive"],
			summary:
				"Audit active skills for low-quality crystallization or auto-bridge artifacts.",
		})
		.input(
			z.object({
				tediId: z.string().optional(),
				appId: z.string().optional(),
				appSlug: z.string().optional().describe("Human-friendly app slug"),
				ownership: z
					.enum(["all", "baseline", "tedi-scoped"])
					.optional()
					.default("all")
					.describe(
						"Which ownership tier to audit. Baseline means tediId is null; tedi-scoped means tediId is set.",
					),
				slug: z
					.string()
					.optional()
					.describe("Optional exact skill slug for targeted review."),
				lifecycleStates: z
					.array(SkillLifecycleStateSchema)
					.optional()
					.default(["active"])
					.describe("Lifecycle states to audit."),
				maxSuccessCount: z
					.number()
					.min(0)
					.optional()
					.default(1)
					.describe("Maximum successful uses for the unproven-active rule."),
				minSlugLength: z
					.number()
					.min(1)
					.optional()
					.default(60)
					.describe("Minimum slug length for the sentence-slug rule."),
				orphanOlderThanDays: z
					.number()
					.min(1)
					.optional()
					.default(30)
					.describe("Age threshold for never-used orphan skills."),
				limit: z.number().min(1).max(200).optional().default(50),
				offset: z.number().min(0).optional().default(0),
				archive: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Archive matched candidates. Requires slug or confirmBulkArchive.",
					),
				confirmBulkArchive: z
					.boolean()
					.optional()
					.default(false)
					.describe("Required for archive=true without an exact slug."),
			}),
		)
		.output(
			z.object({
				applied: z.boolean(),
				archivedCount: z.number(),
				candidates: z.array(
					z.object({
						id: z.string(),
						title: z.string(),
						slug: z.string().nullable().optional(),
						description: z.string().nullable().optional(),
						tediId: z.string().nullable().optional(),
						appId: z.string().nullable().optional(),
						lifecycleState: SkillLifecycleStateSchema.nullable().optional(),
						visibility: CognitiveVisibilitySchema,
						successCount: z.number(),
						failureCount: z.number(),
						lastUsedAt: z.string().nullable().optional(),
						createdAt: z.string().nullable().optional(),
						updatedAt: z.string().nullable().optional(),
						score: z.number(),
						reasons: z.array(
							z.object({
								code: z.enum([
									"LONG_SENTENCE_SLUG",
									"ORPHANED_UNUSED",
									"UNPROVEN_ACTIVE",
									"WEAK_DESCRIPTION",
								]),
								note: z.string(),
							}),
						),
					}),
				),
				limit: z.number(),
				offset: z.number(),
				ownership: z.enum(["all", "baseline", "tedi-scoped"]),
				scanned: z.number(),
				total: z.number(),
				warnings: z.array(z.string()),
			}),
		),

	sweepDraftTtl: oc
		.route({
			method: "POST",
			path: "/skills/sweep-draft-ttl",
			tags: ["cognitive"],
			summary:
				"Archive zero-usage draft skills past their TTL (execute-to-promote draft expiry).",
		})
		.input(
			z.object({
				olderThanDays: z
					.number()
					.min(0)
					.max(365)
					.optional()
					.default(14)
					.describe(
						"Archive drafts with zero recorded usage events and no update for this many days. 0 archives every current zero-use draft.",
					),
				dryRun: z.boolean().optional().default(true),
				limit: z.number().min(1).max(1000).optional().default(500),
			}),
		)
		.output(
			z.object({
				applied: z.boolean(),
				archived: z.number(),
				cutoff: z.string(),
				entries: z.array(
					z.object({
						id: z.string(),
						organizationId: z.string(),
						tediId: z.string().nullable().optional(),
						slug: z.string().nullable().optional(),
						title: z.string(),
						updatedAt: z.string().nullable().optional(),
					}),
				),
			}),
		),

	getForMcp: oc
		.route({ method: "GET", path: "/skills/get-for-mcp", tags: ["cognitive"] })
		.input(
			z.object({
				id: z.string().optional(),
				slug: z.string().optional(),
				tediId: z.string().optional(),
			}),
		)
		.output(z.object({ entry: SkillEntrySchema.nullable() })),

	find: oc
		.route({ method: "POST", path: "/skills/find", tags: ["cognitive"] })
		.input(
			z
				.object({
					query: z
						.string()
						.min(1)
						.describe("Search by title/description/content"),
					tediId: z
						.string()
						.optional()
						.describe("Caller tedi ID for visibility filtering"),
					appId: z
						.string()
						.optional()
						.describe("Scope search to a specific app"),
					limit: z.number().optional(),
					summary: z
						.boolean()
						.optional()
						.describe(
							"Default true: entries carry a truncated content preview (marked with a fetch pointer) and null files, keeping broad searches inside agent context budgets. Pass false for full SKILL.md bodies.",
						),
				})
				// Strict: a dropped filter on a collection read is indistinguishable
				// from an honest empty scope, so an undeclared key must fail loudly
				// rather than return an unfiltered page.
				.strict(),
		)
		.output(z.object({ entries: z.array(SkillEntrySchema) })),

	usage: oc
		.route({ method: "POST", path: "/skills/usage", tags: ["cognitive"] })
		.input(
			z.object({
				id: z.string(),
				success: z.boolean(),
				durationMs: z.number().optional(),
				tediId: z
					.string()
					.optional()
					.describe(
						"Tedi that executed the skill; defaults to the skill's owner tedi",
					),
				runId: z
					.string()
					.optional()
					.describe(
						"Correlation/idempotency identifier for direct telemetry; generated when omitted. It is not promotion evidence.",
					),
				error: z
					.string()
					.optional()
					.describe("Failure reason recorded on the usage event"),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				recorded: z
					.boolean()
					.describe(
						"False when this runId was already stamped (idempotent replay)",
					),
				runId: z.string(),
				promotionEligible: z
					.boolean()
					.describe(
						"Always false for direct self-reports; lifecycle advancement requires canonical terminal workflow evidence.",
					),
			}),
		),

	preview: oc
		.route({ method: "POST", path: "/skills/preview", tags: ["cognitive"] })
		.input(
			z.object({
				// Either preview an update to an existing skill (id) or a fresh draft.
				id: z
					.string()
					.optional()
					.describe("Existing skill id — preview an update"),
				slug: z
					.string()
					.optional()
					.describe("Existing skill slug — preview an update"),
				title: z.string().optional(),
				description: z.string().optional(),
				content: z.string().optional().describe("Full procedure markdown"),
				files: z.record(z.string(), z.string()).optional(),
				domain: z.string().optional(),
				tediId: z.string().optional(),
				inputSchema: z.record(z.string(), z.unknown()).optional(),
				visibility: CognitiveVisibilitySchema.optional(),
				agentSkillsFormat: z.string().optional(),
				r2Path: z.string().optional(),
				appId: z.string().optional(),
				appSlug: z.string().optional(),
				toolIds: z.union([z.array(z.string()), z.string()]).optional(),
				toolSlugs: z.array(z.string()).optional(),
				summary: z.string().optional(),
				tags: z.union([z.array(z.string()), z.string()]).optional(),
				audience: z.array(z.string()).optional(),
				preconditions: SkillPreconditionsSchema.optional(),
				lifecycleState: SkillLifecycleStateSchema.optional(),
			}),
		)
		.output(
			z.object({
				valid: z.boolean(),
				errors: z.array(
					z.object({
						code: z.string(),
						message: z.string(),
						path: z.string().optional(),
					}),
				),
				warnings: z.array(
					z.object({
						code: z.string(),
						message: z.string(),
						path: z.string().optional(),
					}),
				),
				rendered: z.object({
					slug: z.string(),
					skillUri: z.string(),
					frontmatter: z.record(z.string(), JsonValueSchema),
					skillMd: z.string(),
					indexEntry: z.object({
						url: z.string(),
						digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
						frontmatter: z.record(z.string(), JsonValueSchema),
						archives: z
							.array(
								z.object({
									url: z.string(),
									mimeType: z.string(),
									digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
								}),
							)
							.optional(),
					}),
					resolvedToolIds: z.array(z.string()),
					files: z.record(z.string(), z.string()).optional(),
				}),
			}),
		),

	auditToolCoverage: oc
		.route({
			method: "GET",
			path: "/skills/audit-tool-coverage",
			tags: ["cognitive"],
			summary:
				"Read-only audit of skill-to-tool coverage, MCP tool metadata, and read-only outputSchema coverage.",
		})
		.input(
			z.object({
				appId: z.string().optional(),
				appSlug: z
					.string()
					.optional()
					.describe("Optional app slug for app-scoped tool coverage"),
				tediId: z
					.string()
					.optional()
					.describe("Optional tedi scope for skill filtering"),
				limit: z.number().min(1).max(500).optional(),
				summary: z
					.boolean()
					.optional()
					.default(false)
					.describe("Return counts only, omitting detailed entity lists."),
				includeExcludedTools: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Include tools explicitly excluded from skill coverage in the coverage denominator.",
					),
			}),
		)
		.output(
			z.object({
				appId: z.string().nullable(),
				appSlug: z.string().nullable(),
				summaryOnly: z.boolean(),
				skillCount: z.number(),
				toolCount: z.number(),
				excludedToolCount: z.number(),
				coveredToolCount: z.number(),
				uncoveredToolCount: z.number(),
				skillsWithoutToolCoverage: z.array(
					z.object({
						id: z.string(),
						slug: z.string().nullable().optional(),
						title: z.string(),
						hasWorkflow: z.boolean(),
					}),
				),
				toolsWithoutSkillCoverage: z.array(
					z.object({
						id: z.string(),
						toolId: z.string(),
						title: z.string(),
						readOnly: z.boolean(),
						hasOutputSchema: z.boolean(),
					}),
				),
				readOnlyToolsMissingOutputSchema: z.array(
					z.object({
						id: z.string(),
						toolId: z.string(),
						title: z.string(),
					}),
				),
				skillsWithUnresolvedToolMetadata: z.array(
					z.object({
						id: z.string(),
						slug: z.string().nullable().optional(),
						title: z.string(),
						toolNames: z.array(z.string()),
					}),
				),
				warnings: z.array(z.string()),
			}),
		),

	repair: oc
		.route({
			method: "POST",
			path: "/skills/repair",
			tags: ["cognitive"],
			summary: "Repair a stored skill and reconcile its manifest projections",
		})
		.input(
			z.object({
				id: z.string().optional(),
				slug: z.string().optional(),
				dryRun: z.boolean().optional().default(true),
			}),
		)
		.output(
			z.object({
				id: z.string(),
				applied: z.boolean(),
				changes: z.array(
					z.object({
						code: z.string(),
						field: z.string(),
						before: z.unknown().optional(),
						after: z.unknown().optional(),
						note: z.string().optional(),
					}),
				),
				entry: SkillEntrySchema.nullable(),
			}),
		),

	promote: oc
		.route({
			method: "POST",
			path: "/skills/promote",
			tags: ["cognitive"],
			summary:
				"Promote a tedi-scoped candidate skill into a baseline org-library skill.",
		})
		.input(
			z.object({
				id: z.string().optional(),
				slug: z.string().optional(),
				dryRun: z.boolean().optional().default(true),
				visibility: CognitiveVisibilitySchema.optional().default("org"),
				lifecycleState: SkillLifecycleStateSchema.optional().describe(
					"Target lifecycle state. Defaults to active, while preserving proven/crystallized candidates.",
				),
				supersedesId: z
					.string()
					.nullable()
					.optional()
					.describe(
						"Optional baseline skill id that this promotion supersedes",
					),
				revisionReasoning: z
					.string()
					.optional()
					.describe("Reason this candidate is accepted into the org library"),
				force: z
					.boolean()
					.optional()
					.describe(
						"Human/operator override for execute-to-promote lifecycle gating. Requires user or API-key auth; rejected for agent-authenticated callers.",
					),
				...SkillPremortemGateShape,
			}),
		)
		.output(
			z.object({
				id: z.string(),
				applied: z.boolean(),
				changes: z.array(
					z.object({
						code: z.string(),
						field: z.string(),
						before: z.unknown().optional(),
						after: z.unknown().optional(),
						note: z.string().optional(),
					}),
				),
				entry: SkillEntrySchema.nullable(),
			}),
		),

	runWorkflow: oc
		.route({
			method: "POST",
			path: "/skills/run-workflow",
			tags: ["cognitive"],
		})
		.input(
			z.object({
				...StatelessDestructiveConfirmationShape,
				reason: destructiveAuditReason(
					"Audit reason for the confirmed workflow dispatch",
				),
				runId: z
					.string()
					.uuid()
					.optional()
					.describe(
						"Caller-supplied stable run id for safely retrying a dispatch. When both fields are supplied, runId is the explicit workflow identity and idempotencyKey is retained as audit context.",
					),
				idempotencyKey: z
					.string()
					.min(1)
					.max(128)
					.optional()
					.describe(
						"Stable caller key forwarded to the runtime for idempotent admission. When runId is absent, the runtime derives an opaque identity from organization, skill, tedi, and this key.",
					),
				workItemId: z
					.string()
					.uuid()
					.optional()
					.describe(
						"Canonical Work Item admitted with the flow and propagated automatically to every workflow MCP call and artifact receipt.",
					),
				skillId: z
					.string()
					.optional()
					.describe("Skill UUID — provide either skillId or slug"),
				slug: z
					.string()
					.optional()
					.describe("Skill slug — alternative to skillId"),
				tediId: z.string().describe("Tedi that owns this run"),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Input params for the workflow"),
			}),
		)
		.output(
			z.object({
				runId: z.string(),
				workflowInstanceId: z.string(),
				status: SkillRunStatusSchema,
				idempotencyKey: z.string().nullable().optional(),
				workItemId: z.string().nullable(),
				deduplicated: z.boolean(),
			}),
		),

	runWorkflowStatus: oc
		.route({
			method: "GET",
			path: "/skills/run-workflow-status",
			tags: ["cognitive"],
		})
		.input(z.object({ runId: z.string(), tediId: z.string().optional() }))
		.output(SkillRunSchema),

	/** Human observation of an effect after a canonical terminal workflow run. */
	recordRunEffectObservation: oc
		.route({
			method: "POST",
			path: "/skills/run-effect-observation",
			tags: ["cognitive"],
		})
		.input(
			z.strictObject({
				runId: z.uuid(),
				observedState: z.enum(["confirmed", "contradicted", "uncertain"]),
				evidenceRef: z.string().trim().min(1).max(300),
				effectNote: z.string().trim().min(1).max(1500),
			}),
		)
		.output(
			z.strictObject({
				id: z.uuid(),
				runId: z.uuid(),
				workItemId: z.uuid(),
				observedState: z.enum(["confirmed", "contradicted", "uncertain"]),
				source: z.literal("human_attestation"),
				observedAt: z.iso.datetime(),
			}),
		),

	/** Advisory semantic alignment, never proof of task success or promotion. */
	getRunUsefulness: oc
		.route({
			method: "GET",
			path: "/skills/run-usefulness",
			tags: ["cognitive"],
		})
		.input(z.strictObject({ runId: z.uuid() }))
		.output(
			z.strictObject({
				runId: z.uuid(),
				workItemId: z
					.uuid()
					.nullable()
					.describe(
						"Null when the canonical run has no linked Work Item; assessment abstains before inference.",
					),
				alignment: z.enum(["supports", "contradicts", "unknown"]),
				reason: z.enum([
					"unlinked",
					"not_terminal",
					"no_accepted_outcome",
					"no_observation",
					"evidence_overflow",
					"model_unavailable",
					"assessment",
				]),
				evidenceSource: z.enum(["human_attestation", "none"]),
				observationIds: z.array(z.uuid()).max(5),
			}),
		),

	runWorkflowCancel: oc
		.route({
			method: "POST",
			path: "/skills/run-workflow-cancel",
			tags: ["cognitive"],
		})
		.input(
			z.object({
				...StatelessDestructiveConfirmationShape,
				reason: destructiveAuditReason(
					"Audit reason for the confirmed workflow cancellation",
				),
				runId: z.string(),
				tediId: z.string().optional(),
				rollback: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Run registered Cloudflare Workflow rollback handlers before termination",
					),
			}),
		)
		.output(
			z.object({
				runId: z.string(),
				status: SkillRunStatusSchema,
				engine: z.record(z.string(), JsonValueSchema).nullable().optional(),
				cancellation: z
					.object({
						state: z.literal("stopping"),
						durable: z.literal(true),
					})
					.optional()
					.describe(
						"The cancellation intent is durable, but the runtime has not yet confirmed termination. Poll runWorkflowStatus for the terminal outcome.",
					),
			}),
		),

	runWorkflowSendEvent: oc
		.route({
			method: "POST",
			path: "/skills/run-workflow-send-event",
			tags: ["cognitive"],
		})
		.input(
			z.object({
				...StatelessDestructiveConfirmationShape,
				reason: destructiveAuditReason(
					"Audit reason for the confirmed workflow event",
				),
				runId: z.string(),
				tediId: z.string().optional(),
				type: z
					.string()
					.min(1)
					.describe(
						"Event type matched by step.waitForEvent (e.g. 'content-approved')",
					),
				payload: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.output(z.object({ ok: z.boolean() })),

	runWorkflowHistory: oc
		.route({
			method: "GET",
			path: "/skills/run-workflow-history",
			tags: ["cognitive"],
			summary:
				"List recent workflow runs — org-wide fleet view when no tedi/skill filter is given",
		})
		.input(
			z.object({
				tediId: z
					.string()
					.optional()
					.describe("Filter to one tedi's runs (optionally with skillId)"),
				skillId: z.string().optional().describe("Filter to one skill's runs"),
				skillTag: z
					.string()
					.min(1)
					.max(100)
					.optional()
					.describe("Filter to runs whose skill carries this exact tag"),
				status: SkillRunStatusSchema.optional(),
				limit: z.number().int().min(1).max(200).optional().default(50),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.default(0)
					.describe("Number of persisted history rows to skip"),
				reconcile: z
					.boolean()
					.optional()
					.default(true)
					.describe(
						"Set false for a strictly read-only snapshot of persisted run history; no workflow engine reconciliation or repair is attempted.",
					),
			}),
		)
		.output(z.object({ runs: z.array(SkillRunSummarySchema) })),

	listWorkflowRetryCandidates: oc
		.route({
			method: "GET",
			path: "/skills/list-workflow-retry-candidates",
			tags: ["cognitive"],
			summary:
				"List failed skill workflow runs whose canonical engine state is restartable",
			description:
				"Returns exact run/tedi/epoch identity and an epoch-bound restartId after reconciling each bounded candidate with the workflow engine. This is the safe retry inbox; clients must not infer retry eligibility from generic history.",
		})
		.input(
			z.object({
				limit: z.number().int().min(1).max(50).optional().default(20),
			}),
		)
		.output(
			z.object({ candidates: z.array(SkillWorkflowRetryCandidateSchema) }),
		),

	inspectWorkflowRun: oc
		.route({
			method: "GET",
			path: "/skills/inspect-workflow-run",
			tags: ["cognitive"],
			summary: "Inspect one workflow run and its agent-readable evidence",
		})
		.input(
			z.object({
				runId: z.string(),
				tediId: z.string().optional(),
				includeSource: z.boolean().optional().default(false),
				includeArtifactContent: z.boolean().optional().default(false),
			}),
		)
		.output(
			z.object({
				run: SkillRunSchema,
				revision: SkillWorkflowRevisionSchema,
				workflowSource: z.string().nullable().optional(),
				skillDoc: z.string().nullable().optional(),
				artifacts: z.array(SkillWorkflowArtifactSummarySchema),
				steps: z.array(SkillWorkflowStepSchema),
				toolCalls: z.array(SkillWorkflowToolCallSchema),
				warnings: z.array(z.string()),
			}),
		),

	listWorkflowSteps: oc
		.route({
			method: "GET",
			path: "/skills/list-workflow-steps",
			tags: ["cognitive"],
			summary: "List durable step, retry, rollback, sleep, and wait records",
		})
		.input(
			z.object({
				runId: z.string(),
				tediId: z.string().optional(),
				name: z.string().optional(),
				kind: SkillWorkflowStepSchema.shape.kind.optional(),
				limit: z.number().int().min(1).max(500).optional().default(200),
				offset: z.number().int().min(0).optional().default(0),
				includeContent: z.boolean().optional().default(true),
			}),
		)
		.output(
			z.object({
				steps: z.array(SkillWorkflowStepSchema),
				truncated: z.boolean(),
				nextOffset: z.number().int().min(0).nullable(),
			}),
		),

	listWorkflowToolCalls: oc
		.route({
			method: "GET",
			path: "/skills/list-workflow-tool-calls",
			tags: ["cognitive"],
			summary: "List MCP tool-call receipts recorded by workflow steps",
		})
		.input(
			z.object({
				runId: z.string(),
				tediId: z.string().optional(),
				stepName: z.string().optional(),
				attempt: z.number().int().min(1).optional(),
				limit: z.number().int().min(1).max(500).optional().default(200),
				offset: z.number().int().min(0).optional().default(0),
				includeContent: z.boolean().optional().default(true),
			}),
		)
		.output(
			z.object({
				toolCalls: z.array(SkillWorkflowToolCallSchema),
				truncated: z.boolean(),
				nextOffset: z.number().int().min(0).nullable(),
			}),
		),

	listWorkflowRevisions: oc
		.route({
			method: "GET",
			path: "/skills/list-workflow-revisions",
			tags: ["cognitive"],
			summary: "List workflow revisions observed on executed runs",
			description:
				"Requires skillId or slug. tediId optionally narrows the executed-run sample and is injected by a tedi-prefixed MCP namespace.",
		})
		.input(
			z.object({
				skillId: z
					.string()
					.optional()
					.describe("Required unless slug is provided"),
				slug: z
					.string()
					.optional()
					.describe("Required unless skillId is provided"),
				tediId: z.string().optional(),
				limit: z.number().int().min(1).max(200).optional().default(100),
			}),
		)
		.output(
			z.object({
				provenance: z.literal("observed_executed_runs"),
				sampledRunCount: z.number().int().min(0),
				mayBeTruncated: z.boolean(),
				revisions: z.array(SkillWorkflowRevisionSchema),
			}),
		),

	getWorkflowRevision: oc
		.route({
			method: "GET",
			path: "/skills/get-workflow-revision",
			tags: ["cognitive"],
			summary: "Read the pinned workflow revision from one executed run",
		})
		.input(
			z.object({
				runId: z.string(),
				tediId: z.string().optional(),
				includeSource: z.boolean().optional().default(true),
			}),
		)
		.output(
			z.object({
				provenance: z.literal("observed_executed_run"),
				revision: SkillWorkflowRevisionSchema,
				workflowSource: z.string().nullable().optional(),
				skillDoc: z.string().nullable().optional(),
			}),
		),

	compareWorkflowRevisions: oc
		.route({
			method: "GET",
			path: "/skills/compare-workflow-revisions",
			tags: ["cognitive"],
			summary: "Compare pinned revisions from two executed workflow runs",
		})
		.input(
			z.object({
				baselineRunId: z.string(),
				candidateRunId: z.string(),
				tediId: z.string().optional(),
				includeSource: z.boolean().optional().default(false),
			}),
		)
		.output(
			z.object({
				provenance: z.literal("observed_executed_runs"),
				baseline: SkillWorkflowRevisionSchema,
				candidate: SkillWorkflowRevisionSchema,
				changes: z.object({
					revisionDelta: z.number().int().nullable(),
					workflowSourceChanged: z.boolean(),
					skillDocChanged: z.boolean(),
					workerVersionChanged: z.boolean(),
					executionCompatibilityChanged: z.boolean(),
					compatibilityDateChanged: z.boolean(),
					dispatchShimVersionChanged: z.boolean(),
					dynamicWorkflowsVersionChanged: z.boolean(),
					loaderConfigChanged: z.boolean(),
					tenantLimitsChanged: z.boolean(),
					workflowSourceLineDelta: z.number().int().nullable(),
					skillDocLineDelta: z.number().int().nullable(),
				}),
				baselineSource: z.string().nullable().optional(),
				candidateSource: z.string().nullable().optional(),
				baselineSkillDoc: z.string().nullable().optional(),
				candidateSkillDoc: z.string().nullable().optional(),
			}),
		),

	getWorkflowReliability: oc
		.route({
			method: "GET",
			path: "/skills/get-workflow-reliability",
			tags: ["cognitive"],
			summary: "Aggregate bounded workflow-run and step reliability evidence",
			description:
				"Requires at least one of skillId, slug, or tediId. A tediId alone aggregates that tedi's bounded run sample; with a skill selector it narrows the sample to that workflow.",
		})
		.input(
			z.object({
				skillId: z
					.string()
					.optional()
					.describe("Optional when slug or tediId is provided"),
				slug: z
					.string()
					.optional()
					.describe("Optional when skillId or tediId is provided"),
				tediId: z.string().optional(),
				limit: z.number().int().min(1).max(200).optional().default(100),
			}),
		)
		.output(SkillWorkflowReliabilitySchema),

	listWorkflowSchedules: oc
		.route({
			method: "GET",
			path: "/skills/list-workflow-schedules",
			tags: ["cognitive"],
			summary: "List manifest-owned skill workflow schedules",
		})
		.input(
			z.object({
				skillId: z.string().optional(),
				slug: z.string().optional(),
				tediId: z.string().optional(),
				enabled: z.boolean().optional(),
				limit: z.number().int().min(1).max(200).optional().default(100),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.default(0)
					.describe("Zero-based page offset; omitted by legacy callers"),
				query: z
					.string()
					.trim()
					.max(120)
					.optional()
					.describe("Optional cron or linked-skill metadata search"),
			}),
		)
		.output(
			z.object({
				schedules: z.array(SkillScheduleSchema),
				total: z.number().int().nonnegative(),
				offset: z.number().int().nonnegative(),
				limit: z.number().int().positive(),
				nextOffset: z
					.number()
					.int()
					.nonnegative()
					.nullable()
					.describe("Next page offset, or null when this is the last page"),
			}),
		),

	pauseWorkflow: oc
		.route({
			method: "POST",
			path: "/skills/pause-workflow",
			tags: ["cognitive"],
		})
		.input(z.object({ runId: z.string(), tediId: z.string().optional() }))
		.output(SkillWorkflowLifecycleOutputSchema),

	resumeWorkflow: oc
		.route({
			method: "POST",
			path: "/skills/resume-workflow",
			tags: ["cognitive"],
		})
		.input(z.object({ runId: z.string(), tediId: z.string().optional() }))
		.output(SkillWorkflowLifecycleOutputSchema),

	restartWorkflow: oc
		.route({
			method: "POST",
			path: "/skills/restart-workflow",
			tags: ["cognitive"],
			description:
				"Restarts an engine instance from the beginning or a named step. Restarting a terminal run opens a new CAS-guarded durable submission attempt while preserving the prior terminal attempt. Operator recovery can instead burn a verified no-start ambiguous epoch as a canceled submission/run with abortUnknown, without invoking the engine; that permanently retires the ambiguous Workflow instance, so subsequent work needs a new runId.",
		})
		.input(
			z.object({
				...StatelessDestructiveConfirmationShape,
				reason: destructiveAuditReason(
					"Audit reason for the confirmed workflow restart; required when abortUnknown closes an ambiguous restart intent",
				),
				runId: z.string(),
				tediId: z.string().optional(),
				restartId: z
					.string()
					.min(1)
					.max(128)
					.describe(
						"Caller-stable idempotency key for this restart command; retry with the same value to repair partial API/ledger failures without invoking the engine again",
					),
				abortUnknown: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Operator recovery only: after verifying this pending/unknown reserved epoch never started, burn its exact submission/run projection as canceled and permanently retire that Workflow instance. Requires reason, never invokes the engine, exact retries must reuse restartId/from/reason, and subsequent work needs a new runId.",
					),
				from: SkillWorkflowRestartFromSchema.optional(),
			}),
		)
		.output(SkillWorkflowLifecycleOutputSchema),

	approveWorkflow: oc
		.route({
			method: "POST",
			path: "/skills/approve-workflow",
			tags: ["cognitive"],
		})
		.input(
			z.object({
				...StatelessDestructiveConfirmationShape,
				reason: destructiveAuditReason(
					"Audit reason recorded with the approval decision",
				),
				runId: z.string(),
				tediId: z.string().optional(),
				approvalId: z.string().min(1).max(128),
				payload: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.output(SkillWorkflowLifecycleOutputSchema),

	rejectWorkflow: oc
		.route({
			method: "POST",
			path: "/skills/reject-workflow",
			tags: ["cognitive"],
		})
		.input(
			z.object({
				...StatelessDestructiveConfirmationShape,
				runId: z.string(),
				tediId: z.string().optional(),
				approvalId: z.string().min(1).max(128),
				reason: z.string().min(1).max(4000).optional(),
				payload: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.output(SkillWorkflowLifecycleOutputSchema),

	revokeSkillRun: oc
		.route({
			method: "POST",
			path: "/skills/revoke-run",
			tags: ["cognitive"],
			summary: "Retire and revoke a terminal skill workflow run",
			description:
				"Requires a terminal D1 run with no open admission/restart ambiguity. An unretired instance also requires a first-hand terminal Cloudflare engine snapshot; an operator-abort tombstone is already durable no-start proof, and a prior REVOKED claim resumes cleanup without re-reading the retired engine. Atomically retires the Workflow instance, clears result/cost output, and stamps the REVOKED audit marker before deleting D1/R2 artifacts plus memory facts whose source is exactly skill://runs/{runId}. Active or ambiguous runs conflict before cleanup; retired instances cannot restart. The skill_runs identity/source row remains for audit. Muscle entries have no run-source link yet and are not deleted. Idempotent retries repair partial cleanup.",
		})
		.input(
			z.object({
				runId: z.string(),
				reason: z.string().optional(),
				skillId: z
					.string()
					.optional()
					.describe("Optional cross-check that the run belongs to this skill"),
			}),
		)
		.output(
			z.object({
				runId: z.string(),
				revoked: z.boolean(),
				artifactsDeleted: z.number(),
				r2ObjectsDeleted: z.number(),
				factsDeleted: z
					.number()
					.describe(
						"Count of memory facts removed for source skill://runs/{runId}",
					),
				musclesDeleted: z
					.number()
					.describe(
						"Count of muscle memory entries removed (0 until link exists)",
					),
				reason: z.string().optional(),
			}),
		),

	getRunArtifact: oc
		.route({
			method: "POST",
			path: "/skills/get-run-artifact",
			tags: ["cognitive"],
			summary: "Read a single artifact produced by a skill workflow run",
			description:
				"Returns one artifact at `skill://{slug}/runs/{runId}/{path}` (path is run-relative — e.g. `inputs.json`, `manifest.json`, `timeline.json`, `outputs/{step}.json`). Inline payloads return content directly; R2-spilled artifacts are fetched and streamed back. Performs ownership check: caller's org must own the run, and the run must belong to the requested skill.",
		})
		.input(
			z.object({
				runId: z.string(),
				tediId: z.string().optional(),
				path: z
					.string()
					.describe("Run-relative path, e.g. 'outputs/scrape-2.json'"),
				skillId: z
					.string()
					.optional()
					.describe("Optional cross-check that the run belongs to this skill"),
				mediaUrl: z
					.boolean()
					.optional()
					.describe(
						"When true, also return a short-lived signed `url` that serves the decoded media bytes (extracted from base64-in-JSON artifacts) with the right Content-Type — directly viewable in a browser. Skips returning large `content` inline.",
					),
				mediaInline: z
					.boolean()
					.optional()
					.describe(
						"When true, return the media as `mediaBase64` + `mimeType` (extracted from base64-in-JSON artifacts) instead of raw `content`. For session-authenticated callers (e.g. Tedix OS) that render a `data:` URL — no expiring token, so the reference survives transcript scrollback. Use `mediaUrl` for shareable/external links; use `mediaInline` for an authed in-app render. Best for images; large video should still use `mediaUrl` to avoid base64-over-RPC bloat.",
					),
			}),
		)
		.output(
			z.object({
				path: z.string(),
				mimeType: z.string(),
				sizeBytes: z.number(),
				outcome: z.enum(["pending", "success", "failure"]),
				attempt: z.number(),
				createdAt: z.string().nullable().optional(),
				/** Hex SHA-256 of the stored bytes. Re-hash `content` and compare to prove the evidence was not altered. Null for artifacts written before content-addressing. */
				sha256: z.string().nullable().optional(),
				/** Inline content (string). Null if artifact was spilled to R2 — see `r2Available`. */
				content: z.string().nullable(),
				/** True when artifact lives in R2; client should not parse `content` as the value. */
				r2Available: z.boolean(),
				/** Short-lived signed URL serving decoded media (only when `mediaUrl: true`). */
				url: z.string().nullable().optional(),
				/** ISO expiry of `url`. */
				urlExpiresAt: z.string().nullable().optional(),
				/** MIME type of the decoded media bytes, distinct from the wrapper artifact's `mimeType`. */
				mediaMimeType: z.string().nullable().optional(),
				/** Stable session-authenticated Tedix OS/API media path for generated media artifacts. */
				mediaPath: z.string().nullable().optional(),
				/** Decoded media class inferred from `mediaMimeType`. */
				mediaKind: z
					.enum(["image", "video", "audio", "other"])
					.nullable()
					.optional(),
				/** Decoded media base64 (only when `mediaInline: true`); null if the artifact isn't decodable media. Pair with `mimeType` to build a `data:` URL. */
				mediaBase64: z.string().nullable().optional(),
			}),
		),

	listRunArtifacts: oc
		.route({
			method: "GET",
			path: "/skills/list-run-artifacts",
			tags: ["cognitive"],
			summary: "List all artifacts produced by a skill workflow run",
		})
		.input(
			z.object({
				runId: z.string(),
				tediId: z.string().optional(),
				skillId: z
					.string()
					.optional()
					.describe("Optional cross-check that the run belongs to this skill"),
				limit: z.number().int().min(1).max(1000).optional().default(200),
				offset: z.number().int().min(0).optional().default(0),
			}),
		)
		.output(
			z.object({
				artifacts: z.array(
					z.object({
						path: z.string(),
						mimeType: z.string(),
						sizeBytes: z.number(),
						outcome: z.enum(["pending", "success", "failure"]),
						attempt: z.number(),
						storage: z.enum(["inline", "r2"]),
						createdAt: z.string().nullable().optional(),
						/** Hex SHA-256 of the stored bytes. Null for artifacts written before content-addressing. */
						sha256: z.string().nullable().optional(),
					}),
				),
				truncated: z.boolean(),
				nextOffset: z.number().int().min(0).nullable(),
			}),
		),

	validate: oc
		.route({ method: "POST", path: "/skills/validate", tags: ["cognitive"] })
		.input(
			z.object({
				// Mode A: validate an existing stored skill (legacy)
				id: z.string().optional(),
				// Alias for id — the sibling skill-workflow tools all take
				// `skillId`, and an unknown key here was silently dropped, so
				// validate({skillId}) validated an empty draft instead.
				skillId: z.string().optional(),
				slug: z.string().optional(),
				// Mode B: validate a draft input (same shape as record, all optional so callers can validate partial drafts)
				title: z.string().optional(),
				description: z.string().optional(),
				content: z.string().optional(),
				summary: z.string().optional(),
				files: z.record(z.string(), z.string()).optional(),
				appId: z.string().optional(),
				appSlug: z.string().optional(),
				toolSlugs: z.array(z.string()).optional(),
			}),
		)
		.output(
			z.object({
				valid: z.boolean(),
				errors: z.array(SkillValidationIssueSchema),
				warnings: z.array(SkillValidationIssueSchema),
			}),
		),
});

// ---- Muscle Memory ----
export const muscleContract = oc.route({ tags: ["muscle"] }).router({
	list: oc
		.route({ method: "GET", path: "/muscle/list", tags: ["cognitive"] })
		.input(
			z.object({
				tediId: z.string().optional(),
				kind: MuscleMemoryKindSchema.optional(),
				includeUnproven: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Include unproven auto-crystallized entries. Defaults to false so recall surfaces curated/proven muscle memory instead of raw observation candidates.",
					),
				limit: z.number().optional(),
			}),
		)
		.output(z.object({ entries: z.array(MuscleMemorySchema) })),

	register: oc
		.route({ method: "POST", path: "/muscle/register", tags: ["cognitive"] })
		.input(
			z.object({
				tediId: z.string().optional(),
				kind: MuscleMemoryKindSchema,
				name: z.string().min(1),
				description: z.string().optional(),
				r2Path: z.string().optional(),
				origin: MuscleMemoryOriginSchema,
				codeModule: z.string().optional(),
				allowedNamespaces: z
					.array(z.string().min(1))
					.min(1)
					.optional()
					.describe(
						"Caller-declared namespace allowlist for stored codeModule. A nonempty list is required when codeModule is present; registration does not validate live capability membership or execute the code.",
					),
			}),
		)
		.output(z.object({ entry: MuscleMemorySchema })),

	crystallize: oc
		.route({ method: "POST", path: "/muscle/crystallize", tags: ["cognitive"] })
		.input(
			z.object({
				tediId: z.string().optional(),
				skillId: z
					.string()
					.describe(
						"Source skill entry ID (must belong to the caller's org and meet the proven muscle bar: ≥5 verified terminal workflow successes with no unrecovered failure)",
					),
				kind: MuscleMemoryKindSchema,
				name: z.string().min(1),
				description: z.string().optional(),
				r2Path: z.string().optional(),
				codeModule: z.string().optional(),
				allowedNamespaces: z
					.array(z.string().min(1))
					.min(1)
					.optional()
					.describe(
						"Namespace allowlist the stored codeModule may call. REQUIRED when codeModule is present.",
					),
				...SkillPremortemGateShape,
			}),
		)
		.output(z.object({ entry: MuscleMemorySchema })),

	usage: oc
		.route({ method: "POST", path: "/muscle/usage", tags: ["cognitive"] })
		.input(
			z.object({
				id: z.string(),
				success: z.boolean(),
			}),
		)
		.output(z.object({ success: z.boolean() })),
});

// ============================================================================
// Exports
// ============================================================================

export type {
	CognitiveVisibility,
	KnowledgeEntry,
	KnowledgeEntryType,
	MuscleMemory,
	MuscleMemoryKind,
	MuscleMemoryOrigin,
	SkillEntry,
	SkillLifecycleState,
	SkillPreconditions,
	SkillRun,
	SkillRunCostSummary,
	SkillRunStatus,
	SkillRunSummary,
	SkillWorkflowRetryCandidate,
	SkillSchedule,
	SkillSummary,
	SkillWorkflowArtifactSummary,
	SkillWorkflowReliability,
	SkillWorkflowRevision,
	SkillWorkflowRuntimeVariant,
	SkillWorkflowStep,
	SkillWorkflowToolCall,
} from "../schemas/cognitive";

export {
	CognitiveVisibilitySchema,
	KnowledgeEntrySchema,
	KnowledgeEntryTypeSchema,
	MuscleMemoryKindSchema,
	MuscleMemoryOriginSchema,
	MuscleMemorySchema,
	SkillEntrySchema,
	SkillLifecycleStateSchema,
	SkillPreconditionsSchema,
	SkillRunCostSummarySchema,
	SkillRunSchema,
	SkillRunStatusSchema,
	SkillRunSummarySchema,
	SkillWorkflowRetryCandidateSchema,
	SkillSummarySchema,
	SkillWorkflowArtifactSummarySchema,
	SkillWorkflowReliabilitySchema,
	SkillWorkflowRevisionSchema,
	SkillWorkflowRuntimeVariantSchema,
	SkillWorkflowStepSchema,
	SkillWorkflowToolCallSchema,
} from "../schemas/cognitive";
