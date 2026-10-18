import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	recordLearningInteraction,
	listOwnerLearningInteractionsPage,
} from "@tedix/db/queries/learning-feedback";
import type { BaseContext } from "../orpc";
import { learningFeedbackContractRouter } from "./learning-feedback";

const ORG = "10000000-0000-4000-8000-000000000001";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(organizations, tedis, memoryFacts, learningInteractionEvents),
	);
	const db = createDbClient(createD1Facade(sqlite));
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)")
		.run(ORG, "Fictional Harbor", "fictional-harbor");
	const client = (person = "river", org = ORG, role = "owner") =>
		createRouterClient(learningFeedbackContractRouter, {
			context: {
				db,
				organizationId: org,
				authType: "user",
				user: { sub: person },
				userRole: role,
				headers: new Headers(),
				url: new URL("https://api.example.test/rpc"),
				env: {},
			} as BaseContext,
		});
	return { sqlite, db, client };
}
describe("decision learning authority and correction", () => {
	it("keeps a non-admin member's factory reactions separate from another person's preferences", async () => {
		const f = fixture();
		await f
			.client()
			.configure(DecisionLearningConfigSchema.parse({ enabled: true }));
		const member = f.client("luz", ORG, "member");
		const owner = f.client();
		await owner.recordInteraction({
			clientEventId: "owner-factory",
			eventKind: "accepted",
			scope: { kind: "personal" },
			surface: "decision_deck",
			metadata: {
				decisionClass: "factory:Inbox:reply",
				decisionChoice: "useful",
			},
		});
		await expect(
			member.recordInteraction({
				clientEventId: "forged-owner",
				eventKind: "rejected",
				scope: { kind: "personal", id: "river" },
				surface: "decision_deck",
			}),
		).rejects.toThrow(/validation/);
		await member.recordInteraction({
			clientEventId: "member-factory",
			eventKind: "rejected",
			scope: { kind: "personal" },
			surface: "decision_deck",
			metadata: {
				decisionClass: "factory:Inbox:reply",
				decisionChoice: "not_useful",
			},
		});
		const own = await owner.listInteractions({
			scopeKind: "personal",
			limit: 20,
		});
		const hers = await member.listInteractions({
			scopeKind: "personal",
			limit: 20,
		});
		await expect(
			member.recordInteraction({
				clientEventId: "shared",
				eventKind: "accepted",
				scope: { kind: "organization" },
				surface: "decision_deck",
			}),
		).rejects.toThrow(/Shared learning/);
		expect(own.events.map((event) => event.scopeId)).toEqual(["river"]);
		expect(hers.events.map((event) => event.scopeId)).toEqual(["luz"]);
		expect((await owner.model({})).eventCount).toBe(1);
		expect((await member.model({})).eventCount).toBe(1);
		await expect(
			member.correct({
				eventId: own.events[0]!.id,
				clientEventId: "cross-person",
			}),
		).rejects.toThrow(/not found/);
		await member.correct({
			eventId: hers.events[0]!.id,
			clientEventId: "own-correction",
		});
		expect((await member.model({})).eventCount).toBe(0);
		f.sqlite.close();
	});
	it("keeps personal evidence private and prevents a client from forging an automatic promotion", async () => {
		const f = fixture();
		await f.client().configure(
			DecisionLearningConfigSchema.parse({
				enabled: true,
				autoApproveClasses: ["question"],
			}),
		);
		for (let i = 0; i < 5; i++)
			await f.client().recordInteraction({
				clientEventId: `signal-${i}`,
				eventKind: "accepted",
				scope: { kind: "personal" },
				surface: "decision_capture",
				metadata: {
					serverObserved: true,
					decisionClass: "question",
					decisionChoice: "approve",
					feedbackSignal: "approve-as-is",
				},
			});
		expect((await f.client().model({})).eventCount).toBe(5);
		expect((await f.client().model({})).readiness[0]?.ready).toBe(false);
		expect((await f.client("someone-else").model({})).eventCount).toBe(0);
	});
	it("records Undo, excludes the signal from future mining, and retires only the owner's automatic lessons", async () => {
		const f = fixture();
		await f
			.client()
			.configure(DecisionLearningConfigSchema.parse({ enabled: true }));
		const { event } = await recordLearningInteraction(f.db, {
			organizationId: ORG,
			actorType: "user",
			actorId: "river",
			clientEventId: "edited",
			eventKind: "edited",
			scopeKind: "personal",
			scopeId: "river",
			surface: "decision_capture",
			metadata: {
				decisionClass: "investor-email",
				originalBody: "A long introduction about our investment opportunity.",
				editedBody: "Our seed round is open.",
			},
			occurredAt: new Date().toISOString(),
		});
		for (const [id, owner, automatic] of [
			["automatic", "river", true],
			["written", "river", false],
			["other-owner", "other", true],
		] as const)
			await f.db.insert(memoryFacts).values({
				id,
				organizationId: ORG,
				topicKey: `learning-feed:${id}`,
				content: "Prefer concise intros.",
				factType: "preference",
				confidence: 0.9,
				status: "active",
				reviewStatus: "confirmed",
				usePolicy: "requires_user_confirmation",
				visibility: "private",
				metadata: {
					learningFeed: {
						ownerUserId: owner,
						autoConfirmed: automatic,
						evidenceEventIds: [event.id],
					},
				},
			});
		await expect(
			f.client("other").correct({ eventId: event.id, clientEventId: "wrong" }),
		).rejects.toThrow(/not found/);
		await expect(
			f
				.client("river", "20000000-0000-4000-8000-000000000002")
				.correct({ eventId: event.id, clientEventId: "wrong-org" }),
		).rejects.toThrow(/not found/);
		await f.client().correct({ eventId: event.id, clientEventId: "undo" });
		expect((await f.client().model({})).eventCount).toBe(0);
		expect(
			await listOwnerLearningInteractionsPage(f.db, {
				organizationId: ORG,
				ownerUserId: "river",
				surfaces: ["decision_capture"],
				before: null,
				limit: 30,
			}),
		).toEqual([]);
		expect(
			f.sqlite
				.prepare("SELECT id FROM memory_facts WHERE archived_at IS NOT NULL")
				.all(),
		).toEqual([{ id: "automatic" }]);
	});
});
