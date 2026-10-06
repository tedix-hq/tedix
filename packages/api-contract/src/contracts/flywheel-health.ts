import "@orpc/openapi/extensions/route";
/**
 * Flywheel Health Contract
 * oRPC contract for the cognitive flywheel dashboard.
 *
 * Aggregates timestamps from rationale records, telemetry, memory facts,
 * and muscle memory to power the "is the flywheel spinning?" pulse widget.
 * Also provides fact lifecycle distribution for the lifecycle chart.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { JsonValueSchema } from "../schemas/common";

// =============================================================================
// SCHEMAS
// =============================================================================

const FlywheelPulseSchema = z.object({
	/** Last rationale record created */
	lastRationale: z
		.object({
			id: z.string(),
			action: z.string(),
			category: z.string(),
			confidence: z.number(),
			outcomeStatus: z.string(),
			createdAt: z.string(),
		})
		.nullable(),
	/** Last memory fact learned (bridged from observation or direct) */
	lastFactLearned: z
		.object({
			id: z.string(),
			summary: z.string().nullable(),
			factType: z.string(),
			confidence: z.number(),
			source: z.string().nullable(),
			createdAt: z.string().nullable(),
		})
		.nullable(),
	/** Last skill recorded or improved */
	lastSkillActivity: z
		.object({
			id: z.string(),
			title: z.string(),
			revision: z.number(),
			updatedAt: z.string().nullable(),
		})
		.nullable(),
	/** Last muscle memory registered or crystallized */
	lastMuscleActivity: z
		.object({
			id: z.string(),
			name: z.string(),
			kind: z.string(),
			origin: z.string(),
			updatedAt: z.string().nullable(),
		})
		.nullable(),
	/** Last MCP tool call (from telemetry) */
	lastToolCall: z
		.object({
			toolName: z.string().nullable(),
			success: z.boolean().nullable(),
			createdAt: z.string(),
		})
		.nullable(),
	/** Count of rationale records in last 24h */
	decisionsLast24h: z.number(),
	/** Count of facts learned in last 24h */
	factsLearnedLast24h: z.number(),
	/** Count of skill executions (success + failure) in last 24h, from the canonical skill_usage_events ledger */
	skillUsagesLast24h: z.number(),
});

const FactLifecycleTierSchema = z.enum([
	"probation",
	"active_low",
	"active_mid",
	"active_high",
	"gold",
]);

const FactLifecycleSchema = z.object({
	/** Distribution of facts across lifecycle tiers */
	tiers: z.array(
		z.object({
			tier: FactLifecycleTierSchema,
			count: z.number(),
			avgConfidence: z.number(),
			label: z.string(),
		}),
	),
	/** Total fact count */
	totalFacts: z.number(),
	/** Facts with high usage ratio (gold tier: confidence > 0.85 and accessCount > 5) */
	goldCount: z.number(),
	/** Facts still in probation (status = 'probation') */
	probationCount: z.number(),
	/** Confidence distribution histogram (10 buckets: 0-10%, 10-20%, ..., 90-100%) */
	confidenceHistogram: z.array(
		z.object({
			bucket: z.string(),
			count: z.number(),
		}),
	),
});

export const CronExecutionSchema = z.object({
	/** Cron name (e.g., 'brain-reflection', 'objective-review') */
	name: z.string(),
	/** Active execution mechanism after the cron-to-skill-workflow cutover. */
	mechanism: z.enum(["legacy_cron", "scheduled_skill_workflow"]).nullable(),
	/** Canonical run id for the latest execution, when one exists. */
	lastRunId: z.string().nullable(),
	/** Last execution time from the active durable execution ledger */
	lastExecutedAt: z.string().nullable(),
	/** Whether the last execution succeeded (null while running / never ran) */
	lastSuccess: z.boolean().nullable(),
	/** Number of executions in the last 24h */
	executionsLast24h: z.number(),
	/** Expected interval in hours */
	expectedIntervalHours: z.number(),
	/** Whether the cron is overdue */
	overdue: z.boolean(),
	/** Latest schedule/run state; budget governance is not projected as failure. */
	state: z.enum([
		"healthy",
		"disabled",
		"running",
		"failed",
		"overdue",
		"never_ran",
		"budget_blocked",
	]),
	budgetBlockedAt: z.string().nullable(),
	budgetBlockedReason: z.string().nullable(),
	budgetResetAt: z.string().nullable(),
	budgetBlockActive: z.boolean(),
	budgetAdmissionClass: z.enum(["background", "governed_learning"]).nullable(),
});

const OrphanRunHealthSchema = z.object({
	asOf: z.string(),
	organizationId: z.string(),
	thresholds: z.object({
		orphanAgeMinutes: z.number(),
		activityWindowMinutes: z.number(),
	}),
	sampleLimit: z.number(),
	candidateCount: z.number(),
	candidateCountRelation: z.enum(["exact", "at_least"]),
	succeededLostCount: z.number(),
	succeededLostCountRelation: z.enum(["exact", "at_least"]),
	truncated: z.boolean(),
	samples: z.array(
		z.object({
			tediId: z.string(),
			organizationId: z.string(),
			runId: z.string(),
			conversationId: z.string().nullable(),
			runtimeBackend: z.string(),
			runtimeExternalId: z.string().nullable(),
			startedEventId: z.string(),
			startedAt: z.string(),
			succeededLost: z.boolean(),
		}),
	),
});

const CronExecutionStampBaseSchema = z.object({
	tediId: z.uuid(),
	/** Deterministic per-fire key from the runtime scheduler (`cron:{id}:{ts}`) */
	fireKey: z.string().min(1).max(256),
	/** Cron job name from the schedule payload (e.g. 'brain-reflection') */
	cronName: z.string().min(1).max(128),
	/** Runtime run id the fire dispatched */
	runId: z.string().max(256).optional(),
	/** ISO 8601 dispatch time */
	startedAt: z.string().min(1),
});

const RecordCronExecutionInputSchema = z.discriminatedUnion("phase", [
	CronExecutionStampBaseSchema.extend({
		phase: z.literal("started"),
	}),
	CronExecutionStampBaseSchema.extend({
		phase: z.literal("finished"),
		status: z.enum(["success", "failure"]),
		/** ISO 8601 settle time */
		finishedAt: z.string().min(1),
		/** JSON summary of the state transitions the execution performed */
		transitions: z.record(z.string(), JsonValueSchema).optional(),
		/** Terminal error message for status=failure */
		error: z.string().max(4000).optional(),
	}),
]);

const FlywheelWindowInputSchema = z.object({
	tediId: z.uuid(),
	windowDays: z.number().min(1).max(90).optional().default(14),
});

const BrainProducerQualitySchema = z.object({
	windowDays: z.number(),
	since: z.string(),
	producers: z.array(
		z.object({
			producer: z.string(),
			factsLearned: z.number(),
			activeFacts: z.number(),
			archivedFacts: z.number(),
			probationFacts: z.number(),
			withProvenance: z.number(),
			retrievedFacts: z.number(),
			feedbackTouchedFacts: z.number(),
			citedFacts: z.number(),
			avgConfidence: z.number(),
			score: z.number(),
			status: z.enum(["healthy", "thin", "missing"]),
			rates: z.object({
				provenance: z.number(),
				lifecycle: z.number(),
				retrieval: z.number(),
				feedback: z.number(),
				citation: z.number(),
				archive: z.number(),
			}),
			gaps: z.array(z.string()),
		}),
	),
	summary: z.object({
		producerCount: z.number(),
		factsLearned: z.number(),
		healthyProducers: z.number(),
		thinProducers: z.number(),
		missingProducers: z.number(),
	}),
});

const DecisionEpisodeNodeSchema = z.object({
	id: z.string(),
	type: z.enum([
		"decision",
		"fact",
		"outcome",
		"run",
		"work_item",
		"tool_call",
		"payment",
		"objective",
		"approval_request",
	]),
	label: z.string(),
	properties: z.record(z.string(), JsonValueSchema),
});

const DecisionEpisodeEdgeSchema = z.object({
	source: z.string(),
	target: z.string(),
	type: z.string(),
	properties: z.record(z.string(), JsonValueSchema),
});

const DecisionEpisodeSchema = z.object({
	decisionId: z.string(),
	action: z.string(),
	category: z.string(),
	outcomeStatus: z.string(),
	confidence: z.number(),
	createdAt: z.string(),
	completedAt: z.string().nullable(),
	objectiveId: z.string().nullable(),
	approvalRequestId: z.string().nullable(),
	/** WS1 execution link: the runtime run this decision belongs to. */
	runId: z.string().nullable(),
	/** WS1 execution links: tool-call refs stored on the record at write time. */
	toolCallRefs: z.array(z.string()),
	/** WS1: span-checkable proof stored with the outcome claim. */
	proofRef: z.object({ kind: z.string(), ref: z.string() }).nullable(),
	factIds: z.array(z.string()),
	workItemIds: z.array(z.string()),
	toolCallCount: z.number(),
	paymentEventCount: z.number(),
	nodes: z.array(DecisionEpisodeNodeSchema),
	edges: z.array(DecisionEpisodeEdgeSchema),
});

const DecisionEpisodeQualitySchema = z.object({
	episodeCount: z.number(),
	decisionsWithoutFacts: z.number(),
	pendingOutcomes: z.number(),
	episodesWithoutWorkItems: z.number(),
	episodesWithoutToolCalls: z.number(),
	/** WS1 proof gate: episodes with NO runId, work item, or tool-call ref. */
	episodesWithoutExecutionLinks: z.number(),
	/** WS1 proof gate: episodes whose outcome claim carries a proof ref. */
	episodesWithProofRefs: z.number(),
	episodesWithPayments: z.number(),
	averageEdgesPerEpisode: z.number(),
	gaps: z.array(z.string()),
});

const LearningReplayValidationSchema = z.object({
	windowDays: z.number(),
	since: z.string(),
	ready: z.boolean(),
	score: z.number(),
	categories: z.array(
		z.object({
			category: z.string(),
			total: z.number(),
			successes: z.number(),
			failures: z.number(),
			withFacts: z.number(),
		}),
	),
	transitions: z.array(
		z.object({
			failureDecisionId: z.string(),
			successDecisionId: z.string(),
			category: z.string(),
			failureAction: z.string(),
			successAction: z.string(),
			failureAt: z.string(),
			successAt: z.string(),
			sharedEvidenceCount: z.number(),
		}),
	),
	signals: z.array(
		z.object({
			key: z.string(),
			label: z.string(),
			value: z.number(),
			status: z.enum(["healthy", "thin", "missing"]),
		}),
	),
	gaps: z.array(z.string()),
});

const LearningCurvePointSchema = z.object({
	phase: z.enum(["baseline", "recent"]),
	fromEpisode: z.number(),
	cumulativeEpisodes: z.number(),
	episodeCount: z.number(),
	successRate: z.number(),
	averageSteps: z.number(),
	averageDurationMs: z.number().nullable(),
	durationSamples: z.number(),
	averageTokenCost: z.number().nullable(),
	tokenCostSamples: z.number(),
	workItemLinkRate: z.number(),
});

const LearningCurveRegressionAlertSchema = z.object({
	cohort: z.enum(["organic", "operator", "scheduled_dogfood"]),
	taskType: z.string(),
	metric: z.enum(["success_rate", "steps", "duration", "token_cost"]),
	severity: z.enum(["warning", "critical"]),
	baseline: z.number(),
	recent: z.number(),
	delta: z.number(),
	message: z.string(),
});

const LearningCurvesSummarySchema = z.object({
	taskTypeCount: z.number(),
	episodeCount: z.number(),
	improvingTaskTypes: z.number(),
	regressingTaskTypes: z.number(),
	alertCount: z.number(),
	cohortCounts: z.object({
		organic: z.number(),
		operator: z.number(),
		scheduled_dogfood: z.number(),
	}),
});

const LearningCurvesReportSchema = z.object({
	tediId: z.string(),
	orgId: z.string(),
	windowDays: z.number(),
	cohort: z.enum(["all", "organic", "operator", "scheduled_dogfood"]),
	since: z.string(),
	generatedAt: z.string(),
	curves: z.array(
		z.object({
			cohort: z.enum(["organic", "operator", "scheduled_dogfood"]),
			taskType: z.string(),
			totalEpisodes: z.number(),
			points: z.array(LearningCurvePointSchema),
			baseline: LearningCurvePointSchema.nullable(),
			recent: LearningCurvePointSchema.nullable(),
			direction: z.enum(["improved", "regressed", "flat", "insufficient_data"]),
		}),
	),
	alerts: z.array(LearningCurveRegressionAlertSchema),
	pagination: z.object({
		offset: z.number(),
		limit: z.number(),
		totalTaskTypes: z.number(),
		nextOffset: z.number().nullable(),
	}),
	summary: LearningCurvesSummarySchema,
});

const ReferenceClassMetricSchema = z.object({
	/** Interpolated median over available samples; null when none */
	median: z.number().nullable(),
	/** Nearest-rank 80th percentile; null when no samples */
	p80: z.number().nullable(),
	samples: z.number(),
});

const ReferenceClassEstimateSchema = z.object({
	taskType: z.string(),
	windowDays: z.number(),
	since: z.string(),
	generatedAt: z.string(),
	episodeCount: z.number(),
	successRate: z.number(),
	durationMs: ReferenceClassMetricSchema,
	toolCallCount: ReferenceClassMetricSchema,
	/** First-half vs second-half comparison (learning-curve convention) */
	trend: z.enum(["improving", "flat", "regressing", "insufficient_data"]),
	/** reference_class once ≥3 episodes exist in the window */
	verdict: z.enum(["reference_class", "insufficient_data"]),
});

const StrategyMapLagPointSchema = z.object({
	/** Lag in days: leading(t) vs lagging(t + lag) */
	lag: z.number(),
	/** Pearson r at this lag; null when undefined (constant series / <2 pairs) */
	correlation: z.number().nullable(),
	/** Paired daily buckets (both rates defined) at this lag */
	n: z.number(),
});

const StrategyMapHypothesisSchema = z.object({
	key: z.enum([
		"skill_reuse_to_decision_success",
		"linked_episodes_to_completion_quality",
		"consolidation_to_citation",
	]),
	leading: z.string(),
	lagging: z.string(),
	/** Strategy-map stage transition this hypothesis tests */
	chain: z.string(),
	bestLag: z.number().nullable(),
	correlation: z.number().nullable(),
	n: z.number(),
	/** Lags swept — bestLag is a best-of-lagsTested pick (selection bias). */
	lagsTested: z.number(),
	/**
	 * Effect-size floor r had to clear at the selected lag:
	 * max(supportThreshold, sqrt(4 + 2*ln(lagsTested))/sqrt(n)). Null when no
	 * lag qualified.
	 */
	supportFloor: z.number().nullable(),
	/** Why the floor exceeds the flat supportThreshold. */
	selectionBiasNote: z.string(),
	verdict: z.enum(["supported", "unsupported", "insufficient_data"]),
	lags: z.array(StrategyMapLagPointSchema),
});

const StrategyMapValidationSchema = z.object({
	tediId: z.string(),
	orgId: z.string(),
	windowDays: z.number(),
	maxLagDays: z.number(),
	since: z.string(),
	generatedAt: z.string(),
	bucketCount: z.number(),
	minPairedBuckets: z.number(),
	supportThreshold: z.number(),
	hypotheses: z.array(StrategyMapHypothesisSchema),
	summary: z.object({
		supported: z.number(),
		unsupported: z.number(),
		insufficientData: z.number(),
	}),
});

const KnowledgeMarketTediSchema = z.object({
	tediId: z.string(),
	/** Non-archived skills this tedi owns (inventory context for repute). */
	ownedSkills: z.number(),
	/** This tedi's own executions in the window, split by skill origin. */
	executions: z.object({
		total: z.number(),
		self: z.number(),
		commons: z.number(),
		peer: z.number(),
	}),
	repute: z.object({
		/** Distinct owned skills executed by at least one OTHER tedi. */
		skillsUsedByOthers: z.number(),
		executionsByOthers: z.number(),
		distinctConsumers: z.number(),
		/** Cross-tedi citations of this tedi's facts (scope-proxy — see caveats). */
		factCitationsByOthers: z.number(),
		distinctFactCiters: z.number(),
	}),
	reciprocity: z.object({
		/** Executions of this tedi's skills by peers (selling). */
		given: z.number(),
		/** This tedi's executions of peers' skills (buying); commons excluded. */
		received: z.number(),
		/** (given − received) / (given + received); null when both are 0. */
		balance: z.number().nullable(),
		flag: z.enum(["balanced", "all_sell", "all_buy", "inactive"]),
	}),
	localness: z.object({
		selfShare: z.number().nullable(),
		commonsShare: z.number().nullable(),
		peerShare: z.number().nullable(),
		/** High self-share + zero commons-share above the execution floor. */
		flag: z.boolean(),
	}),
	/** Skill-market isolate: no consumers, no peer use, no commons use. */
	isolate: z.boolean(),
});

const KnowledgeMarketReportSchema = z.object({
	orgId: z.string(),
	window: z.object({
		days: z.number(),
		since: z.string(),
		generatedAt: z.string(),
	}),
	orgRollup: z.object({
		totalSkillExecutions: z.number(),
		tediActorExecutions: z.number(),
		/** Share of tedi-actor executions that are NOT self-owned. */
		crossUseShare: z.number().nullable(),
		/** Share of commons (org-scoped) skills with ≥1 execution in window. */
		commonsUtilization: z.number().nullable(),
		commons: z.object({
			totalSkills: z.number(),
			usedSkills: z.number(),
			deadSkills: z.number(),
		}),
		isolates: z.array(z.string()),
		pairFlows: z.array(
			z.object({
				ownerTediId: z.string(),
				userTediId: z.string(),
				executions: z.number(),
				distinctSkills: z.number(),
				oneWay: z.boolean(),
			}),
		),
	}),
	tedis: z.array(KnowledgeMarketTediSchema),
	/** Honest method caveats (provenance proxies, truncation) — always read. */
	caveats: z.array(z.string()),
});

// =============================================================================
// CONTRACT
// =============================================================================

export const flywheelHealthContract = oc
	.route({ tags: ["flywheel"], prefix: "/flywheel" })
	.errors(baseErrors)
	.router({
		/**
		 * Get the flywheel pulse — latest activity timestamps across all cognitive layers
		 * GET /flywheel/pulse
		 */
		pulse: oc
			.route({
				method: "GET",
				path: "/pulse",
				summary: "Get flywheel pulse",
				description:
					"Returns the most recent activity across all flywheel layers: rationale, memory, skills, muscle memory, and tool execution. Powers the 'is it spinning?' heartbeat widget.",
			})
			.input(z.object({ tediId: z.uuid() }))
			.output(FlywheelPulseSchema),

		/**
		 * Get fact lifecycle distribution
		 * GET /flywheel/fact-lifecycle
		 */
		factLifecycle: oc
			.route({
				method: "GET",
				path: "/fact-lifecycle",
				summary: "Get fact lifecycle distribution",
				description:
					"Returns the distribution of facts across lifecycle tiers (probation, active, gold) with confidence histogram. Powers the fact lifecycle chart.",
			})
			.input(
				z.object({
					tediId: z.uuid().optional(),
				}),
			)
			.output(FactLifecycleSchema),

		/**
		 * Get cron execution status
		 * GET /flywheel/crons
		 */
		crons: oc
			.route({
				method: "GET",
				path: "/crons",
				summary: "Get cron execution status",
				description:
					"Returns execution and canonical schedule state for the six cognitive learning schedules. Budget-suppressed occurrences are state=budget_blocked with reason/reset evidence, not runtime failures. After cron-to-skill-workflow migration it prefers scheduled skill-run terminals and falls back to the legacy cron ledger for pre-cutover tenants.",
			})
			.input(z.object({ tediId: z.uuid() }))
			.output(
				z.object({
					crons: z.array(CronExecutionSchema),
				}),
			),

		/**
		 * Read the current organization's canonical orphan-run candidates.
		 * GET /flywheel/orphan-run-health
		 */
		getOrphanRunHealth: oc
			.route({
				method: "GET",
				path: "/orphan-run-health",
				summary: "Get canonical orphan-run health",
				description:
					"Applies the same organization-scoped D1 predicate as the scheduled orphan sweep. Counts are exact when the bounded scan fits and explicitly lower-bounded when truncated; transcript-tail and facet latency analytics are not used as terminal evidence.",
			})
			.input(
				z.object({
					sampleLimit: z.number().int().min(1).max(100).optional().default(25),
				}),
			)
			.output(OrphanRunHealthSchema),

		/**
		 * Record a cognitive cron execution stamp (runtime-internal write path)
		 * POST /flywheel/crons/executions
		 */
		recordCronExecution: oc
			.route({
				method: "POST",
				path: "/crons/executions",
				summary: "Record a cognitive cron execution stamp",
				description:
					"Writes a durable execution stamp for a cognitive cron fire: 'started' marks the fire running at dispatch; 'finished' seals it success/failure with a JSON summary of state transitions. Written mechanically by the tedi runtime on every fire — this ledger is what the crons health read reports.",
			})
			.input(RecordCronExecutionInputSchema)
			.output(z.object({ ok: z.literal(true) })),

		/**
		 * Get brain producer quality by source/automation kind.
		 * GET /flywheel/producer-quality
		 */
		producerQuality: oc
			.route({
				method: "GET",
				path: "/producer-quality",
				summary: "Get brain producer quality",
				description:
					"Scores automated and manual brain-write producers by provenance, lifecycle retention, retrieval, feedback, citation, and archive pressure.",
			})
			.input(FlywheelWindowInputSchema)
			.output(BrainProducerQualitySchema),

		/**
		 * Project recent decision episodes into a graph-shaped payload.
		 * GET /flywheel/decision-episodes
		 */
		decisionEpisodes: oc
			.route({
				method: "GET",
				path: "/decision-episodes",
				summary: "Get decision episode projections",
				description:
					"Returns recent rationale records as graph-shaped decision episodes: cited facts, outcomes, work items, tool calls, and payment artifacts.",
			})
			.input(
				z.object({
					tediId: z.uuid(),
					limit: z.number().min(1).max(25).optional().default(10),
				}),
			)
			.output(
				z.object({
					episodes: z.array(DecisionEpisodeSchema),
					quality: DecisionEpisodeQualitySchema,
				}),
			),

		/**
		 * Validate whether outcomes create replayable learning signal.
		 * GET /flywheel/learning-validation
		 */
		learningValidation: oc
			.route({
				method: "GET",
				path: "/learning-validation",
				summary: "Validate learning replay signal",
				description:
					"Checks whether the tedi has enough completed, evidence-backed, attributed, contrastive decisions to prove that feedback can improve future behavior.",
			})
			.input(
				FlywheelWindowInputSchema.extend({
					windowDays: z.number().min(7).max(180).optional().default(30),
				}),
			)
			.output(LearningReplayValidationSchema),

		/**
		 * Get evidence-derived learning curves and regression alerts by task type.
		 * GET /flywheel/learning-curves
		 */
		learningCurves: oc
			.route({
				method: "GET",
				path: "/learning-curves",
				summary: "Get task-type learning curves",
				description:
					"Aggregates every completed episode in the selected window into bounded learning-curve points and reports mechanical regressions in success, steps, duration, and token cost.",
			})
			.input(
				z.object({
					tediId: z.uuid(),
					windowDays: z.number().min(7).max(180).optional().default(30),
					minEpisodes: z.number().min(2).max(100).optional().default(4),
					maxPointsPerTask: z.number().min(2).max(50).optional().default(20),
					limit: z.number().min(1).max(50).optional().default(20),
					offset: z.number().min(0).optional().default(0),
					cohort: z
						.enum(["all", "organic", "operator", "scheduled_dogfood"])
						.optional()
						.default("all"),
				}),
			)
			.output(LearningCurvesReportSchema),

		/**
		 * Outside-view (reference-class) estimate for one task type.
		 * GET /flywheel/reference-class
		 */
		getReferenceClassEstimate: oc
			.route({
				method: "GET",
				path: "/reference-class",
				summary:
					"Get the outside-view reference-class estimate for a task type",
				description:
					"Reference-class forecasting (Kahneman-Tversky 1977; Lovallo & Kahneman 2003) over the tedi's own completed episodes: given a learning-curve task identity (explicit evidence.taskType, 'skill:{slug}', or rationale category), returns the distribution comparable episodes actually landed in — median/p80 duration and tool-call count, episode count, success rate, and trend — so planners estimate objectives/tasks from the outside view instead of the inside view.",
			})
			.input(
				z.object({
					tediId: z.uuid(),
					taskType: z
						.string()
						.min(1)
						.max(500)
						.describe(
							"Learning-curve task identity: explicit evidence.taskType, 'skill:{slug}', or rationale category",
						),
					windowDays: z.number().min(7).max(180).optional().default(30),
				}),
			)
			.output(ReferenceClassEstimateSchema),

		/**
		 * Empirically validate benchmark v2's strategy map with lagged
		 * cross-correlations over daily buckets.
		 * GET /flywheel/strategy-map
		 */
		validateStrategyMap: oc
			.route({
				method: "GET",
				path: "/strategy-map",
				summary: "Validate the benchmark strategy map's causal lags",
				description:
					"Tests benchmark v2's leading→lagging causal hypotheses (skill reuse → decision success, linked episodes → completion quality, consolidation → citation) with lagged cross-correlations over daily buckets. Reports effect size (Pearson r) + paired-bucket sample size per lag and an honest supported/unsupported/insufficient_data verdict — no p-values.",
			})
			.input(
				z.object({
					tediId: z.uuid(),
					windowDays: z.number().min(14).max(90).optional().default(28),
					maxLagDays: z.number().min(1).max(14).optional().default(7),
				}),
			)
			.output(StrategyMapValidationSchema),

		/**
		 * Get Davenport & Prusak knowledge-market telemetry for the org.
		 * GET /flywheel/knowledge-market
		 */
		getKnowledgeMarketReport: oc
			.route({
				method: "GET",
				path: "/knowledge-market",
				summary: "Get the org knowledge-market telemetry report",
				description:
					"Davenport & Prusak knowledge-market telemetry for the cross-tedi mesh: repute (whose skills and facts other tedis actually use), per-pair reciprocity balance (the price system), localness pathology (self-only skill use plus dead commons inventory), and market isolates (hoarding proxy). Org-scoped, windowed, read-only; every method caveat (fact-provenance proxy, scan truncation) is carried in the payload's caveats array.",
			})
			.input(
				z.object({
					windowDays: z.number().min(1).max(90).optional().default(14),
				}),
			)
			.output(KnowledgeMarketReportSchema),
	});

export type FlywheelHealthContract = typeof flywheelHealthContract;
