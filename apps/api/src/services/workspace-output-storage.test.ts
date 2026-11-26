import { eq } from "drizzle-orm";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
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
import {
	createOsCollaborationProposal,
	mergeOsCollaborationProposal,
	getOsCollaborationProposal,
} from "@tedix/db/queries/os-workspaces/collaboration";
import * as d1Outputs from "../../test/shared-output-fixture";
import {
	osWorkspaces,
	osCollaborationProposals,
} from "@tedix/db/schema/os-workspaces";
import {
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/tenant-store/outputs-schema";
import {
	workspaceFeedLedger,
	workspaceFeedCursors,
	workspaceActivity,
	workspaceOutputIndex,
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
			osCollaborationProposals,
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
	return { core, coreSql, objectSql, tenant, output, revision };
}

describe("workspace output storage authority", () => {
	it("reads every object operation without consulting shared authority", async () => {
		const { core, tenant, output, revision } = await fixture(false);
		await d1Outputs.createOsOutput(
			core,
			scope,
			{ ...output, title: "Shared copy", kind: "sheet" },
			revision,
		);
		await executeOutputQuery(tenant, scope, {
			op: "create",
			output: { ...output, kind: "sheet" },
			revision,
		});
		const objectRevision = await executeOutputQuery(tenant, scope, {
			op: "revision",
			revisionId: revision.id,
		});
		await publishOutputProjection(core, output, objectRevision!);
		const query = vi.spyOn(config.env.WORKSPACE_RUNTIME!, "outputQuery");
		const params = {
			organizationId: scope.organizationId,
			outputId: output.id,
		};
		expect((await storage.getOsOutput(core, params))?.title).toBe(output.title);
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
				await storage.getActiveSheetByTitle(core, {
					...scope,
					title: output.title,
				})
			)?.output.id,
		).toBe(output.id);
		expect(
			(await storage.listOsOutputs(core, scope, viewer)).map(
				(row) => row.title,
			),
		).toEqual([output.title]);
		await settled();
		expect(
			await storage.getOsOutput(core, {
				...params,
				workspaceId: "other-workspace",
			}),
		).toBeUndefined();
		expect(
			await storage.getOsOutput(core, {
				...params,
				organizationId: "other-org",
			}),
		).toBeUndefined();
		expect(
			await storage.getOsOutputRevision(core, {
				organizationId: "other-org",
				revisionId: revision.id,
			}),
		).toBeUndefined();
		expect(
			await storage.getOsOutputRevisionByNumber(core, {
				...params,
				outputId: "missing",
				revision: 1,
			}),
		).toBeUndefined();
		expect(
			await storage.listOsOutputRevisions(core, {
				...params,
				outputId: "missing",
			}),
		).toEqual([]);
	});

	it("reads the current file directly in its workspace and refuses stale or foreign files", async () => {
		const { core, coreSql, tenant, output, revision } = await fixture();
		await executeOutputQuery(tenant, scope, { op: "create", output, revision });
		// App slots already identify the workspace; feed publication need not have finished.
		coreSql.exec("DROP TABLE workspace_output_index");
		const params = { ...scope, outputId: output.id };
		expect(
			await storage.getOsOutputWithCurrentRevision(core, params),
		).toMatchObject({
			output: { id: output.id },
			revision: { id: revision.id },
		});
		expect(
			await storage.getOsOutputWithCurrentRevision(core, {
				...params,
				organizationId: "other-org",
			}),
		).toBeUndefined();
		expect(
			await storage.getOsOutputWithCurrentRevision(core, {
				...params,
				workspaceId: "other-workspace",
			}),
		).toBeUndefined();
		await tenant
			.update(osOutputs)
			.set({ currentRevisionId: "missing" })
			.where(eq(osOutputs.id, output.id));
		expect(
			await storage.getOsOutputWithCurrentRevision(core, params),
		).toBeUndefined();
		await tenant
			.update(osOutputs)
			.set({ currentRevisionId: revision.id, status: "archived" })
			.where(eq(osOutputs.id, output.id));
		expect(
			await storage.getOsOutputWithCurrentRevision(core, params),
		).toBeUndefined();
	});

	it("lists only the organization index without a runtime, excluding shared-only rows", async () => {
		const { core, output, revision } = await fixture(false);
		await d1Outputs.createOsOutput(core, scope, output, revision);
		await publishOutputProjection(
			core,
			{ ...output, title: "Indexed title" },
			(await d1Outputs.getOsOutputRevision(core, {
				organizationId: scope.organizationId,
				revisionId: revision.id,
			}))!,
		);
		await d1Outputs.createOsOutput(
			core,
			scope,
			{ ...output, id: "shared-only", currentRevisionId: "shared-revision" },
			{ ...revision, id: "shared-revision", outputId: "shared-only" },
		);
		delete config.env.WORKSPACE_RUNTIME;
		expect(
			(
				await storage.listOsOutputs(
					core,
					{ organizationId: scope.organizationId },
					viewer,
				)
			).map((row) => row.title),
		).toEqual(["Indexed title"]);
		expect(
			await storage.listOsOutputs(
				core,
				{ organizationId: scope.organizationId },
				{ userIds: ["other-user"] },
			),
		).toEqual([]);
	});

	it("rejects missing runtime for object reads instead of returning shared content", async () => {
		const { core, output, revision } = await fixture(false);
		await d1Outputs.createOsOutput(core, scope, output, revision);
		delete config.env.WORKSPACE_RUNTIME;
		const params = {
			organizationId: scope.organizationId,
			outputId: output.id,
		};
		const reads = [
			() => storage.getOsOutput(core, params),
			() =>
				storage.getOsOutputRevision(core, {
					organizationId: scope.organizationId,
					revisionId: revision.id,
				}),
			() =>
				storage.getOsOutputRevisionByNumber(core, { ...params, revision: 1 }),
			() => storage.listOsOutputRevisions(core, params),
			() => storage.listOsOutputs(core, scope, viewer),
			() =>
				storage.getActiveSheetByTitle(core, { ...scope, title: output.title }),
		];
		for (const read of reads)
			await expect(read()).rejects.toThrow(
				"Workspace output runtime is unavailable",
			);
	});

	it.each(["missing-runtime", "missing-location"])(
		"refuses writes with %s without changing shared rows",
		async (state) => {
			const { core, tenant, output, revision } = await fixture(false);
			const created = await d1Outputs.createOsOutput(
				core,
				scope,
				output,
				revision,
			);
			if (state === "missing-runtime") delete config.env.WORKSPACE_RUNTIME;
			const params = {
				organizationId: scope.organizationId,
				outputId: output.id,
			};
			const writes: Array<() => Promise<unknown>> = [
				() =>
					storage.createOsOutputRevision(core, {
						...revision,
						id: "revision-2",
						expectedRevision: 1,
					}),
				() => storage.updateOsOutput(core, params, { title: "Changed" }),
				() => storage.deleteOsOutput(core, params),
			];
			if (state === "missing-runtime")
				writes.push(() =>
					storage.createOsOutput(core, scope, output, revision),
				);
			for (const write of writes)
				await expect(write()).rejects.toThrow(
					state === "missing-runtime"
						? "Workspace output runtime is unavailable"
						: "Workspace output location is missing",
				);
			expect(await d1Outputs.getOsOutput(core, params)).toEqual(created.output);
			expect(await core.select().from(osOutputRevisions)).toHaveLength(1);
			expect(await executeOutputQuery(tenant, scope, { op: "list" })).toEqual(
				[],
			);
		},
	);

	it("does not fall back to shared rows for missing object reads", async () => {
		const { core, tenant, output, revision } = await fixture(false);
		await d1Outputs.createOsOutput(core, scope, output, revision);
		await publishOutputProjection(
			core,
			output,
			(await d1Outputs.getOsOutputRevision(core, {
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
		expect(await storage.getOsOutput(core, params)).toBeUndefined();
		expect(
			(
				await storage.getOsOutputRevision(core, {
					organizationId: scope.organizationId,
					revisionId: revision.id,
				})
			)?.id,
		).toBeUndefined();
		expect(
			(
				await storage.getOsOutputRevisionByNumber(core, {
					...params,
					revision: 1,
				})
			)?.id,
		).toBeUndefined();
		expect(
			(await storage.listOsOutputRevisions(core, params)).map((row) => row.id),
		).toEqual([]);
		expect(await storage.listOsOutputs(core, scope, viewer)).toEqual([]);
		expect(query.mock.calls.some(([, query]) => query.op === "get")).toBe(true);
		expect(await executeOutputQuery(tenant, scope, { op: "list" })).toEqual([]);
	});

	it("excludes shared outputs from the library after their projections are removed", async () => {
		const { core, output, revision } = await fixture(false);
		const created = await d1Outputs.createOsOutput(
			core,
			scope,
			output,
			revision,
		);
		await publishOutputProjection(core, created.output, created.revision);
		expect(await core.select().from(workspaceOutputIndex)).toHaveLength(1);
		await publishWorkspaceChange(
			{ db: core },
			outputRevisionChange(created.output, created.revision),
		);
		expect(await core.select().from(workspaceOutputIndex)).toHaveLength(1);
		await core.delete(workspaceOutputIndex);
		expect(await core.select().from(workspaceOutputIndex)).toEqual([]);
		const library = await buildOsOutputLibrary(core, {
			organizationId: scope.organizationId,
			viewer,
			creator: { kind: "user", id: "user-1" },
			limit: 10,
			canReadRevision: async () => true,
		});
		expect(library.items).toEqual([]);
		expect(
			(
				await storage.getOsOutput(core, {
					organizationId: scope.organizationId,
					outputId: output.id,
				})
			)?.id,
		).toBeUndefined();
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

	it("refuses create and move without a workspace", async () => {
		const { core, output, revision } = await fixture();
		await expect(
			storage.createOsOutput(
				core,
				scope,
				{ ...output, workspaceId: null },
				revision,
			),
		).rejects.toThrow("Workspace output requires a workspace");
		const created = await d1Outputs.createOsOutput(
			core,
			{ organizationId: scope.organizationId },
			{ ...output, workspaceId: null },
			revision,
		);
		expect(await storage.moveOsOutput(core, created.output, "target")).toEqual({
			ok: false,
			reason: "source_not_ready",
		});
	});

	it("uses the indexed object for moves and never reads a stale shared row as fallback", async () => {
		const { core, tenant, output, revision } = await fixture();
		await storage.createOsOutput(core, scope, output, revision);
		await d1Outputs.createOsOutput(
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
		tenant
			.insert(osWorkspaces)
			.values({
				...(await core.select().from(osWorkspaces))[0]!,
				id: "target",
				name: "Move target",
			})
			.run();
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
			await d1Outputs.getOsOutput(core, {
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
		expect(
			(
				await storage.updateOsOutput(
					core,
					{ organizationId: scope.organizationId, outputId: output.id },
					{ title: "Object edit" },
				)
			)?.title,
		).toBe("Object edit");
		const next = {
			...revision,
			id: "revision-2",
			contentSha256: "b".repeat(64),
			expectedRevision: 1,
		};
		expect((await storage.createOsOutputRevision(core, next)).ok).toBe(true);
		const refresh = vi.spyOn(
			config.env.WORKSPACE_RUNTIME!,
			"refreshOutputProjection",
		);
		expect(
			await storage.createOsOutputRevision(core, {
				...next,
				id: "revision-unchanged",
				expectedRevision: 2,
			}),
		).toMatchObject({ ok: true, revision: { id: next.id } });
		expect(refresh).not.toHaveBeenCalled();
		refresh.mockRestore();
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
			await d1Outputs.getOsOutput(core, {
				organizationId: scope.organizationId,
				outputId: output.id,
			}),
		).toBeUndefined();
	});

	it("reads the object even when a shared copy exists", async () => {
		const { core, tenant, output, revision } = await fixture(false);
		await d1Outputs.createOsOutput(
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
		).toEqual(["Stale imported title"]);
		await settled();
		expect(
			(
				await storage.getOsOutput(core, {
					organizationId: scope.organizationId,
					outputId: output.id,
				})
			)?.title,
		).toBe("Stale imported title");
	});

	it("finds a newer same-title object sheet", async () => {
		const { core, tenant, output, revision } = await fixture();
		await d1Outputs.createOsOutput(
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

	it("reads a just-saved revision before the feed has indexed it", async () => {
		const { core, output, revision } = await fixture();
		await storage.createOsOutput(core, scope, output, revision);
		// The save returns before its feed publish lands.
		config.env.WORKSPACE_RUNTIME!.refreshOutputProjection = async () => {};
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
		const params = {
			organizationId: scope.organizationId,
			revisionId: "revision-2",
		};
		expect(await storage.getOsOutputRevision(core, params)).toBeUndefined();
		expect(
			(
				await storage.getOsOutputRevision(core, {
					...params,
					workspaceId: scope.workspaceId,
				})
			)?.revision,
		).toBe(2);
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
		await d1Outputs.createOsOutput(core, scope, output, revision);
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
			(
				await d1Outputs.getOsOutput(core, {
					organizationId: scope.organizationId,
					outputId: output.id,
				})
			)?.id,
		).toBe(output.id);
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

	it("creates an uploaded file's document in the workspace's own store", async () => {
		const { core, output, revision } = await fixture();
		const objects = new Map<string, ArrayBuffer>();
		const bucket = {
			put: async (key: string, value: ArrayBuffer) => objects.set(key, value),
			get: async (key: string) => {
				const bytes = objects.get(key);
				return bytes ? { arrayBuffer: async () => bytes } : null;
			},
			head: async (key: string) => (objects.has(key) ? {} : null),
		};
		const { confirmOsWorkspaceFile } = await import("./os-workspace-outputs");
		const file = {
			output,
			revision: {
				...revision,
				content: JSON.stringify({
					kind: "document",
					blocks: [],
					file: { workspaceId: scope.workspaceId, resourceId: output.id },
				}),
			},
		};
		await confirmOsWorkspaceFile(core, file, bucket as never);
		// A second confirm of the same upload keeps the one document.
		await confirmOsWorkspaceFile(core, file, bucket as never);
		const ids = { organizationId: scope.organizationId, outputId: output.id };
		expect(await d1Outputs.getOsOutput(core, ids)).toBeUndefined();
		expect((await storage.getOsOutput(core, ids))?.id).toBe(output.id);
		expect(
			(
				await storage.getOsOutputRevision(core, {
					organizationId: scope.organizationId,
					revisionId: revision.id,
				})
			)?.outputId,
		).toBe(output.id);
	});
});

async function collaborationFixture(moved = true) {
	const f = await fixture(moved);
	await executeOutputQuery(f.tenant, scope, {
		op: "create",
		output: f.output,
		revision: f.revision,
	});
	await publishOutputProjection(f.core, f.output, {
		...f.revision,
		note: null,
		skillId: null,
		skillRunId: null,
	});
	const proposal = await createOsCollaborationProposal(f.core, {
		id: "proposal-1",
		...scope,
		documentType: "output",
		documentId: f.output.id,
		baseRevisionId: f.revision.id,
		baseRevision: 1,
		content: "proposed bytes",
		status: "accepted",
		sourceKind: "agent_session",
		sourceId: "codex:author",
		createdByKind: "user",
		createdById: "user-1",
		sequence: 0,
	});
	const params = {
		organizationId: scope.organizationId,
		proposalId: proposal.id,
		expectedSequence: 0,
		revisionId: "request-revision",
		rationale: "Reviewed",
		evidenceRefs: "[]",
		mergedByKind: "user" as const,
		mergedById: "user-1",
		outputBody: {
			content: proposal.content,
			bodyR2Key: "proposal-body",
			contentSha256: "b".repeat(64),
			contentBytes: 14,
		},
	};
	return { ...f, proposal, params };
}

describe("object-first collaboration merge", () => {
	it("writes the object revision before the shared receipt, leaving shared output tables empty", async () => {
		const f = await collaborationFixture();
		const result = await mergeOsCollaborationProposal(
			f.core,
			f.params,
			async (input) => {
				expect(
					(await getOsCollaborationProposal(f.core, f.params))?.status,
				).toBe("accepted");
				const committed = await storage.commitCollaborationOutput(input);
				expect(
					(
						await executeOutputQuery(f.tenant, scope, {
							op: "get",
							outputId: f.output.id,
						})
					)?.currentRevisionId,
				).toBe(f.proposal.id);
				expect(
					(await getOsCollaborationProposal(f.core, f.params))?.status,
				).toBe("accepted");
				return committed;
			},
		);
		expect(result).toMatchObject({
			ok: true,
			proposal: { status: "merged", resultRevisionId: f.proposal.id },
			revision: { id: f.proposal.id, revision: 2 },
		});
		expect(await f.core.select().from(osOutputs)).toEqual([]);
		expect(await f.core.select().from(osOutputRevisions)).toEqual([]);
	});

	it("recovers a crash before the receipt without writing a second revision, even after a later edit", async () => {
		const f = await collaborationFixture();
		await expect(
			mergeOsCollaborationProposal(f.core, f.params, async (input) => {
				await storage.commitCollaborationOutput(input);
				throw new Error("crash before receipt");
			}),
		).rejects.toThrow("crash before receipt");
		expect((await getOsCollaborationProposal(f.core, f.params))?.status).toBe(
			"accepted",
		);
		await executeOutputQuery(f.tenant, scope, {
			op: "revise",
			params: {
				id: "later-revision",
				organizationId: scope.organizationId,
				outputId: f.output.id,
				expectedRevision: 2,
				bodyR2Key: "later-body",
				contentSha256: "c".repeat(64),
				contentBytes: 5,
				createdByKind: "user",
				createdById: "user-2",
			},
		});
		const result = await mergeOsCollaborationProposal(
			f.core,
			{ ...f.params, revisionId: "new-request-id" },
			storage.commitCollaborationOutput,
		);
		expect(result).toMatchObject({
			ok: true,
			revision: { id: f.proposal.id, revision: 2 },
		});
		expect(
			await mergeOsCollaborationProposal(
				f.core,
				f.params,
				storage.commitCollaborationOutput,
			),
		).toMatchObject({ ok: true, revision: { id: f.proposal.id } });
		expect(
			await executeOutputQuery(f.tenant, scope, {
				op: "history",
				outputId: f.output.id,
			}),
		).toHaveLength(3);
		expect(
			(
				await executeOutputQuery(f.tenant, scope, {
					op: "get",
					outputId: f.output.id,
				})
			)?.currentRevisionId,
		).toBe("later-revision");
	});

	it("refuses a stale base without changing the revision history or shared receipt", async () => {
		const f = await collaborationFixture();
		await executeOutputQuery(f.tenant, scope, {
			op: "revise",
			params: {
				id: "racing-revision",
				organizationId: scope.organizationId,
				outputId: f.output.id,
				expectedRevision: 1,
				bodyR2Key: "racing-body",
				contentSha256: "c".repeat(64),
				contentBytes: 5,
				createdByKind: "user",
				createdById: "user-2",
			},
		});
		expect(
			await mergeOsCollaborationProposal(
				f.core,
				f.params,
				storage.commitCollaborationOutput,
			),
		).toEqual({ ok: false, reason: "revision_conflict" });
		expect(
			await executeOutputQuery(f.tenant, scope, {
				op: "history",
				outputId: f.output.id,
			}),
		).toHaveLength(2);
		expect((await getOsCollaborationProposal(f.core, f.params))?.status).toBe(
			"accepted",
		);
	});
});

it("repairs a failed D1 receipt write without creating another object revision", async () => {
	const f = await collaborationFixture();
	f.coreSql
		.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE ON os_collaboration_proposals
		WHEN NEW.status = 'merged' BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END;`);
	await expect(
		mergeOsCollaborationProposal(
			f.core,
			f.params,
			storage.commitCollaborationOutput,
		),
	).rejects.toMatchObject({
		cause: expect.objectContaining({ message: "receipt unavailable" }),
	});
	expect((await getOsCollaborationProposal(f.core, f.params))?.status).toBe(
		"accepted",
	);
	expect(
		await executeOutputQuery(f.tenant, scope, {
			op: "history",
			outputId: f.output.id,
		}),
	).toHaveLength(2);
	f.coreSql.exec("DROP TRIGGER fail_receipt");
	expect(
		await mergeOsCollaborationProposal(
			f.core,
			{ ...f.params, revisionId: "retry-id" },
			storage.commitCollaborationOutput,
		),
	).toMatchObject({
		ok: true,
		proposal: { status: "merged", resultRevisionId: f.proposal.id },
	});
	expect(
		await executeOutputQuery(f.tenant, scope, {
			op: "history",
			outputId: f.output.id,
		}),
	).toHaveLength(2);
	expect(await f.core.select().from(osOutputs)).toEqual([]);
	expect(await f.core.select().from(osOutputRevisions)).toEqual([]);
});

it("refuses different content for a previously committed proposal id", async () => {
	const f = await collaborationFixture();
	await mergeOsCollaborationProposal(
		f.core,
		f.params,
		storage.commitCollaborationOutput,
	);
	expect(
		await mergeOsCollaborationProposal(
			f.core,
			{
				...f.params,
				outputBody: { ...f.params.outputBody, contentSha256: "d".repeat(64) },
			},
			storage.commitCollaborationOutput,
		),
	).toEqual({ ok: false, reason: "revision_conflict" });
	expect(
		await executeOutputQuery(f.tenant, scope, {
			op: "history",
			outputId: f.output.id,
		}),
	).toHaveLength(2);
});
