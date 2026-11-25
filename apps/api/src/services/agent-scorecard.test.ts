import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import { skillRuns } from "@tedix/db/schema/cognitive";
import { machineToolCalls } from "@tedix/db/schema/machines";
import { tedis, tediCallCosts } from "@tedix/db/schema/tedis";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { billingUsageCharges } from "@tedix/db/schema/billing";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import { workAttempts, workItems } from "@tedix/db/schema/work-items";
import { readAgentScorecardActivity } from "@tedix/db/queries/work-items/agent-scorecard";
import { summarizeTediScorecard } from "./agent-scorecard";

it("compares each tedi across execution sources without double charging or crossing tenant/project boundaries", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			tedis,
			kernelRuntimeRuns,
			skillRuns,
			machineToolCalls,
			tediCallCosts,
			billingUsageCharges,
			workAgentSessions,
			workAttempts,
			workItems,
			workInteractions,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	const now = "2026-11-25T12:00:00.000Z";
	const started = "2026-11-25T11:00:00.000Z";
	const finished = "2026-11-25T11:01:00.000Z";
	try {
		await db.insert(tedis).values([
			{
				id: "juniper",
				organizationId: "org",
				name: "juniper",
				displayName: "Juniper",
				slug: "juniper",
				scope: "organization",
			},
			{
				id: "cedar",
				organizationId: "org",
				name: "Cedar",
				slug: "cedar",
				scope: "organization",
			},
			{
				id: "foreign",
				organizationId: "other",
				name: "Foreign",
				slug: "foreign",
				scope: "organization",
			},
		]);
		await db.insert(workItems).values({
			id: "work",
			orgId: "org",
			title: "Shared work",
			projectId: "project",
			createdAt: started,
		});
		await db.insert(kernelRuntimeRuns).values([
			{
				id: "home",
				organizationId: "org",
				conversationId: "conversation",
				delegatedTediId: "juniper",
				childRunId: "child",
				status: "completed",
				startedAt: started,
				completedAt: finished,
				createdAt: started,
				updatedAt: finished,
				metadata: { workItemId: "work" },
			},
			{
				id: "foreign-home",
				organizationId: "other",
				conversationId: "conversation",
				delegatedTediId: "juniper",
				status: "failed",
				createdAt: started,
				updatedAt: started,
			},
		]);
		await db.insert(skillRuns).values({
			id: "code",
			organizationId: "org",
			skillId: "skill",
			tediId: "juniper",
			workflowInstanceId: "wf",
			runtimeEnvironment: "production",
			status: "failed",
			startedAt: started,
			completedAt: finished,
			workItemId: "work",
		});
		await db.insert(machineToolCalls).values({
			id: "machine",
			orgId: "org",
			machineName: "fixture",
			tool: "read_file",
			input: "{}",
			requestedByType: "tedi",
			requestedById: "juniper",
			status: "done",
			createdAt: started,
			finishedAt: finished,
			expiresAt: now,
		});
		await db.insert(tediCallCosts).values({
			id: "call",
			tediId: "juniper",
			orgId: "org",
			gatewayLogId: "gateway",
			gatewayId: "fixture",
			model: "fixture",
			snapshotAt: started,
			inputTokens: 80,
			outputTokens: 20,
			totalTokens: 100,
			estimatedCostUsd: 0.1,
			workItemId: "work",
			costBasis: "gateway_reported",
		});
		await db.insert(billingUsageCharges).values({
			id: "charge",
			organizationId: "org",
			tediId: "juniper",
			usagePeriodId: "period",
			gatewayLogId: "gateway",
			provider: "fixture",
			model: "fixture",
			source: "runtime",
			inputTokens: 80,
			outputTokens: 20,
			providerCostMicros: 100000,
			occurredAt: started,
			metadata: { workItemId: "work" },
		});
		const params = {
			orgId: "org",
			viewerUserId: "viewer",
			since: "2026-11-24T12:00:00.000Z",
			now,
		};
		const summary = summarizeTediScorecard(
			await readAgentScorecardActivity(db, params),
			Date.parse(now),
		);
		expect(summary.sort((a, b) => b.started - a.started)).toEqual([
			{
				id: "juniper",
				runner: "Juniper",
				started: 3,
				done: 2,
				failed: 1,
				durationMs: 180000,
				costUsd: 0.1,
				tokens: 100,
			},
			{
				id: "cedar",
				runner: "Cedar",
				started: 0,
				done: 0,
				failed: 0,
				durationMs: 0,
				costUsd: null,
				tokens: null,
			},
		]);
		const scoped = summarizeTediScorecard(
			await readAgentScorecardActivity(db, { ...params, projectId: "project" }),
			Date.parse(now),
		);
		expect(scoped.find((row) => row.id === "juniper")).toMatchObject({
			started: 2,
			done: 1,
			failed: 1,
			costUsd: 0.1,
			tokens: 100,
		});
		expect(
			(
				await readAgentScorecardActivity(db, {
					...params,
					projectId: "unrelated",
				})
			).homeRuns,
		).toEqual([]);
	} finally {
		sqlite.close();
	}
});
