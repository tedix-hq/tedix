import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	learningInteractionEvents,
	learningImprovementProposals,
} from "@tedix/db/schema/learning-feedback";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it } from "vite-plus/test";
import { parseReflectedLessons } from "@tedix/context-core/request-ledger";
import { recordLedgerLessonCandidates } from "./request-ledger-lessons";

it("requires both a recorded failure and its explicit fix", () => {
	const lesson = {
		rule: "Use the native uploader for long content",
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
	const db = createDbClient(createD1Facade(sqlite));
	const lesson = {
		rule: "Use the native uploader for long content",
		failure: "Failed upload: content too long",
		fix: "Switched to the native uploader and saved successfully",
	};
	const scope = {
		organizationId: "org-example",
		ownerUserId: "subject-ada",
		repository: "example/app",
		harness: "codex",
		sessionKey: "session-a",
		sourceAt: "2026-10-16T10:00:00Z",
	};
	await recordLedgerLessonCandidates(db, [lesson], scope);
	await recordLedgerLessonCandidates(
		db,
		[{ ...lesson, fix: "Native upload succeeded again" }],
		{ ...scope, sessionKey: "session-b:v3" },
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
});

it("accepts the exact error text inside a failure receipt without requiring its prefix", () => {
	const lesson = {
		rule: "Use the native uploader for large content",
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
