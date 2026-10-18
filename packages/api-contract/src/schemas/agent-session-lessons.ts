/**
 * Team lessons for local coding-agent sessions (Claude Code, Codex).
 *
 * A lesson is an ordinary brain fact (`memory_facts`) whose topic key starts
 * with `learning-feed:` — the shape the learning feed writes
 * (`learning-feed:decision:<repo>:<harness>:<topic>`) and seeded lessons reuse.
 * Only active lessons are delivered: org-wide ones (no tedi) plus the
 * caller's own personal lessons (`metadata.learningFeed.ownerUserId`,
 * visibility `private`; lessons learned from one user's decisions are
 * personal), `reviewStatus: confirmed` (by a person, or by the miner once the
 * evidence meets its thresholds — no review gate) (a person confirmed it, which also ends
 * probation), not archived and not superseded. `metadata.learningFeed.scope`
 * `{ repo, harness, topic }` targets a lesson; the slug `general` matches any
 * session.
 */

import * as z from "zod";

/** Topic-key prefix shared by learning-feed facts and seeded lessons. */
export const AGENT_LESSON_TOPIC_PREFIX = "learning-feed:";

export const LessonTriggersSchema = z.strictObject({
	pathGlobs: z.array(z.string().min(1).max(300)).max(20).optional(),
	commands: z.array(z.string().min(1).max(100)).max(20).optional(),
	keywords: z.array(z.string().min(1).max(100)).max(20).optional(),
	repos: z.array(z.string().min(1).max(300)).max(10).optional(),
	organizations: z.array(z.string().min(1).max(100)).max(10).optional(),
});
export type LessonTriggers = z.infer<typeof LessonTriggersSchema>;

/** Persisted under memory_facts.metadata.learningFeed.evidence. */
export const LessonEvidenceSourceSchema = z.object({
	kind: z.enum(["fact", "decision", "correction"]),
	id: z.string().min(1),
	quote: z.string().min(1).max(280),
});
export type LessonEvidenceSource = z.infer<typeof LessonEvidenceSourceSchema>;
export const LessonEvidenceSchema = z.object({
	version: z.literal(1),
	sources: z.array(LessonEvidenceSourceSchema),
	supportCount: z.number().int().nonnegative(),
	state: z.enum(["live", "held"]),
	redistillRequestedAt: z.string().optional(),
});
export type LessonEvidence = z.infer<typeof LessonEvidenceSchema>;

export const GetAgentSessionLessonsInputSchema = z.strictObject({
	catalog: z
		.boolean()
		.optional()
		.describe(
			"Return the complete approved trigger catalog for local matching, without a prompt budget or delivery receipt. Never a delivery claim.",
		),
	selectedLessonIds: z.array(z.string().min(1).max(100)).max(6).optional(),
	harness: z
		.string()
		.trim()
		.min(1)
		.max(40)
		.describe("Calling agent host, e.g. `claude-code` or `codex`"),
	repo: z
		.string()
		.trim()
		.min(1)
		.max(300)
		.optional()
		.describe(
			"Repository of the session, e.g. `github.com/tedix-hq/tedix` or a Git origin URL",
		),
	topics: z
		.array(z.string().trim().min(1).max(100))
		.max(20)
		.optional()
		.describe(
			"Short task hints (branch words, Work title words). Never raw prompt text.",
		),
	budgetBytes: z
		.number()
		.int()
		.min(200)
		.max(8000)
		.default(3200)
		.describe("UTF-8 byte budget for the returned lesson texts"),
	sessionId: z
		.string()
		.regex(/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/)
		.optional()
		.describe(
			"The agent host's chat id. With it, which lessons reached this session is recorded so their effect can be measured, and a stable 10% of sessions (by this id) are a holdout that receives no learned lessons.",
		),
});
export type GetAgentSessionLessonsInput = z.input<
	typeof GetAgentSessionLessonsInputSchema
>;

export const AgentSessionLessonSchema = z.object({
	triggers: LessonTriggersSchema.optional(),
	id: z.string().describe("Fact id"),
	shortId: z.string().describe("First 8 characters of the fact id"),
	text: z.string(),
	scope: z.object({
		repo: z.string(),
		harness: z.string(),
		topic: z.string(),
	}),
	updatedAt: z.string().nullable(),
	learned: z.boolean().optional(),
	supportCount: z.number().int().nonnegative().optional(),
});
export type AgentSessionLesson = z.infer<typeof AgentSessionLessonSchema>;

export const GetAgentSessionLessonsResultSchema = z.object({
	organizationId: z.string(),
	lessons: z.array(AgentSessionLessonSchema),
	/** Approved lessons that apply to this session before the byte budget. */
	matched: z.number().int().nonnegative(),
	/** True when the budget dropped at least one matching lesson. */
	truncated: z.boolean(),
	/**
	 * This session is in the measurement holdout: learned (mined) lessons
	 * were withheld and only written or person-reviewed ones returned.
	 */
	holdout: z.boolean().optional(),
});
export type GetAgentSessionLessonsResult = z.infer<
	typeof GetAgentSessionLessonsResultSchema
>;

export const ListAgentLessonsInputSchema = z.strictObject({
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(50)
		.describe("How many lessons to return, newest first"),
});
export type ListAgentLessonsInput = z.input<typeof ListAgentLessonsInputSchema>;

export const AgentLessonEntrySchema = z.object({
	evidence: LessonEvidenceSchema.nullable().optional(),
	id: z.string().describe("Fact id"),
	text: z.string(),
	addedAt: z
		.string()
		.nullable()
		.describe("When the lesson was written (its fact's creation time)"),
	learnedFrom: z
		.object({
			replies: z
				.number()
				.int()
				.nonnegative()
				.describe("Decisions (replies) the lesson cites"),
			lastReplyAt: z
				.string()
				.nullable()
				.describe("Time of the newest cited reply"),
			fromCaller: z
				.boolean()
				.describe("True when the lesson was learned from the caller's replies"),
		})
		.nullable()
		.describe("Null when the lesson cites no decisions (written by hand)"),
});
export type AgentLessonEntry = z.infer<typeof AgentLessonEntrySchema>;

export const ListAgentLessonsResultSchema = z.object({
	lessons: z.array(AgentLessonEntrySchema),
});
export type ListAgentLessonsResult = z.infer<
	typeof ListAgentLessonsResultSchema
>;

export const MineAgentSessionLessonsInputSchema = z.strictObject({});
export type MineAgentSessionLessonsInput = z.input<
	typeof MineAgentSessionLessonsInputSchema
>;

export const MineAgentSessionLessonsResultSchema = z.object({
	organizationId: z.string(),
	decisionEventsScanned: z.number().int().nonnegative(),
	factsWritten: z.number().int().nonnegative(),
	factsSuperseded: z.number().int().nonnegative(),
	factsRoutedToTedi: z.number().int().nonnegative(),
	factsArchived: z.number().int().nonnegative(),
	mistakeEventsRecorded: z.number().int().nonnegative(),
	proposalsCreated: z.number().int().nonnegative(),
	/** True when a per-run cap stopped the run early; run it again. */
	budgetHit: z.boolean(),
	/** The run outlasted the reply window and continues in the background;
	 * the counts are what was done by then. Ask again in a minute. */
	inProgress: z.boolean().optional(),
});
export type MineAgentSessionLessonsResult = z.infer<
	typeof MineAgentSessionLessonsResultSchema
>;

export const GetLessonEffectivenessInputSchema = z.strictObject({
	weeks: z
		.number()
		.int()
		.min(1)
		.max(8)
		.default(4)
		.describe("How many recent weeks of sessions to measure"),
});
export type GetLessonEffectivenessInput = z.input<
	typeof GetLessonEffectivenessInputSchema
>;

const LessonEffectivenessArmSchema = z.object({
	/** Sessions in this arm. */
	sessions: z.number().int().nonnegative(),
	/** Matching user corrections in those sessions after the lessons arrived. */
	corrections: z.number().int().nonnegative(),
	/** Corrections per session; null without sessions. */
	rate: z.number().nullable(),
});
export type LessonEffectivenessArm = z.infer<
	typeof LessonEffectivenessArmSchema
>;

export const LessonEffectivenessVerdictSchema = z.enum([
	"insufficient",
	"helps",
	"no_better",
]);
export type LessonEffectivenessVerdict = z.infer<
	typeof LessonEffectivenessVerdictSchema
>;

export const LessonEffectivenessEntrySchema = z.object({
	/** The lesson's lineage; a superseding lesson keeps it. */
	topicKey: z.string(),
	/** The current lesson under the key, when it is still delivered. */
	lessonId: z.string().nullable(),
	shortId: z.string().nullable(),
	subjects: z.array(z.string()),
	/** Sessions that received it, and corrections there on its subject. */
	delivered: LessonEffectivenessArmSchema,
	/** Holdout sessions it would have reached, and corrections there. */
	holdout: LessonEffectivenessArmSchema,
	verdict: LessonEffectivenessVerdictSchema,
});
export type LessonEffectivenessEntry = z.infer<
	typeof LessonEffectivenessEntrySchema
>;

export const GetLessonEffectivenessResultSchema = z.object({
	organizationId: z.string(),
	since: z.string(),
	holdoutPercent: z.number(),
	/** Every correction in sessions that got learned lessons vs the holdout. */
	overall: z.object({
		delivered: LessonEffectivenessArmSchema,
		holdout: LessonEffectivenessArmSchema,
	}),
	weeks: z.array(
		z.object({
			/** Monday (UTC) of the week the session first received lessons. */
			weekStart: z.string(),
			delivered: LessonEffectivenessArmSchema,
			holdout: LessonEffectivenessArmSchema,
		}),
	),
	lessons: z.array(LessonEffectivenessEntrySchema),
	/** A read cap was reached; older sessions were not counted. */
	truncated: z.boolean(),
});
export type GetLessonEffectivenessResult = z.infer<
	typeof GetLessonEffectivenessResultSchema
>;

export const UpdateLessonTriggersInputSchema = z.strictObject({
	lessonId: z.string().uuid(),
	triggers: LessonTriggersSchema,
});
export const BackfillLessonTriggersInputSchema = z.strictObject({
	limit: z.number().int().min(1).max(25).default(10),
});
export const BackfillLessonTriggersResultSchema = z.object({
	updated: z.number(),
	remaining: z.number(),
});
export const RecordLessonIncidentInputSchema = z.strictObject({
	eventId: z.string().min(1).max(200),
	reason: z.string().min(1).max(2000),
	occurredAt: z.string().datetime(),
	lessonIds: z.array(z.string().uuid()).max(20).default([]),
	repo: z.string().max(300).optional(),
	paths: z.array(z.string().max(300)).max(30).optional(),
	projectId: z.string().uuid(),
	actor: z.strictObject({
		sessionId: z.string().max(200),
		harness: z.string().max(40),
		hookTrust: z.enum(["trusted", "untrusted", "unknown"]),
		dispatchPath: z.string().max(100),
		delivery: z.enum(["observed", "absent", "unknown"]),
	}),
});
export const RecordLessonIncidentResultSchema = z.object({
	fingerprint: z.string(),
	lessonIds: z.array(z.string()),
	workItemIds: z.array(z.string()),
});
