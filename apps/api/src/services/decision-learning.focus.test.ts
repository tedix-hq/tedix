import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { recordLearningInteraction } from "@tedix/db/queries/learning-feedback";
import { createD1Facade } from "../../../../packages/db/src/test/d1-facade";
import { schemaDdl } from "../../../../packages/db/src/test/schema-ddl";
import { readDecisionLearning } from "./decision-learning";
vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	listApprovedAgentLessons: vi.fn().mockResolvedValue([]),
}));

it("the real model reader learns feed feedback without neutral exposures displacing it", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, learningInteractionEvents));
	sqlite.exec("PRAGMA foreign_keys=OFF");
	const db = createDbClient(createD1Facade(sqlite));
	const organizationId = "fictional-cedar";
	await db.insert(organizations).values({
		id: organizationId,
		name: "Fictional Cedar",
		slug: "fictional-cedar",
		metadata: { decisionLearning: { enabled: true, historyLimit: 30 } },
	});
	const base = {
		organizationId,
		actorType: "user" as const,
		actorId: "morgan",
		scopeKind: "personal" as const,
		scopeId: "morgan",
		surface: "focus_feed",
		eventKind: "answered" as const,
		metadata: { reaction: "pin", classId: "supplier" },
		occurredAt: "2030-01-01T12:00:00.000Z",
	};
	await recordLearningInteraction(db, {
		...base,
		clientEventId: "pin-supplier",
	});
	await recordLearningInteraction(db, {
		...base,
		clientEventId: "other-person",
		actorId: "river",
		scopeId: "river",
		metadata: { reaction: "pin", classId: "private" },
	});
	for (let i = 0; i < 40; i++)
		for (const surface of ["focus_feed", "focus_feed_counterfactual"])
			await recordLearningInteraction(db, {
				...base,
				clientEventId: `${surface}:${i}`,
				surface,
				eventKind: "delivered",
				metadata: { reaction: "impression", classId: "supplier" },
				occurredAt: "2030-01-01T12:00:30.000Z",
			});
	const model = await readDecisionLearning(
		db,
		organizationId,
		"morgan",
		new Date("2030-01-01T12:01:00Z"),
	);
	expect(model.eventCount).toBe(1);
	expect(
		model.weights.personal.find((w) => w.key === "class:supplier")?.value,
	).toBeGreaterThan(0);
	expect(model.weights.personal.some((w) => w.key === "class:private")).toBe(
		false,
	);
	sqlite.close();
});
