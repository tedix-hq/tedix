import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	learningInteractionEvents,
	learningImprovementProposals,
} from "@tedix/db/schema/learning-feedback";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it } from "vite-plus/test";
import { parseReflectedLessons } from "@tedix/context-core/request-ledger";
import {
	recordFilingCorrectionLesson,
	recordLedgerLessonCandidates,
} from "./request-ledger-lessons";

it("compares paraphrases against approved lessons, memory and earlier personal proposals without leaking private sources", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			learningInteractionEvents,
			learningImprovementProposals,
			memoryFacts,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	const insert = sqlite.prepare(`INSERT INTO memory_facts
		(id,organization_id,content,fact_type,confidence,visibility,review_status,status,topic_key,metadata)
		VALUES (?,? ,?,'observation',0.9,?,'confirmed','active',?,?)`);
	insert.run(
		"approved",
		"org-example",
		"Send large content through the native uploader",
		"org",
		"learning-feed:upload",
		null,
	);
	insert.run(
		"memory",
		"org-example",
		"The inline transport caps body size",
		"shared",
		null,
		null,
	);
	insert.run("foreign", "org-elsewhere", "FOREIGN TENANT", "org", null, null);
	insert.run(
		"private",
		"org-example",
		"OTHER USER PRIVATE",
		"private",
		"learning-feed:private",
		JSON.stringify({ learningFeed: { ownerUserId: "other-user" } }),
	);
	const scope = {
		organizationId: "org-example",
		ownerUserId: "ada",
		repository: "example/app",
		harness: "codex",
		sessionKey: "session-a",
		sourceAt: "2026-10-16T10:00:00Z",
	};
	const lesson = {
		rule: "Inline content overflows → use native uploads. Why: the size limit.",
		failure: "Failed upload due to size limit",
		fix: "Native upload succeeded",
		failureEventId: "failure",
		fixEventId: "fix",
	};
	await recordLedgerLessonCandidates(db, [lesson], scope, async (prompt) => {
		expect(prompt).toContain("Send large content through the native uploader");
		expect(prompt).toContain("The inline transport caps body size");
		expect(prompt).not.toContain("FOREIGN TENANT");
		expect(prompt).not.toContain("OTHER USER PRIVATE");
		return '{"novel":[]}';
	});
	expect(
		sqlite
			.prepare("SELECT count(*) n FROM learning_improvement_proposals")
			.get(),
	).toEqual({ n: 0 });
	await expect(
		recordLedgerLessonCandidates(db, [lesson], scope, async () => null),
	).rejects.toThrow("semantic comparison unavailable");
	await recordLedgerLessonCandidates(
		db,
		[lesson],
		scope,
		async () => '{"novel":[0]}',
	);
	await recordLedgerLessonCandidates(
		db,
		[{ ...lesson, rule: "Use native transport when inline bodies overflow" }],
		scope,
		async (prompt) => {
			expect(JSON.parse(prompt).existing).toContain(lesson.rule);
			return '{"novel":[]}';
		},
	);
	expect(
		sqlite
			.prepare("SELECT count(*) n FROM learning_improvement_proposals")
			.get(),
	).toEqual({ n: 1 });
});

it("requires both a recorded failure and its explicit fix", () => {
	const lesson = {
		rule: "Long uploads fail → use the native uploader. Why: the inline content limit.",
		failure: "Failed upload: content too long",
		fix: "Switched to the native uploader and saved successfully",
	};
	const raw = JSON.stringify({ lessons: [lesson, lesson] });
	expect(parseReflectedLessons(raw, lesson.fix, lesson.failure)).toEqual([
		lesson,
	]);
	expect(
		parseReflectedLessons(raw, "I'll try the uploader later", lesson.failure),
	).toEqual([]);
	expect(parseReflectedLessons(raw, lesson.fix, "Started upload")).toEqual([]);
});

it("deduplicates candidate lessons across retries, backfills and sessions without approving them", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(learningInteractionEvents));
	sqlite.exec(schemaDdl(learningImprovementProposals));
	sqlite.exec(schemaDdl(memoryFacts));
	const db = createDbClient(createD1Facade(sqlite));
	const lesson = {
		rule: "Long uploads fail → use the native uploader. Why: the inline content limit.",
		failure: "Failed upload: content too long",
		fix: "Switched to the native uploader and saved successfully",
		failureEventId: "source-failure",
		fixEventId: "source-fix",
	};
	const scope = {
		organizationId: "org-example",
		ownerUserId: "subject-ada",
		repository: "example/app",
		harness: "codex",
		sessionKey: "session-a",
		sourceAt: "2026-10-16T10:00:00Z",
	};
	await recordLedgerLessonCandidates(
		db,
		[lesson],
		scope,
		async () => '{"novel":[0]}',
	);
	await recordLedgerLessonCandidates(
		db,
		[{ ...lesson, fix: "Native upload succeeded again" }],
		{ ...scope, sessionKey: "session-b:v3" },
		async () => '{"novel":[0]}',
	);
	expect(
		sqlite.prepare("SELECT count(*) n FROM learning_interaction_events").get(),
	).toEqual({ n: 1 });
	const proposal = sqlite
		.prepare(
			"SELECT status,scope_kind,promotion_route FROM learning_improvement_proposals",
		)
		.all();
	expect(proposal).toEqual([
		{
			status: "proposed",
			scope_kind: "personal",
			promotion_route: "memory_fact_governance",
		},
	]);
	const evidence = sqlite
		.prepare("SELECT metadata FROM learning_interaction_events")
		.get()!;
	expect(JSON.parse(String(evidence.metadata))).toMatchObject({
		failureEventId: "source-failure",
		fixEventId: "source-fix",
	});
});

it("accepts the exact error text inside a failure receipt without requiring its prefix", () => {
	const lesson = {
		rule: "Large uploads fail → use the native uploader. Why: the inline content limit.",
		failure: "content exceeds the upload limit",
		fix: "Native upload saved successfully",
	};
	expect(
		parseReflectedLessons(
			JSON.stringify({ lessons: [lesson] }),
			lesson.fix,
			`Failed upload: ${lesson.failure}`,
		),
	).toEqual([lesson]);
	expect(
		parseReflectedLessons(
			JSON.stringify({ lessons: [lesson] }),
			lesson.fix,
			`Agent said: ${lesson.failure}`,
		),
	).toEqual([]);
});

it("reuses the lesson proposal pipeline with the correction's personal or project visibility", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(learningInteractionEvents, learningImprovementProposals),
	);
	const db = createDbClient(createD1Facade(sqlite));
	const [event] = await db
		.insert(learningInteractionEvents)
		.values({
			id: "filing-correction",
			organizationId: "org-example",
			actorType: "user",
			actorId: "identity-ada",
			clientEventId: "correction",
			eventKind: "edited",
			scopeKind: "project",
			scopeId: "project-docs",
			issueKey: "request-filing:request-example",
			surface: "request_filing",
			targetType: "request",
			targetId: "request-example",
			metadata: {
				text: "Improve guides",
				projectId: "project-docs",
				previousProjectId: "project-tools",
			},
			occurredAt: "2026-10-10T10:00:00.000Z",
		})
		.returning();
	await recordFilingCorrectionLesson(db, event!);
	await recordFilingCorrectionLesson(db, event!);
	const proposals = await db.select().from(learningImprovementProposals);
	expect(proposals).toHaveLength(1);
	expect(proposals[0]).toMatchObject({
		scopeKind: "project",
		scopeId: "project-docs",
		status: "proposed",
		evidenceEventIds: [event!.id],
	});
});
