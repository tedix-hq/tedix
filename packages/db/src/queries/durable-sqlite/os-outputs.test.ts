import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import * as platform from "../os-workspaces/outputs";
import {
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { createDurableSqliteFixture } from "../../test/durable-sqlite-fixture";
import { schemaDdl } from "../../test/schema-ddl";
import type { TenantStoreDb } from "./tenant-store";
import { createTenantStoreDb } from "./tenant-store";
import * as tenant from "./os-outputs";

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

async function seedPlatform(db: ReturnType<typeof platformDb>["db"]) {
	return platform.createOsOutput(
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
			content: BODY,
			contentSha256: await sha256Hex(BODY),
			contentBytes: BODY.length,
			bodyR2Key: "org-1/outputs/out-1/rev-1",
			note: null,
		},
	);
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

describe("os outputs plane parity", () => {
	it("creates output + revision 1 identically; tenant stores no inline body", async () => {
		const p = platformDb();
		const t = tenantDb();
		const createdP = await seedPlatform(p.db);
		const createdT = await seedTenant(t.db);
		expect(createdT.output).toEqual(createdP.output);
		expect({ ...createdT.revision, content: BODY }).toEqual(createdP.revision);
		expect(createdT.revision).toMatchObject({
			content: "",
			bodyR2Key: "org-1/outputs/out-1/rev-1",
		});
	});

	it("appends revisions max+1 with CAS and advances the pointer on both planes", async () => {
		const p = platformDb();
		const t = tenantDb();
		await seedPlatform(p.db);
		await seedTenant(t.db);
		const sha = await sha256Hex(BODY_V2);
		const [secondP, secondT] = await Promise.all([
			platform.createOsOutputRevision(p.db, {
				id: "rev-2",
				organizationId: "org-1",
				outputId: "out-1",
				content: BODY_V2,
				contentSha256: sha,
				contentBytes: BODY_V2.length,
				bodyR2Key: "org-1/outputs/out-1/rev-2",
				note: "second draft",
				createdByKind: "tedi",
				createdById: "tedi-1",
				expectedRevision: 1,
			}),
			tenant.createOsOutputRevision(t.db, {
				id: "rev-2",
				organizationId: "org-1",
				outputId: "out-1",
				bodyR2Key: "org-1/outputs/out-1/rev-2",
				contentSha256: sha,
				contentBytes: BODY_V2.length,
				note: "second draft",
				createdByKind: "tedi",
				createdById: "tedi-1",
				expectedRevision: 1,
			}),
		]);
		expect(secondT).toMatchObject({ ok: true });
		expect(secondP).toMatchObject({ ok: true });
		if (secondT.ok && secondP.ok) {
			// createdAt is stamped at write time and legitimately differs across planes.
			expect({
				...secondT.revision,
				content: BODY_V2,
				createdAt: secondP.revision.createdAt,
			}).toEqual(secondP.revision);
			expect(secondT.revision.revision).toBe(2);
		}
		expect(
			await tenant.getOsOutput(t.db, {
				organizationId: "org-1",
				outputId: "out-1",
			}),
		).toMatchObject({ currentRevisionId: "rev-2" });

		// Stale CAS conflicts identically.
		const [staleP, staleT] = await Promise.all([
			platform.createOsOutputRevision(p.db, {
				id: "rev-3",
				organizationId: "org-1",
				outputId: "out-1",
				content: "{}",
				createdByKind: "tedi",
				createdById: "tedi-1",
				expectedRevision: 1,
			}),
			tenant.createOsOutputRevision(t.db, {
				id: "rev-3",
				organizationId: "org-1",
				outputId: "out-1",
				bodyR2Key: "org-1/outputs/out-1/rev-3",
				contentSha256: sha,
				contentBytes: BODY_V2.length,
				createdByKind: "tedi",
				createdById: "tedi-1",
				expectedRevision: 1,
			}),
		]);
		expect(staleT).toEqual(staleP);
		expect(staleT).toEqual({ ok: false, reason: "revision_conflict" });
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
			revision: { id: "rev-1", revision: 1 },
		});
		expect(
			t.sqlite
				.prepare("SELECT count(*) AS count FROM os_output_revisions")
				.get(),
		).toEqual({ count: 1 });
	});

	it("scopes reads to the organization and lists library rows identically", async () => {
		const p = platformDb();
		const t = tenantDb();
		for (const db of [p.db, t.db as unknown as typeof p.db]) {
			await (db === p.db ? seedPlatform : seedTenant)(db as never);
		}
		const anyone = { userIds: [] };
		const [libP, libT] = await Promise.all([
			platform.listOsOutputLibraryRows(p.db, "org-1", anyone),
			tenant.listOsOutputLibraryRows(t.db, "org-1", anyone),
		]);
		expect(libT).toHaveLength(1);
		expect(libP).toHaveLength(1);
		expect(libT[0]!.output).toEqual(libP[0]!.output);
		expect(libT[0]!.revision).toEqual(libP[0]!.revision);
		expect(libT[0]!.revision).not.toHaveProperty("content");
		expect(await tenant.listOsOutputs(t.db, "org-2", anyone)).toHaveLength(0);
		expect(
			await tenant.listOsOutputs(t.db, "org-1", anyone, { kind: "sheet" }),
		).toHaveLength(0);
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
});
