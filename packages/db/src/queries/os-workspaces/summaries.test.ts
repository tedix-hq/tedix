import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	kernelConversations,
	kernelRuntimeRuns,
} from "../../schema/cognitive-runtime";
import {
	osWorkspaceProjects,
	osWorkspaces,
	osWorkspaceSummaries,
} from "../../schema/os-workspaces";
import { projects } from "../../schema/projects";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	applyOsWorkspaceSummary,
	computeOsWorkspaceSummary,
	deleteOsWorkspaceSummary,
	getOsWorkspaceSummary,
	listOsWorkspaceSummaries,
	parseOsWorkspaceSummaryPayload,
} from "./summaries";

const ORG = "org-1";
const WS = "workspace-1";

async function seed() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE tedis (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE tedi_objectives (id TEXT PRIMARY KEY NOT NULL); INSERT INTO organizations VALUES ('org-1'), ('org-2');",
	);
	sqlite.exec(
		schemaDdl(
			projects,
			osWorkspaces,
			osWorkspaceProjects,
			osWorkspaceSummaries,
			kernelConversations,
			kernelRuntimeRuns,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(projects).values({
		id: "project-1",
		orgId: ORG,
		key: "FIN",
		name: "Finance",
		createdAt: "2026-09-21T00:00:00.000Z",
	});
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
		messageCount: 3,
	});
	await db.insert(kernelConversations).values({
		id: "conv-row-2",
		organizationId: ORG,
		conversationId: "conv-2",
		workspaceId: WS,
		lastMessageAt: "2026-11-01T01:00:00.000Z",
		messageCount: 2,
	});
	await db.insert(kernelRuntimeRuns).values({
		id: "run-1",
		organizationId: ORG,
		conversationId: "conv-1",
		status: "completed",
		startedAt: "2026-11-01T00:00:00.000Z",
		completedAt: "2026-11-01T00:01:00.000Z",
		updatedAt: "2026-11-01T00:01:00.000Z",
	});
	await db.insert(kernelRuntimeRuns).values({
		id: "run-2",
		organizationId: ORG,
		conversationId: "conv-2",
		status: "running",
		startedAt: "2026-11-01T01:00:00.000Z",
		updatedAt: "2026-11-01T01:02:00.000Z",
	});
	// A run outside the workspace's conversations must not leak in.
	await db.insert(kernelConversations).values({
		id: "conv-row-3",
		organizationId: ORG,
		conversationId: "conv-3",
		workspaceId: null,
		lastMessageAt: "2026-11-01T02:00:00.000Z",
		messageCount: 9,
	});
	await db.insert(kernelRuntimeRuns).values({
		id: "run-3",
		organizationId: ORG,
		conversationId: "conv-3",
		status: "running",
		startedAt: "2026-11-01T02:00:00.000Z",
		updatedAt: "2026-11-01T02:05:00.000Z",
	});
	return { db };
}

function message(
	revision: number,
	overrides: Partial<{
		usage: string;
		runStatus: string;
		workLinks: string;
		publishedAt: string;
	}> = {},
) {
	return {
		organizationId: ORG,
		workspaceId: WS,
		revision,
		usage: overrides.usage ?? '{"conversationCount":1}',
		runStatus: overrides.runStatus ?? "{}",
		workLinks: overrides.workLinks ?? "[]",
		publishedAt: overrides.publishedAt ?? "2026-11-05T00:00:00.000Z",
		appliedAt: "2026-11-05T00:00:01.000Z",
	};
}

describe("OS workspace summaries", () => {
	it("computes work links, run status and usage from source tables", async () => {
		const { db } = await seed();
		await db.insert(osWorkspaceProjects).values({
			id: "link-1",
			organizationId: ORG,
			workspaceId: WS,
			projectId: "project-1",
			status: "active",
			createdByKind: "user",
			createdById: "user-1",
			createdAt: "2026-09-21T00:00:00.000Z",
			updatedAt: "2026-09-21T00:00:00.000Z",
		});
		const payload = await computeOsWorkspaceSummary(db, {
			organizationId: ORG,
			workspaceId: WS,
		});
		expect(payload.workLinks.map((l) => l.projectId)).toEqual(["project-1"]);
		expect(payload.usage).toEqual({
			conversationCount: 2,
			messageCount: 5,
			runCount: 2,
		});
		expect(payload.runStatus.activeRunCount).toBe(1);
		expect(payload.runStatus.latestRun).toMatchObject({
			id: "run-2",
			status: "running",
		});
	});

	it("applies idempotently in revision order — newest wins", async () => {
		const { db } = await seed();
		const first = await applyOsWorkspaceSummary(db, message(10));
		expect(first?.revision).toBe(10);
		// A stale replay is a no-op.
		expect(await applyOsWorkspaceSummary(db, message(9))).toBeUndefined();
		// A redelivery of the same revision is a no-op.
		expect(await applyOsWorkspaceSummary(db, message(10))).toBeUndefined();
		const stored = await getOsWorkspaceSummary(db, {
			organizationId: ORG,
			workspaceId: WS,
		});
		expect(stored?.revision).toBe(10);
		// A newer snapshot replaces the stored row.
		const newer = await applyOsWorkspaceSummary(
			db,
			message(11, { usage: '{"conversationCount":2}' }),
		);
		expect(newer?.revision).toBe(11);
		expect(parseOsWorkspaceSummaryPayload(newer!).usage.conversationCount).toBe(
			2,
		);
	});

	it("lists an org's summary rows and deletes by scope", async () => {
		const { db } = await seed();
		await applyOsWorkspaceSummary(db, message(1));
		expect(await listOsWorkspaceSummaries(db, ORG)).toHaveLength(1);
		expect(await listOsWorkspaceSummaries(db, "org-2")).toHaveLength(0);
		await deleteOsWorkspaceSummary(db, {
			organizationId: ORG,
			workspaceId: WS,
		});
		expect(await listOsWorkspaceSummaries(db, ORG)).toHaveLength(0);
	});
});
