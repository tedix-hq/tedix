import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const dependencies = vi.hoisted(() => ({ readSiteDrillReceipt: vi.fn() }));
vi.mock("./cms-site-restore-drill-workflow", () => ({
	CMS_SITE_DRILL_CAPTURE_ID: "capture",
	CMS_SITE_DRILL_SITE_ID: "13d1b0d0-2664-4006-981b-d27af4e73794",
	CMS_SITE_DRILL_SLUG: "emdash1rc-src-20260928",
	CmsSiteRestoreDrillWorkflow: class {},
	insertSiteDrillSentinel: vi.fn(),
	readSiteDrillCapture: vi.fn(),
	readSiteDrillReceipt: dependencies.readSiteDrillReceipt,
	writeSiteDrillReceipt: vi.fn(),
}));

import {
	CMS_SITE_CRON_PAUSE_KEY,
	CMS_SITE_CRON_PAUSE_MAX_MS,
	fixedSiteCronPauseDecision,
} from "./cms-site-cron-pause";
import {
	EmDashDB,
	databaseRecoveryBookmarkAdminResponse,
	digestCmsRecoverySqlite,
	digestCmsSiteSqlite,
} from "./index";

const siteId = "13d1b0d0-2664-4006-981b-d27af4e73794";
const slug = "emdash1rc-src-20260928";
const now = Date.parse("2026-09-29T03:00:00.000Z");

function control(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		siteId,
		slug,
		createdAt: new Date(now - 60_000).toISOString(),
		expiresAt: new Date(now + 60_000).toISOString(),
		...overrides,
	};
}

function storage(value: unknown = null) {
	const get = vi.fn(async (_key: string) =>
		value === null ? null : { json: async () => value },
	);
	return { get } as unknown as R2Bucket & { get: typeof get };
}

describe("fixed disposable CMS cron pause", () => {
	beforeEach(() => {
		dependencies.readSiteDrillReceipt.mockReset().mockResolvedValue(null);
	});

	it("does not read a control or receipt for any other tenant", async () => {
		const bucket = storage(control());
		expect(
			await fixedSiteCronPauseDecision(
				bucket,
				{ siteId: "another", slug },
				now,
			),
		).toEqual({ pause: false });
		expect(
			await fixedSiteCronPauseDecision(
				bucket,
				{ siteId, slug: "another" },
				now,
			),
		).toEqual({ pause: false });
		expect(bucket.get).not.toHaveBeenCalled();
		expect(dependencies.readSiteDrillReceipt).not.toHaveBeenCalled();
	});

	it("pauses the exact site while a bounded control is active", async () => {
		const bucket = storage(control());
		expect(
			await fixedSiteCronPauseDecision(bucket, { siteId, slug }, now),
		).toEqual({ pause: true, reason: "active-control" });
		expect(bucket.get).toHaveBeenCalledWith(CMS_SITE_CRON_PAUSE_KEY);
		expect(dependencies.readSiteDrillReceipt).not.toHaveBeenCalled();
	});

	it("resumes when the control expired and there is no active drill", async () => {
		const bucket = storage(
			control({ expiresAt: new Date(now - 1).toISOString() }),
		);
		expect(
			await fixedSiteCronPauseDecision(bucket, { siteId, slug }, now),
		).toEqual({ pause: false });
		expect(dependencies.readSiteDrillReceipt).toHaveBeenCalledWith(bucket);
	});

	it("keeps maintenance paused after control expiry until drill reconciliation", async () => {
		dependencies.readSiteDrillReceipt.mockResolvedValue({ phase: "mutated" });
		const bucket = storage(
			control({ expiresAt: new Date(now - 1).toISOString() }),
		);
		expect(
			await fixedSiteCronPauseDecision(bucket, { siteId, slug }, now),
		).toEqual({ pause: true, reason: "unfinished-drill" });
	});

	it("also holds an unfinished drill if the control was removed", async () => {
		dependencies.readSiteDrillReceipt.mockResolvedValue({
			phase: "restore-scheduled",
		});
		expect(
			await fixedSiteCronPauseDecision(storage(), { siteId, slug }, now),
		).toEqual({ pause: true, reason: "unfinished-drill" });
	});

	it("resumes after a verified drill and control removal", async () => {
		dependencies.readSiteDrillReceipt.mockResolvedValue({ phase: "verified" });
		expect(
			await fixedSiteCronPauseDecision(storage(), { siteId, slug }, now),
		).toEqual({ pause: false });
	});

	it.each([
		control({ siteId: "another" }),
		control({
			expiresAt: new Date(now + CMS_SITE_CRON_PAUSE_MAX_MS).toISOString(),
		}),
		control({ createdAt: new Date(now + 1).toISOString() }),
		control({ expiresAt: "not-a-date" }),
		{ ...control(), version: 2 },
	])("fails closed on malformed or unbounded controls %#", async (value) => {
		expect(
			await fixedSiteCronPauseDecision(storage(value), { siteId, slug }, now),
		).toEqual({ pause: true, reason: "invalid-control" });
	});

	it("fails closed when R2 or receipt reads fail", async () => {
		const bucket = storage();
		bucket.get.mockRejectedValueOnce(new Error("R2 unavailable"));
		expect(
			await fixedSiteCronPauseDecision(bucket, { siteId, slug }, now),
		).toEqual({ pause: true, reason: "invalid-control" });
		dependencies.readSiteDrillReceipt.mockRejectedValueOnce(
			new Error("receipt invalid"),
		);
		expect(
			await fixedSiteCronPauseDecision(bucket, { siteId, slug }, now),
		).toEqual({ pause: true, reason: "invalid-control" });
	});
});

function sqliteFixture(args: {
	posts?: Array<Record<string, unknown>>;
	heartbeatValue?: string;
	heartbeatRevision?: string;
	schemaSql?: string;
	blob?: Uint8Array;
}) {
	const posts = args.posts ?? [
		{
			id: "post-1",
			slug: "native-taxonomy-archive-proof",
			status: "published",
		},
		{ id: "post-2", slug: "another", status: "draft" },
	];
	const heartbeat = {
		name: "system:scheduler:last_completed_at",
		value: JSON.stringify(args.heartbeatValue ?? "2026-09-29T02:50:00.000Z"),
		revision: args.heartbeatRevision ?? "revision-1",
	};
	const schema = [
		{
			type: "table",
			name: "ec_posts",
			tbl_name: "ec_posts",
			sql: args.schemaSql ?? "CREATE TABLE ec_posts (id TEXT)",
		},
		{
			type: "table",
			name: "media",
			tbl_name: "media",
			sql: "CREATE TABLE media (storage_key TEXT)",
		},
		{
			type: "table",
			name: "options",
			tbl_name: "options",
			sql: "CREATE TABLE options (name TEXT)",
		},
		{
			type: "index",
			name: "options_name",
			tbl_name: "options",
			sql: "CREATE INDEX options_name ON options(name)",
		},
		{
			type: "table",
			name: "_tedix_cms_restore_drill",
			tbl_name: "_tedix_cms_restore_drill",
			sql: "CREATE TABLE _tedix_cms_restore_drill (id INTEGER)",
		},
	];
	const exec = vi.fn((statement: string) => {
		let rows: Array<Record<string, unknown>>;
		if (statement.startsWith("SELECT type, name, tbl_name, sql")) {
			expect(statement).toContain("name <> '_tedix_cms_restore_drill'");
			rows = schema.filter(
				(entry) => entry.name !== "_tedix_cms_restore_drill",
			);
		} else if (statement === 'SELECT * FROM "ec_posts"') rows = posts;
		else if (statement === 'SELECT * FROM "media"')
			rows = [
				{
					storage_key: "images/proof.png",
					bytes: args.blob ?? new Uint8Array([1, 2]),
				},
			];
		else if (statement === 'SELECT * FROM "options"') rows = [heartbeat];
		else if (statement.startsWith("SELECT id, slug, status FROM ec_posts"))
			rows = posts;
		else if (statement.startsWith("SELECT storage_key FROM media"))
			rows = [{ storage_key: "images/proof.png" }];
		else if (statement.startsWith("SELECT value, revision FROM options"))
			rows = [heartbeat];
		else if (statement.includes("name = '_tedix_cms_restore_drill'")) rows = [];
		else throw new Error(`Unexpected SQL: ${statement}`);
		return { toArray: () => rows };
	});
	return { exec };
}

describe("fixed disposable CMS SQLite proof", () => {
	it("full recovery digest includes the drill sentinel and bounds work before materializing all rows", () => {
		const sql = (sentinel: string) => ({
			databaseSize: 1024,
			exec(statement: string) {
				let rows: Array<Record<string, unknown>>;
				if (
					statement ===
					"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
				)
					rows = [
						{
							type: "table",
							name: "ec_posts",
							tbl_name: "ec_posts",
							sql: "CREATE TABLE ec_posts (id TEXT)",
						},
						{
							type: "table",
							name: "_tedix_cms_restore_drill",
							tbl_name: "_tedix_cms_restore_drill",
							sql: "CREATE TABLE _tedix_cms_restore_drill (state TEXT)",
						},
					];
				else if (statement === 'SELECT * FROM "ec_posts"')
					rows = [{ id: "post-1" }];
				else if (statement === 'SELECT * FROM "_tedix_cms_restore_drill"')
					rows = [{ state: sentinel }];
				else throw new Error(`Unexpected SQL: ${statement}`);
				return {
					[Symbol.iterator]: () => rows[Symbol.iterator](),
					toArray: () => rows,
				};
			},
		});
		const before = digestCmsRecoverySqlite(sql("before") as never);
		expect(before).toMatch(/^[0-9a-f]{64}$/);
		expect(digestCmsRecoverySqlite(sql("after") as never)).not.toBe(before);
		const oversized = {
			databaseSize: 64 * 1024 * 1024 + 1,
			exec: vi.fn(),
		};
		expect(() => digestCmsRecoverySqlite(oversized as never)).toThrow(
			"digest size limit",
		);
		expect(oversized.exec).not.toHaveBeenCalled();
	});

	it("stops a large SQLite cursor at the row cap without materializing it", () => {
		let yielded = 0;
		const sql = {
			databaseSize: 1024,
			exec(statement: string) {
				if (statement.startsWith("SELECT type, name, tbl_name, sql"))
					return {
						*[Symbol.iterator]() {
							yield {
								type: "table",
								name: "ec_posts",
								tbl_name: "ec_posts",
								sql: "CREATE TABLE ec_posts (id TEXT)",
							};
						},
						toArray: () => {
							throw new Error("must not materialize schema cursor");
						},
					};
				if (statement === 'SELECT * FROM "ec_posts"')
					return {
						*[Symbol.iterator]() {
							for (let id = 0; id < 21_000; id++) {
								yielded++;
								yield { id };
							}
						},
						toArray: () => {
							throw new Error("must not materialize row cursor");
						},
					};
				throw new Error(`Unexpected SQL: ${statement}`);
			},
		};
		expect(() => digestCmsRecoverySqlite(sql as never)).toThrow(
			"row digest limit",
		);
		expect(yielded).toBe(20_001);
	});

	it("digests all table rows and schema independent of row order, except the drill sentinel", () => {
		const first = sqliteFixture({});
		const baseline = digestCmsSiteSqlite(first as never);
		expect(baseline).toMatch(/^[0-9a-f]{64}$/);
		const reversed = sqliteFixture({
			posts: [
				{ id: "post-2", slug: "another", status: "draft" },
				{
					id: "post-1",
					slug: "native-taxonomy-archive-proof",
					status: "published",
				},
			],
		});
		expect(digestCmsSiteSqlite(reversed as never)).toBe(baseline);
		expect(
			digestCmsSiteSqlite(
				sqliteFixture({ heartbeatRevision: "revision-2" }) as never,
			),
		).not.toBe(baseline);
		expect(
			digestCmsSiteSqlite(
				sqliteFixture({
					schemaSql: "CREATE TABLE ec_posts (id TEXT, title TEXT)",
				}) as never,
			),
		).not.toBe(baseline);
		expect(
			digestCmsSiteSqlite(
				sqliteFixture({ blob: new Uint8Array([1, 3]) }) as never,
			),
		).not.toBe(baseline);
	});

	it("returns a full digest and heartbeat from the exact Durable Object", async () => {
		const sql = sqliteFixture({});
		const object = Object.assign(Object.create(EmDashDB.prototype), {
			ctx: {
				id: { toString: () => "fixed-object" },
				storage: {
					sql,
					getCurrentBookmark: async () => "private-bookmark",
				},
			},
			env: {
				DB_DO: {
					idFromName: (name: string) => ({
						toString: () => (name === slug ? "fixed-object" : name),
					}),
				},
			},
		}) as EmDashDB;
		const proof = await object.readSiteDrillProof();
		expect(proof).toMatchObject({
			bookmark: "private-bookmark",
			sentinel: "absent",
			post: { id: "post-1" },
			mediaKeys: ["images/proof.png"],
			schedulerHeartbeatValue: "2026-09-29T02:50:00.000Z",
			schedulerHeartbeatRevision: "revision-1",
		});
		expect(proof.databaseDigest).toBe(digestCmsSiteSqlite(sql as never));
	});

	it("adds digest fields only to the fixed site's authenticated diagnostic", async () => {
		const proof = {
			bookmark: "private-bookmark",
			databaseDigest: "a".repeat(64),
			schedulerHeartbeatValue: "2026-09-29T02:50:00.000Z",
			schedulerHeartbeatRevision: "revision-1",
		};
		const readSiteDrillProof = vi.fn().mockResolvedValue(proof);
		const captureRecoveryBookmark = vi.fn().mockResolvedValue("other-bookmark");
		const env = {
			CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
			DB_DO: {
				idFromName: (name: string) => name,
				get: () => ({ readSiteDrillProof, captureRecoveryBookmark }),
			},
		};
		const url = new URL(
			`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/recovery-bookmark`,
		);
		const request = new Request(url, {
			method: "POST",
			headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
		});
		const bundle = { slug, version: 7, etag: "bundle-etag" };
		const fixed = await databaseRecoveryBookmarkAdminResponse({
			env: env as never,
			request,
			slug,
			url,
			siteId,
			bundle,
			readCurrentBundle: async () => bundle,
		});
		expect(await fixed?.json()).toMatchObject(proof);
		expect(captureRecoveryBookmark).not.toHaveBeenCalled();
		const other = await databaseRecoveryBookmarkAdminResponse({
			env: env as never,
			request,
			slug,
			url,
			siteId: "other-site",
			bundle,
			readCurrentBundle: async () => bundle,
		});
		expect(await other?.json()).not.toHaveProperty("databaseDigest");
		expect(captureRecoveryBookmark).toHaveBeenCalledOnce();
	});
});
