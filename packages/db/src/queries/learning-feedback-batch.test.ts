import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { learningInteractionEvents } from "../schema/learning-feedback";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listLearningInteractionsForIssueKey,
	listLearningInteractionsForIssuePrefix,
	listLearningIssueKeysForReflection,
	listLearningOwnersForReflection,
	listOwnerLearningInteractionsPage,
	recordLearningInteractionsBatch,
} from "./learning-feedback";

function makeDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, tedis, learningInteractionEvents));
	// The tenant row is not under test here.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	return createDbClient(createD1Facade(sqlite));
}

function row(n: number, over: { scopeId?: string; issueKey?: string } = {}) {
	return {
		organizationId: "org-1",
		actorType: "user" as const,
		actorId: "user-1",
		clientEventId: `agent-session-import:${n}`,
		eventKind: "answered" as const,
		scopeKind: "personal" as const,
		scopeId: over.scopeId ?? "user-1",
		issueKey: over.issueKey ?? `decision:acme:codex:t${n % 3}`,
		surface: "agent_session_import",
		metadata: { answer: `reply ${n}` },
		occurredAt: `2025-01-${String((n % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
	};
}

describe("recordLearningInteractionsBatch", () => {
	it("writes many rows under the bound-parameter ceiling and is idempotent", async () => {
		const db = makeDb();
		const rows = Array.from({ length: 25 }, (_, n) => row(n));
		expect(await recordLearningInteractionsBatch(db, rows)).toEqual({
			recorded: 25,
		});
		expect(
			await recordLearningInteractionsBatch(db, [...rows, row(99)]),
		).toEqual({ recorded: 1 });
	});

	it("lists scopes and their events, optionally only one person's", async () => {
		const db = makeDb();
		await recordLearningInteractionsBatch(db, [
			row(1, { issueKey: "decision:acme:codex:a" }),
			row(2, { issueKey: "decision:acme:codex:b" }),
			row(3, { issueKey: "decision:acme:codex:c", scopeId: "user-2" }),
		]);
		expect(
			await listLearningIssueKeysForReflection(db, {
				organizationId: "org-1",
				surface: "agent_session_import",
				ownerUserId: "user-1",
				limit: 10,
			}),
		).toEqual(["decision:acme:codex:b", "decision:acme:codex:a"]);
		const events = await listLearningInteractionsForIssueKey(db, {
			organizationId: "org-1",
			issueKey: "decision:acme:codex:c",
			surfaces: ["decision_capture", "agent_session_import"],
			limit: 10,
		});
		expect(events.map((e) => e.clientEventId)).toEqual([
			"agent-session-import:3",
		]);
		const byRepo = await listLearningInteractionsForIssuePrefix(db, {
			organizationId: "org-1",
			issuePrefix: "decision:acme:",
			surfaces: ["agent_session_import"],
			limit: 10,
		});
		expect(byRepo.map((e) => e.clientEventId).sort()).toEqual([
			"agent-session-import:1",
			"agent-session-import:2",
			"agent-session-import:3",
		]);
		expect(
			await listLearningInteractionsForIssuePrefix(db, {
				organizationId: "org-1",
				issuePrefix: "decision:acm:",
				surfaces: ["agent_session_import"],
				limit: 10,
			}),
		).toEqual([]);
		expect(
			await listLearningInteractionsForIssueKey(db, {
				organizationId: "org-1",
				issueKey: "decision:acme:codex:c",
				surfaces: ["agent_session_import"],
				ownerUserId: "user-1",
				limit: 10,
			}),
		).toEqual([]);
	});
});

describe("whole-history reads", () => {
	it("summarizes each person and pages their events newest first", async () => {
		const db = makeDb();
		await recordLearningInteractionsBatch(db, [
			...Array.from({ length: 7 }, (_, n) => row(n)),
			row(50, { scopeId: "user-2" }),
		]);
		expect(
			await listLearningOwnersForReflection(db, {
				organizationId: "org-1",
				surfaces: ["agent_session_import"],
				limit: 10,
			}),
		).toEqual([
			{ ownerUserId: "user-2", events: 1, newestAt: row(50).occurredAt },
			{ ownerUserId: "user-1", events: 7, newestAt: row(6).occurredAt },
		]);
		const seen: string[] = [];
		let before: { occurredAt: string; id: string } | null = null;
		for (;;) {
			const page = await listOwnerLearningInteractionsPage(db, {
				organizationId: "org-1",
				ownerUserId: "user-1",
				surfaces: ["agent_session_import"],
				before,
				limit: 3,
			});
			seen.push(...page.map((e) => e.clientEventId));
			if (page.length < 3) break;
			const last = page.at(-1)!;
			before = { occurredAt: last.occurredAt, id: last.id };
		}
		expect(seen).toEqual(
			[6, 5, 4, 3, 2, 1, 0].map((n) => `agent-session-import:${n}`),
		);
	});
});
