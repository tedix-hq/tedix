import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { importAgentSessionDecisions } from "./agent-session-decision-import";

describe("historic session imports against D1 persistence", () => {
	it("records a new member's decisions once and preserves their personal scope on repeat import", async () => {
		const sqlite = new DatabaseSync(":memory:");
		onTestFinished(() => sqlite.close());
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(learningInteractionEvents));
		const db = createDbClient(createD1Facade(sqlite));
		const input = {
			organizationId: "org-acme",
			userId: "member-grace",
			decisions: (["claude-code", "codex", "opencode"] as const).flatMap(
				(harness) =>
					["turn-1", "turn-2"].map((turnId) => ({
						harness,
						sessionId: `fictional-${harness}-session`,
						turnId,
						repository: "acme-app",
						topic: "preferences",
						occurredAt: "2026-03-01T10:00:00.000Z",
						agentMessage: "Should I use technical language?",
						reply: "Keep the explanation in plain English.",
					})),
			),
		};
		expect(await importAgentSessionDecisions(db, input)).toEqual({
			received: 6,
			recorded: 6,
			duplicates: 0,
		});
		const stored = () =>
			sqlite
				.prepare("SELECT * FROM learning_interaction_events ORDER BY id")
				.all();
		const first = stored();
		expect(await importAgentSessionDecisions(db, input)).toEqual({
			received: 6,
			recorded: 0,
			duplicates: 6,
		});
		expect(stored()).toEqual(first);
		expect(first).toHaveLength(6);
		for (const row of first)
			expect(row).toMatchObject({
				organization_id: "org-acme",
				actor_id: "member-grace",
				scope_kind: "personal",
				scope_id: "member-grace",
			});
	});
});
