import { osWorkspaces, osGadgetExecutions } from "../schema/os-workspaces";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { projects } from "../schema/projects";
import { workItems, workAttempts } from "../schema/work-items";
import { skillRuns } from "../schema/cognitive";
import {
	kernelRuntimeRuns,
	kernelConversations,
	kernelConversationGrants,
} from "../schema/cognitive-runtime";
import { tedis } from "../schema/tedis";
import { tediObjectives } from "../schema/tedi-objectives";
import {
	readAttentionFactoryLinks,
	readAttentionSources,
	attentionProjectBriefs,
	attentionProjectExists,
} from "./work-attention";
it("scopes Attention reads and project matches to the organization through the D1 facade", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	for (const table of [
		projects,
		workItems,
		workAttempts,
		skillRuns,
		kernelRuntimeRuns,
		kernelConversations,
		kernelConversationGrants,
		tedis,
		tediObjectives,
	])
		sqlite.exec(schemaDdl(table));
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(projects).values({
		id: "project-example",
		orgId: "org-example",
		key: "DOCS",
		name: "Documentation",
		description: "Clear installation guides",
		status: "active",
		createdAt: "2026-10-17T10:00:00Z",
	});
	expect(await attentionProjectExists(db, "other-org", "project-example")).toBe(
		false,
	);
	expect(await attentionProjectBriefs(db, "other-org")).toEqual([]);
	expect(
		(await attentionProjectBriefs(db, "org-example"))[0]?.description,
	).toBe("Clear installation guides");
	const mine = await readAttentionSources(
		db,
		"org-example",
		"2026-10-16T00:00:00Z",
	);
	expect(mine.projects[0]).toMatchObject({
		name: "Documentation",
		active: 0,
		recent: 0,
	});
	const at = new Date().toISOString();
	await db.insert(workItems).values({
		id: "item-example",
		orgId: "org-example",
		title: "Improve guides",
		projectId: "project-example",
		disposition: "accepted",
		createdAt: at,
	});
	await db.insert(workAttempts).values({
		id: "attempt-example",
		orgId: "org-example",
		workItemId: "item-example",
		executorType: "external_agent",
		executorId: "agent-example",
		attemptNumber: 1,
		startedAt: at,
		heartbeatAt: at,
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
	});
	await db.insert(kernelRuntimeRuns).values({
		id: "private-run",
		organizationId: "org-example",
		conversationId: "private-chat",
		createdAt: at,
		updatedAt: at,
	});
	await db.insert(kernelConversationGrants).values({
		id: "grant-example",
		organizationId: "org-example",
		conversationId: "private-chat",
		granteeDescopeUserId: "owner-example",
		access: "owner",
	});
	const owner = await readAttentionSources(
		db,
		"org-example",
		"2026-10-16T00:00:00Z",
		"owner-example",
	);
	expect(owner.projects[0]).toMatchObject({ active: 1, recent: 1 });
	expect(owner.backlog).toEqual([]);
	expect(owner.runs.map((row) => row.id)).toEqual(["private-run"]);
	expect(
		(
			await readAttentionSources(
				db,
				"org-example",
				"2026-10-16T00:00:00Z",
				"other-person",
			)
		).runs,
	).toEqual([]);
	expect(
		(await readAttentionSources(db, "other-org", "2026-10-16T00:00:00Z"))
			.projects,
	).toEqual([]);
	await db.insert(workItems).values({
		id: "old-red",
		orgId: "org-example",
		title: "Red Ship",
		createdAt: "2026-10-01T00:00:00Z",
		deadline: "2026-10-01T00:30:00Z",
		metadata: { repositoryObserver: 1, event: { kind: "ship_red" } },
	});
	await db.insert(workItems).values({
		id: "newer-backlog",
		orgId: "org-example",
		title: "Newer proposed work",
		createdAt: at,
	});
	expect(
		(await readAttentionSources(db, "org-example", "2026-10-16T00:00:00Z"))
			.backlog[0]?.id,
	).toBe("old-red");
});

it("keeps factory links tenant-scoped and private-workspace names owner-only", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(osWorkspaces));
	sqlite.exec(schemaDdl(osGadgetExecutions));
	const db = createDbQueryClient(createD1Facade(sqlite));
	for (const [id, organizationId, visibility, ownerUserId] of [
		["shared", "org-example", "org", null],
		["private", "org-example", "private", "owner-sub"],
		["foreign", "other-org", "org", null],
	] as const) {
		await db.insert(osWorkspaces).values({
			id,
			organizationId,
			name: id,
			visibility,
			ownerUserId,
			createdByKind: "user",
			createdById: "owner-sub",
		});
		await db.insert(osGadgetExecutions).values({
			id: `execution-${id}`,
			organizationId,
			workspaceId: id,
			gadgetId: "app-example",
			runId: `run-${id}`,
			status: "running",
			grantedCapabilities: "[]",
			policyDecision: "{}",
			createdByKind: "user",
			createdById: "owner-sub",
			createdAt: "2026-10-17T11:00:00Z",
		});
	}
	const since = "2026-10-17T00:00:00Z";
	expect(
		(
			await readAttentionFactoryLinks(db, "org-example", "visitor-sub", since)
		).map((r) => r.factoryName),
	).toEqual(["shared"]);
	expect(
		(await readAttentionFactoryLinks(db, "org-example", "owner-sub", since))
			.map((r) => r.factoryName)
			.sort(),
	).toEqual(["private", "shared"]);
});
