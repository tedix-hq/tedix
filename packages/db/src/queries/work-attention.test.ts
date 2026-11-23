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
	listUnattendedObjectives,
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

it("seeks latest heartbeats per Work Item without scanning Attempt history", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	try {
		for (const table of [tediObjectives, workItems, workAttempts])
			sqlite.exec(schemaDdl(table));
		let query = "";
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => {
					query = statement;
				},
			}),
		);
		const old = "2026-11-20T00:00:00.000Z";
		const since = "2026-11-22T00:00:00.000Z";
		for (const [id, orgId, priority, status] of [
			["empty", "org-example", 0, "active"],
			["no-attempt", "org-example", 1, "active"],
			["old", "org-example", 2, "active"],
			["boundary", "org-example", 3, "active"],
			["paused", "org-example", 4, "paused"],
			["foreign", "other-org", 0, "active"],
		] as const) {
			await db.insert(tediObjectives).values({
				id,
				orgId,
				priority,
				status,
				title: id,
				tediId: "tedi-example",
				createdAt: old,
			});
			if (id !== "empty")
				await db.insert(workItems).values({
					id: `item-${id}`,
					orgId,
					objectiveId: id,
					title: id,
					createdAt: old,
				});
		}
		await db.insert(workItems).values({
			id: "second-old",
			orgId: "org-example",
			objectiveId: "old",
			title: "Second item",
			createdAt: old,
		});
		const insert = sqlite.prepare(`INSERT INTO work_attempts
			(id, org_id, work_item_id, executor_type, executor_id, attempt_number,
			started_at, heartbeat_at, runtime_state, outcome, finished_at)
			VALUES (?, ?, ?, 'tedi', 'tedi-example', ?, ?, ?, 'finished', 'succeeded', ?)`);
		for (let i = 1; i <= 1000; i++) {
			// The most recently started Attempt need not have the latest heartbeat.
			insert.run(
				`history-${i}`,
				"org-example",
				"item-old",
				i,
				i === 1 ? "2026-11-19T00:00:00.000Z" : old,
				i === 1 ? "2026-11-21T00:00:00.000Z" : old,
				since,
			);
		}
		insert.run("second", "org-example", "second-old", 1, old, old, since);
		insert.run(
			"boundary",
			"org-example",
			"item-boundary",
			1,
			old,
			since,
			since,
		);
		// Even a foreign Work Item linked to this objective must not affect it.
		await db.insert(workItems).values({
			id: "foreign-link",
			orgId: "other-org",
			objectiveId: "old",
			title: "Foreign",
			createdAt: old,
		});
		insert.run("foreign", "other-org", "foreign-link", 1, old, since, since);
		expect(await listUnattendedObjectives(db, "org-example", since)).toEqual([
			{ id: "empty", title: "empty", lastAttentionAt: null },
			{ id: "no-attempt", title: "no-attempt", lastAttentionAt: null },
			{ id: "old", title: "old", lastAttentionAt: "2026-11-21T00:00:00.000Z" },
		]);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all("org-example", "org-example", "org-example", "active", since, 100)
			.map((row) => String(row.detail))
			.join(" | ");
		expect(plan).toContain(
			"SEARCH a USING COVERING INDEX idx_work_attempt_org_item_heartbeat (org_id=? AND work_item_id=?)",
		);
		expect(plan).toContain("idx_work_items_org_objective");
		expect(plan).not.toMatch(
			/SCAN a\b|USE TEMP B-TREE FOR ORDER BY.*CORRELATED/,
		);
	} finally {
		sqlite.close();
	}
});

it("reads project attention per Work Item instead of scanning every org Attempt", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	try {
		for (const table of [
			projects,
			workItems,
			workAttempts,
			skillRuns,
			kernelRuntimeRuns,
			kernelConversations,
			kernelConversationGrants,
			tedis,
		])
			sqlite.exec(schemaDdl(table));
		const statements: string[] = [];
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => {
					statements.push(statement);
				},
			}),
		);
		await db.insert(projects).values({
			id: "project-example",
			orgId: "org-example",
			key: "DOCS",
			name: "Documentation",
			status: "active",
			createdAt: "2026-11-20T00:00:00Z",
		});
		await db.insert(workItems).values({
			id: "item-example",
			orgId: "org-example",
			title: "Improve guides",
			projectId: "project-example",
			createdAt: "2026-11-20T00:00:00Z",
		});
		const since = "2026-11-22T00:00:00.000Z";
		const later = new Date(Date.now() + 300_000).toISOString();
		const insert = sqlite.prepare(`INSERT INTO work_attempts
			(id, org_id, work_item_id, executor_type, executor_id, attempt_number,
			started_at, heartbeat_at, expires_at, runtime_state, outcome)
			VALUES (?, ?, ?, 'tedi', 'tedi-example', ?, ?, ?, ?, ?, ?)`);
		insert.run(
			"old",
			"org-example",
			"item-example",
			1,
			since,
			"2026-11-21T00:00:00.000Z",
			since,
			"finished",
			"succeeded",
		);
		insert.run(
			"live",
			"org-example",
			"item-example",
			2,
			since,
			"2026-11-23T00:00:00.000Z",
			later,
			"running",
			null,
		);
		// Another organization's Attempt on a same-named item must not count.
		insert.run(
			"foreign",
			"other-org",
			"item-example",
			1,
			since,
			"2026-11-23T01:00:00.000Z",
			later,
			"running",
			null,
		);
		statements.length = 0;
		const { projects: rows } = await readAttentionSources(
			db,
			"org-example",
			since,
		);
		expect(rows[0]).toMatchObject({
			id: "project-example",
			lastAttentionAt: "2026-11-23T00:00:00.000Z",
			active: 1,
			recent: 1,
		});
		const query = statements.find((s) =>
			s.includes("project_last_attention_at"),
		);
		expect(query).toBeDefined();
		const params = Array.from(
			{ length: (query!.match(/\?/g) ?? []).length },
			() => "org-example",
		);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...params)
			.map((row) => String(row.detail))
			.join(" | ");
		expect(plan).toContain("idx_work_attempt_org_item_heartbeat");
		expect(plan).toMatch(/idx_work_items_org_project/);
		expect(plan).not.toMatch(/SCAN a\b/);
	} finally {
		sqlite.close();
	}
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
