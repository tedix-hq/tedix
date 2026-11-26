import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { workAttempts, workItems } from "@tedix/db/schema/work-items";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import { readAgentScorecardHistory } from "@tedix/db/queries/work-items/agent-scorecard";
import { AgentHistorySchema } from "@tedix/api-contract/schemas/work-items";
import { summarizeAgentHistory, agentHistoryEvidence } from "./agent-history";

it("keeps 7/30-day outcome, model and scope evidence distinct and attributes exact later CI/reverts", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(workItems, workAttempts, workAgentSessions, workInteractions),
	);
	const db = createDbClient(createD1Facade(sqlite));
	const now = Date.parse("2026-11-26T12:00:00.000Z");
	const at = (days: number, minutes = 0) =>
		new Date(now - days * 86_400_000 + minutes * 60_000).toISOString();
	const workId = "11111111-1111-4111-8111-111111111111";
	const sha = "a".repeat(40);
	try {
		await db.insert(workItems).values([
			{
				id: workId,
				orgId: "org",
				title: "Task",
				createdAt: at(1),
				projectId: "project",
				accountableOwnerType: "user",
				accountableOwnerId: "reader",
			},
			{
				id: "foreign",
				orgId: "other",
				title: "Other tenant",
				createdAt: at(1),
				projectId: "project",
			},
			{
				id: "private",
				orgId: "org",
				title: "Other owner",
				createdAt: at(1),
				projectId: "other-project",
				accountableOwnerType: "user",
				accountableOwnerId: "other",
			},
		]);
		const outcomes = [
			"succeeded",
			"landed_unverified",
			"failed",
			"cancelled",
			"expired",
			"rejected",
			null,
		] as const;
		await db.insert(workAttempts).values(
			outcomes.map((outcome, i) => ({
				id: `attempt-${i}`,
				orgId: "org",
				workItemId: workId,
				executorType: "external_agent" as const,
				executorId: "agent",
				externalSessionKey: `codex:session-${i}`,
				attemptNumber: i + 1,
				heartbeatAt: at(1),
				startedAt: at(1),
				finishedAt: outcome ? at(1, i + 1) : null,
				outcome,
				runtimeState: "finished" as const,
				metadata: {
					...(i === 2
						? {}
						: {
								runnerMetrics: {
									modelId: "model-a",
									tokensIn: 100,
									tokensOut: 20,
									estimatedCostUsd: 1,
								},
							}),
					...(i < 2
						? { settlement: { mode: "commit", commitShas: [sha] } }
						: {}),
				},
			})),
		);
		await db.insert(workAttempts).values([
			{
				id: "older",
				orgId: "org",
				workItemId: workId,
				executorType: "external_agent",
				executorId: "agent",
				externalSessionKey: "claude:older",
				attemptNumber: 8,
				heartbeatAt: at(10),
				startedAt: at(10),
				finishedAt: at(10, 20),
				outcome: "succeeded",
				runtimeState: "finished",
				metadata: {},
			},
			{
				id: "outside",
				orgId: "org",
				workItemId: workId,
				executorType: "external_agent",
				executorId: "agent",
				externalSessionKey: "codex:outside",
				attemptNumber: 9,
				heartbeatAt: at(31),
				startedAt: at(31),
				runtimeState: "failed",
				outcome: "failed",
			},
			{
				id: "foreign-attempt",
				orgId: "other",
				workItemId: "foreign",
				executorType: "external_agent",
				executorId: "agent",
				attemptNumber: 1,
				heartbeatAt: at(1),
				startedAt: at(1),
				runtimeState: "finished",
				outcome: "succeeded",
			},
			{
				id: "private-attempt",
				orgId: "org",
				workItemId: "private",
				executorType: "external_agent",
				executorId: "agent",
				attemptNumber: 1,
				heartbeatAt: at(1),
				startedAt: at(1),
				runtimeState: "finished",
				outcome: "succeeded",
			},
		]);
		// The host report now belongs to a later Attempt: never charge it to "older".
		const telemetry = {
			executor: "claude-code" as const,
			model: "model-a",
			provider: "example",
			reasoningEffort: null,
			brief: "Test",
			startedAt: at(1),
			finishedAt: at(1, 1),
			heartbeatAt: at(1, 1),
			outcome: "succeeded" as const,
			finalMessage: "Test",
			tools: {},
			usage: { input: 100, cached: 0, output: 20, reasoning: 0 },
			shas: [],
			workItems: [workId],
			corrections: [],
			source: "wrapper" as const,
			estimatedCostUsd: 1,
			rateVersionId: null,
			lesson: null,
			lessonStatus: "pending" as const,
		};
		await db.insert(workAgentSessions).values({
			id: "matching",
			organizationId: "org",
			userId: "reader",
			harness: "codex",
			sessionKey: "session-2",
			workItemId: workId,
			state: "done",
			stateSince: at(1),
			lastEventAt: at(1),
			telemetry: { ...telemetry, executor: "codex" },
		});
		await db.insert(workAgentSessions).values({
			id: "overwritten",
			organizationId: "org",
			userId: "reader",
			harness: "claude-code",
			sessionKey: "older",
			telemetry,
			workItemId: workId,
			state: "done",
			stateSince: at(1),
			lastEventAt: at(1),
		});
		const event = {
			projectId: "22222222-2222-4222-8222-222222222222",
			repository: "example/product",
			branch: "main",
			sha,
			workItemId: workId,
			summary: "Receipt",
			evidenceUrl: "https://example.com/receipt",
		};
		await db.insert(workItems).values([
			{
				id: "push",
				orgId: "org",
				title: "Push",
				createdAt: at(1, 10),
				metadata: {
					repositoryObserver: 1,
					event: {
						...event,
						kind: "push",
						commits: [{ sha, workItemId: workId }],
					},
				},
			},
			{
				id: "red",
				orgId: "org",
				title: "Red CI",
				createdAt: at(1, 20),
				metadata: {
					repositoryObserver: 1,
					event: { ...event, kind: "ci_red" },
				},
			},
			{
				id: "revert",
				orgId: "org",
				title: "Revert",
				createdAt: at(1, 30),
				metadata: {
					repositoryObserver: 1,
					event: {
						...event,
						sha: "b".repeat(40),
						kind: "push",
						commits: [{ sha: "b".repeat(40), revertsSha: sha }],
					},
				},
			},
		]);
		const input = {
			orgId: "org",
			projectIds: ["project"],
			since: at(30),
			now: at(0),
		};
		const facts = await readAgentScorecardHistory(db, input);
		expect(facts.rows).toHaveLength(8);
		expect(facts.rows.find((row) => row.id === "older")?.sessionId).toBeNull();
		// Duplicate reports/pages cannot multiply usage or outcomes.
		const history = AgentHistorySchema.parse(
			summarizeAgentHistory(
				{ ...facts, rows: [...facts.rows, ...facts.rows] },
				now,
			),
		);
		const week = history.windows[0]!;
		expect(week.rows).toHaveLength(1);
		expect(week.rows[0]).toMatchObject({
			executor: "codex",
			model: "model-a",
			attempts: 7,
			items: 1,
			succeeded: 1,
			landedUnverified: 1,
			failed: 1,
			cancelled: 1,
			expired: 1,
			rejected: 1,
			unsettled: 1,
			successRate: 1 / 6,
			medianSettleMs: 210_000,
			p90SettleMs: 360_000,
			attemptsPerItem: 7,
			landedItems: 1,
			costPerLandedItemUsd: 7,
			tokensPerLandedItem: 840,
			landedCommits: 1,
			qualityObservedCommits: 1,
			reverts: 1,
			redCi: 1,
		});
		expect(
			history.windows[1]!.rows.find((row) => row.executor === "claude-code"),
		).toMatchObject({
			model: null,
			costPerLandedItemUsd: null,
			reverts: null,
			redCi: null,
		});
		expect(agentHistoryEvidence(history, "codex")).toContain(
			"7d codex/model-a: 7 attempts/1 items",
		);
		expect(agentHistoryEvidence(history, "devin")).toContain(
			"no recorded Attempts",
		);
		expect(
			(await readAgentScorecardHistory(db, { ...input, projectIds: [] })).rows,
		).toEqual([]);
		expect(
			(
				await readAgentScorecardHistory(db, {
					...input,
					projectIds: undefined,
					viewerUserId: "reader",
				})
			).rows,
		).toHaveLength(8);
		const missing = summarizeAgentHistory({ ...facts, observations: [] }, now)
			.windows[0]!.rows[0]!;
		expect(missing.reverts).toBeNull();
		expect(missing.redCi).toBeNull();
		const wrongWork = facts.observations.map((observation) => ({
			...observation,
			workItemId: "33333333-3333-4333-8333-333333333333",
		}));
		expect(
			summarizeAgentHistory({ ...facts, observations: wrongWork }, now)
				.windows[0]!.rows[0]!.redCi,
		).toBeNull();
	} finally {
		sqlite.close();
	}
});
