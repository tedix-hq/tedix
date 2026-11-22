import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { organizations } from "@tedix/db/schema/organizations";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { LOCAL_DEMO_PROJECT_ID } from "@tedix/auth/local-demo";
import { createRouterClient } from "@orpc/server";
import { userContext, apiKeyContext } from "../test-context";
import { describe, expect, it } from "vite-plus/test";
import {
	canAccessLearningEvent,
	isHumanLearningReviewer,
	learningScopeCanNominateSubject,
	resolveLearningActor,
	resolveLearningScope,
	learningFeedbackContractRouter,
} from "./learning-feedback";

describe("learning feedback identity and scope", () => {
	it("acknowledges local exposure without storing it and still requires a person", async () => {
		const env = {
			ENVIRONMENT: "development",
			DESCOPE_PROJECT_ID: LOCAL_DEMO_PROJECT_ID,
		} as CloudflareEnv;
		const input = {
			clientEventId: crypto.randomUUID(),
			sessionId: crypto.randomUUID(),
			cardId: "sample-card",
			sourceVersion: 1,
			position: 0,
			aboveFold: ["title" as const],
			railOpened: false,
			timezone: "UTC",
			ranking: {
				version: "decision-learning-v1" as const,
				score: 0,
				features: [],
			},
			candidates: [
				{
					cardId: "sample-card",
					score: 0,
					reason: "shown" as const,
					position: 0,
				},
			],
			candidateCount: 1,
			candidateSetComplete: true,
		};
		const person = createRouterClient(learningFeedbackContractRouter, {
			context: userContext({ env }),
		});
		const machine = createRouterClient(learningFeedbackContractRouter, {
			context: apiKeyContext({ env, scopes: ["tedis:write"] }),
		});
		await expect(person.recordExposure(input)).resolves.toEqual({ id: null });
		await expect(machine.recordExposure(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("derives personal and organization scopes instead of trusting caller ids", () => {
		expect(
			resolveLearningScope({
				kind: "personal",
				organizationId: "org-1",
				actorId: "user-1",
			}),
		).toBe("user-1");
		expect(
			resolveLearningScope({
				kind: "organization",
				organizationId: "org-1",
				actorId: "user-1",
			}),
		).toBe("org-1");
	});

	it("binds tedi scope to the selected tedi and rejects a mismatch", () => {
		expect(
			resolveLearningScope({
				kind: "tedi",
				organizationId: "org-1",
				actorId: "user-1",
				tediId: "tedi-1",
			}),
		).toBe("tedi-1");
		expect(() =>
			resolveLearningScope({
				kind: "tedi",
				requestedId: "tedi-2",
				organizationId: "org-1",
				actorId: "user-1",
				tediId: "tedi-1",
			}),
		).toThrow(/must match/);
	});

	it("uses the authenticated principal as event actor", () => {
		expect(
			resolveLearningActor({
				authType: "user",
				user: { sub: "user-1" },
			}),
		).toEqual({ actorType: "user", actorId: "user-1" });
		expect(
			resolveLearningActor({ authType: "tedi", tediId: "tedi-1" }),
		).toEqual({
			actorType: "tedi",
			actorId: "tedi-1",
		});
		expect(
			resolveLearningActor({
				authType: "service-binding",
				descopeUserId: "acting-user-1",
				serviceAccount: { clientId: "mcp-service" },
			}),
		).toEqual({ actorType: "user", actorId: "acting-user-1" });
	});

	it("keeps final improvement approval behind a direct human session", () => {
		expect(
			isHumanLearningReviewer({
				authType: "user",
				user: { sub: "user-1" } as never,
			}),
		).toBe(true);
		expect(
			isHumanLearningReviewer({
				authType: "service-binding",
				user: undefined,
			}),
		).toBe(false);
		expect(isHumanLearningReviewer({ authType: "tedi", user: undefined })).toBe(
			false,
		);
	});

	it("keeps personal learning events private to their authenticated actor", () => {
		expect(
			canAccessLearningEvent("user-1", {
				scopeKind: "personal",
				scopeId: "user-1",
			}),
		).toBe(true);
		expect(
			canAccessLearningEvent("user-2", {
				scopeKind: "personal",
				scopeId: "user-1",
			}),
		).toBe(false);
		expect(
			canAccessLearningEvent(null, {
				scopeKind: "organization",
				scopeId: "org-1",
			}),
		).toBe(true);
	});

	it("prevents scoped evidence from nominating a wider unrelated subject", () => {
		expect(
			learningScopeCanNominateSubject({
				scopeKind: "personal",
				scopeId: "user-1",
				tediId: "tedi-1",
				subjectKind: "memory_fact",
				subjectId: "fact-1",
				actorType: "user",
				actorId: "user-1",
			}),
		).toBe(true);
		expect(
			learningScopeCanNominateSubject({
				scopeKind: "personal",
				scopeId: "user-1",
				tediId: "tedi-1",
				subjectKind: "workflow",
				subjectId: "workflow-1",
				actorType: "user",
				actorId: "user-1",
			}),
		).toBe(false);
		expect(
			learningScopeCanNominateSubject({
				scopeKind: "workflow",
				scopeId: "workflow-1",
				tediId: "tedi-1",
				subjectKind: "workflow",
				subjectId: "workflow-2",
				actorType: "tedi",
				actorId: "tedi-1",
			}),
		).toBe(false);
	});
});

it("records the first routing once per organization/person/card and rejects machines", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(organizations, tedis, learningInteractionEvents));
		sqlite.exec("PRAGMA foreign_keys = OFF");
		const db = createDbClient(createD1Facade(sqlite));
		const person = (sub: string, organizationId = "org-1") =>
			createRouterClient(learningFeedbackContractRouter, {
				context: userContext({ db, sub, organizationId }),
			});
		const route = {
			id: "candidate-one",
			destination: "deck",
			reason: "valuable_opportunity",
			policyVersion: 1,
			classId: "opportunity",
		};
		await expect(
			person("user-1").recordDeckRoutings({ routes: [route, route] }),
		).resolves.toEqual({ recorded: 1 });
		await expect(
			person("user-1").recordDeckRoutings({
				routes: [{ ...route, reason: "critical", policyVersion: 2 }],
			}),
		).resolves.toEqual({ recorded: 0 });
		await expect(
			person("user-2").recordDeckRoutings({ routes: [route] }),
		).resolves.toEqual({ recorded: 1 });
		await expect(
			person("user-1", "org-2").recordDeckRoutings({ routes: [route] }),
		).resolves.toEqual({ recorded: 1 });
		const rows = await db.select().from(learningInteractionEvents);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({
			organizationId: "org-1",
			actorId: "user-1",
			scopeId: "user-1",
			scopeKind: "personal",
			surface: "decision_deck_routing",
			eventKind: "delivered",
			metadata: { routingReason: "valuable_opportunity", policyVersion: 1 },
		});
		const machine = createRouterClient(learningFeedbackContractRouter, {
			context: apiKeyContext({ db, scopes: ["tedis:write"] }),
		});
		await expect(
			machine.recordDeckRoutings({ routes: [route] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	} finally {
		sqlite.close();
	}
});
