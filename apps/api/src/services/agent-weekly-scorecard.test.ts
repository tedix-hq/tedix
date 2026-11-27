import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { workAttempts, workItems } from "@tedix/db/schema/work-items";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import { readAgentScorecardHistory } from "@tedix/db/queries/work-items/agent-scorecard";
import { AgentWeeklyScorecardSchema } from "@tedix/api-contract/schemas/work-items";
import { summarizeAgentWeeklyScorecard } from "./agent-weekly-scorecard";

it("groups the week per agent and task kind with landing, verification, cost and fix rates", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(workItems, workAttempts, workInteractions, workAgentSessions),
	);
	const db = createDbClient(createD1Facade(sqlite));
	const now = Date.parse("2026-11-26T12:00:00.000Z");
	const at = (days: number, minutes = 0) =>
		new Date(now - days * 86_400_000 + minutes * 60_000).toISOString();
	const sha = "a".repeat(40);
	const revertSha = "b".repeat(40);
	const landed = "11111111-1111-4111-8111-111111111111";
	const unverified = "22222222-2222-4222-8222-222222222222";
	const failed = "33333333-3333-4333-8333-333333333333";
	try {
		await db.insert(workItems).values([
			{
				id: landed,
				orgId: "org",
				title: "Landed",
				createdAt: at(2),
				projectId: "project",
				riskLevel: "low",
				metadata: { size: "small", tags: ["docs"] },
			},
			{
				id: unverified,
				orgId: "org",
				title: "Unverified",
				createdAt: at(2),
				projectId: "project",
				riskLevel: "low",
				metadata: { size: "small", tags: ["docs"] },
			},
			{
				id: failed,
				orgId: "org",
				title: "Failed",
				createdAt: at(2),
				projectId: "project",
				riskLevel: "high",
				metadata: { size: "large", tags: ["api"] },
			},
		]);
		await db.insert(workAttempts).values([
			{
				id: "attempt-landed",
				orgId: "org",
				workItemId: landed,
				executorType: "external_agent",
				executorId: "agent",
				externalSessionKey: "codex:s1",
				attemptNumber: 1,
				heartbeatAt: at(2),
				startedAt: at(2),
				finishedAt: at(2, 30),
				outcome: "succeeded",
				runtimeState: "finished",
				metadata: {
					runnerMetrics: {
						modelId: "model-a",
						tokensIn: 100,
						tokensOut: 20,
						estimatedCostUsd: 1,
					},
					settlement: { mode: "commit", commitShas: [sha] },
				},
			},
			{
				id: "attempt-unverified",
				orgId: "org",
				workItemId: unverified,
				executorType: "external_agent",
				executorId: "agent",
				externalSessionKey: "codex:s2",
				attemptNumber: 1,
				heartbeatAt: at(2),
				startedAt: at(2, 40),
				finishedAt: at(2, 70),
				outcome: "landed_unverified",
				runtimeState: "finished",
				metadata: {
					runnerMetrics: {
						modelId: "model-a",
						tokensIn: 300,
						tokensOut: 60,
						estimatedCostUsd: 3,
					},
					settlement: { mode: "commit", commitShas: [revertSha] },
				},
			},
			{
				id: "attempt-failed",
				orgId: "org",
				workItemId: failed,
				executorType: "external_agent",
				executorId: "agent",
				externalSessionKey: "codex:s3",
				attemptNumber: 2,
				heartbeatAt: at(1),
				startedAt: at(1),
				finishedAt: at(1, 10),
				outcome: "failed",
				runtimeState: "finished",
				metadata: {},
			},
		]);
		await db.insert(workInteractions).values([
			{
				id: "ask-1",
				orgId: "org",
				workItemId: landed,
				kind: "question",
				subject: "Pick one",
				prompt: "Which option?",
				creatorType: "tedi",
				creatorId: "tedi",
				createdAt: at(1),
			},
			{
				id: "ask-2",
				orgId: "org",
				workItemId: landed,
				kind: "question",
				subject: "Confirm",
				prompt: "Continue?",
				creatorType: "tedi",
				creatorId: "tedi",
				createdAt: at(1, 5),
			},
		]);
		const event = {
			projectId: "22222222-2222-4222-8222-222222222222",
			repository: "example/product",
			branch: "main",
			workItemId: landed,
			summary: "Receipt",
			evidenceUrl: "https://example.com/receipt",
		};
		await db.insert(workItems).values([
			{
				id: "push",
				orgId: "org",
				title: "Push",
				createdAt: at(2, 35),
				metadata: {
					repositoryObserver: 1,
					event: {
						...event,
						kind: "push",
						sha,
						commits: [{ sha, workItemId: landed }],
					},
				},
			},
			{
				id: "revert",
				orgId: "org",
				title: "Revert",
				createdAt: at(1),
				metadata: {
					repositoryObserver: 1,
					event: {
						...event,
						kind: "push",
						sha: revertSha,
						commits: [{ sha: revertSha, revertsSha: sha }],
					},
				},
			},
		]);
		const facts = await readAgentScorecardHistory(db, {
			orgId: "org",
			projectId: "project",
			since: at(30),
			now: at(0),
		});
		const weekly = AgentWeeklyScorecardSchema.parse(
			summarizeAgentWeeklyScorecard(facts, now),
		);
		expect(weekly.rows).toHaveLength(2);
		const docs = weekly.rows.find((row) => row.risk === "low")!;
		expect(docs).toMatchObject({
			executor: "codex",
			model: "model-a",
			size: "small",
			risk: "low",
			tags: ["docs"],
			items: 2,
			attempts: 2,
			landedItems: 2,
			landedRate: 1,
			verifiedRate: 0.5,
			firstAttemptLandedRate: 1,
			costPerLandedUsd: 2,
			tokensPerLanded: 240,
			humanInterventions: 2,
			fixedOrRevertedWithin7d: 1,
		});
		expect(docs.medianTimeToLandMs).toBe(30 * 60_000);
		const api = weekly.rows.find((row) => row.risk === "high")!;
		expect(api).toMatchObject({
			items: 1,
			attempts: 1,
			landedItems: 0,
			landedRate: 0,
			verifiedRate: null,
			firstAttemptLandedRate: 0,
			medianTimeToLandMs: null,
			costPerLandedUsd: null,
			humanInterventions: 0,
			fixedOrRevertedWithin7d: null,
		});
	} finally {
		sqlite.close();
	}
});
