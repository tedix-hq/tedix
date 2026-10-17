import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizations } from "../schema/organizations";
import { learningInteractionEvents } from "../schema/learning-feedback";
import { tedis } from "../schema/tedis";
import { schemaDdl } from "../test/schema-ddl";
import { createD1Facade } from "../test/d1-facade";
import {
	getDecisionLearningConfig,
	setDecisionLearningConfig,
} from "./decision-learning";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import {
	recordLearningInteraction,
	listLearningInteractions,
} from "./learning-feedback";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";

it("persists one tenant's policy without overwriting unrelated metadata or changing another tenant", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values([
		{
			id: "org-lighthouse",
			name: "Lighthouse",
			slug: "lighthouse",
			metadata: { industryVertical: "fictional" },
		},
		{ id: "org-harbor", name: "Harbor", slug: "harbor" },
	]);
	await setDecisionLearningConfig(
		db,
		"org-lighthouse",
		DecisionLearningConfigSchema.parse({
			enabled: true,
			unchangedThreshold: 7,
		}),
	);
	expect(
		(await getDecisionLearningConfig(db, "org-lighthouse")).unchangedThreshold,
	).toBe(7);
	expect((await getDecisionLearningConfig(db, "org-harbor")).enabled).toBe(
		false,
	);
	expect(
		sqlite
			.prepare(
				"SELECT json_extract(metadata,'$.industryVertical') AS value FROM organizations WHERE id='org-lighthouse'",
			)
			.get()?.value,
	).toBe("fictional");
});

describe("durable decision replay", () => {
	it("replays 30 stored signals with personal isolation and a durable correction", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(organizations, tedis, learningInteractionEvents));
		sqlite.exec("PRAGMA foreign_keys = OFF");
		const db = createDbClient(createD1Facade(sqlite));
		const now = new Date("2026-06-10T10:00:00Z");
		for (let i = 0; i < 30; i++)
			await recordLearningInteraction(db, {
				organizationId: "org-lighthouse",
				actorType: "user",
				actorId: "person-river",
				clientEventId: `decision-${i}`,
				eventKind: i < 10 ? "rejected" : i < 20 ? "edited" : "accepted",
				scopeKind: "personal",
				scopeId: "person-river",
				surface: "decision_capture",
				metadata: {
					decisionClass: i < 10 ? "news" : "investor-email",
					decisionChoice: "approve",
					feedbackSignal: "approve-as-is",
					serverObserved: true,
					originalBody:
						i >= 10 && i < 20
							? "I am writing at length to introduce this project for your consideration."
							: null,
					editedBody: i >= 10 && i < 20 ? "Our seed round is open." : null,
				},
				occurredAt: new Date(now.getTime() - 60000 * (31 - i)).toISOString(),
			});
		const events = await listLearningInteractions(db, {
			organizationId: "org-lighthouse",
			personalScopeId: "person-river",
			limit: 100,
		});
		const config = DecisionLearningConfigSchema.parse({ enabled: true });
		const model = learnDecisions({
			organizationId: "org-lighthouse",
			personId: "person-river",
			events,
			config,
			now,
		});
		expect(model.eventCount).toBe(30);
		expect(model.preferences[0]?.sentence).toContain("shorter");
		expect(
			model.readiness.find((r) => r.classId === "investor-email")?.ready,
		).toBe(true);
		expect(
			await listLearningInteractions(db, {
				organizationId: "org-lighthouse",
				personalScopeId: "someone-else",
				limit: 100,
			}),
		).toEqual([]);
		const last = events[0]!;
		await recordLearningInteraction(db, {
			organizationId: "org-lighthouse",
			actorType: "user",
			actorId: "person-river",
			clientEventId: "correction",
			eventKind: "undone",
			scopeKind: "personal",
			scopeId: "person-river",
			surface: "decision_learning",
			metadata: { learningCorrection: true, correctsEventId: last.id },
			occurredAt: now.toISOString(),
		});
		expect(
			learnDecisions({
				organizationId: "org-lighthouse",
				personId: "person-river",
				events: await listLearningInteractions(db, {
					organizationId: "org-lighthouse",
					personalScopeId: "person-river",
					limit: 100,
				}),
				config,
				now,
			}).eventCount,
		).toBe(29);
	});
});
