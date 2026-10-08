/**
 * Lesson effectiveness: delivered vs holdout corrections, and the nightly
 * retirement of learned lessons that do not reduce them.
 */

import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	correctionSubjects,
	HOLDOUT_PERCENT,
	isHoldoutSession,
	lessonSubjects,
} from "./lesson-delivery";
import {
	readLessonEffectiveness,
	retireIneffectiveLessons,
	summarizeLessonEffectiveness,
	weekStart,
} from "./lesson-effectiveness";
import { isReplaceableLesson } from "./learning-feed-miner";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "user-a";
const KEY = `learning-feed:decision:general:general:communication:user:${USER}`;
const NOW = new Date("2026-10-08T12:00:00Z");

function setup(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryFacts));
	// The generated DDL leaves out SQL defaults; D1 has CURRENT_TIMESTAMP.
	const ddl = schemaDdl(learningInteractionEvents).replace(
		/(created_at\W*\s+text\s+NOT NULL)/i,
		"$1 DEFAULT CURRENT_TIMESTAMP",
	);
	expect(ddl).toContain("DEFAULT CURRENT_TIMESTAMP");
	sqlite.exec(ddl);
	const db = createDbClient(
		createD1Facade(sqlite) as unknown as D1Database,
	) as DbClient;
	return { db, sqlite };
}

function insertFact(
	sqlite: DatabaseSync,
	id: string,
	topicKey: string,
	metadata: Record<string, unknown>,
	priority = "active",
) {
	sqlite
		.prepare(
			`INSERT INTO memory_facts (id, organization_id, topic_key, content, fact_type, status, review_status, use_policy, visibility, priority, confidence, metadata)
			 VALUES (?, ?, ?, ?, 'preference', 'active', 'confirmed', 'requires_user_confirmation', 'private', ?, 0.8, ?)`,
		)
		.run(
			id,
			ORG,
			topicKey,
			"How to answer and report:\n- Keep answers short.",
			priority,
			JSON.stringify(metadata),
		);
}

let seq = 0;
function insertEvent(
	sqlite: DatabaseSync,
	row: {
		surface: string;
		eventKind: string;
		threadId: string;
		occurredAt: string;
		metadata: Record<string, unknown>;
	},
) {
	seq++;
	sqlite
		.prepare(
			`INSERT INTO learning_interaction_events (id, organization_id, actor_type, actor_id, client_event_id, signal_class, event_kind, scope_kind, scope_id, surface, thread_id, metadata, occurred_at)
			 VALUES (?, ?, 'user', ?, ?, 'quality', ?, 'personal', ?, ?, ?, ?, ?)`,
		)
		.run(
			`event-${seq}`,
			ORG,
			USER,
			`client-${seq}`,
			row.eventKind,
			USER,
			row.surface,
			row.threadId,
			JSON.stringify(row.metadata),
			row.occurredAt,
		);
}

/** `delivered` sessions got the lesson, `holdout` sessions had it withheld. */
function seedSessions(
	sqlite: DatabaseSync,
	input: {
		delivered: number;
		holdout: number;
		deliveredCorrections: number;
		holdoutCorrections: number;
		at: string;
	},
) {
	const at = input.at;
	const later = new Date(new Date(at).getTime() + 60_000).toISOString();
	const sessions = [
		...Array.from({ length: input.delivered }, (_, i) => ({
			id: `d-${at}-${i}`,
			holdout: false,
			corrections: i < input.deliveredCorrections ? 1 : 0,
		})),
		...Array.from({ length: input.holdout }, (_, i) => ({
			id: `h-${at}-${i}`,
			holdout: true,
			corrections: i < input.holdoutCorrections ? 1 : 0,
		})),
	];
	for (const session of sessions) {
		insertEvent(sqlite, {
			surface: "lesson_delivery",
			eventKind: "delivered",
			threadId: session.id,
			occurredAt: at,
			metadata: {
				holdout: session.holdout,
				measured: [
					{ id: "fact-mined", topicKey: KEY, subjects: ["communication"] },
				],
			},
		});
		for (let c = 0; c < session.corrections; c++)
			insertEvent(sqlite, {
				surface: "decision_capture",
				eventKind: "answered",
				threadId: session.id,
				occurredAt: later,
				metadata: {
					answer: "Too long, explain it in plain English",
					replyClass: "plain-english",
				},
			});
	}
}

describe("holdout", () => {
	it("is stable per session and close to the holdout share", async () => {
		const ids = Array.from(
			{ length: 2000 },
			(_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		);
		const arms = await Promise.all(ids.map(isHoldoutSession));
		const share = (arms.filter(Boolean).length / ids.length) * 100;
		expect(share).toBeGreaterThan(HOLDOUT_PERCENT - 2);
		expect(share).toBeLessThan(HOLDOUT_PERCENT + 2);
		expect(await isHoldoutSession(ids[7]!.toUpperCase())).toBe(arms[7]);
	});
});

describe("subjects", () => {
	it("reads a lesson's subject tag and a correction's class and words", () => {
		expect(
			lessonSubjects({
				content: "x",
				metadata: { learningFeed: { scope: { topic: "git" } } },
			}),
		).toEqual(["git"]);
		expect(
			lessonSubjects({
				content: "How the user works",
				metadata: {
					learningFeed: {
						scope: { topic: "standing" },
						rules: [{ subject: "communication" }, { subject: "deploy" }],
					},
				},
			}),
		).toEqual(["communication", "deploy"]);
		expect(
			correctionSubjects({
				eventKind: "answered",
				metadata: { replyClass: "verify", answer: "Did you push it?" },
			}),
		).toEqual(expect.arrayContaining(["git", "deploy"]));
		// A plain continue is no correction.
		expect(
			correctionSubjects({
				eventKind: "answered",
				metadata: { replyClass: "continue", answer: "go on" },
			}),
		).toBeNull();
		// An edited draft is one, whatever its class.
		expect(
			correctionSubjects({ eventKind: "edited", metadata: { answer: "no" } }),
		).toEqual([]);
	});
});

describe("summarizeLessonEffectiveness", () => {
	it("compares corrections after delivery, per lesson subject and week", async () => {
		const { db, sqlite } = setup();
		seedSessions(sqlite, {
			delivered: 20,
			holdout: 4,
			deliveredCorrections: 2,
			holdoutCorrections: 2,
			at: "2026-10-05T10:00:00.000Z",
		});
		// A correction before the lesson arrived does not count.
		insertEvent(sqlite, {
			surface: "decision_capture",
			eventKind: "answered",
			threadId: "d-2026-10-05T10:00:00.000Z-10",
			occurredAt: "2026-10-05T09:00:00.000Z",
			metadata: { answer: "explain it simpler", replyClass: "plain-english" },
		});
		// A correction on another subject counts overall, not for the lesson.
		insertEvent(sqlite, {
			surface: "decision_capture",
			eventKind: "answered",
			threadId: "d-2026-10-05T10:00:00.000Z-11",
			occurredAt: "2026-10-05T11:00:00.000Z",
			metadata: { answer: "That commit is wrong", replyClass: "correction" },
		});
		const report = await readLessonEffectiveness(
			{ db, authType: "user", user: { sub: USER } } as never,
			ORG,
			4,
			NOW,
		);
		expect(report.overall.delivered).toEqual({
			sessions: 20,
			corrections: 3,
			rate: 0.15,
		});
		expect(report.overall.holdout).toEqual({
			sessions: 4,
			corrections: 2,
			rate: 0.5,
		});
		expect(report.weeks).toEqual([
			expect.objectContaining({ weekStart: "2026-10-05" }),
		]);
		expect(report.lessons).toEqual([
			expect.objectContaining({
				topicKey: KEY,
				subjects: ["communication"],
				delivered: { sessions: 20, corrections: 2, rate: 0.1 },
				holdout: { sessions: 4, corrections: 2, rate: 0.5 },
				verdict: "helps",
			}),
		]);
		// Another person sees none of this user's personal sessions.
		const other = await readLessonEffectiveness(
			{ db, authType: "user", user: { sub: "user-b" } } as never,
			ORG,
			4,
			NOW,
		);
		expect(other.overall.delivered.sessions).toBe(0);
		expect(other.lessons).toEqual([]);
	});

	it("gives no verdict without enough exposure", () => {
		const report = summarizeLessonEffectiveness({
			deliveries: [],
			decisions: [],
		});
		expect(report.lessons).toEqual([]);
		expect(report.overall.delivered.rate).toBeNull();
	});
});

describe("retireIneffectiveLessons", () => {
	it("decays a learned lesson that does not help, then archives it, never a written one", async () => {
		const { db, sqlite } = setup();
		insertFact(sqlite, "fact-mined", KEY, {
			learningFeed: {
				autoConfirmed: true,
				ownerUserId: USER,
				scope: { repo: "general", harness: "general", topic: "communication" },
			},
		});
		insertFact(sqlite, "fact-written", KEY.replace("communication", "x"), {
			learningFeed: { scope: { topic: "communication" } },
		});
		seedSessions(sqlite, {
			delivered: 20,
			holdout: 4,
			deliveredCorrections: 5,
			holdoutCorrections: 1,
			at: "2026-10-01T10:00:00.000Z",
		});
		const confidence = () =>
			sqlite
				.prepare(
					"SELECT confidence, archived_at FROM memory_facts WHERE id = ?",
				)
				.get("fact-mined") as {
				confidence: number;
				archived_at: string | null;
			};

		expect(
			await retireIneffectiveLessons(db, { orgId: ORG, now: NOW }),
		).toEqual({ evaluated: 1, decayed: 1, archived: 0 });
		expect(confidence().confidence).toBeCloseTo(0.64);
		// The same week again is a no-op.
		expect(
			await retireIneffectiveLessons(db, {
				orgId: ORG,
				now: new Date("2026-10-09T12:00:00Z"),
			}),
		).toEqual({ evaluated: 1, decayed: 0, archived: 0 });
		expect(confidence().confidence).toBeCloseTo(0.64);
		// Two more weeks with the same evidence: decayed, then archived.
		await retireIneffectiveLessons(db, {
			orgId: ORG,
			now: new Date("2026-10-15T12:00:00Z"),
		});
		expect(confidence().confidence).toBeCloseTo(0.512);
		const third = await retireIneffectiveLessons(db, {
			orgId: ORG,
			now: new Date("2026-10-22T12:00:00Z"),
		});
		expect(third.archived).toBe(1);
		expect(confidence().archived_at).toBe("2026-10-22T12:00:00.000Z");
		const mined = sqlite
			.prepare("SELECT metadata FROM memory_facts WHERE id = 'fact-mined'")
			.get() as { metadata: string };
		const meta = JSON.parse(mined.metadata);
		expect(meta.learningFeed.retired).toBeTruthy();
		// A retired lesson is settled: the distiller never learns it again.
		expect(
			isReplaceableLesson({ reviewStatus: "confirmed", metadata: meta }),
		).toBe(false);
		const written = sqlite
			.prepare(
				"SELECT confidence, archived_at FROM memory_facts WHERE id = 'fact-written'",
			)
			.get() as { confidence: number; archived_at: string | null };
		expect(written).toEqual({ confidence: 0.8, archived_at: null });
		// Every decision is logged.
		const log = sqlite
			.prepare(
				"SELECT metadata FROM learning_interaction_events WHERE surface = 'lesson_retirement' ORDER BY occurred_at",
			)
			.all() as Array<{ metadata: string }>;
		expect(log.map((row) => JSON.parse(row.metadata).action)).toEqual([
			"decay",
			"decay",
			"archive",
		]);
	});

	it("leaves a lesson that helps, or one without exposure, alone", async () => {
		const { db, sqlite } = setup();
		insertFact(sqlite, "fact-mined", KEY, {
			learningFeed: { autoConfirmed: true, ownerUserId: USER },
		});
		seedSessions(sqlite, {
			delivered: 20,
			holdout: 4,
			deliveredCorrections: 3,
			holdoutCorrections: 2,
			at: "2026-10-01T10:00:00.000Z",
		});
		expect(
			await retireIneffectiveLessons(db, { orgId: ORG, now: NOW }),
		).toEqual({ evaluated: 1, decayed: 0, archived: 0 });
		const thin = setup();
		insertFact(thin.sqlite, "fact-mined", KEY, {
			learningFeed: { autoConfirmed: true, ownerUserId: USER },
		});
		seedSessions(thin.sqlite, {
			delivered: 19,
			holdout: 4,
			deliveredCorrections: 19,
			holdoutCorrections: 0,
			at: "2026-10-01T10:00:00.000Z",
		});
		expect(
			await retireIneffectiveLessons(thin.db, { orgId: ORG, now: NOW }),
		).toEqual({ evaluated: 0, decayed: 0, archived: 0 });
	});

	it("weeks start on Monday", () => {
		expect(weekStart("2026-10-08T12:00:00Z")).toBe("2026-10-05");
		expect(weekStart("2026-10-05T00:00:00Z")).toBe("2026-10-05");
		expect(weekStart("2026-10-04T23:59:59Z")).toBe("2026-09-28");
	});
});
