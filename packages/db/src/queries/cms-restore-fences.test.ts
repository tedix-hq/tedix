import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	abortCmsCaptureCronPause,
	assertCmsCaptureCronPause,
	claimCmsCaptureCronPause,
	closeCmsRestoreFence,
	countCmsRestorePermitsForSite,
	drainCmsCaptureCronPause,
	enterCmsProvisioningPermit,
	enterCmsRestorePermit,
	getCmsRestoreFenceState,
	getCmsRestoreEpoch,
	leaveCmsRestorePermit,
	reconcileCmsRestoreOuterPermits,
	releaseCmsCaptureCronPause,
	releaseCmsRestoreFence,
} from "./cms-restore-fences";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE cms_sites (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL,
			restore_epoch INTEGER NOT NULL DEFAULT 0
		);
		INSERT INTO cms_sites (id, slug, status) VALUES
			('site-1', 'one', 'active'),
			('site-2', 'two', 'active'),
			('site-3', 'three', 'paused'),
			('site-4', 'four', 'provisioning');
		CREATE TABLE cms_restore_fences (
			site_id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			generation TEXT NOT NULL,
			capture_id TEXT NOT NULL,
			restore_epoch INTEGER,
			closed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		CREATE TABLE cms_capture_cron_pauses (
			site_id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			capture_id TEXT NOT NULL,
			expires_at_unix INTEGER NOT NULL,
			drained_at_unix INTEGER
		);
		CREATE TABLE cms_restore_permits (
			id TEXT PRIMARY KEY,
			site_id TEXT NOT NULL,
			slug TEXT NOT NULL,
			restore_epoch INTEGER NOT NULL DEFAULT 0,
			kind TEXT NOT NULL DEFAULT 'legacy',
			entered_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		CREATE INDEX cms_restore_permits_site_slug_idx
			ON cms_restore_permits(site_id, slug);
		CREATE TABLE cms_deprovision_operations (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			slug TEXT NOT NULL,
			authoring_app_id TEXT,
			status TEXT NOT NULL DEFAULT 'queued'
		);
	`);
	return { db: createDbQueryClient(createD1Facade(sqlite)), sqlite };
}

const one = {
	siteId: "site-1",
	slug: "one",
	restoreEpoch: 0,
	kind: "outer" as const,
};
const two = {
	siteId: "site-2",
	slug: "two",
	restoreEpoch: 0,
	kind: "outer" as const,
};
const closed = { ...one, generation: "generation-1", captureId: "capture-1" };

describe("CMS restore fence", () => {
	it("never reconciles an in-flight scheduled permit as an abandoned response", async () => {
		const { db } = fixture();
		const scheduled = { ...one, kind: "scheduled" as const, permitId: "cron" };
		expect(await enterCmsRestorePermit(db, scheduled)).toBe(true);
		expect(await closeCmsRestoreFence(db, closed)).toBe(true);
		expect(await reconcileCmsRestoreOuterPermits(db, closed)).toBe(0);
		expect(await getCmsRestoreFenceState(db, one)).toMatchObject({
			inFlight: 1,
		});
		expect(await leaveCmsRestorePermit(db, scheduled)).toBe(true);
		expect(await releaseCmsRestoreFence(db, closed)).toBe(true);
	});

	it("atomically excludes exact-site scheduled admissions while a capture drains", async () => {
		const { db } = fixture();
		const capture = {
			siteId: one.siteId,
			slug: one.slug,
			captureId: "capture-1",
		};
		const scheduled = {
			...one,
			kind: "scheduled" as const,
			permitId: "cron-1",
		};
		expect(await enterCmsRestorePermit(db, scheduled)).toBe(true);
		expect(await claimCmsCaptureCronPause(db, capture)).toBe(true);
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(false);
		expect(
			await enterCmsRestorePermit(db, { ...scheduled, permitId: "cron-2" }),
		).toBe(false);
		expect(
			await enterCmsRestorePermit(db, {
				...two,
				kind: "scheduled",
				permitId: "other-cron",
			}),
		).toBe(true);
		expect(
			await enterCmsRestorePermit(db, { ...one, permitId: "public-read" }),
		).toBe(true);
		expect(await leaveCmsRestorePermit(db, scheduled)).toBe(true);
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(true);
		expect(await assertCmsCaptureCronPause(db, capture)).toBe(true);
		expect(
			await releaseCmsCaptureCronPause(db, { ...capture, captureId: "wrong" }),
		).toBe(false);
		expect(await releaseCmsCaptureCronPause(db, capture)).toBe(true);
		// A lost D1 response can replay the same exact release.
		expect(await releaseCmsCaptureCronPause(db, capture)).toBe(true);
		expect(
			await enterCmsRestorePermit(db, { ...scheduled, permitId: "cron-2" }),
		).toBe(true);
	});

	it("expires a crashed capture and never lets it release its replacement", async () => {
		const { db, sqlite } = fixture();
		const first = {
			siteId: one.siteId,
			slug: one.slug,
			captureId: "capture-1",
		};
		const second = { ...first, captureId: "capture-2" };
		expect(await claimCmsCaptureCronPause(db, first)).toBe(true);
		expect(await claimCmsCaptureCronPause(db, second)).toBe(false);
		sqlite.exec(
			"UPDATE cms_capture_cron_pauses SET expires_at_unix = unixepoch() - 1",
		);
		expect(await assertCmsCaptureCronPause(db, first)).toBe(false);
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				kind: "scheduled",
				permitId: "resumed-cron",
			}),
		).toBe(true);
		expect(await claimCmsCaptureCronPause(db, second)).toBe(true);
		expect(await releaseCmsCaptureCronPause(db, first)).toBe(false);
		expect(await drainCmsCaptureCronPause(db, second)).toBe(false);
	});

	it("aborts only the exact failed capture without draining or reclaiming permits", async () => {
		const { db, sqlite } = fixture();
		const capture = {
			siteId: one.siteId,
			slug: one.slug,
			captureId: "failed-capture",
		};
		const scheduled = {
			...one,
			kind: "scheduled" as const,
			permitId: "in-flight-cron",
		};
		expect(await enterCmsRestorePermit(db, scheduled)).toBe(true);
		expect(await claimCmsCaptureCronPause(db, capture)).toBe(true);
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(false);
		expect(
			await abortCmsCaptureCronPause(db, { ...capture, slug: "wrong" }),
		).toBe(0);
		expect(
			await abortCmsCaptureCronPause(db, { ...capture, siteId: two.siteId }),
		).toBe(0);
		expect(await abortCmsCaptureCronPause(db, capture)).toBe(1);
		expect(await abortCmsCaptureCronPause(db, capture)).toBe(0);
		expect(await countCmsRestorePermitsForSite(db, one.siteId)).toBe(1);
		expect(
			await enterCmsRestorePermit(db, { ...scheduled, permitId: "new-cron" }),
		).toBe(true);
		const replacement = { ...capture, captureId: "replacement" };
		expect(await claimCmsCaptureCronPause(db, replacement)).toBe(true);
		expect(await abortCmsCaptureCronPause(db, capture)).toBe(0);
		expect(
			await enterCmsRestorePermit(db, {
				...scheduled,
				permitId: "blocked-cron",
			}),
		).toBe(false);
		sqlite.exec(
			"UPDATE cms_capture_cron_pauses SET expires_at_unix = unixepoch() - 1",
		);
		expect(await abortCmsCaptureCronPause(db, replacement)).toBe(1);
	});

	it("never releases an expired or undrained capture pause", async () => {
		const { db, sqlite } = fixture();
		const capture = {
			siteId: one.siteId,
			slug: one.slug,
			captureId: "capture-1",
		};
		expect(await claimCmsCaptureCronPause(db, capture)).toBe(true);
		expect(await releaseCmsCaptureCronPause(db, capture)).toBe(false);
		expect(await drainCmsCaptureCronPause(db, capture)).toBe(true);
		sqlite.exec(
			"UPDATE cms_capture_cron_pauses SET expires_at_unix = unixepoch() - 1",
		);
		expect(await releaseCmsCaptureCronPause(db, capture)).toBe(false);
		expect(
			sqlite
				.prepare(
					"SELECT capture_id FROM cms_capture_cron_pauses WHERE site_id = ?",
				)
				.get(capture.siteId),
		).toMatchObject({ capture_id: capture.captureId });
	});

	it("reconciles only stale outer permits after nested and legacy work drains", async () => {
		const { db, sqlite } = fixture();
		expect(await enterCmsRestorePermit(db, { ...one, permitId: "outer" })).toBe(
			true,
		);
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				permitId: "nested",
				kind: "nested",
			}),
		).toBe(true);
		sqlite.exec(`INSERT INTO cms_restore_permits (id, site_id, slug)
			VALUES ('legacy', 'site-1', 'old-slug')`);
		expect(await closeCmsRestoreFence(db, closed)).toBe(true);
		expect(await reconcileCmsRestoreOuterPermits(db, closed)).toBe(0);
		expect(
			await leaveCmsRestorePermit(db, {
				...one,
				permitId: "nested",
				kind: "nested",
			}),
		).toBe(true);
		expect(await reconcileCmsRestoreOuterPermits(db, closed)).toBe(0);
		sqlite.exec("DELETE FROM cms_restore_permits WHERE id = 'legacy'");
		expect(await reconcileCmsRestoreOuterPermits(db, closed)).toBe(1);
		expect(await countCmsRestorePermitsForSite(db, one.siteId)).toBe(0);
		expect(await reconcileCmsRestoreOuterPermits(db, closed)).toBe(0);
		expect(await releaseCmsRestoreFence(db, closed)).toBe(true);
	});

	it("rejects wrong fence identity, old slug, other site, and post-release reclaim", async () => {
		const { db, sqlite } = fixture();
		expect(await enterCmsRestorePermit(db, { ...one, permitId: "outer" })).toBe(
			true,
		);
		expect(
			await enterCmsRestorePermit(db, { ...two, permitId: "other-site" }),
		).toBe(true);
		sqlite.exec(`INSERT INTO cms_restore_permits (id, site_id, slug, kind)
			VALUES ('old-slug', 'site-1', 'before-rename', 'outer')`);
		expect(await reconcileCmsRestoreOuterPermits(db, closed)).toBe(0);
		expect(await closeCmsRestoreFence(db, closed)).toBe(true);
		expect(
			await reconcileCmsRestoreOuterPermits(db, {
				...closed,
				generation: "wrong",
			}),
		).toBe(0);
		expect(
			await reconcileCmsRestoreOuterPermits(db, {
				...closed,
				captureId: "wrong",
			}),
		).toBe(0);
		expect(
			await reconcileCmsRestoreOuterPermits(db, {
				...closed,
				slug: "before-rename",
			}),
		).toBe(0);
		expect(
			await reconcileCmsRestoreOuterPermits(db, {
				...closed,
				siteId: two.siteId,
			}),
		).toBe(0);
		expect(await reconcileCmsRestoreOuterPermits(db, closed)).toBe(1);
		expect(
			sqlite.prepare("SELECT id FROM cms_restore_permits ORDER BY id").all(),
		).toEqual([{ id: "old-slug" }, { id: "other-site" }]);
		expect(await releaseCmsRestoreFence(db, closed)).toBe(false);
		sqlite.exec("DELETE FROM cms_restore_permits WHERE id = 'old-slug'");
		expect(await releaseCmsRestoreFence(db, closed)).toBe(true);
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				restoreEpoch: 1,
				permitId: "fresh",
			}),
		).toBe(true);
		expect(await reconcileCmsRestoreOuterPermits(db, closed)).toBe(0);
		expect(await countCmsRestorePermitsForSite(db, one.siteId)).toBe(1);
	});

	it("pins new permits to a typed epoch and rotates once across close and release", async () => {
		const { db, sqlite } = fixture();
		expect(await getCmsRestoreEpoch(db, one)).toBe(0);
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				permitId: "outer",
				kind: "outer",
			}),
		).toBe(true);
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				permitId: "nested",
				kind: "nested",
			}),
		).toBe(true);
		expect(
			sqlite
				.prepare(
					"SELECT id, restore_epoch, kind FROM cms_restore_permits ORDER BY id",
				)
				.all(),
		).toEqual([
			{ id: "nested", restore_epoch: 0, kind: "nested" },
			{ id: "outer", restore_epoch: 0, kind: "outer" },
		]);
		expect(await closeCmsRestoreFence(db, closed)).toBe(true);
		expect(await getCmsRestoreEpoch(db, one)).toBe(1);
		expect(await closeCmsRestoreFence(db, closed)).toBe(false);
		expect(await getCmsRestoreEpoch(db, one)).toBe(1);
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				permitId: "late",
				kind: "nested",
			}),
		).toBe(false);
		expect(await countCmsRestorePermitsForSite(db, one.siteId)).toBe(2);
		expect(await releaseCmsRestoreFence(db, closed)).toBe(false);
		expect(
			await leaveCmsRestorePermit(db, {
				...one,
				permitId: "outer",
				kind: "nested",
			}),
		).toBe(false);
		expect(
			await leaveCmsRestorePermit(db, {
				...one,
				permitId: "nested",
				kind: "nested",
			}),
		).toBe(true);
		expect(
			await leaveCmsRestorePermit(db, {
				...one,
				permitId: "outer",
				kind: "outer",
			}),
		).toBe(true);
		expect(await releaseCmsRestoreFence(db, closed)).toBe(true);
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				permitId: "stale",
				kind: "nested",
			}),
		).toBe(false);
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				restoreEpoch: 1,
				permitId: "fresh",
			}),
		).toBe(true);
	});

	it("does not rotate a historical closed fence with a null epoch", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`INSERT INTO cms_restore_fences (site_id, slug, generation, capture_id)
			VALUES ('site-1', 'one', 'generation-1', 'capture-1')`);
		expect(await closeCmsRestoreFence(db, closed)).toBe(false);
		expect(await getCmsRestoreEpoch(db, one)).toBe(0);
		expect(await reconcileCmsRestoreOuterPermits(db, closed)).toBe(0);
		expect(await releaseCmsRestoreFence(db, closed)).toBe(true);
	});

	it("admits only the exact provisioning site and blocks fences and teardown receipts", async () => {
		const { db, sqlite } = fixture();
		const provisioning = {
			siteId: "site-4",
			slug: "four",
			restoreEpoch: 0,
			kind: "outer" as const,
		};
		expect(
			await enterCmsProvisioningPermit(db, { ...provisioning, permitId: "p1" }),
		).toBe(true);
		expect(
			await enterCmsProvisioningPermit(db, { ...provisioning, permitId: "p1" }),
		).toBe(false);
		expect(
			await enterCmsProvisioningPermit(db, { ...one, permitId: "active" }),
		).toBe(false);
		expect(
			await enterCmsRestorePermit(db, { ...provisioning, permitId: "generic" }),
		).toBe(false);
		expect(
			await enterCmsProvisioningPermit(db, {
				...provisioning,
				slug: "wrong",
				permitId: "wrong",
			}),
		).toBe(false);
		sqlite.exec(`INSERT INTO cms_restore_fences (site_id, slug, generation, capture_id)
			VALUES ('site-4', 'four', 'generation', 'capture')`);
		expect(
			await enterCmsProvisioningPermit(db, {
				...provisioning,
				permitId: "fenced",
			}),
		).toBe(false);
		sqlite.exec("DELETE FROM cms_restore_fences WHERE site_id = 'site-4'");
		sqlite.exec(`INSERT INTO cms_deprovision_operations (id, organization_id, slug)
			VALUES ('site-4', 'org-1', 'four')`);
		expect(
			await enterCmsProvisioningPermit(db, {
				...provisioning,
				permitId: "retired",
			}),
		).toBe(false);
		expect(await getCmsRestoreFenceState(db, provisioning)).toMatchObject({
			inFlight: 1,
		});
		expect(
			await leaveCmsRestorePermit(db, { ...provisioning, permitId: "p1" }),
		).toBe(true);
	});

	it("admits only an exact active site and isolates another site", async () => {
		const { db } = fixture();
		expect(await enterCmsRestorePermit(db, { ...one, permitId: "p1" })).toBe(
			true,
		);
		expect(await enterCmsRestorePermit(db, { ...one, permitId: "p1" })).toBe(
			false,
		);
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				slug: "wrong",
				permitId: "p2",
			}),
		).toBe(false);
		expect(
			await enterCmsRestorePermit(db, {
				siteId: "missing",
				slug: "missing",
				permitId: "p2",
				restoreEpoch: 0,
				kind: "outer",
			}),
		).toBe(false);
		expect(
			await enterCmsRestorePermit(db, {
				siteId: "site-3",
				slug: "three",
				permitId: "p2",
				restoreEpoch: 0,
				kind: "outer",
			}),
		).toBe(false);
		expect(await enterCmsRestorePermit(db, { ...two, permitId: "p2" })).toBe(
			true,
		);
		expect(await getCmsRestoreFenceState(db, one)).toMatchObject({
			fence: null,
			inFlight: 1,
		});
		expect(await getCmsRestoreFenceState(db, two)).toMatchObject({
			fence: null,
			inFlight: 1,
		});
	});

	it("closes admission atomically, drains owned permits, and releases exact generation and capture", async () => {
		const { db } = fixture();
		expect(await enterCmsRestorePermit(db, { ...one, permitId: "p1" })).toBe(
			true,
		);
		expect(await closeCmsRestoreFence(db, closed)).toBe(true);
		expect(await enterCmsRestorePermit(db, { ...one, permitId: "p2" })).toBe(
			false,
		);
		expect(await enterCmsRestorePermit(db, { ...two, permitId: "p2" })).toBe(
			true,
		);
		expect(
			await closeCmsRestoreFence(db, { ...closed, generation: "generation-2" }),
		).toBe(false);
		expect(await getCmsRestoreFenceState(db, one)).toMatchObject({
			fence: { generation: "generation-1", captureId: "capture-1" },
			inFlight: 1,
		});
		expect(await releaseCmsRestoreFence(db, closed)).toBe(false);
		expect(await leaveCmsRestorePermit(db, { ...two, permitId: "p1" })).toBe(
			false,
		);
		expect(await getCmsRestoreFenceState(db, one)).toMatchObject({
			inFlight: 1,
		});
		expect(await leaveCmsRestorePermit(db, { ...one, permitId: "p1" })).toBe(
			true,
		);
		expect(await leaveCmsRestorePermit(db, { ...one, permitId: "p1" })).toBe(
			false,
		);
		expect(
			await releaseCmsRestoreFence(db, { ...closed, generation: "stale" }),
		).toBe(false);
		expect(
			await releaseCmsRestoreFence(db, { ...closed, captureId: "wrong" }),
		).toBe(false);
		expect(await getCmsRestoreFenceState(db, one)).toMatchObject({
			inFlight: 0,
		});
		expect(await releaseCmsRestoreFence(db, closed)).toBe(true);
		expect(await getCmsRestoreFenceState(db, one)).toMatchObject({
			fence: null,
			inFlight: 0,
		});
		expect(
			await enterCmsRestorePermit(db, {
				...one,
				restoreEpoch: 1,
				permitId: "p3",
			}),
		).toBe(true);
	});

	it("keeps orphan permits and closed fences until explicit reconciliation", async () => {
		const { db, sqlite } = fixture();
		expect(
			await enterCmsRestorePermit(db, { ...one, permitId: "orphan" }),
		).toBe(true);
		expect(await closeCmsRestoreFence(db, closed)).toBe(true);
		sqlite.exec("UPDATE cms_restore_permits SET entered_at = '2020-01-01'");
		expect(await getCmsRestoreFenceState(db, one)).toMatchObject({
			inFlight: 1,
		});
		expect(await releaseCmsRestoreFence(db, closed)).toBe(false);
		expect(await enterCmsRestorePermit(db, { ...one, permitId: "new" })).toBe(
			false,
		);
	});

	it("does not release while an old-slug permit still belongs to the immutable site", async () => {
		const { db, sqlite } = fixture();
		expect(await closeCmsRestoreFence(db, closed)).toBe(true);
		sqlite.exec(`INSERT INTO cms_restore_permits (id, site_id, slug)
			VALUES ('old-slug-permit', 'site-1', 'before-rename')`);
		expect(await countCmsRestorePermitsForSite(db, one.siteId)).toBe(1);
		expect(await releaseCmsRestoreFence(db, closed)).toBe(false);
		sqlite.exec("DELETE FROM cms_restore_permits WHERE id = 'old-slug-permit'");
		expect(await releaseCmsRestoreFence(db, closed)).toBe(true);
	});

	it("keeps the immutable site fenced if its slug changes", async () => {
		const { db, sqlite } = fixture();
		expect(await closeCmsRestoreFence(db, closed)).toBe(true);
		sqlite.exec("UPDATE cms_sites SET slug = 'renamed' WHERE id = 'site-1'");
		expect(
			await enterCmsRestorePermit(db, {
				siteId: "site-1",
				slug: "renamed",
				permitId: "after-rename",
				restoreEpoch: 0,
				kind: "outer",
			}),
		).toBe(false);
	});

	it("lets a replacement site close a fence after a deprovisioned site used its slug", async () => {
		const { db, sqlite } = fixture();
		expect(await closeCmsRestoreFence(db, closed)).toBe(true);
		sqlite.exec("DELETE FROM cms_sites WHERE id = 'site-1'");
		sqlite.exec(
			"INSERT INTO cms_sites (id, slug, status) VALUES ('site-5', 'one', 'active')",
		);
		const replacement = {
			siteId: "site-5",
			slug: "one",
			generation: "generation-2",
			captureId: "capture-2",
		};
		expect(await closeCmsRestoreFence(db, replacement)).toBe(true);
		expect(
			await enterCmsRestorePermit(db, {
				...replacement,
				restoreEpoch: 0,
				kind: "outer",
				permitId: "p4",
			}),
		).toBe(false);
		expect(await getCmsRestoreFenceState(db, one)).toMatchObject({
			fence: { generation: "generation-1" },
		});
		expect(await getCmsRestoreFenceState(db, replacement)).toMatchObject({
			fence: { generation: "generation-2" },
		});
	});
});
