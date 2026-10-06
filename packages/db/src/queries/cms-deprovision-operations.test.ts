import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	pauseCmsSiteUnlessRestoring,
	restoreCmsSiteUnlessDeprovisioning,
} from "./cms-sites";
import {
	CmsDeprovisionReservationConflictError,
	completeCmsDeprovisionOperation,
	getCmsDeprovisionOperation,
	getCmsDeprovisionOperationForOrganization,
	reserveCmsDeprovisionOperation,
	updateCmsDeprovisionOperation,
} from "./cms-deprovision-operations";
import {
	closeCmsRestoreFence,
	countCmsRestorePermitsForSite,
	enterCmsRestorePermit,
	leaveCmsRestorePermit,
	releaseCmsRestoreFence,
} from "./cms-restore-fences";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE cms_deprovision_operations (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			slug TEXT NOT NULL,
			authoring_app_id TEXT,
			status TEXT NOT NULL DEFAULT 'queued',
			stage TEXT NOT NULL DEFAULT 'queued',
			deleted TEXT NOT NULL DEFAULT '[]',
			errors TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		CREATE TABLE cms_sites (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			slug TEXT NOT NULL,
			authoring_app_id TEXT,
			status TEXT NOT NULL,
			restore_epoch INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE cms_restore_fences (
			site_id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			generation TEXT NOT NULL,
			capture_id TEXT NOT NULL,
			restore_epoch INTEGER,
			closed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		CREATE TABLE cms_restore_permits (
			id TEXT PRIMARY KEY,
			site_id TEXT NOT NULL,
			slug TEXT NOT NULL,
			restore_epoch INTEGER NOT NULL DEFAULT 0,
			kind TEXT NOT NULL DEFAULT 'legacy',
			entered_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		CREATE TABLE cms_capture_cron_pauses (
			site_id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			capture_id TEXT NOT NULL,
			expires_at_unix INTEGER NOT NULL,
			drained_at_unix INTEGER
		);
		CREATE TABLE apps (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			visibility TEXT NOT NULL
		);
		INSERT INTO cms_sites (id, organization_id, slug, authoring_app_id, status, updated_at)
		VALUES ('site-1', 'org-1', 'example', 'app-1', 'paused', '2026-01-01');
		INSERT INTO apps (id, organization_id, visibility)
		VALUES ('app-1', 'org-1', 'disabled');
	`);
	return { db: createDbQueryClient(createD1Facade(sqlite)), sqlite };
}

describe("CMS deprovision operation ledger", () => {
	it("serializes owner archive against a restore close and keeps the authoring app paired", async () => {
		const fence = {
			siteId: "site-1",
			slug: "example",
			generation: "generation-1",
			captureId: "capture-1",
		};
		const archive = async (db: ReturnType<typeof fixture>["db"]) =>
			pauseCmsSiteUnlessRestoring(db, {
				id: "site-1",
				organizationId: "org-1",
				authoringAppId: "app-1",
			});
		{
			const { db, sqlite } = fixture();
			sqlite.exec("UPDATE cms_sites SET status = 'active' WHERE id = 'site-1'");
			sqlite.exec("UPDATE apps SET visibility = 'private' WHERE id = 'app-1'");
			expect(await closeCmsRestoreFence(db, fence)).toBe(true);
			expect(await archive(db)).toBe(false);
			expect(
				sqlite
					.prepare("SELECT status FROM cms_sites WHERE id = 'site-1'")
					.get(),
			).toEqual({ status: "active" });
			expect(
				sqlite.prepare("SELECT visibility FROM apps WHERE id = 'app-1'").get(),
			).toEqual({ visibility: "private" });
		}
		{
			const { db, sqlite } = fixture();
			sqlite.exec("UPDATE cms_sites SET status = 'active' WHERE id = 'site-1'");
			sqlite.exec("UPDATE apps SET visibility = 'private' WHERE id = 'app-1'");
			expect(await archive(db)).toBe(true);
			expect(await closeCmsRestoreFence(db, fence)).toBe(false);
			expect(
				sqlite
					.prepare("SELECT status FROM cms_sites WHERE id = 'site-1'")
					.get(),
			).toEqual({ status: "paused" });
			expect(
				sqlite.prepare("SELECT visibility FROM apps WHERE id = 'app-1'").get(),
			).toEqual({ visibility: "disabled" });
		}
	});

	it("refuses unarchive under a closed restore fence without enabling its app", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec("UPDATE cms_sites SET status = 'active' WHERE id = 'site-1'");
		const fence = {
			siteId: "site-1",
			slug: "example",
			generation: "generation-1",
			captureId: "capture-1",
		};
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		expect(
			await restoreCmsSiteUnlessDeprovisioning(db, {
				id: "site-1",
				organizationId: "org-1",
				authoringAppId: "app-1",
			}),
		).toBe(false);
		expect(
			sqlite.prepare("SELECT visibility FROM apps WHERE id = 'app-1'").get(),
		).toEqual({ visibility: "disabled" });
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
		expect(
			await restoreCmsSiteUnlessDeprovisioning(db, {
				id: "site-1",
				organizationId: "org-1",
				authoringAppId: "app-1",
			}),
		).toBe(true);
		expect(
			sqlite.prepare("SELECT visibility FROM apps WHERE id = 'app-1'").get(),
		).toEqual({ visibility: "private" });
	});

	it("does not pause a site whose owner or authoring app changed after the read", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec("UPDATE cms_sites SET status = 'active' WHERE id = 'site-1'");
		sqlite.exec("UPDATE apps SET visibility = 'private' WHERE id = 'app-1'");
		const archive = (organizationId: string) =>
			pauseCmsSiteUnlessRestoring(db, {
				id: "site-1",
				organizationId,
				authoringAppId: "app-1",
			});
		expect(await archive("other-org")).toBe(false);
		sqlite.exec(
			"UPDATE cms_sites SET authoring_app_id = NULL WHERE id = 'site-1'",
		);
		expect(await archive("org-1")).toBe(false);
		expect(
			sqlite.prepare("SELECT status FROM cms_sites WHERE id = 'site-1'").get(),
		).toEqual({ status: "active" });
		expect(
			sqlite.prepare("SELECT visibility FROM apps WHERE id = 'app-1'").get(),
		).toEqual({ visibility: "private" });
	});

	it("refuses a closed restore fence, then reserves after exact release", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec("UPDATE cms_sites SET status = 'active' WHERE id = 'site-1'");
		const fence = {
			siteId: "site-1",
			slug: "example",
			generation: "generation-1",
			captureId: "capture-1",
		};
		expect(await closeCmsRestoreFence(db, fence)).toBe(true);
		await expect(
			reserveCmsDeprovisionOperation(db, {
				siteId: "site-1",
				organizationId: "org-1",
				slug: "example",
				authoringAppId: "app-1",
			}),
		).rejects.toMatchObject({
			reason: "restore_fenced",
		});
		expect(await getCmsDeprovisionOperation(db, "site-1")).toBeNull();
		expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
		expect(
			await reserveCmsDeprovisionOperation(db, {
				siteId: "site-1",
				organizationId: "org-1",
				slug: "example",
				authoringAppId: "app-1",
			}),
		).toMatchObject({ id: "site-1" });
	});

	it("blocks new restore admission and close after reservation, including failed retries", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec("UPDATE cms_sites SET status = 'active' WHERE id = 'site-1'");
		const input = {
			siteId: "site-1",
			organizationId: "org-1",
			slug: "example",
			authoringAppId: "app-1",
			restoreEpoch: 0,
			kind: "outer" as const,
		};
		expect(
			await enterCmsRestorePermit(db, { ...input, permitId: "in-flight" }),
		).toBe(true);
		expect(await reserveCmsDeprovisionOperation(db, input)).toMatchObject({
			status: "queued",
		});
		expect(await countCmsRestorePermitsForSite(db, input.siteId)).toBe(1);
		expect(
			await enterCmsRestorePermit(db, { ...input, permitId: "too-late" }),
		).toBe(false);
		expect(
			await closeCmsRestoreFence(db, {
				...input,
				generation: "generation-1",
				captureId: "capture-1",
			}),
		).toBe(false);
		expect(
			await leaveCmsRestorePermit(db, { ...input, permitId: "in-flight" }),
		).toBe(true);
		expect(await countCmsRestorePermitsForSite(db, input.siteId)).toBe(0);
		await updateCmsDeprovisionOperation(db, {
			siteId: input.siteId,
			organizationId: input.organizationId,
			status: "failed",
			stage: "provider_cleanup_failed",
		});
		expect(await reserveCmsDeprovisionOperation(db, input)).toMatchObject({
			status: "failed",
			stage: "provider_cleanup_failed",
		});
		expect(
			await enterCmsRestorePermit(db, { ...input, permitId: "retry" }),
		).toBe(false);
		expect(
			await closeCmsRestoreFence(db, {
				...input,
				generation: "generation-2",
				captureId: "capture-2",
			}),
		).toBe(false);
	});

	it("rejects mismatched site identity and isolates another site", async () => {
		const { db, sqlite } = fixture();
		const input = {
			siteId: "site-1",
			organizationId: "org-1",
			slug: "example",
			authoringAppId: "app-1",
			restoreEpoch: 0,
			kind: "outer" as const,
		};
		for (const mismatch of [
			{ ...input, organizationId: "org-2" },
			{ ...input, slug: "wrong" },
			{ ...input, authoringAppId: null },
		]) {
			await expect(
				reserveCmsDeprovisionOperation(db, mismatch),
			).rejects.toBeInstanceOf(CmsDeprovisionReservationConflictError);
		}
		expect(await getCmsDeprovisionOperation(db, input.siteId)).toBeNull();
		sqlite.exec(`
			INSERT INTO cms_sites (id, organization_id, slug, authoring_app_id, status, updated_at)
			VALUES ('site-2', 'org-2', 'other', NULL, 'active', '2026-01-01');
			INSERT INTO cms_restore_permits (id, site_id, slug) VALUES ('old-slug-permit', 'site-2', 'old');
		`);
		expect(await countCmsRestorePermitsForSite(db, "site-2")).toBe(1);
		expect(await countCmsRestorePermitsForSite(db, input.siteId)).toBe(0);
		expect(await reserveCmsDeprovisionOperation(db, input)).toMatchObject({
			id: "site-1",
		});
		await expect(
			reserveCmsDeprovisionOperation(db, { ...input, slug: "wrong" }),
		).rejects.toMatchObject({
			reason: "site_identity_mismatch",
		});
		expect(
			await enterCmsRestorePermit(db, {
				siteId: "site-2",
				slug: "other",
				permitId: "site-2",
				restoreEpoch: 0,
				kind: "outer",
			}),
		).toBe(true);
	});
	it("atomically fences site and authoring proxy restoration after cleanup reservation", async () => {
		const { db, sqlite } = fixture();
		const restore = () =>
			restoreCmsSiteUnlessDeprovisioning(db, {
				id: "site-1",
				organizationId: "org-1",
				authoringAppId: "app-1",
			});
		expect(await restore()).toBe(true);
		expect(
			sqlite.prepare("SELECT status FROM cms_sites WHERE id = 'site-1'").get(),
		).toEqual({ status: "active" });
		expect(
			sqlite.prepare("SELECT visibility FROM apps WHERE id = 'app-1'").get(),
		).toEqual({ visibility: "private" });

		sqlite.exec(
			"UPDATE cms_sites SET status = 'paused'; DELETE FROM apps WHERE id = 'app-1'",
		);
		expect(await restore()).toBe(false);
		expect(
			sqlite.prepare("SELECT status FROM cms_sites WHERE id = 'site-1'").get(),
		).toEqual({ status: "paused" });
		sqlite.exec(
			"INSERT INTO apps (id, organization_id, visibility) VALUES ('app-1', 'org-1', 'disabled')",
		);
		sqlite.exec("UPDATE apps SET organization_id = 'other-org'");
		expect(await restore()).toBe(false);
		expect(
			sqlite.prepare("SELECT status FROM cms_sites WHERE id = 'site-1'").get(),
		).toEqual({ status: "paused" });
		sqlite.exec("UPDATE apps SET organization_id = 'org-1'");
		await reserveCmsDeprovisionOperation(db, {
			siteId: "site-1",
			organizationId: "org-1",
			slug: "example",
			authoringAppId: "app-1",
		});
		expect(await restore()).toBe(false);
		expect(
			sqlite.prepare("SELECT status FROM cms_sites WHERE id = 'site-1'").get(),
		).toEqual({ status: "paused" });
		expect(
			sqlite.prepare("SELECT visibility FROM apps WHERE id = 'app-1'").get(),
		).toEqual({ visibility: "disabled" });
	});

	it("never restores a site still provisioning", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(
			"UPDATE cms_sites SET status = 'provisioning' WHERE id = 'site-1'",
		);
		expect(
			await restoreCmsSiteUnlessDeprovisioning(db, {
				id: "site-1",
				organizationId: "org-1",
				authoringAppId: "app-1",
			}),
		).toBe(false);
		expect(
			sqlite.prepare("SELECT status FROM cms_sites WHERE id = 'site-1'").get(),
		).toEqual({ status: "provisioning" });
		expect(
			sqlite.prepare("SELECT visibility FROM apps WHERE id = 'app-1'").get(),
		).toEqual({ visibility: "disabled" });
	});

	it("keeps one receipt through retries and site deletion, scoped to its organization", async () => {
		const { db } = fixture();
		const input = {
			siteId: "site-1",
			organizationId: "org-1",
			slug: "example",
			authoringAppId: "app-1",
		};
		const first = await reserveCmsDeprovisionOperation(db, input);
		expect(first.status).toBe("queued");
		expect((await reserveCmsDeprovisionOperation(db, input)).id).toBe(first.id);
		expect(
			await getCmsDeprovisionOperationForOrganization(db, {
				siteId: input.siteId,
				organizationId: "other-org",
			}),
		).toBeNull();

		await updateCmsDeprovisionOperation(db, {
			siteId: input.siteId,
			organizationId: input.organizationId,
			status: "succeeded",
			stage: "completed",
			deleted: ["durable_object", "site"],
			errors: [],
		});
		const receipt = await getCmsDeprovisionOperation(db, input.siteId);
		expect(receipt?.status).toBe("succeeded");
		expect(receipt?.deleted).toEqual(["durable_object", "site"]);
		expect((await reserveCmsDeprovisionOperation(db, input)).status).toBe(
			"succeeded",
		);
		expect(
			await updateCmsDeprovisionOperation(db, {
				siteId: input.siteId,
				organizationId: "other-org",
				status: "failed",
				stage: "failed",
			}),
		).toBeNull();
	});

	it("commits site removal and success receipt together on D1", async () => {
		const { db, sqlite } = fixture();
		await reserveCmsDeprovisionOperation(db, {
			siteId: "site-1",
			organizationId: "org-1",
			slug: "example",
			authoringAppId: "app-1",
		});
		const receipt = await completeCmsDeprovisionOperation(db, {
			siteId: "site-1",
			organizationId: "org-1",
			deleted: ["durable_object", "site"],
		});
		expect(receipt.status).toBe("succeeded");
		expect(receipt.deleted).toEqual(["durable_object", "site"]);
		expect(
			sqlite.prepare("SELECT id FROM cms_sites WHERE id = 'site-1'").get(),
		).toBeUndefined();
	});
});
