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

export const GetAgentSessionLessonsInputSchema = z.strictObject({
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
});
export type GetAgentSessionLessonsInput = z.input<
	typeof GetAgentSessionLessonsInputSchema
>;

export const AgentSessionLessonSchema = z.object({
	id: z.string().describe("Fact id"),
	shortId: z.string().describe("First 8 characters of the fact id"),
	text: z.string(),
	scope: z.object({
		repo: z.string(),
		harness: z.string(),
		topic: z.string(),
	}),
	updatedAt: z.string().nullable(),
});
export type AgentSessionLesson = z.infer<typeof AgentSessionLessonSchema>;

export const GetAgentSessionLessonsResultSchema = z.object({
	organizationId: z.string(),
	lessons: z.array(AgentSessionLessonSchema),
	/** Approved lessons that apply to this session before the byte budget. */
	matched: z.number().int().nonnegative(),
	/** True when the budget dropped at least one matching lesson. */
	truncated: z.boolean(),
});
export type GetAgentSessionLessonsResult = z.infer<
	typeof GetAgentSessionLessonsResultSchema
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
	/** The run outlasted the reply window and continues in the background; the
	 * counts are what it had done by then. Ask again later for more. */
	inProgress: z.boolean().optional(),
});
export type MineAgentSessionLessonsResult = z.infer<
	typeof MineAgentSessionLessonsResultSchema
>;
