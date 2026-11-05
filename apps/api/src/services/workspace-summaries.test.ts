import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	getOsWorkspaceSummary,
	parseOsWorkspaceSummaryPayload,
} from "@tedix/db/queries/os-workspaces/summaries";
import {
	kernelConversations,
	kernelRuntimeRuns,
} from "@tedix/db/schema/cognitive-runtime";
import {
	osWorkspaceProjects,
	osWorkspaces,
	osWorkspaceSummaries,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import { handleAutomationEventMessage } from "../jobs/automation-events";
import {
	handleWorkspaceSummaryMessage,
	publishOsWorkspaceSummary,
} from "./workspace-summaries";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		"CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE tedis (id TEXT PRIMARY KEY NOT NULL);",
	);
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osWorkspaceProjects,
			osWorkspaceSummaries,
			kernelConversations,
			kernelRuntimeRuns,
		),
	);
	const d1 = createD1Facade(sqlite);
	const db = createDbQueryClient(d1);
	return { db, d1 };
}

async function seedWorkspace(db: ReturnType<typeof createDbQueryClient>) {
	await db.insert(osWorkspaces).values({
		id: WS,
		organizationId: ORG,
		name: "Books",
		createdByKind: "user",
		createdById: "user-1",
	});
	await db.insert(kernelConversations).values({
		id: "conv-row-1",
		organizationId: ORG,
		conversationId: "conv-1",
		workspaceId: WS,
		lastMessageAt: "2026-11-01T00:00:00.000Z",
		messageCount: 4,
	});
	await db.insert(kernelRuntimeRuns).values({
		id: "run-1",
		organizationId: ORG,
		conversationId: "conv-1",
		status: "running",
		startedAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:01:00.000Z",
	});
}

describe("workspace summaries", () => {
	it("publishes a snapshot the consumer applies with < 5s lag", async () => {
		const { db, d1 } = await fixture();
		await seedWorkspace(db);
		const sent: unknown[] = [];
		const env = {
			DB: d1,
			AUTOMATION_EVENTS: { send: vi.fn(async (m: unknown) => sent.push(m)) },
		} as unknown as CloudflareEnv;

		const started = Date.now();
		expect(
			await publishOsWorkspaceSummary(env, {
				organizationId: ORG,
				workspaceId: WS,
			}),
		).toEqual({ queued: true });
		expect(sent).toHaveLength(1);
		expect(await handleAutomationEventMessage(env, sent[0], {})).toBe("ack");
		const lagMs = Date.now() - started;
		expect(lagMs).toBeLessThan(5_000);

		const row = await getOsWorkspaceSummary(db, {
			organizationId: ORG,
			workspaceId: WS,
		});
		expect(row).toBeDefined();
		const payload = parseOsWorkspaceSummaryPayload(row!);
		expect(payload.usage).toEqual({
			conversationCount: 1,
			messageCount: 4,
			runCount: 1,
		});
		expect(payload.runStatus).toEqual({
			activeRunCount: 1,
			latestRun: {
				id: "run-1",
				status: "running",
				updatedAt: "2026-11-01T00:01:00.000Z",
			},
		});
		expect(payload.workLinks).toEqual([]);
		expect(
			Date.parse(row!.appliedAt) - Date.parse(row!.publishedAt),
		).toBeLessThan(5_000);
	});

	it("acks poison shapes, retries apply failures and drops stale revisions", async () => {
		const { db, d1 } = await fixture();
		const env = { DB: d1 } as unknown as CloudflareEnv;
		expect(
			await handleWorkspaceSummaryMessage(env, { kind: "workspace_summary" }),
		).toBe("ack");
		expect(
			await handleWorkspaceSummaryMessage(
				{
					DB: {
						prepare: () => {
							throw new Error("down");
						},
					},
				} as never,
				{
					kind: "workspace_summary",
					organizationId: ORG,
					workspaceId: WS,
					revision: 5,
					usage: "{}",
					runStatus: "{}",
					workLinks: "[]",
					publishedAt: "2026-11-05T00:00:00.000Z",
				},
			),
		).toBe("retry");

		const message = (revision: number) => ({
			kind: "workspace_summary",
			organizationId: ORG,
			workspaceId: WS,
			revision,
			usage: `{"conversationCount":${revision}}`,
			runStatus: "{}",
			workLinks: "[]",
			publishedAt: "2026-11-05T00:00:00.000Z",
		});
		expect(await handleWorkspaceSummaryMessage(env, message(10))).toBe("ack");
		expect(await handleWorkspaceSummaryMessage(env, message(9))).toBe("ack");
		const row = await getOsWorkspaceSummary(db, {
			organizationId: ORG,
			workspaceId: WS,
		});
		expect(row?.revision).toBe(10);
	});
});
