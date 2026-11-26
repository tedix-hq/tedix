import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { osWorkspaces } from "../../schema/os-workspaces";
import {
	osOutputRevisions,
	osOutputs,
} from "../../tenant-store/outputs-schema";
import { createD1Facade } from "../../test/d1-facade";
import { createDurableSqliteFixture } from "../../test/durable-sqlite-fixture";
import { schemaDdl } from "../../test/schema-ddl";
import type { TenantStoreDb } from "./tenant-store";
import { createTenantStoreDb } from "./tenant-store";
import * as tenant from "./os-outputs";
import { executeOutputQuery } from "./output-rpc";

const BODY = '{"kind":"document","blocks":[]}';
const BODY_V2 =
	'{"kind":"document","blocks":[{"type":"paragraph","text":"v2"}]}';

const accountability = {
	organizationId: "org-1",
	createdByKind: "tedi" as const,
	createdById: "tedi-1",
	createdAt: "2026-08-13T18:00:00.000Z",
};

function platformDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
	`);
	sqlite.exec(schemaDdl(osWorkspaces, osOutputs, osOutputRevisions));
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

function tenantDb(): { sqlite: DatabaseSync; db: TenantStoreDb } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = OFF;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
	`);
	sqlite.exec(schemaDdl(osWorkspaces, osOutputs, osOutputRevisions));
	return {
		sqlite,
		db: createTenantStoreDb(createDurableSqliteFixture(sqlite)),
	};
}

async function seedTenant(db: TenantStoreDb) {
	return tenant.createOsOutput(
		db,
		{
			...accountability,
			id: "out-1",
			workspaceId: "ws-1",
			kind: "document",
			title: "Launch brief",
			status: "active",
			currentRevisionId: "rev-1",
			updatedAt: accountability.createdAt,
		},
		{
			...accountability,
			id: "rev-1",
			outputId: "out-1",
			revision: 1,
			content: "",
			contentSha256: await sha256Hex(BODY),
			contentBytes: BODY.length,
			bodyR2Key: "org-1/outputs/out-1/rev-1",
			note: null,
		},
	);
}

describe("workspace object outputs", () => {
	it("replays an exact transfer snapshot and rolls back a partial revision import", async () => {
		const source = tenantDb(),
			target = tenantDb();
		try {
			await seedTenant(source.db);
			const snapshot = (await tenant.snapshotOutput(source.db, {
				organizationId: "org-1",
				outputId: "out-1",
			}))!;
			snapshot.output.workspaceId = "ws-2";
			await tenant.importOutput(target.db, snapshot);
			expect(await tenant.importOutput(target.db, snapshot)).toEqual(
				snapshot.output,
			);
			await expect(
				tenant.importOutput(target.db, {
					...snapshot,
					output: { ...snapshot.output, title: "Conflicting file" },
				}),
			).rejects.toThrow("conflicts");
			const invalid = {
				output: { ...snapshot.output, id: "out-2", currentRevisionId: "rev-2" },
				revisions: [
					{ ...snapshot.revisions[0]!, outputId: "out-2", id: "rev-2" },
					{ ...snapshot.revisions[0]!, outputId: "out-2", id: "rev-3" },
				],
			};
			await expect(tenant.importOutput(target.db, invalid)).rejects.toThrow();
			expect(
				await tenant.getOsOutput(target.db, {
					organizationId: "org-1",
					outputId: "out-2",
				}),
			).toBeUndefined();
			expect(
				await tenant.getOsOutputRevision(target.db, {
					organizationId: "org-1",
					revisionId: "rev-2",
				}),
			).toBeUndefined();
		} finally {
			source.sqlite.close();
			target.sqlite.close();
		}
	});
	it("creates output and an R2-backed first revision", async () => {
		const t = tenantDb();
		const created = await seedTenant(t.db);
		expect(created.output).toEqual({
			...accountability,
			id: "out-1",
			currentRevisionId: "rev-1",
			workspaceId: "ws-1",
			kind: "document",
			title: "Launch brief",
			status: "active",
			updatedAt: accountability.createdAt,
		});
		expect(created.revision).toEqual({
			...accountability,
			id: "rev-1",
			outputId: "out-1",
			revision: 1,
			content: "",
			bodyR2Key: "org-1/outputs/out-1/rev-1",
			contentSha256: await sha256Hex(BODY),
			contentBytes: BODY.length,
			note: null,
			skillRunId: null,
			skillId: null,
			agentTurnId: null,
			accessEnvelope: null,
		});
		t.sqlite.close();
	});

	it("appends max+1, advances the pointer and rejects stale CAS", async () => {
		const t = tenantDb();
		const first = await seedTenant(t.db);
		const params = {
			id: "rev-2",
			organizationId: "org-1",
			outputId: "out-1",
			bodyR2Key: "org-1/outputs/out-1/rev-2",
			contentSha256: await sha256Hex(BODY_V2),
			contentBytes: BODY_V2.length,
			note: "second draft",
			createdByKind: "tedi" as const,
			createdById: "tedi-1",
			expectedRevision: 1,
		};
		expect(await tenant.createOsOutputRevision(t.db, params)).toEqual({
			ok: true,
			output: {
				...first.output,
				currentRevisionId: params.id,
				updatedAt: expect.any(String),
			},
			revision: {
				...first.revision,
				id: params.id,
				revision: 2,
				content: "",
				bodyR2Key: params.bodyR2Key,
				contentSha256: params.contentSha256,
				contentBytes: params.contentBytes,
				note: params.note,
				createdAt: expect.any(String),
			},
		});
		expect(
			await tenant.getOsOutput(t.db, {
				organizationId: "org-1",
				outputId: "out-1",
			}),
		).toMatchObject({ currentRevisionId: "rev-2" });
		expect(
			await tenant.createOsOutputRevision(t.db, { ...params, id: "rev-3" }),
		).toEqual({ ok: false, reason: "revision_conflict" });
		t.sqlite.close();
	});

	it("dedupes a byte-identical save on the digest alone", async () => {
		const t = tenantDb();
		await seedTenant(t.db);
		const same = await tenant.createOsOutputRevision(t.db, {
			id: "rev-same",
			organizationId: "org-1",
			outputId: "out-1",
			bodyR2Key: "org-1/outputs/out-1/other-key",
			contentSha256: await sha256Hex(BODY),
			contentBytes: BODY.length,
			createdByKind: "user",
			createdById: "u-1",
			expectedRevision: 1,
		});
		expect(same).toMatchObject({
			ok: true,
			output: { currentRevisionId: "rev-1" },
			revision: { id: "rev-1", revision: 1 },
		});
		expect(
			t.sqlite
				.prepare("SELECT count(*) AS count FROM os_output_revisions")
				.get(),
		).toEqual({ count: 1 });
	});

	it("scopes reads to the organization and lists metadata-only library rows", async () => {
		const t = tenantDb();
		const created = await seedTenant(t.db);
		const anyone = { userIds: [] };
		const library = await tenant.listOsOutputLibraryRows(t.db, "org-1", anyone);
		expect(library).toHaveLength(1);
		expect(library[0]!.output).toEqual(created.output);
		const { content: _content, ...metadata } = created.revision;
		expect(library[0]!.revision).toEqual(metadata);
		expect(library[0]!.revision).not.toHaveProperty("content");
		expect(await tenant.listOsOutputs(t.db, "org-2", anyone)).toHaveLength(0);
		expect(
			await tenant.listOsOutputs(t.db, "org-1", anyone, { kind: "sheet" }),
		).toHaveLength(0);
		t.sqlite.close();
	});

	it("hides outputs of a private workspace from everyone but its owner", async () => {
		const t = tenantDb();
		await t.db.insert(osWorkspaces).values([
			{
				id: "ws-1",
				organizationId: "org-1",
				name: "Team",
				createdByKind: "user",
				createdById: "u-1",
			},
			{
				id: "ws-private",
				organizationId: "org-1",
				name: "Robin (private)",
				visibility: "private",
				ownerUserId: "u-owner",
				createdByKind: "user",
				createdById: "u-owner",
			},
		]);
		await tenant.createOsOutput(
			t.db,
			{
				...accountability,
				id: "out-p",
				workspaceId: "ws-private",
				kind: "document",
				title: "p",
				status: "active",
				currentRevisionId: "r-p",
				updatedAt: accountability.createdAt,
			},
			{
				...accountability,
				id: "r-p",
				outputId: "out-p",
				revision: 1,
				content: "",
				contentSha256: "x",
				contentBytes: 1,
				bodyR2Key: "k",
			},
		);
		const ids = async (userIds: string[]) =>
			(await tenant.listOsOutputs(t.db, "org-1", { userIds })).map((o) => o.id);
		expect(await ids(["u-owner"])).toEqual(["out-p"]);
		expect(await ids(["u-other"])).toEqual([]);
	});

	it("archives and deletes inside org scope identically", async () => {
		const t = tenantDb();
		await seedTenant(t.db);
		expect(
			await tenant.updateOsOutput(
				t.db,
				{ organizationId: "org-2", outputId: "out-1" },
				{ status: "archived" },
			),
		).toBeUndefined();
		expect(
			await tenant.updateOsOutput(
				t.db,
				{ organizationId: "org-1", outputId: "out-1" },
				{ status: "archived" },
			),
		).toMatchObject({ status: "archived" });
		expect(
			await tenant.deleteOsOutput(t.db, {
				organizationId: "org-2",
				outputId: "out-1",
			}),
		).toBe(false);
		expect(
			await tenant.deleteOsOutput(t.db, {
				organizationId: "org-1",
				outputId: "out-1",
			}),
		).toBe(true);
		expect(
			await tenant.getOsOutputRevision(t.db, {
				organizationId: "org-1",
				revisionId: "rev-1",
			}),
		).toBeUndefined();
	});

	it("resolves revision metadata and referenced body hashes identically", async () => {
		const t = tenantDb();
		await seedTenant(t.db);
		expect(
			await tenant.getOsOutputRevisionByNumber(t.db, {
				organizationId: "org-1",
				outputId: "out-1",
				revision: 1,
			}),
		).toMatchObject({ id: "rev-1", bodyR2Key: "org-1/outputs/out-1/rev-1" });
		const meta = await tenant.listOsOutputRevisions(t.db, {
			organizationId: "org-1",
			outputId: "out-1",
		});
		expect(meta).toHaveLength(1);
		expect(meta[0]).not.toHaveProperty("content");
		const sha = await sha256Hex(BODY);
		expect(
			await tenant.referencedOutputBodyHashes(t.db, "org-1", [sha, "other"]),
		).toEqual(new Set([sha]));
		const scope = { organizationId: "org-1", workspaceId: "ws-1" };
		expect(
			await tenant.referencedOutputBodyKeys(t.db, scope, [
				"org-1/outputs/out-1/rev-1",
				"missing",
			]),
		).toEqual(new Set(["org-1/outputs/out-1/rev-1"]));
		expect(
			await tenant.referencedOutputBodyKeys(
				t.db,
				{ ...scope, workspaceId: "ws-2" },
				["org-1/outputs/out-1/rev-1"],
			),
		).toEqual(new Set());
	});

	it("rejects an inline revision on the tenant plane", async () => {
		const t = tenantDb();
		await expect(
			tenant.createOsOutput(
				t.db,
				{
					...accountability,
					id: "out-1",
					kind: "document",
					title: "x",
					status: "active",
					currentRevisionId: "r-1",
					updatedAt: accountability.createdAt,
				},
				{
					...accountability,
					id: "r-1",
					outputId: "out-1",
					revision: 1,
					content: BODY,
				},
			),
		).rejects.toThrow("TENANT_STORE_OUTPUT_BODY_INLINE");
	});
	it("points a revision at a rewritten body only from the body it had, inside its workspace", async () => {
		const t = tenantDb();
		await seedTenant(t.db);
		const scope = { organizationId: "org-1", workspaceId: "ws-1" };
		const previousSha256 = await sha256Hex(BODY);
		const rewritten = {
			contentSha256: await sha256Hex(BODY_V2),
			contentBytes: BODY_V2.length,
			bodyR2Key: "org-1/outputs/out-1/rewritten",
		};
		const rebody = (target: typeof scope, revisionId: string, from: string) =>
			executeOutputQuery(t.db, target, {
				op: "rebody",
				revisionId,
				previousSha256: from,
				...rewritten,
			});
		expect(await rebody(scope, "rev-1", "0".repeat(64))).toBe(false);
		expect(await rebody(scope, "missing", previousSha256)).toBe(false);
		expect(
			await rebody(
				{ ...scope, organizationId: "org-2" },
				"rev-1",
				previousSha256,
			),
		).toBe(false);
		await expect(
			rebody({ ...scope, workspaceId: "ws-2" }, "rev-1", previousSha256),
		).rejects.toThrow("Output is outside this workspace");
		expect(
			await tenant.getOsOutputRevision(t.db, {
				organizationId: "org-1",
				revisionId: "rev-1",
			}),
		).toMatchObject({ contentSha256: previousSha256 });
		expect(await rebody(scope, "rev-1", previousSha256)).toBe(true);
		expect(
			await tenant.getOsOutputRevision(t.db, {
				organizationId: "org-1",
				revisionId: "rev-1",
			}),
		).toMatchObject({ ...rewritten, content: "", revision: 1 });
		// A replay finds the body already moved.
		expect(await rebody(scope, "rev-1", previousSha256)).toBe(false);
	});
});

it("recognizes an idempotently initialized empty directory as document owner", async () => {
	const local = tenantDb();
	const core = platformDb();
	const row = {
		id: "ws-empty",
		organizationId: "org-1",
		name: "Empty",
		status: "active" as const,
		createdByKind: "user" as const,
		createdById: "owner",
		createdAt: "now",
		updatedAt: "now",
		visibility: "private" as const,
		ownerUserId: "owner",
		description: null,
		sourceBlueprintId: null,
		sourceBlueprintRevisionId: null,
		sourceBlueprintRevisionNumber: null,
		instantiationPreflight: null,
		previousBlueprintRevisionId: null,
		previousBlueprintRevisionNumber: null,
		previousInstantiationPreflight: null,
		blueprintDecision: null,
		iconUrl: null,
		defaultTediId: null,
		machineAccess: null,
		highestApprovalMode: null,
	};
	tenant.initializeWorkspaceDirectory(local.db, row);
	tenant.initializeWorkspaceDirectory(local.db, row);
	expect(local.db.select().from(osWorkspaces).all()).toHaveLength(1);
	expect(local.db.select().from(osOutputs).all()).toEqual([]);
	local.sqlite.close();
	core.sqlite.close();
});
