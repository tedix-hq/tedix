import { DatabaseSync } from "node:sqlite";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	CMS_DEPLOY_JOB_ID_RE,
	cmsDeployWorkflowInstanceId,
	startCmsDeployWorkflow,
} from "./deploy-admission";

const SITE_ONE = "11111111-1111-4111-8111-111111111111";
const SITE_TWO = "22222222-2222-4222-8222-222222222222";

function fixture(slug = "acme") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE cms_sites (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
			canonical_url TEXT NOT NULL, custom_domain TEXT, public_path_prefix TEXT,
			template_slug TEXT NOT NULL, config TEXT, mcp_app_id TEXT,
			authoring_app_id TEXT, restore_epoch INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE cms_restore_fences (
			site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, generation TEXT NOT NULL,
			capture_id TEXT NOT NULL, restore_epoch INTEGER, closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
		CREATE TABLE cms_deprovision_operations (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued');
		CREATE TABLE tenant_bundles (
			slug TEXT NOT NULL, version INTEGER NOT NULL, is_active INTEGER NOT NULL,
			source_revision TEXT, etag TEXT
		);
	`);
	const insertSite = (siteId: string) => {
		sqlite
			.prepare(`
			INSERT INTO cms_sites (id, organization_id, slug, name, status,
				canonical_url, template_slug, created_at, updated_at)
			VALUES (?, 'org-one', ?, 'Site', 'active', 'https://example.test',
				'tedix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`)
			.run(siteId, slug);
	};
	insertSite(SITE_ONE);
	return { sqlite, db: createD1Facade(sqlite), insertSite };
}

function workflow(state: "errored" | "running" | "complete" = "errored") {
	const instances = new Map<string, { id: string; params: unknown }>();
	const restart = vi.fn(async () => undefined);
	const create = vi.fn(async (options: { id: string; params: unknown }) => {
		if (instances.has(options.id)) throw new Error("duplicate workflow id");
		instances.set(options.id, options);
		return { id: options.id };
	});
	return {
		instances,
		create,
		restart,
		async get(id: string) {
			if (!instances.has(id)) throw new Error("missing workflow");
			return {
				id,
				async status() {
					return { status: state };
				},
				restart,
			};
		},
	};
}

describe("CMS deploy workflow admission", () => {
	it("creates a fresh workflow after a restore epoch rotates", async () => {
		const { sqlite, db } = fixture();
		try {
			const flow = workflow();
			const first = await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
			});
			sqlite
				.prepare("UPDATE cms_sites SET restore_epoch = 1 WHERE id = ?")
				.run(SITE_ONE);
			const second = await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
			});
			expect(first.jobId).toBe(`cms-${SITE_ONE}-e0-v1`);
			expect(second).toEqual({ jobId: `cms-${SITE_ONE}-e1-v1`, reused: false });
			expect(flow.instances.get(first.jobId)?.params).toMatchObject({
				restoreEpoch: 0,
			});
			expect(flow.instances.get(second.jobId)?.params).toMatchObject({
				restoreEpoch: 1,
			});
			expect(flow.restart).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});
	it("pins the current active site in the workflow ID and required payload", async () => {
		const { sqlite, db } = fixture();
		try {
			const flow = workflow();
			const result = await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
			});
			expect(result).toEqual({ jobId: `cms-${SITE_ONE}-e0-v1`, reused: false });
			expect(flow.instances.get(result.jobId)?.params).toEqual({
				siteId: SITE_ONE,
				restoreEpoch: 0,
				orgSlug: "acme",
				summary: undefined,
				sourceCommit: undefined,
				nextBundleVersion: 1,
				expectedActiveVersion: null,
			});
			expect(
				sqlite.prepare("SELECT COUNT(*) AS n FROM cms_restore_permits").get(),
			).toEqual({ n: 0 });
		} finally {
			sqlite.close();
		}
	});

	it("rejects an unpinned Artifacts-backed deploy before creating a workflow", async () => {
		const { sqlite, db } = fixture();
		try {
			sqlite.exec(
				"INSERT INTO tenant_bundles (slug,version,is_active,source_revision) VALUES ('acme', 38, 1, 'artifacts-commit:abc')",
			);
			const flow = workflow();
			await expect(
				startCmsDeployWorkflow({ workflow: flow, db, orgSlug: "acme" }),
			).rejects.toThrow(/requires sourceCommit.*Artifacts-backed bundle/);
			expect(flow.create).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});

	it("keeps IDs bounded for a maximal slug, version, and full source commit", () => {
		const source = "a".repeat(40);
		const id = cmsDeployWorkflowInstanceId(
			SITE_ONE,
			"a".repeat(63),
			Number.MAX_SAFE_INTEGER,
			0,
			source,
		);
		expect(id).toBe(
			`cms-${SITE_ONE}-e0-v${Number.MAX_SAFE_INTEGER}-s${source}`,
		);
		expect(id.length).toBe(103);
		// The gateway secret scan exempts job IDs only under this exact pattern.
		expect(CMS_DEPLOY_JOB_ID_RE.source).toBe(
			"^cms-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-e[0-9]{1,16}-v[1-9][0-9]{0,15}(?:-s[a-f0-9]{40})?$",
		);
		expect(id).toMatch(CMS_DEPLOY_JOB_ID_RE);
		expect(cmsDeployWorkflowInstanceId(SITE_ONE, "acme", 1, 0)).toMatch(
			CMS_DEPLOY_JOB_ID_RE,
		);
		expect(id).not.toBe(
			`cms-deploy-${"a".repeat(63)}-v${Number.MAX_SAFE_INTEGER}-s${source.slice(0, 12)}`,
		);
		expect(cmsDeployWorkflowInstanceId(SITE_TWO, "acme", 1, 0)).not.toBe(
			cmsDeployWorkflowInstanceId(SITE_ONE, "acme", 1, 0),
		);
		expect(() => cmsDeployWorkflowInstanceId("bad", "acme", 1, 0)).toThrow(
			"site ID",
		);
		expect(() => cmsDeployWorkflowInstanceId(SITE_ONE, "Acme", 1, 0)).toThrow(
			"slug",
		);
		expect(() => cmsDeployWorkflowInstanceId(SITE_ONE, "acme", 0, 0)).toThrow(
			"version",
		);
		expect(() =>
			cmsDeployWorkflowInstanceId(SITE_ONE, "acme", 1, 0, "bad"),
		).toThrow("source commit");
	});

	it("coalesces concurrent requests into the exact site generation", async () => {
		const { sqlite, db } = fixture();
		try {
			sqlite.exec(
				"INSERT INTO tenant_bundles (slug,version,is_active,source_revision) VALUES ('acme', 7, 1, 'artifacts-commit:abc')",
			);
			const flow = workflow();
			const sourceCommit = "a".repeat(40);
			const [first, second] = await Promise.all([
				startCmsDeployWorkflow({
					workflow: flow,
					db,
					orgSlug: "acme",
					summary: "ship",
					sourceCommit,
				}),
				startCmsDeployWorkflow({
					workflow: flow,
					db,
					orgSlug: "acme",
					summary: "ship",
					sourceCommit,
				}),
			]);
			expect(first.jobId).toBe(`cms-${SITE_ONE}-e0-v8-s${sourceCommit}`);
			expect(second.jobId).toBe(first.jobId);
			expect([first.reused, second.reused].sort()).toEqual([false, true]);
			expect(flow.restart).not.toHaveBeenCalled();
			expect(flow.instances.get(first.jobId)?.params).toMatchObject({
				siteId: SITE_ONE,
				restoreEpoch: 0,
				orgSlug: "acme",
				nextBundleVersion: 8,
				expectedActiveVersion: 7,
				sourceCommit,
			});
		} finally {
			sqlite.close();
		}
	});

	it("does not reuse an old site's version-one workflow after slug reuse", async () => {
		const { sqlite, db, insertSite } = fixture();
		try {
			const flow = workflow();
			const first = await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
			});
			sqlite.exec(`DELETE FROM cms_sites WHERE id = '${SITE_ONE}'`);
			insertSite(SITE_TWO);
			const second = await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
			});
			expect(second.jobId).not.toBe(first.jobId);
			expect(second).toEqual({ jobId: `cms-${SITE_TWO}-e0-v1`, reused: false });
			expect(flow.restart).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});

	it("denies admission after a deprovision receipt, before workflow creation", async () => {
		const { sqlite, db } = fixture();
		try {
			sqlite.exec(
				`INSERT INTO cms_deprovision_operations (id) VALUES ('${SITE_ONE}')`,
			);
			const flow = workflow();
			await expect(
				startCmsDeployWorkflow({ workflow: flow, db, orgSlug: "acme" }),
			).rejects.toThrow("permit denied");
			expect(flow.create).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});
	it("admits only one of two concurrent source commits", async () => {
		const { sqlite, db } = fixture();
		try {
			const flow = workflow("running");
			const results = await Promise.allSettled(
				["a", "b"].map((letter) =>
					startCmsDeployWorkflow({
						workflow: flow,
						db,
						orgSlug: "acme",
						sourceCommit: letter.repeat(40),
					}),
				),
			);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const rejected = results.find(
				(result) => result.status === "rejected",
			) as PromiseRejectedResult;
			expect(rejected.reason.message).toContain("already in progress");
			expect(flow.instances.size).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	it("retains site admission through health checking after bundle activation", async () => {
		const { sqlite, db } = fixture();
		try {
			const flow = workflow("running");
			const sourceCommit = "a".repeat(40);
			const first = await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
				sourceCommit,
			});
			sqlite.exec(
				"INSERT INTO tenant_bundles (slug,version,is_active,source_revision) VALUES ('acme', 1, 1, 'artifacts-commit:abc')",
			);
			expect(
				await startCmsDeployWorkflow({
					workflow: flow,
					db,
					orgSlug: "acme",
					sourceCommit,
				}),
			).toEqual({ jobId: first.jobId, reused: true });
			await expect(
				startCmsDeployWorkflow({
					workflow: flow,
					db,
					orgSlug: "acme",
					sourceCommit: "b".repeat(40),
				}),
			).rejects.toThrow("already in progress");
			expect(flow.create).toHaveBeenCalledOnce();
		} finally {
			sqlite.close();
		}
	});

	it("admits the next generation only after a terminal workflow", async () => {
		const { sqlite, db } = fixture();
		try {
			const flow = workflow("complete");
			const first = await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
			});
			sqlite.exec(
				"INSERT INTO tenant_bundles (slug,version,is_active,source_revision) VALUES ('acme', 1, 1, NULL)",
			);
			const second = await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
			});
			expect(second.jobId).not.toBe(first.jobId);
			expect(second.jobId).toContain("-v2");
		} finally {
			sqlite.close();
		}
	});
	it("recovers a crash between reserving the site and creating its workflow", async () => {
		const { sqlite, db } = fixture();
		try {
			const flow = workflow("running");
			flow.create.mockRejectedValueOnce(new Error("provider unavailable"));
			await expect(
				startCmsDeployWorkflow({ workflow: flow, db, orgSlug: "acme" }),
			).rejects.toThrow("provider unavailable");
			const retry = await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
			});
			expect(retry.jobId).toBe(`cms-${SITE_ONE}-e0-v1`);
			expect(flow.instances.size).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	it("reserves a fresh generation when retrying a failed deploy", async () => {
		const { sqlite, db } = fixture();
		try {
			const flow = workflow("errored");
			await startCmsDeployWorkflow({
				workflow: flow,
				db,
				orgSlug: "acme",
				sourceCommit: "a".repeat(40),
			});
			const results = await Promise.allSettled(
				["a", "b"].map((letter) =>
					startCmsDeployWorkflow({
						workflow: flow,
						db,
						orgSlug: "acme",
						sourceCommit: letter.repeat(40),
					}),
				),
			);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(flow.instances.size).toBe(2);
			expect([...flow.instances.keys()].some((id) => id.includes("-v2"))).toBe(
				true,
			);
		} finally {
			sqlite.close();
		}
	});
});

it.each([true, false])(
	"does not coalesce staging and direct activation for the same source (stage first: %s)",
	async (stageFirst) => {
		const { sqlite, db } = fixture();
		try {
			const flow = workflow("running");
			const input = {
				workflow: flow,
				db,
				orgSlug: "acme",
				sourceCommit: "a".repeat(40),
			};
			const results = await Promise.allSettled([
				startCmsDeployWorkflow({ ...input, stageOnly: stageFirst }),
				startCmsDeployWorkflow({ ...input, stageOnly: !stageFirst }),
			]);
			expect(results.map((result) => result.status)).toEqual([
				"fulfilled",
				"rejected",
			]);
			expect(flow.create).toHaveBeenCalledTimes(1);
			expect(flow.create.mock.calls[0]?.[0].params).toMatchObject({
				stageOnly: stageFirst,
			});
		} finally {
			sqlite.close();
		}
	},
);
