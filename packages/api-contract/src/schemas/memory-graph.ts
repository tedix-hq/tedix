import * as z from "zod";
import { MEMORY_FACT_TYPES, MEMORY_FEEDBACK_SIGNALS } from "../constants/enums";
import { JsonValueSchema } from "./common";

// ============================================================================
// Enums
// ============================================================================

export const FactTypeSchema = z.enum(MEMORY_FACT_TYPES);
export type FactType = z.infer<typeof FactTypeSchema>;

export const MemoryFeedbackSignalSchema = z.enum(MEMORY_FEEDBACK_SIGNALS);
export type MemoryFeedbackSignal = z.infer<typeof MemoryFeedbackSignalSchema>;

export const RelationTypeSchema = z.enum([
	"caused_by",
	"contradicts",
	"supersedes",
	"applies_to",
	"learned_from",
	"requires",
	"related_to",
	"promoted_from",
]);
export type RelationType = z.infer<typeof RelationTypeSchema>;

export const PrioritySchema = z.enum(["core", "active", "background"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const VisibilitySchema = z.enum(["private", "shared", "org"]);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const MemoryScopeSchema = z.enum([
	"org",
	"tedi",
	"kernel",
	"session",
	"graph",
]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryUsePolicySchema = z.enum([
	"can_use_as_instruction",
	"can_use_as_evidence",
	"requires_user_confirmation",
	"do_not_inject_automatically",
]);
export type MemoryUsePolicy = z.infer<typeof MemoryUsePolicySchema>;

export const MemoryReviewStatusSchema = z.enum([
	"pending",
	"confirmed",
	"evidence_only",
	"restricted",
	"stale",
	"disputed",
	"rejected",
	"superseded",
]);
export type MemoryReviewStatus = z.infer<typeof MemoryReviewStatusSchema>;

/** Per-part caps; together they keep the judged bundle under 8k characters. */
export const MEMORY_SOURCE_EVIDENCE_LIMITS = {
	userTurnChars: 3_000,
	assistantReplyChars: 4_000,
	toolReceipts: 16,
	toolNameChars: 48,
} as const;

/**
 * What the after-turn Observer saw when it wrote a fact: the user turn, the
 * assistant reply and content-free tool receipts. Request-only evidence for
 * the memory-quality judgment; the API never persists it.
 */
export const MemorySourceEvidenceSchema = z.object({
	userTurn: z.string().max(MEMORY_SOURCE_EVIDENCE_LIMITS.userTurnChars),
	assistantReply: z
		.string()
		.max(MEMORY_SOURCE_EVIDENCE_LIMITS.assistantReplyChars)
		.optional(),
	toolReceipts: z
		.array(
			z.object({
				tool: z
					.string()
					.min(1)
					.max(MEMORY_SOURCE_EVIDENCE_LIMITS.toolNameChars),
				outcome: z.enum(["succeeded", "failed", "unavailable", "unknown"]),
			}),
		)
		.max(MEMORY_SOURCE_EVIDENCE_LIMITS.toolReceipts)
		.optional(),
});
export type MemorySourceEvidence = z.infer<typeof MemorySourceEvidenceSchema>;

export const ExpertiseLevelSchema = z.enum([
	"novice",
	"familiar",
	"proficient",
	"expert",
]);
export type ExpertiseLevel = z.infer<typeof ExpertiseLevelSchema>;

export const GapSeveritySchema = z.enum(["critical", "moderate", "minor"]);
export type GapSeverity = z.infer<typeof GapSeveritySchema>;

export const GapDetectedBySchema = z.enum([
	"failure",
	"self_test",
	"comparison",
	"reflection",
	"human",
	"boundary",
]);
export type GapDetectedBy = z.infer<typeof GapDetectedBySchema>;

export const CuriositySourceSchema = z.enum([
	"gap_detection",
	"adjacent_domain",
	"cross_tedi",
	"human_request",
	"self_test",
	"reflection",
]);
export type CuriositySource = z.infer<typeof CuriositySourceSchema>;

export const CuriosityStatusSchema = z.enum([
	"queued",
	"exploring",
	"completed",
	"deferred",
]);
export type CuriosityStatus = z.infer<typeof CuriosityStatusSchema>;

// ============================================================================
// Object schemas
// ============================================================================

export const FactSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string().nullable().optional(),
	domainId: z.string().nullable().optional(),
	content: z.string(),
	summary: z.string().nullable().optional(),
	factType: FactTypeSchema,
	confidence: z.number().min(0).max(1),
	validFrom: z.string().nullable().optional(),
	validTo: z.string().nullable().optional(),
	status: z.enum(["probation", "active"]).nullable().optional(),
	source: z.string().nullable().optional(),
	sourceSessionId: z.string().nullable().optional(),
	sourceUrl: z.string().nullable().optional(),
	sourceHash: z.string().nullable().optional(),
	embeddingId: z.string().nullable().optional(),
	topicKey: z.string().nullable().optional(),
	memoryScope: MemoryScopeSchema.nullable().optional(),
	usePolicy: MemoryUsePolicySchema.nullable().optional(),
	reviewStatus: MemoryReviewStatusSchema.nullable().optional(),
	priority: PrioritySchema.nullable().optional(),
	visibility: VisibilitySchema.nullable().optional(),
	promotedFrom: z.string().nullable().optional(),
	promotedAt: z.string().nullable().optional(),
	metadata: z.record(z.string(), JsonValueSchema).nullable().optional(),
	lastVerifiedAt: z.string().nullable().optional(),
	lastAccessedAt: z.string().nullable().optional(),
	accessCount: z.number(),
	usageCount: z.number(),
	archivedAt: z.string().nullable().optional(),
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});
export type Fact = z.infer<typeof FactSchema>;

export const EdgeSchema = z.object({
	id: z.string(),
	sourceFactId: z.string(),
	targetFactId: z.string(),
	relationType: RelationTypeSchema,
	strength: z.number().min(0).max(1),
	context: z.string().nullable().optional(),
	createdAt: z.string().nullable().optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;

export const DomainSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	name: z.string(),
	parentId: z.string().nullable().optional(),
	description: z.string().nullable().optional(),
	createdAt: z.string().nullable().optional(),
});
export type Domain = z.infer<typeof DomainSchema>;

export const SearchResultSchema = z.object({
	factId: z.string(),
	score: z.number(),
	fact: FactSchema.optional(),
	relatedFacts: z.array(FactSchema).optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const CuriosityItemSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	organizationId: z.string(),
	topic: z.string(),
	domain: z.string(),
	reason: z.string(),
	priority: z.number(),
	source: CuriositySourceSchema,
	status: CuriosityStatusSchema,
	factsLearned: z.number(),
	gapsFound: z.number(),
	completedAt: z.string().nullable().optional(),
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});
export type CuriosityItem = z.infer<typeof CuriosityItemSchema>;

export const MemoryHealthSchema = z.object({
	totalFacts: z.number(),
	activeFacts: z.number(),
	archivedFacts: z.number(),
	totalGaps: z.number(),
	totalOpinions: z.number(),
	totalEdges: z.number(),
	totalDomains: z.number(),
	avgConfidence: z.number(),
	orphanRatio: z.number(),
	staleFacts: z.number(),
	contradictions: z.number(),
	curiosityQueue: z.object({
		queued: z.number(),
		exploring: z.number(),
		completedTotal: z.number(),
	}),
});
export type MemoryHealth = z.infer<typeof MemoryHealthSchema>;
