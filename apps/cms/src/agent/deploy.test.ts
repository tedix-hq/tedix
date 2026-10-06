import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	closeCmsRestoreFence,
	getCmsRestoreFenceState,
} from "@tedix/db/queries/cms-restore-fences";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { rollback, type DeployContext } from "./deploy";

const activate = vi.hoisted(() => vi.fn());
vi.mock("@tedix/provisioning/cms", () => ({
	activateTenantBundleVersion: activate,
	listTenantBundleVersions: vi.fn(),
}));

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE cms_sites (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
			canonical_url TEXT NOT NULL, custom_domain TEXT, public_path_prefix TEXT,
			template_slug TEXT NOT NULL, config TEXT, mcp_app_id TEXT,
			authoring_app_id TEXT, restore_epoch INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		INSERT INTO cms_sites (id, organization_id, slug, name, status, canonical_url,
			template_slug, created_at, updated_at)
		VALUES ('site-one', 'org-one', 'one', 'One', 'active', 'https://one.test',
			'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
		CREATE TABLE cms_restore_fences (
			site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, generation TEXT NOT NULL,
			capture_id TEXT NOT NULL, restore_epoch INTEGER, closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE cms_deprovision_operations (id TEXT PRIMARY KEY);
		CREATE TABLE cms_restore_permits (
			id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL,
			restore_epoch INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'outer',
			entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE cms_capture_cron_pauses (
			site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, capture_id TEXT NOT NULL,
			expires_at_unix INTEGER NOT NULL, drained_at_unix INTEGER
		);
	`);
	const platformDb = createD1Facade(sqlite);
	const ctx = {
		config: { environment: "production" },
		platformDb,
		bundlesBucket: {} as R2Bucket,
		sandbox: {} as DeployContext["sandbox"],
	} satisfies DeployContext;
	return { sqlite, platformDb, ctx, db: createDbQueryClient(platformDb) };
}

describe("manual CMS bundle rollback restore permit", () => {
	beforeEach(() => {
		activate.mockReset();
	});

	it("does not invoke bundle activation for a fenced site", async () => {
		const { sqlite, ctx, db } = fixture();
		try {
			await closeCmsRestoreFence(db, {
				siteId: "site-one",
				slug: "one",
				generation: "g1",
				captureId: "c1",
			});
			await expect(rollback(ctx, "one", 4)).rejects.toThrow("permit denied");
			expect(activate).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});

	it("holds the permit through activation and releases it on failure", async () => {
		const { sqlite, ctx, db } = fixture();
		try {
			let finish!: (value: { success: false; error: string }) => void;
			activate.mockImplementation(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const task = rollback(ctx, "one", 4);
			await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
			expect(
				(await getCmsRestoreFenceState(db, { siteId: "site-one", slug: "one" }))
					.inFlight,
			).toBe(1);
			finish({ success: false, error: "missing bundle" });
			await expect(task).rejects.toThrow("Rollback failed: missing bundle");
			expect(
				(await getCmsRestoreFenceState(db, { siteId: "site-one", slug: "one" }))
					.inFlight,
			).toBe(0);
		} finally {
			sqlite.close();
		}
	});
});
