import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createDbClient } from "@tedix/db/client";
import { appendWorkspaceFeedLedger } from "@tedix/db/queries/workspace-feed/ledger";
import { applyWorkspaceChangeEvents } from "@tedix/db/queries/workspace-feed/projection";
import { publishOutputProjection } from "@tedix/db/queries/workspace-feed/output-publication";
import { retireWorkspaceOutputIndex } from "@tedix/db/queries/workspace-feed/read";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createDurableSqliteFixture } from "@tedix/db/test/durable-sqlite-fixture";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { createTenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	executeOutputQuery,
	type WorkspaceOutputRuntime,
	type OutputOperation,
	type OutputQuery,
	type OutputQueryResult,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import { hasWorkspaceOutputAuthority } from "@tedix/db/queries/durable-sqlite/os-outputs";
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
	background: [] as Promise<unknown>[],
}));
vi.mock("cloudflare:workers", () => ({
	env: config.env,
	waitUntil: (work: Promise<unknown>) => config.background.push(work),
}));
/** Lists repair projections after responding; wait as the runtime would. */
const settled = () => Promise.all(config.background.splice(0));
import * as storage from "./workspace-output-storage";
import { publishWorkspaceChange, outputRevisionChange } from "./workspace-feed";
import { buildOsOutputLibrary } from "./os-output-library";
import { sweepOutputRevisionBodies } from "./os-output-revision-gc";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	delete config.env.WORKSPACE_RUNTIME;
});
const scope = { organizationId: "org-1", workspaceId: "workspace-1" };
const viewer = { userIds: ["user-1"] };

async function fixture(moved = true) {
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
	if (moved)
		tenant
			.insert(osWorkspaces)
			.values((await core.select().from(osWorkspaces))[0]!)
			.run();
	config.env.WORKSPACE_RUNTIME = {
		transferOutput: async () => ({ ok: false, reason: "not_found" }),
		outputQuery: async <K extends OutputOperation>(
			bound: typeof scope,
			query: OutputQuery<K>,
		) => {
			if (query.op === "authority")
				return (
					(await hasWorkspaceOutputAuthority(tenant, bound, core))
						? "object"
						: "shared"
				) as OutputQueryResult<K>;
			return executeOutputQuery(tenant, bound, query);
		},
		refreshOutputProjection: async (bound, outputId) => {
			const output = await executeOutputQuery(tenant, bound, {
				op: "get",
				outputId,
			});
			if (!output?.currentRevisionId) {
				await retireWorkspaceOutputIndex(core, {
					organizationId: bound.organizationId,
					outputId,
				});
				return;
			}
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
	it("uses shared storage for every read and revision write despite index rows", async () => {
		const { core, tenant, output, revision } = await fixture(false);
		await legacy.createOsOutput(core, scope, output, revision);
		await publishOutputProjection(
			core,
			output,
			(await legacy.getOsOutputRevision(core, {
				organizationId: scope.organizationId,
				revisionId: revision.id,
			}))!,
		);
		const query = vi.spyOn(config.env.WORKSPACE_RUNTIME!, "outputQuery");
		const params = {
			organizationId: scope.organizationId,
			outputId: output.id,
		};
		expect((await core.select().from(workspaceOutputIndex)).length).toBe(1);
		expect((await storage.getOsOutput(core, params))?.id).toBe(output.id);
		expect(
			(
				await storage.getOsOutputRevision(core, {
					organizationId: scope.organizationId,
					revisionId: revision.id,
				})
			)?.id,
		).toBe(revision.id);
		expect(
			(
				await storage.getOsOutputRevisionByNumber(core, {
					...params,
					revision: 1,
				})
			)?.id,
		).toBe(revision.id);
		expect(
			(await storage.listOsOutputRevisions(core, params)).map((row) => row.id),
		).toEqual([revision.id]);
		expect(
			(
				await storage.createOsOutputRevision(core, {
					...revision,
					id: "revision-2",
					contentSha256: "b".repeat(64),
					expectedRevision: 1,
				})
			).ok,
		).toBe(true);
		expect(
			(
				await storage.getOsOutputRevisionByNumber(core, {
					...params,
					revision: 2,
				})
			)?.id,
		).toBe("revision-2");
		expect(
			(await storage.listOsOutputs(core, scope, viewer)).map((row) => row.id),
		).toEqual([output.id]);
		expect(
			(
				await storage.createOsOutput(
					core,
					scope,
					{ ...output, id: "output-2", currentRevisionId: "revision-new" },
					{ ...revision, id: "revision-new", outputId: "output-2" },
				)
			).output.id,
		).toBe("output-2");
		expect(
			(await storage.updateOsOutput(core, params, { title: "Shared edit" }))
				?.title,
		).toBe("Shared edit");
		expect(
			query.mock.calls.every(([, query]) => query.op === "authority"),
		).toBe(true);
		expect(await executeOutputQuery(tenant, scope, { op: "list" })).toEqual([]);
	});

	it("removes shared projections on publication and keeps them in the Outputs library", async () => {
		const { core, output, revision } = await fixture(false);
		const created = await legacy.createOsOutput(core, scope, output, revision);
		await publishOutputProjection(core, created.output, created.revision);
		expect(await core.select().from(workspaceOutputIndex)).toHaveLength(1);
		await publishWorkspaceChange(
			{ db: core },
			outputRevisionChange(created.output, created.revision),
		);
		expect(await core.select().from(workspaceOutputIndex)).toEqual([]);
		const library = await buildOsOutputLibrary(core, {
			organizationId: scope.organizationId,
			viewer,
			creator: { kind: "user", id: "user-1" },
			limit: 10,
			canReadRevision: async () => true,
		});
		expect(library.items.map((item) => item.output.id)).toEqual([output.id]);
		expect(
			(
				await storage.getOsOutput(core, {
					organizationId: scope.organizationId,
					outputId: output.id,
				})
			)?.id,
		).toBe(output.id);
	});

	it("recognizes a transfer destination with object outputs and no imported workspace row", async () => {
		const { core, tenant, output, revision } = await fixture(false);
		await executeOutputQuery(tenant, scope, { op: "create", output, revision });
		await publishOutputProjection(
			core,
			output,
			(await executeOutputQuery(tenant, scope, {
				op: "revision",
				revisionId: revision.id,
			}))!,
		);
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
				await storage.getOsOutputRevisionByNumber(core, {
					organizationId: scope.organizationId,
					outputId: output.id,
					revision: 1,
				})
			)?.id,
		).toBe(revision.id);
	});
	it.each([false, true])(
		"does not move an output into a workspace owned by the other store (object source: %s)",
		async (moved) => {
			const { core, tenant, output, revision } = await fixture(moved);
			await storage.createOsOutput(core, scope, output, revision);
			const target = "other-store";
			if (moved) {
				await legacy.createOsOutput(
					core,
					{ ...scope, workspaceId: target },
					{
						...output,
						workspaceId: target,
						id: "target-output",
						currentRevisionId: "target-revision",
					},
					{ ...revision, outputId: "target-output", id: "target-revision" },
				);
			} else {
				tenant
					.insert(osWorkspaces)
					.values({
						...(await core.select().from(osWorkspaces))[0]!,
						id: target,
						name: "Object target",
					})
					.run();
			}
			const stored = await storage.getOsOutput(core, {
				organizationId: scope.organizationId,
				outputId: output.id,
			});
			expect(await storage.moveOsOutput(core, stored!, target)).toEqual({
				ok: false,
				reason: "conflict",
			});
			expect(
				(
					await storage.getOsOutput(core, {
						organizationId: scope.organizationId,
						outputId: output.id,
					})
				)?.workspaceId,
			).toBe(scope.workspaceId);
		},
	);

	it("uses the indexed object for moves and never reads a stale shared row as fallback", async () => {
		const { core, tenant, output, revision } = await fixture();
		await storage.createOsOutput(core, scope, output, revision);
		await legacy.createOsOutput(
			core,
			scope,
			{ ...output, title: "Old shared row" },
			revision,
		);
		const canonical = await storage.getOsOutput(core, {
			organizationId: scope.organizationId,
			outputId: output.id,
		});
		expect(canonical?.title).toBe(output.title);
		const move = vi.fn(async () => ({
			ok: false as const,
			reason: "not_found" as const,
		}));
		config.env.WORKSPACE_RUNTIME!.transferOutput = move;
		expect(await storage.moveOsOutput(core, canonical!, "target")).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(move).toHaveBeenCalledWith(scope, output.id, "target");
		await executeOutputQuery(tenant, scope, {
			op: "delete",
			outputId: output.id,
		});
		expect(
			await storage.getOsOutput(core, {
				organizationId: scope.organizationId,
				outputId: output.id,
			}),
		).toBeUndefined();
		expect(
			await storage.getOsOutputRevision(core, {
				organizationId: scope.organizationId,
				revisionId: revision.id,
			}),
		).toBeUndefined();
	});
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
		await settled();
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

	it("keeps shared workspace outputs authoritative even when an older object copy exists", async () => {
		const { core, tenant, output, revision } = await fixture(false);
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

	it("finds a newer same-title object sheet", async () => {
		const { core, tenant, output, revision } = await fixture();
		await legacy.createOsOutput(
			core,
			scope,
			{ ...output, kind: "sheet" },
			revision,
		);
		await executeOutputQuery(tenant, scope, {
			op: "create",
			output: {
				...output,
				id: "newer-sheet",
				kind: "sheet",
				currentRevisionId: "sheet-revision",
				updatedAt: "2026-11-09T12:00:00.000Z",
			},
			revision: { ...revision, id: "sheet-revision", outputId: "newer-sheet" },
		});
		expect(
			(
				await storage.getActiveSheetByTitle(core, {
					...scope,
					title: output.title,
				})
			)?.output.id,
		).toBe("newer-sheet");
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

	it("deletes only the owning object despite a stale shared copy", async () => {
		const { core, tenant, output, revision } = await fixture();
		await legacy.createOsOutput(core, scope, output, revision);
		await executeOutputQuery(tenant, scope, { op: "create", output, revision });
		const storedRevision = await executeOutputQuery(tenant, scope, {
			op: "revision",
			revisionId: revision.id,
		});
		await publishOutputProjection(core, output, storedRevision!);
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
		expect(
			(await core.select().from(workspaceOutputIndex)).filter(
				(row) => row.isCurrent,
			),
		).toEqual([]);
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
