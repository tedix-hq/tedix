import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { tediControlPlaneBindingHistory } from "../../schema/control-plane-history";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../../schema/control-plane";
import { organizations } from "../../schema/organizations";
import { tedis } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { getRuntimeProfileById } from "./definitions";
import {
	listRuntimeProfileRevisions,
	listTediControlPlaneBindingHistory,
	publishRuntimeProfileRevision,
	rollbackRuntimeProfileRevision,
} from "./revisions";

function setup(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(
		schemaDdl(
			organizations,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			tediControlPlaneBindingHistory,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
		INSERT INTO runtime_profiles
			(id, organization_id, name, slug, scope, status, version, config)
		VALUES ('rp-1', 'org-1', 'Default', 'default', 'organization', 'active', 1, '{"model":"a"}');
		INSERT INTO tedis
			(id, organization_id, name, slug, runtime_profile_id)
		VALUES ('tedi-1', 'org-1', 'Tedi', 'tedi', 'rp-1');
	`);
	return createDbClient(createD1Facade(sqlite));
}

describe("immutable control-plane revisions", () => {
	it("publishes a successor without mutating the pinned source revision", async () => {
		const db = setup();
		const result = await publishRuntimeProfileRevision(db, {
			revisionId: "rp-1",
			expectedVersion: 1,
			config: { model: "b" },
			changeSummary: "Use model b",
			publishedBy: "user-1",
		});

		expect(result).toMatchObject({
			ok: true,
			revision: {
				version: 2,
				supersedesRevisionId: "rp-1",
				config: { model: "b" },
			},
		});
		expect(await getRuntimeProfileById(db, "rp-1")).toMatchObject({
			version: 1,
			config: { model: "a" },
		});
		const revisions = await listRuntimeProfileRevisions(db, "rp-1");
		expect(revisions.map((revision) => revision.version)).toEqual([2, 1]);
		const [tedi] = await db.select().from(tedis);
		expect(tedi?.runtimeProfileId).toBe("rp-1");
	});

	it("rejects publication from a stale family head", async () => {
		const db = setup();
		expect(
			await publishRuntimeProfileRevision(db, {
				revisionId: "rp-1",
				expectedVersion: 2,
				config: { model: "b" },
			}),
		).toEqual({ ok: false, reason: "revision_conflict" });
	});

	it("rolls back by appending a revision, moving one exact pin, and recording history", async () => {
		const db = setup();
		const second = await publishRuntimeProfileRevision(db, {
			revisionId: "rp-1",
			expectedVersion: 1,
			config: { model: "b" },
		});
		if (!second.ok) throw new Error("expected revision publication");
		await db
			.update(tedis)
			.set({ runtimeProfileId: second.revision.id })
			.where(eq(tedis.id, "tedi-1"));

		const rollback = await rollbackRuntimeProfileRevision(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			currentRevisionId: second.revision.id,
			targetRevisionId: "rp-1",
			expectedVersion: 2,
			publishedBy: "user-1",
		});
		expect(rollback).toMatchObject({
			ok: true,
			revision: {
				version: 3,
				rollbackOfRevisionId: "rp-1",
				config: { model: "a" },
			},
		});
		if (!rollback.ok) throw new Error("expected rollback");
		const [tedi] = await db.select().from(tedis);
		expect(tedi?.runtimeProfileId).toBe(rollback.revision.id);
		expect(
			await listTediControlPlaneBindingHistory(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
			}),
		).toMatchObject([
			{
				previousRevisionId: second.revision.id,
				revisionId: rollback.revision.id,
				kind: "runtime_profile",
			},
		]);
	});
});
