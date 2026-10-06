import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	closeCmsRestoreFence,
	getCmsRestoreFenceState,
	releaseCmsRestoreFence,
} from "@tedix/db/queries/cms-restore-fences";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { describe, expect, it } from "vite-plus/test";
import {
	CmsUnknownProcessOutcomeError,
	hasExactCmsDeprovisionAuthority,
	withCmsSiteRestorePermit,
	withExactCmsSiteRestorePermit,
} from "./cms-restore-permit";

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
			template_slug, created_at, updated_at) VALUES
			('site-one', 'org-one', 'one', 'One', 'active', 'https://one.test', 'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
			('site-two', 'org-two', 'two', 'Two', 'active', 'https://two.test', 'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
		CREATE TABLE cms_restore_fences (
			site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, generation TEXT NOT NULL,
			capture_id TEXT NOT NULL, restore_epoch INTEGER, closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE cms_deprovision_operations (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL,
			authoring_app_id TEXT, status TEXT NOT NULL, stage TEXT NOT NULL,
			deleted TEXT NOT NULL DEFAULT '[]', errors TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
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
	const binding = createD1Facade(sqlite);
	return { sqlite, binding, db: createDbQueryClient(binding) };
}

describe("CMS Builder restore permit", () => {
	it("rejects a queued callback from before restore release while admitting a new owner action", async () => {
		const { sqlite, binding, db } = fixture();
		try {
			const oldSite = { siteId: "site-one", slug: "one", restoreEpoch: 0 };
			const fence = {
				siteId: "site-one",
				slug: "one",
				generation: "g1",
				captureId: "c1",
			};
			expect(await closeCmsRestoreFence(db, fence)).toBe(true);
			expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
			let mutated = false;
			await expect(
				withExactCmsSiteRestorePermit(binding, oldSite, async () => {
					mutated = true;
				}),
			).rejects.toThrow("permit denied");
			expect(mutated).toBe(false);
			await expect(
				withCmsSiteRestorePermit(binding, "one", async () => "new action"),
			).resolves.toBe("new action");
			expect(
				sqlite
					.prepare("SELECT restore_epoch FROM cms_sites WHERE id = 'site-one'")
					.get(),
			).toEqual({ restore_epoch: 1 });
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{ siteId: "site-one", slug: "one", restoreEpoch: 1 },
					async () => {
						return sqlite
							.prepare(
								"SELECT restore_epoch, kind FROM cms_restore_permits WHERE site_id = 'site-one'",
							)
							.get();
					},
				),
			).resolves.toEqual({ restore_epoch: 1, kind: "nested" });
		} finally {
			sqlite.close();
		}
	});
	it("requires a paused canonical site and matching running deprovision receipt", async () => {
		const { sqlite, binding } = fixture();
		try {
			const site = { siteId: "site-one", slug: "one" };
			expect(await hasExactCmsDeprovisionAuthority(binding, site)).toBe(false);
			sqlite.exec(
				"UPDATE cms_sites SET status = 'paused' WHERE id = 'site-one'",
			);
			expect(await hasExactCmsDeprovisionAuthority(binding, site)).toBe(false);
			sqlite.exec(`INSERT INTO cms_deprovision_operations
				(id, organization_id, slug, status, stage)
				VALUES ('site-one', 'org-one', 'one', 'queued', 'queued')`);
			expect(await hasExactCmsDeprovisionAuthority(binding, site)).toBe(false);
			sqlite.exec(
				"UPDATE cms_deprovision_operations SET status = 'running' WHERE id = 'site-one'",
			);
			expect(await hasExactCmsDeprovisionAuthority(binding, site)).toBe(true);
			sqlite.exec(
				"UPDATE cms_deprovision_operations SET organization_id = 'other' WHERE id = 'site-one'",
			);
			expect(await hasExactCmsDeprovisionAuthority(binding, site)).toBe(false);
			sqlite.exec(
				"UPDATE cms_deprovision_operations SET organization_id = 'org-one', authoring_app_id = 'other' WHERE id = 'site-one'",
			);
			expect(await hasExactCmsDeprovisionAuthority(binding, site)).toBe(false);
		} finally {
			sqlite.close();
		}
	});

	it("denies a stale site ID after slug reuse and propagates D1 failure", async () => {
		const { sqlite, binding } = fixture();
		try {
			sqlite.exec(`
				UPDATE cms_sites SET status = 'paused' WHERE id = 'site-one';
				INSERT INTO cms_deprovision_operations
					(id, organization_id, slug, status, stage)
				VALUES ('site-one', 'org-one', 'one', 'running', 'Removing CMS resources');
				DELETE FROM cms_sites WHERE id = 'site-one';
				INSERT INTO cms_sites (id, organization_id, slug, name, status,
					canonical_url, template_slug, created_at, updated_at)
				VALUES ('replacement', 'org-one', 'one', 'Replacement', 'paused',
					'https://one.test', 'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			`);
			expect(
				await hasExactCmsDeprovisionAuthority(binding, {
					siteId: "site-one",
					slug: "one",
				}),
			).toBe(false);
			sqlite.exec("DROP TABLE cms_deprovision_operations");
			await expect(
				hasExactCmsDeprovisionAuthority(binding, {
					siteId: "replacement",
					slug: "one",
				}),
			).rejects.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it("rejects a closed site before mutation while leaving another site available", async () => {
		const { sqlite, binding, db } = fixture();
		try {
			await closeCmsRestoreFence(db, {
				siteId: "site-one",
				slug: "one",
				generation: "g1",
				captureId: "c1",
			});
			let mutated = false;
			await expect(
				withCmsSiteRestorePermit(binding, "one", async () => {
					mutated = true;
				}),
			).rejects.toThrow("permit denied");
			expect(mutated).toBe(false);
			await expect(
				withCmsSiteRestorePermit(binding, "two", async () => "allowed"),
			).resolves.toBe("allowed");
			expect(
				(await getCmsRestoreFenceState(db, { siteId: "site-two", slug: "two" }))
					.inFlight,
			).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it("holds the permit across the asynchronous mutation and releases after an error", async () => {
		const { sqlite, binding, db } = fixture();
		try {
			let rejectOperation!: (reason: Error) => void;
			const operation = new Promise<void>((_resolve, reject) => {
				rejectOperation = reject;
			});
			let entered!: () => void;
			const entry = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const task = withCmsSiteRestorePermit(binding, "one", async () => {
				entered();
				await operation;
			});
			await entry;
			expect(
				(await getCmsRestoreFenceState(db, { siteId: "site-one", slug: "one" }))
					.inFlight,
			).toBe(1);
			expect(
				await closeCmsRestoreFence(db, {
					siteId: "site-one",
					slug: "one",
					generation: "g1",
					captureId: "c1",
				}),
			).toBe(true);
			rejectOperation(new Error("mutation failed"));
			await expect(task).rejects.toThrow("mutation failed");
			expect(
				(await getCmsRestoreFenceState(db, { siteId: "site-one", slug: "one" }))
					.inFlight,
			).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it("fails closed when the database cannot admit the permit", async () => {
		const { sqlite, binding } = fixture();
		try {
			sqlite.exec("DROP TABLE cms_restore_permits");
			let mutated = false;
			await expect(
				withCmsSiteRestorePermit(binding, "one", async () => {
					mutated = true;
				}),
			).rejects.toThrow();
			expect(mutated).toBe(false);
		} finally {
			sqlite.close();
		}
	});

	it("rejects a stale site identity after its slug is reused", async () => {
		const { sqlite, binding } = fixture();
		try {
			sqlite.exec(`
				DELETE FROM cms_sites WHERE id = 'site-one';
				INSERT INTO cms_sites (id, organization_id, slug, name, status,
					canonical_url, template_slug, created_at, updated_at)
				VALUES ('replacement', 'org-one', 'one', 'Replacement', 'active',
					'https://one.test', 'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			`);
			let mutated = false;
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{ siteId: "site-one", slug: "one", restoreEpoch: 0 },
					async () => {
						mutated = true;
					},
				),
			).rejects.toThrow("permit denied");
			expect(mutated).toBe(false);
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{ siteId: "replacement", slug: "one", restoreEpoch: 0 },
					async () => "allowed",
				),
			).resolves.toBe("allowed");
		} finally {
			sqlite.close();
		}
	});

	it("rejects an old payload without a site ID and a deprovisioned site", async () => {
		const { sqlite, binding } = fixture();
		try {
			let mutated = false;
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{
						siteId: undefined as unknown as string,
						slug: "one",
						restoreEpoch: 0,
					},
					async () => {
						mutated = true;
					},
				),
			).rejects.toThrow("exact site identity required");
			sqlite.exec(
				"INSERT INTO cms_deprovision_operations (id, organization_id, slug, status, stage) VALUES ('site-one', 'org-one', 'one', 'running', 'Removing CMS resources')",
			);
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{ siteId: "site-one", slug: "one", restoreEpoch: 0 },
					async () => {
						mutated = true;
					},
				),
			).rejects.toThrow("permit denied");
			expect(mutated).toBe(false);
		} finally {
			sqlite.close();
		}
	});

	it("releases ordinary build errors even when the uncertainty policy is enabled", async () => {
		const { sqlite, binding, db } = fixture();
		try {
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{ siteId: "site-one", slug: "one", restoreEpoch: 0 },
					async () => {
						throw new Error("build failed with a known outcome");
					},
					{ retainPermitOnUnknownProcessOutcome: true },
				),
			).rejects.toThrow("build failed with a known outcome");
			expect(
				(await getCmsRestoreFenceState(db, { siteId: "site-one", slug: "one" }))
					.inFlight,
			).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it("retains a durable drain blocker only for an opted-in unknown build outcome", async () => {
		const { sqlite, binding, db } = fixture();
		try {
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{ siteId: "site-one", slug: "one", restoreEpoch: 0 },
					async () => {
						throw new CmsUnknownProcessOutcomeError("build outcome unknown");
					},
					{ retainPermitOnUnknownProcessOutcome: true },
				),
			).rejects.toThrow("build outcome unknown");
			expect(
				(await getCmsRestoreFenceState(db, { siteId: "site-one", slug: "one" }))
					.inFlight,
			).toBe(1);
			expect(
				await closeCmsRestoreFence(db, {
					siteId: "site-one",
					slug: "one",
					generation: "g1",
					captureId: "c1",
				}),
			).toBe(true);
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{ siteId: "site-one", slug: "one", restoreEpoch: 0 },
					async () => "unexpected",
				),
			).rejects.toThrow("permit denied");
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{ siteId: "site-two", slug: "two", restoreEpoch: 0 },
					async () => "allowed",
				),
			).resolves.toBe("allowed");
		} finally {
			sqlite.close();
		}
	});

	it("releases unknown-outcome errors without the explicit build policy", async () => {
		const { sqlite, binding, db } = fixture();
		try {
			await expect(
				withExactCmsSiteRestorePermit(
					binding,
					{ siteId: "site-one", slug: "one", restoreEpoch: 0 },
					async () => {
						throw new CmsUnknownProcessOutcomeError("unobserved");
					},
				),
			).rejects.toThrow("unobserved");
			expect(
				(await getCmsRestoreFenceState(db, { siteId: "site-one", slug: "one" }))
					.inFlight,
			).toBe(0);
		} finally {
			sqlite.close();
		}
	});
});
