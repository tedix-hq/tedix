import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createDbClient } from "@tedix/db/client";
import { appendWorkspaceFeedLedger } from "@tedix/db/queries/workspace-feed/ledger";
import { applyWorkspaceChangeEvents } from "@tedix/db/queries/workspace-feed/projection";
import { publishOutputProjection } from "@tedix/db/queries/workspace-feed/output-publication";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createDurableSqliteFixture } from "@tedix/db/test/durable-sqlite-fixture";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { createTenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	executeOutputQuery,
	type WorkspaceOutputRuntime,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import * as legacy from "@tedix/db/queries/os-workspaces/outputs";
import {
	osOutputs,
	osOutputRevisions,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import {
	workspaceFeedLedger,
	workspaceFeedCursors,
	workspaceActivity,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "@tedix/db/schema/workspace-feed";

const config = vi.hoisted(() => ({
	env: {} as { WORKSPACE_RUNTIME?: WorkspaceOutputRuntime },
}));
vi.mock("cloudflare:workers", () => ({ env: config.env }));
import * as storage from "./workspace-output-storage";
import { sweepOutputRevisionBodies } from "./os-output-revision-gc";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	delete config.env.WORKSPACE_RUNTIME;
});
const scope = { organizationId: "org-1", workspaceId: "workspace-1" };
const viewer = { userIds: ["user-1"] };

async function fixture() {
	const coreSql = new DatabaseSync(":memory:");
	const objectSql = new DatabaseSync(":memory:");
	databases.push(coreSql, objectSql);
	for (const sql of databases) {
		sql.exec(
			"PRAGMA foreign_keys=OFF; CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-1');",
		);
		sql.exec(schemaDdl(osWorkspaces, osOutputs, osOutputRevisions));
	}
	coreSql.exec(
		schemaDdl(
			workspaceFeedLedger,
			workspaceFeedCursors,
			workspaceActivity,
			workspaceOutputIndex,
			workspaceWorkLinks,
		),
	);
	const core = createDbQueryClient(createD1Facade(coreSql));
	const tenant = createTenantStoreDb(createDurableSqliteFixture(objectSql));
	await core.insert(osWorkspaces).values({
		id: scope.workspaceId,
		organizationId: scope.organizationId,
		name: "Private scratch",
		visibility: "private",
		ownerUserId: "user-1",
		createdByKind: "user",
		createdById: "user-1",
	});
	config.env.WORKSPACE_RUNTIME = {
		outputQuery: (bound, query) => executeOutputQuery(tenant, bound, query),
		refreshOutputProjection: async (bound, outputId) => {
			const output = await executeOutputQuery(tenant, bound, {
				op: "get",
				outputId,
			});
			if (!output?.currentRevisionId) return;
			const revision = await executeOutputQuery(tenant, bound, {
				op: "revision",
				revisionId: output.currentRevisionId,
			});
			if (revision) await publishOutputProjection(core, output, revision);
		},
	};
	const output = {
		id: "output-1",
		...scope,
		title: "Scratch output",
		kind: "document" as const,
		status: "active" as const,
		currentRevisionId: "revision-1",
		createdByKind: "user" as const,
		createdById: "user-1",
		createdAt: "2026-11-08T12:00:00.000Z",
		updatedAt: "2026-11-08T12:00:00.000Z",
	};
	const revision = {
		id: "revision-1",
		organizationId: scope.organizationId,
		outputId: output.id,
		revision: 1,
		content: "",
		bodyR2Key: "fixture-body",
		contentSha256: "a".repeat(64),
		contentBytes: 10,
		accessEnvelope: '{"version":1,"sources":[]}',
		createdByKind: "user" as const,
		createdById: "user-1",
		createdAt: output.createdAt,
	};
	return { core, tenant, output, revision };
}

describe("workspace output storage authority", () => {
	it("creates in the object, resolves from its index, and preserves CAS on browser edits", async () => {
		const { core, tenant, output, revision } = await fixture();
		await storage.createOsOutput(core, scope, output, revision);
		expect(
			await legacy.getOsOutput(core, {
				organizationId: scope.organizationId,
				outputId: output.id,
			}),
		).toBeUndefined();
		expect(
			(
				await storage.getOsOutput(core, {
					organizationId: scope.organizationId,
					outputId: output.id,
				})
			)?.id,
		).toBe(output.id);
		expect(
			(await storage.listOsOutputs(core, scope, viewer)).map((row) => row.id),
		).toEqual([output.id]);
		const next = {
			...revision,
			id: "revision-2",
			contentSha256: "b".repeat(64),
			expectedRevision: 1,
		};
		expect((await storage.createOsOutputRevision(core, next)).ok).toBe(true);
		expect(
			await storage.createOsOutputRevision(core, {
				...next,
				id: "revision-stale",
				contentSha256: "c".repeat(64),
			}),
		).toEqual({ ok: false, reason: "revision_conflict" });
		expect(
			(
				await executeOutputQuery(tenant, scope, {
					op: "get",
					outputId: output.id,
				})
			)?.currentRevisionId,
		).toBe("revision-2");
		expect(
			(
				await storage.getOsOutputRevision(core, {
					organizationId: scope.organizationId,
					revisionId: "revision-2",
				})
			)?.accessEnvelope,
		).toBe(revision.accessEnvelope);
		expect(
			(
				await storage.listOsOutputRevisions(core, {
					organizationId: scope.organizationId,
					outputId: output.id,
				})
			).map((row) => row.revision),
		).toEqual([2, 1]);
	});

	it("discovers an existing agent output during scoped listing without copying its row to D1", async () => {
		const { core, tenant, output, revision } = await fixture();
		await executeOutputQuery(tenant, scope, {
			op: "create",
			output,
			revision: { ...revision, accessEnvelope: null },
		});
		expect(
			await storage.getOsOutput(core, {
				organizationId: scope.organizationId,
				outputId: output.id,
			}),
		).toBeUndefined();
		await storage.listOsOutputs(core, scope, viewer);
		expect(
			(
				await storage.getOsOutput(core, {
					organizationId: scope.organizationId,
					outputId: output.id,
				})
			)?.id,
		).toBe(output.id);
		expect(
			(
				await storage.getOsOutputRevision(core, {
					organizationId: scope.organizationId,
					revisionId: revision.id,
				})
			)?.accessEnvelope,
		).toBeNull();
		expect(
			await legacy.getOsOutput(core, {
				organizationId: scope.organizationId,
				outputId: output.id,
			}),
		).toBeUndefined();
	});

	it("keeps legacy D1 IDs authoritative even when an older object copy exists", async () => {
		const { core, tenant, output, revision } = await fixture();
		await legacy.createOsOutput(
			core,
			scope,
			{ ...output, title: "Legacy title" },
			revision,
		);
		await executeOutputQuery(tenant, scope, {
			op: "create",
			output: { ...output, title: "Stale imported title" },
			revision,
		});
		expect(
			(await storage.listOsOutputs(core, scope, viewer)).map(
				(row) => row.title,
			),
		).toEqual(["Legacy title"]);
		expect(
			(
				await storage.getOsOutput(core, {
					organizationId: scope.organizationId,
					outputId: output.id,
				})
			)?.title,
		).toBe("Legacy title");
	});

	it("does not list private object rows for a viewer without workspace access", async () => {
		const { core, tenant, output, revision } = await fixture();
		await executeOutputQuery(tenant, scope, { op: "create", output, revision });
		expect(
			await storage.listOsOutputs(core, scope, { userIds: ["other-user"] }),
		).toEqual([]);
	});

	it("keeps the latest revision current when a delayed publication arrives", async () => {
		const { core, output, revision } = await fixture();
		await storage.createOsOutput(core, scope, output, revision);
		await storage.createOsOutputRevision(core, {
			...revision,
			id: "revision-2",
			contentSha256: "b".repeat(64),
			expectedRevision: 1,
		});
		const delayed = await appendWorkspaceFeedLedger(core, {
			...scope,
			kind: "output",
			id: output.id,
			revision: 1,
			actor: { kind: "user", id: "user-1" },
			changeRecordId: revision.id,
			at: "2026-11-09T12:00:00.000Z",
			summary: { title: "Stale title" },
		});
		await applyWorkspaceChangeEvents(core, [delayed]);
		const indexed = await core.select().from(workspaceOutputIndex);
		expect(
			indexed.filter((row) => row.isCurrent).map((row) => row.revision),
		).toEqual([2]);
		expect(indexed.map((row) => row.revision).sort()).toEqual([1, 2]);
	});

	it("pauses D1-only garbage collection while object revision inventories are incomplete", async () => {
		const { core } = await fixture();
		const bucket = { list: vi.fn(), head: vi.fn(), delete: vi.fn() };
		expect(
			await sweepOutputRevisionBodies({
				db: createDbClient(core.$client),
				bucket,
				organizationId: scope.organizationId,
				now: new Date(),
				dryRun: false,
			}),
		).toEqual({
			scanned: 0,
			eligible: 0,
			removed: 0,
			paused: "workspace-output-inventory-incomplete",
		});
		expect(bucket.list).not.toHaveBeenCalled();
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	it("returns the committed object write when projection publication fails", async () => {
		const { core, tenant, output, revision } = await fixture();
		await core.$client.exec("DROP TABLE workspace_feed_ledger");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				(await storage.createOsOutput(core, scope, output, revision)).output.id,
			).toBe(output.id);
			expect(
				(
					await executeOutputQuery(tenant, scope, {
						op: "get",
						outputId: output.id,
					})
				)?.id,
			).toBe(output.id);
			expect(warn).toHaveBeenCalledWith(
				"workspace_output_projection_pending",
				expect.objectContaining({ outputId: output.id }),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("deletes a stale object copy before deleting its authoritative D1 row", async () => {
		const { core, tenant, output, revision } = await fixture();
		await legacy.createOsOutput(core, scope, output, revision);
		await executeOutputQuery(tenant, scope, { op: "create", output, revision });
		expect(
			await storage.deleteOsOutput(core, {
				organizationId: scope.organizationId,
				outputId: output.id,
			}),
		).toBe(true);
		expect(
			await storage.getOsOutput(core, {
				organizationId: scope.organizationId,
				outputId: output.id,
			}),
		).toBeUndefined();
		expect(
			await executeOutputQuery(tenant, scope, {
				op: "get",
				outputId: output.id,
			}),
		).toBeUndefined();
	});

	it("rejects RPC row access through a different workspace scope", async () => {
		const { tenant, output, revision } = await fixture();
		await executeOutputQuery(tenant, scope, { op: "create", output, revision });
		await expect(
			executeOutputQuery(
				tenant,
				{ ...scope, workspaceId: "other-workspace" },
				{ op: "get", outputId: output.id },
			),
		).rejects.toThrow("outside this workspace");
		await expect(
			executeOutputQuery(tenant, scope, {
				op: "update",
				outputId: output.id,
				patch: { workspaceId: "other-workspace" },
			}),
		).rejects.toThrow("explicit transfer");
	});
});
