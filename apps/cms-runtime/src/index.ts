import {
	publicAssetCacheEligible,
	publicAssetCacheRequest,
	publicAssetClientResponse,
	imageRepresentationEtag,
	validateImageSourceRevision,
} from "./tenant-public-cache";
import { staticAssetResponse } from "./static-assets";
import {
	isMarketingHost,
	isMarketingContactPath,
	marketingResponse,
	type MarketingEnv,
} from "./marketing";
/**
 * CMS Runtime Worker
 *
 * Each tenant's Astro+Emdash bundle is loaded into a per-isolate V8 sandbox
 * via the worker_loader (Dynamic Workers) binding. The EmDashDB Durable Object
 * namespace is injected as DB_DO; per-tenant R2 / KV are exposed to the
 * isolate as RPC `WorkerEntrypoint` stubs because Dynamic Workers cannot
 * accept native R2 bindings yet (see Cloudflare docs:
 *   https://developers.cloudflare.com/dynamic-workers/usage/bindings/ ).
 *
 * Routing:
 *   {slug}.cms.tedix.dev/*       (production)
 *   {slug}.cms.tedix.tech/*      (development)
 *
 * Flow:
 *   1. Extract slug from Host.
 *   2. Look up org in PLATFORM_DB (cached 5 min per isolate).
 *   3. Look up active bundle row (`tenant_bundles`) for that slug.
 *   4. Fetch main + chunked modules from R2 TENANT_BUNDLES.
 *   5. Build TenantR2 / TenantSession RPC stubs with per-tenant `props`.
 *   6. env.LOADER.get(slug, factory) → forward request to entrypoint.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { withDynamicWorkerLoaderDiagnostics } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { createHash } from "node:crypto";

import { EmDashDB as EmdashSqlDB } from "@emdash-cms/cloudflare/db/do-sql";
import {
	CMS_PITR_SELF_TEST_DO_NAME,
	CMS_PITR_SELF_TEST_RECEIPT_KEY,
	type CmsPitrSelfTestReceipt,
} from "./cms-pitr-self-test-workflow";
import {
	CMS_SITE_DRILL_SITE_ID,
	CMS_SITE_DRILL_SLUG,
	insertSiteDrillSentinel,
	readSiteDrillCapture,
	readSiteDrillReceipt,
	writeSiteDrillReceipt,
	type CmsSiteDrillProof,
} from "./cms-site-restore-drill-workflow";
import { fixedSiteCronPauseDecision } from "./cms-site-cron-pause";
import {
	claimCmsSiteRestoreReceipt,
	readCmsSiteRestoreReceipt,
	type CmsSiteRestoreIdentity,
	type CmsSiteRestoreReceipt,
} from "./cms-site-restore-receipt";
import {
	CmsRestoreFenceUnavailableError,
	cmsRestoreFenceResponse,
	type CmsRestoreFenceIdentity,
	withCmsRestorePermit,
	withCmsRestoreResponsePermit,
} from "./tenant-restore-fence";
import type {
	CollectionDeletionGuardInput,
	CollectionDeletionGuardResult,
} from "emdash";

interface CmsSiteDrillDigestProof extends CmsSiteDrillProof {
	databaseDigest: string;
	schedulerHeartbeatValue: string | null;
	schedulerHeartbeatRevision: string | null;
}

function canonicalSqlValue(value: unknown): [string, string | number | null] {
	if (value === null) return ["null", null];
	if (typeof value === "string") return ["text", value];
	if (typeof value === "number" && Number.isFinite(value))
		return ["number", value];
	if (value instanceof ArrayBuffer)
		return [
			"blob",
			Array.from(new Uint8Array(value), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join(""),
		];
	if (ArrayBuffer.isView(value))
		return [
			"blob",
			Array.from(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join(""),
		];
	throw new Error(
		"CMS site restore drill encountered unsupported SQLite value",
	);
}

function quoteSqlIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/** Synchronous DO SQLite reads form one event-loop snapshot. Include every
 * stored table and schema object except the drill's own mutation sentinel. */
export function digestCmsSiteSqlite(sql: DurableObjectStorage["sql"]): string {
	const schema = sql
		.exec<{
			type: string;
			name: string;
			tbl_name: string;
			sql: string | null;
		}>(
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name <> '_tedix_cms_restore_drill' AND tbl_name <> '_tedix_cms_restore_drill' ORDER BY type, name",
		)
		.toArray();
	const hash = createHash("sha256");
	hash.update(JSON.stringify(["cms-site-sqlite-v1", schema]));
	for (const table of schema.filter((item) => item.type === "table")) {
		const rows = sql
			.exec<Record<string, string | number | null | ArrayBuffer>>(
				`SELECT * FROM ${quoteSqlIdentifier(table.name)}`,
			)
			.toArray()
			.map((row) =>
				JSON.stringify(
					Object.keys(row)
						.sort()
						.map((column) => [column, canonicalSqlValue(row[column])]),
				),
			)
			.sort();
		hash.update(JSON.stringify([table.name, rows]));
	}
	return hash.digest("hex");
}

/** The customer capture includes every SQLite schema object and row. Bound the
 * synchronous work so a large database fails closed before the DO's 30s
 * blockConcurrencyWhile deadline or memory limit. */
export function digestCmsRecoverySqlite(
	sql: DurableObjectStorage["sql"],
): string {
	const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
	const MAX_DIGEST_BYTES = 16 * 1024 * 1024;
	const MAX_SCHEMA_OBJECTS = 512;
	const MAX_ROWS = 20_000;
	const MAX_DIGEST_MS = 20_000;
	if (
		!Number.isFinite(sql.databaseSize) ||
		sql.databaseSize > MAX_DATABASE_BYTES
	)
		throw new Error("CMS recovery database exceeds digest size limit");
	const started = Date.now();
	let bytes = 0;
	let rowsSeen = 0;
	const charge = (value: string) => {
		bytes += new TextEncoder().encode(value).byteLength;
		if (bytes > MAX_DIGEST_BYTES || Date.now() - started > MAX_DIGEST_MS)
			throw new Error("CMS recovery database exceeds digest work limit");
	};
	const schema: Array<{
		type: string;
		name: string;
		tbl_name: string;
		sql: string | null;
	}> = [];
	for (const item of sql.exec<{
		type: string;
		name: string;
		tbl_name: string;
		sql: string | null;
	}>(
		"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
	)) {
		if (schema.length >= MAX_SCHEMA_OBJECTS)
			throw new Error("CMS recovery database exceeds schema digest limit");
		charge(JSON.stringify(item));
		schema.push(item);
	}
	const hash = createHash("sha256");
	const schemaValue = JSON.stringify([CMS_RECOVERY_DIGEST_ALGORITHM, schema]);
	charge(schemaValue);
	hash.update(schemaValue);
	for (const table of schema.filter((item) => item.type === "table")) {
		const rows: string[] = [];
		for (const row of sql.exec<
			Record<string, string | number | null | ArrayBuffer>
		>(`SELECT * FROM ${quoteSqlIdentifier(table.name)}`)) {
			if (++rowsSeen > MAX_ROWS)
				throw new Error("CMS recovery database exceeds row digest limit");
			for (const value of Object.values(row)) {
				const blobBytes =
					value instanceof ArrayBuffer
						? value.byteLength
						: ArrayBuffer.isView(value)
							? value.byteLength
							: 0;
				// Hex encoding doubles a blob before JSON and sorting allocate more.
				if (blobBytes * 2 > MAX_DIGEST_BYTES - bytes)
					throw new Error("CMS recovery database exceeds digest work limit");
			}
			const encoded = JSON.stringify(
				Object.keys(row)
					.sort()
					.map((column) => [column, canonicalSqlValue(row[column])]),
			);
			charge(encoded);
			rows.push(encoded);
		}
		rows.sort();
		const tableValue = JSON.stringify([table.name, rows]);
		charge(tableValue);
		hash.update(tableValue);
	}
	if (Date.now() - started > MAX_DIGEST_MS)
		throw new Error("CMS recovery database exceeds digest time limit");
	return hash.digest("hex");
}

/** Tenant data is the whole slug-named object. Delete its storage atomically
 * through the platform API; dropping tables individually violates foreign keys. */
export class EmDashDB extends EmdashSqlDB {
	private siteDrillEnv(): Pick<
		Env,
		"DB_DO" | "RECOVERY_STORAGE" | "PLATFORM_DB" | "TENANT_BUNDLES"
	> {
		return this.env as unknown as Pick<
			Env,
			"DB_DO" | "RECOVERY_STORAGE" | "PLATFORM_DB" | "TENANT_BUNDLES"
		>;
	}

	private assertSiteDrillObject(): void {
		if (
			this.ctx.id.toString() !==
			this.siteDrillEnv().DB_DO.idFromName(CMS_SITE_DRILL_SLUG).toString()
		)
			throw new Error("CMS site restore drill object identity mismatch");
	}

	private siteDrillPrimary():
		| Pick<
				EmDashDB,
				| "readSiteDrillProof"
				| "prepareSiteDrillMutation"
				| "scheduleSiteDrillRestore"
				| "restartSiteDrill"
				| "scheduleSiteDrillUndo"
				| "scheduleSiteDrillFinalRestore"
		  >
		| undefined {
		return (this.ctx.storage as DurableObjectStorage & { primary?: EmDashDB })
			.primary;
	}

	private siteDrillSentinel(): "absent" | "after" {
		const found = this.ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_tedix_cms_restore_drill'",
			)
			.toArray();
		if (!found.length) return "absent";
		const row = this.ctx.storage.sql
			.exec<{ state: string }>(
				"SELECT state FROM _tedix_cms_restore_drill WHERE id = 1",
			)
			.toArray()[0];
		if (row?.state !== "after")
			throw new Error("CMS site restore drill sentinel invalid");
		return "after";
	}

	/** Fixed-site SQL proof; every RPC checks the actual Durable Object id. */
	async readSiteDrillProof(): Promise<CmsSiteDrillDigestProof> {
		this.assertSiteDrillObject();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.readSiteDrillProof();
		const posts = this.ctx.storage.sql
			.exec<{ id: string; slug: string; status: string }>(
				"SELECT id, slug, status FROM ec_posts ORDER BY id",
			)
			.toArray();
		const post = posts.filter(
			(row) =>
				row.slug === "native-taxonomy-archive-proof" &&
				row.status === "published",
		);
		if (post.length !== 1 || !post[0]?.id)
			throw new Error("CMS site restore drill native post unavailable");
		const mediaKeys = this.ctx.storage.sql
			.exec<{ storage_key: string }>(
				"SELECT storage_key FROM media ORDER BY storage_key",
			)
			.toArray()
			.map((row) => row.storage_key);
		const heartbeat = this.ctx.storage.sql
			.exec<{ value: string; revision: string | null }>(
				"SELECT value, revision FROM options WHERE name = ?",
				"system:scheduler:last_completed_at",
			)
			.toArray()[0];
		const heartbeatValue = heartbeat
			? (JSON.parse(heartbeat.value) as unknown)
			: null;
		if (heartbeatValue !== null && typeof heartbeatValue !== "string")
			throw new Error("CMS site restore drill scheduler heartbeat invalid");
		const databaseDigest = digestCmsSiteSqlite(this.ctx.storage.sql);
		return {
			bookmark: await this.ctx.storage.getCurrentBookmark(),
			sentinel: this.siteDrillSentinel(),
			post: post[0],
			postDigest: createHash("sha256")
				.update(JSON.stringify(posts))
				.digest("hex"),
			mediaKeys,
			databaseDigest,
			schedulerHeartbeatValue: heartbeatValue,
			schedulerHeartbeatRevision: heartbeat?.revision ?? null,
		};
	}

	async prepareSiteDrillMutation(): Promise<void> {
		this.assertSiteDrillObject();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.prepareSiteDrillMutation();
		const env = this.siteDrillEnv();
		const receipt = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
		if (receipt?.phase === "mutated" || receipt?.phase === "media-deleted")
			return;
		if (receipt?.phase !== "claimed")
			throw new Error("CMS site restore drill not claimed");
		const { manifest, records } = await readSiteDrillCapture(
			env.RECOVERY_STORAGE,
		);
		const authority = await readRecoveryAuthority(
			env as Env,
			CMS_SITE_DRILL_SLUG,
		);
		if (
			authority?.siteId !== CMS_SITE_DRILL_SITE_ID ||
			authority.bundle.version !== manifest.bundle.version ||
			authority.bundle.etag !== manifest.bundle.etag ||
			!records.some(
				(record) =>
					record.key === receipt.mediaKey &&
					record.sha256 === receipt.mediaSha256,
			)
		)
			throw new Error("CMS site restore drill capture authority changed");
		const proof = await this.readSiteDrillProof();
		if (
			proof.post.id !== receipt.postId ||
			proof.post.status !== receipt.postStatus ||
			proof.postDigest !== receipt.postDigest ||
			!proof.mediaKeys.includes(receipt.mediaKey)
		)
			throw new Error(
				"CMS site restore drill database changed before mutation",
			);
		if (proof.sentinel === "after") {
			// The prior R2 receipt write may have failed after the exact SQL
			// sentinel committed. This reserved table identifies that partial step.
			await writeSiteDrillReceipt(env.RECOVERY_STORAGE, {
				...receipt,
				phase: "mutated",
			});
			return;
		}
		// Bookmark values identify provider history, not SQLite content. The
		// full digest is synchronous with the sentinel insert, so a concurrent
		// request cannot write between this final comparison and the mutation.
		if (digestCmsSiteSqlite(this.ctx.storage.sql) !== receipt.databaseDigest)
			throw new Error("CMS site restore drill database drifted from capture");
		insertSiteDrillSentinel(this.ctx.storage);
		await writeSiteDrillReceipt(env.RECOVERY_STORAGE, {
			...receipt,
			phase: "mutated",
		});
	}

	async scheduleSiteDrillRestore(): Promise<void> {
		this.assertSiteDrillObject();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.scheduleSiteDrillRestore();
		const env = this.siteDrillEnv();
		const receipt = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
		if (receipt?.phase === "restore-scheduled") return;
		if (receipt?.phase !== "media-deleted")
			throw new Error("CMS site restore drill media deletion not verified");
		if (this.siteDrillSentinel() !== "after")
			throw new Error("CMS site restore drill sentinel mutation unavailable");
		const { manifest } = await readSiteDrillCapture(env.RECOVERY_STORAGE);
		const undoBookmark = await this.ctx.storage.onNextSessionRestoreBookmark(
			manifest.bookmark,
		);
		await writeSiteDrillReceipt(env.RECOVERY_STORAGE, {
			...receipt,
			phase: "restore-scheduled",
			undoBookmark,
		});
	}

	async restartSiteDrill(): Promise<void> {
		this.assertSiteDrillObject();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.restartSiteDrill();
		const receipt = await readSiteDrillReceipt(
			this.siteDrillEnv().RECOVERY_STORAGE,
		);
		if (!receipt) throw new Error("CMS site restore drill receipt missing");
		const sentinel = this.siteDrillSentinel();
		if (
			(receipt.phase === "restore-scheduled" && sentinel === "after") ||
			(receipt.phase === "undo-scheduled" && sentinel === "absent") ||
			(receipt.phase === "final-scheduled" && sentinel === "after")
		)
			this.ctx.abort();
	}

	async scheduleSiteDrillUndo(): Promise<void> {
		this.assertSiteDrillObject();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.scheduleSiteDrillUndo();
		const env = this.siteDrillEnv();
		const receipt = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
		if (receipt?.phase === "undo-scheduled") return;
		if (receipt?.phase !== "restored" || !receipt.undoBookmark)
			throw new Error("CMS site restore drill undo unavailable");
		if (this.siteDrillSentinel() !== "absent")
			throw new Error("CMS site restore drill restore not observed");
		const redoBookmark = await this.ctx.storage.onNextSessionRestoreBookmark(
			receipt.undoBookmark,
		);
		await writeSiteDrillReceipt(env.RECOVERY_STORAGE, {
			...receipt,
			phase: "undo-scheduled",
			redoBookmark,
		});
	}

	async scheduleSiteDrillFinalRestore(): Promise<void> {
		this.assertSiteDrillObject();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.scheduleSiteDrillFinalRestore();
		const env = this.siteDrillEnv();
		const receipt = await readSiteDrillReceipt(env.RECOVERY_STORAGE);
		if (receipt?.phase === "final-scheduled") return;
		if (receipt?.phase !== "undone" || !receipt.redoBookmark)
			throw new Error("CMS site restore drill final restore unavailable");
		if (this.siteDrillSentinel() !== "after")
			throw new Error("CMS site restore drill undo not observed");
		const { manifest } = await readSiteDrillCapture(env.RECOVERY_STORAGE);
		const finalUndoBookmark =
			await this.ctx.storage.onNextSessionRestoreBookmark(manifest.bookmark);
		await writeSiteDrillReceipt(env.RECOVERY_STORAGE, {
			...receipt,
			phase: "final-scheduled",
			finalUndoBookmark,
		});
	}

	private pitrSelfTestEnv(): Pick<Env, "DB_DO" | "RECOVERY_STORAGE"> {
		return this.env as unknown as Pick<Env, "DB_DO" | "RECOVERY_STORAGE">;
	}

	private assertPitrSelfTestObject(): void {
		if (
			this.ctx.id.toString() !==
			this.pitrSelfTestEnv()
				.DB_DO.idFromName(CMS_PITR_SELF_TEST_DO_NAME)
				.toString()
		)
			throw new Error("CMS PITR self-test object identity mismatch");
	}

	private pitrSelfTestPrimary():
		| Pick<
				EmDashDB,
				| "preparePitrSelfTest"
				| "restartPitrSelfTest"
				| "readPitrSelfTestState"
				| "readPitrSelfTestReceiptState"
				| "schedulePitrSelfTestUndo"
				| "completePitrSelfTest"
		  >
		| undefined {
		return (this.ctx.storage as DurableObjectStorage & { primary?: EmDashDB })
			.primary;
	}

	private async pitrSelfTestReceipt(): Promise<CmsPitrSelfTestReceipt | null> {
		const object = await this.pitrSelfTestEnv().RECOVERY_STORAGE.get(
			CMS_PITR_SELF_TEST_RECEIPT_KEY,
		);
		if (!object) return null;
		const value = (await object.json()) as Record<string, unknown>;
		if (
			value.version !== 1 ||
			![
				"preparing",
				"restore-scheduled",
				"undo-scheduled",
				"verified",
			].includes(String(value.state)) ||
			(value.state !== "verified" &&
				value.state !== "preparing" &&
				(typeof value.undoBookmark !== "string" || !value.undoBookmark)) ||
			(value.state === "undo-scheduled" &&
				(typeof value.redoBookmark !== "string" || !value.redoBookmark))
		)
			throw new Error("CMS PITR self-test receipt invalid");
		return value as CmsPitrSelfTestReceipt;
	}

	private pitrSelfTestState(): "missing" | "before" | "after" {
		const table = this.ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_tedix_pitr_self_test'",
			)
			.toArray();
		if (!table.length) return "missing";
		const rows = this.ctx.storage.sql
			.exec<{ state: string }>(
				"SELECT state FROM _tedix_pitr_self_test WHERE id = 1",
			)
			.toArray();
		const state = rows[0]?.state;
		if (state === "before" || state === "after") return state;
		throw new Error("CMS PITR self-test marker invalid");
	}

	/** No caller-supplied site or bookmark; this RPC is fenced to one invalid-slug DO. */
	async preparePitrSelfTest(): Promise<void> {
		this.assertPitrSelfTestObject();
		const primary = this.pitrSelfTestPrimary();
		if (primary) return primary.preparePitrSelfTest();
		const receipt = await this.pitrSelfTestReceipt();
		if (receipt?.state === "preparing")
			throw new Error(
				"CMS PITR self-test preparation needs operator reconciliation",
			);
		if (receipt) return;
		const claim = await this.pitrSelfTestEnv().RECOVERY_STORAGE.put(
			CMS_PITR_SELF_TEST_RECEIPT_KEY,
			JSON.stringify({ version: 1, state: "preparing" }),
			{
				httpMetadata: { contentType: "application/json" },
				onlyIf: new Headers({ "If-None-Match": "*" }),
			},
		);
		if (!claim) throw new Error("CMS PITR self-test already claimed");
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS _tedix_pitr_self_test (id INTEGER PRIMARY KEY, state TEXT NOT NULL)",
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO _tedix_pitr_self_test (id, state) VALUES (1, 'before') ON CONFLICT(id) DO UPDATE SET state = 'before'",
		);
		const bookmark = await this.ctx.storage.getCurrentBookmark();
		this.ctx.storage.sql.exec(
			"UPDATE _tedix_pitr_self_test SET state = 'after' WHERE id = 1",
		);
		const undoBookmark =
			await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
		// A failed receipt write leaves only the reserved object affected. Never
		// abort without the provider-issued undo point held outside its database.
		await this.pitrSelfTestEnv().RECOVERY_STORAGE.put(
			CMS_PITR_SELF_TEST_RECEIPT_KEY,
			JSON.stringify({ version: 1, state: "restore-scheduled", undoBookmark }),
			{ httpMetadata: { contentType: "application/json" } },
		);
	}

	/** The expected RPC disconnect is followed by a fresh-stub read in the Workflow. */
	async restartPitrSelfTest(): Promise<void> {
		this.assertPitrSelfTestObject();
		const primary = this.pitrSelfTestPrimary();
		if (primary) return primary.restartPitrSelfTest();
		const receipt = await this.pitrSelfTestReceipt();
		if (!receipt) throw new Error("CMS PITR self-test receipt missing");
		const state = this.pitrSelfTestState();
		if (
			(receipt.state === "restore-scheduled" && state === "after") ||
			(receipt.state === "undo-scheduled" && state === "before")
		)
			this.ctx.abort();
	}

	async readPitrSelfTestState(): Promise<"missing" | "before" | "after"> {
		this.assertPitrSelfTestObject();
		const primary = this.pitrSelfTestPrimary();
		return primary ? primary.readPitrSelfTestState() : this.pitrSelfTestState();
	}

	async readPitrSelfTestReceiptState(): Promise<
		"missing" | CmsPitrSelfTestReceipt["state"]
	> {
		this.assertPitrSelfTestObject();
		const primary = this.pitrSelfTestPrimary();
		if (primary) return primary.readPitrSelfTestReceiptState();
		return (await this.pitrSelfTestReceipt())?.state ?? "missing";
	}

	async schedulePitrSelfTestUndo(): Promise<void> {
		this.assertPitrSelfTestObject();
		const primary = this.pitrSelfTestPrimary();
		if (primary) return primary.schedulePitrSelfTestUndo();
		const receipt = await this.pitrSelfTestReceipt();
		if (
			!receipt ||
			receipt.state === "verified" ||
			receipt.state === "preparing"
		)
			throw new Error("CMS PITR self-test undo receipt unavailable");
		if (receipt.state === "undo-scheduled") return;
		if (this.pitrSelfTestState() !== "before")
			throw new Error("CMS PITR self-test restore not observed");
		const redoBookmark = await this.ctx.storage.onNextSessionRestoreBookmark(
			receipt.undoBookmark,
		);
		await this.pitrSelfTestEnv().RECOVERY_STORAGE.put(
			CMS_PITR_SELF_TEST_RECEIPT_KEY,
			JSON.stringify({ ...receipt, state: "undo-scheduled", redoBookmark }),
			{ httpMetadata: { contentType: "application/json" } },
		);
	}

	async completePitrSelfTest(): Promise<void> {
		this.assertPitrSelfTestObject();
		const primary = this.pitrSelfTestPrimary();
		if (primary) return primary.completePitrSelfTest();
		const receipt = await this.pitrSelfTestReceipt();
		if (receipt?.state === "verified") return;
		if (
			receipt?.state !== "undo-scheduled" ||
			this.pitrSelfTestState() !== "after"
		)
			throw new Error("CMS PITR self-test undo not observed");
		await this.pitrSelfTestEnv().RECOVERY_STORAGE.put(
			CMS_PITR_SELF_TEST_RECEIPT_KEY,
			JSON.stringify({ version: 1, state: "verified" }),
			{ httpMetadata: { contentType: "application/json" } },
		);
	}

	override async query(
		...args: Parameters<EmdashSqlDB["query"]>
	): ReturnType<EmdashSqlDB["query"]> {
		try {
			return await super.query(...args);
		} catch (error) {
			if (
				/(?:_emdash_fields|_emdash_block_types|_emdash_block_type_versions|_emdash_media_usage_[a-z_]+|ec_pages)/.test(
					args[0],
				)
			) {
				console.error("[cms-do] CMS schema query failed:", error);
			}
			throw error;
		}
	}

	async deleteTenantData(): Promise<void> {
		const primary = (
			this.ctx.storage as DurableObjectStorage & {
				primary?: { deleteTenantData(): Promise<void> };
			}
		).primary;
		if (primary) return primary.deleteTenantData();
		await this.ctx.storage.deleteAll();
	}

	/** Capture a PITR bookmark from the primary after proving CMS tables exist. */
	async captureRecoveryBookmark(): Promise<string | null> {
		const storage = this.ctx.storage as DurableObjectStorage & {
			primary?: { captureRecoveryBookmark(): Promise<string | null> };
		};
		if (storage.primary) return storage.primary.captureRecoveryBookmark();
		const present = storage.sql.exec(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'ec_%' OR name IN ('revisions', 'taxonomies', 'content_taxonomies', 'media', 'users', 'options')) LIMIT 1",
		);
		if (!present.toArray().length) return null;
		const bookmark = await storage.getCurrentBookmark();
		if (!bookmark) throw new Error("CMS recovery bookmark unavailable");
		return bookmark;
	}

	/** A primary-only SQLite/PITR pair. No tenant isolate receives this RPC. */
	async captureRecoverySnapshot(): Promise<{
		bookmark: string;
		databaseDigest: string;
	} | null> {
		const storage = this.ctx.storage as DurableObjectStorage & {
			primary?: {
				captureRecoverySnapshot(): Promise<{
					bookmark: string;
					databaseDigest: string;
				} | null>;
			};
		};
		if (storage.primary) return storage.primary.captureRecoverySnapshot();
		const result = await this.ctx.blockConcurrencyWhile(async () => {
			try {
				const present = storage.sql.exec(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'ec_%' OR name IN ('revisions', 'taxonomies', 'content_taxonomies', 'media', 'users', 'options')) LIMIT 1",
				);
				if (!present.toArray().length)
					return { ok: true as const, snapshot: null };
				const databaseDigest = digestCmsRecoverySqlite(storage.sql);
				let timeout: ReturnType<typeof setTimeout> | undefined;
				let bookmark: string;
				try {
					bookmark = await Promise.race([
						storage.getCurrentBookmark(),
						new Promise<never>((_resolve, reject) => {
							timeout = setTimeout(
								() => reject(new Error("CMS recovery bookmark timed out")),
								5_000,
							);
						}),
					]);
				} finally {
					if (timeout) clearTimeout(timeout);
				}
				if (!bookmark) throw new Error("CMS recovery bookmark unavailable");
				return {
					ok: true as const,
					snapshot: { bookmark, databaseDigest },
				};
			} catch (error) {
				// Throwing inside blockConcurrencyWhile resets the Durable Object.
				return { ok: false as const, error };
			}
		});
		if (!result.ok) throw result.error;
		return result.snapshot;
	}

	private cmsSiteRestorePrimary():
		| Pick<EmDashDB, "scheduleCmsSiteRestore" | "restartCmsSiteRestore">
		| undefined {
		return (this.ctx.storage as DurableObjectStorage & { primary?: EmDashDB })
			.primary;
	}

	private assertCmsSiteRestoreObject(identity: CmsSiteRestoreIdentity): void {
		const env = this.env as unknown as Pick<Env, "DB_DO">;
		if (
			this.ctx.id.toString() !== env.DB_DO.idFromName(identity.slug).toString()
		)
			throw new Error("CMS restore Durable Object identity mismatch");
	}

	/** A one-shot provider schedule: an unacknowledged intent is never retried. */
	async scheduleCmsSiteRestore(
		input: CmsSiteRestoreIdentity & {
			bookmark: string;
			expectedDatabaseDigest: string;
			direction: "target" | "undo";
		},
	): Promise<{ undoBookmark: string }> {
		this.assertCmsSiteRestoreObject(input);
		const primary = this.cmsSiteRestorePrimary();
		if (primary) return primary.scheduleCmsSiteRestore(input);
		const env = this.env as unknown as Pick<
			Env,
			"PLATFORM_DB" | "RECOVERY_STORAGE" | "TENANT_BUNDLES"
		>;
		const db = createDbClient(env.PLATFORM_DB);
		const [fence, permits, receipt, authority] = await Promise.all([
			getCmsRestoreFenceState(db, input),
			countCmsRestorePermitsForSite(db, input.siteId),
			readCmsSiteRestoreReceipt(env.RECOVERY_STORAGE, input),
			readRecoveryAuthority(env as Env, input.slug),
		]);
		if (
			fence.fence?.generation !== input.generation ||
			fence.fence.captureId !== input.captureId ||
			permits !== 0 ||
			!receipt ||
			receipt.receipt.phase !==
				(input.direction === "target"
					? "target-schedule-intent"
					: "undo-schedule-intent") ||
			(input.direction === "undo" && receipt.receipt.mode !== "roundtrip") ||
			!receipt.receipt.undoCaptureId ||
			authority?.siteId !== input.siteId ||
			authority.bundle.version !== receipt.receipt.bundle.version ||
			authority.bundle.etag !== receipt.receipt.bundle.etag
		)
			throw new Error("CMS restore schedule authority changed");
		const sourceCaptureId =
			input.direction === "target"
				? input.captureId
				: receipt.receipt.undoCaptureId;
		const captureIdentity = { ...input, captureId: sourceCaptureId };
		const [controlObject, manifestObject] = await Promise.all([
			env.RECOVERY_STORAGE.get(
				`${cmsRecoveryPrefix(input.siteId, sourceCaptureId)}control.json`,
			),
			env.RECOVERY_STORAGE.get(
				`${cmsRecoveryPrefix(input.siteId, sourceCaptureId)}manifest.json`,
			),
		]);
		const control = controlObject ? await controlObject.json() : null;
		const manifest = manifestObject ? await manifestObject.json() : null;
		if (
			!isCmsRecoveryControl(control, captureIdentity) ||
			control.state !== "verified" ||
			!isCmsRecoveryManifest(manifest, captureIdentity) ||
			manifest.version !== 2 ||
			Date.now() >= Date.parse(manifest.retainUntil) ||
			(input.direction === "target"
				? manifest.bookmark !== input.bookmark
				: receipt.receipt.undoBookmark !== input.bookmark) ||
			manifest.bundle.version !== receipt.receipt.bundle.version ||
			manifest.bundle.etag !== receipt.receipt.bundle.etag
		)
			throw new Error("CMS restore schedule capture changed");
		const expectedCurrentDigest =
			input.direction === "target"
				? await (async () => {
						const undo = await env.RECOVERY_STORAGE.get(
							`${cmsRecoveryPrefix(input.siteId, receipt.receipt.undoCaptureId!)}manifest.json`,
						);
						const value = undo ? await undo.json() : null;
						const undoIdentity = {
							...input,
							captureId: receipt.receipt.undoCaptureId!,
						};
						if (
							!isCmsRecoveryManifest(value, undoIdentity) ||
							value.version !== 2
						)
							throw new Error("CMS restore undo capture unavailable");
						return value.databaseDigest;
					})()
				: receipt.receipt.databaseDigest;
		if (
			!expectedCurrentDigest ||
			input.expectedDatabaseDigest !== expectedCurrentDigest
		)
			throw new Error("CMS restore current digest unavailable");
		const result = await this.ctx.blockConcurrencyWhile(async () => {
			try {
				if (
					digestCmsRecoverySqlite(this.ctx.storage.sql) !==
					expectedCurrentDigest
				)
					throw new Error("CMS restore current database changed");
				const undoBookmark =
					await this.ctx.storage.onNextSessionRestoreBookmark(input.bookmark);
				return { ok: true as const, undoBookmark };
			} catch (error) {
				return { ok: false as const, error };
			}
		});
		if (!result.ok) throw result.error;
		if (!result.undoBookmark)
			throw new Error("CMS restore schedule acknowledgement unavailable");
		return { undoBookmark: result.undoBookmark };
	}

	/** Abort the old session only after the schedule acknowledgement is durable. */
	async restartCmsSiteRestore(
		input: CmsSiteRestoreIdentity & { direction: "target" | "undo" },
	): Promise<void> {
		this.assertCmsSiteRestoreObject(input);
		const primary = this.cmsSiteRestorePrimary();
		if (primary) return primary.restartCmsSiteRestore(input);
		const env = this.env as unknown as Pick<
			Env,
			"PLATFORM_DB" | "RECOVERY_STORAGE"
		>;
		const [state, receipt] = await Promise.all([
			getCmsRestoreFenceState(createDbClient(env.PLATFORM_DB), input),
			readCmsSiteRestoreReceipt(env.RECOVERY_STORAGE, input),
		]);
		if (
			state.fence?.generation !== input.generation ||
			state.fence.captureId !== input.captureId ||
			receipt?.receipt.phase !==
				(input.direction === "target"
					? "target-scheduled"
					: "undo-scheduled") ||
			!receipt.receipt.undoBookmark ||
			(input.direction === "undo" && !receipt.receipt.redoBookmark)
		)
			throw new Error("CMS restore restart authority changed");
		this.ctx.abort();
	}
}
export { CmsOutboundProxy } from "./outbound-proxy";
export { CmsRecoveryWorkflow } from "./cms-recovery-workflow";
export { CmsPitrSelfTestWorkflow } from "./cms-pitr-self-test-workflow";
export { CmsSiteRestoreDrillWorkflow } from "./cms-site-restore-drill-workflow";
export { CmsSiteRestoreWorkflow } from "./cms-site-restore-workflow";
export { TenantAiSearch } from "./tenant-ai-search";
export {
	TenantPluginHost,
	TenantPluginKvBridge,
} from "./tenant-plugin-executor";

import {
	CmsMediaBucketCreateOutcomeUnknownError,
	deleteCmsMediaBucket,
	inspectCmsMediaBucket,
	listTenantBundleVersions,
	provisionCmsMediaBucket,
} from "@tedix/provisioning/cms";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import { getCmsDeprovisionOperation } from "@tedix/db/queries/cms-deprovision-operations";
import {
	abortCmsCaptureCronPause,
	enterCmsRecoveryPurgePermit,
	enterCmsProvisioningPermit,
	enterCmsRestorePermit,
	countCmsRestorePermitsForSite,
	getCmsRestoreEpoch,
	getCmsRestoreFenceState,
	leaveCmsRestorePermit,
} from "@tedix/db/queries/cms-restore-fences";
import {
	getCmsSiteByActiveWwwAlias,
	getCmsSiteByHostname,
	getCmsSiteBySlug,
} from "@tedix/db/queries/cms-sites";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
	resolveSurfaceTenant,
} from "@tedix/tenant-directory";
import {
	getActiveTenantBundle,
	listActiveTenantBundles,
} from "@tedix/db/queries/tenant-bundles";
import type { TenantBundle } from "@tedix/db/schema/tenant-bundles";
import {
	MUTABLE_MEDIA_CACHE_CONTROL,
	type ImageTransformFormat,
	matchInternalMediaKey,
	parseTransformParams,
	resolveTransformQuality,
} from "emdash/media/image-endpoint";
import {
	applyContentSignal,
	applyEdgeCacheHeaders,
} from "./edge-cache-headers";
import { withCmsAgentDiscoveryLinks } from "./agent-discovery";
import type { TenantAiSearchNamespace } from "./tenant-ai-search";
import { tenantAiSearchInstanceId } from "./tenant-ai-search-policy";
import { deriveTenantEmdashEncryptionKeys } from "./tenant-emdash-encryption";
import {
	resolveTenantPlatformApiUrl,
	tenantRuntimeCacheKey,
} from "./tenant-cache-key";
import {
	fetchWithTenantLoaderRecovery,
	TenantLoaderRecovery,
} from "./tenant-loader-recovery";
import {
	deriveTenantInternalAuthToken,
	rewriteTenantInternalAuthHeader,
} from "./tenant-internal-auth";
import {
	deriveTenantHumanAuthKey,
	forwardCmsHumanAssertion,
	hasAttestedCmsHumanIdentity,
} from "./tenant-human-auth";
import { protectLeadFormIp } from "./lead-ip-hash";
import {
	CMS_RECOVERY_DIGEST_ALGORITHM,
	cmsRecoveryControlKey,
	cmsRecoveryPrefix,
	isCmsRecoveryControl,
	isCmsRecoveryManifest,
	putCmsRecoveryControl,
	purgeCmsRecoveryObjects,
	readRecoveryAuthority,
	readVerifiedCmsRecoveryCapture,
	type CmsRecoveryControl,
	type CmsRecoveryManifest,
} from "./cms-recovery-workflow";
import {
	cmsAuthRejectionCodes,
	diagnoseCmsProductSession,
	diagnoseCmsTenantRejection,
	handleCmsSessionBroker,
	type CmsSessionBrokerEnv,
	withCmsProductSession,
} from "./session-broker";
import {
	ensureWebMcpBridge,
	handleWebMcpRequest,
	normalizeWebMcpToolPacks,
	type WebMcpToolPack,
} from "./webmcp";

// The bindings this Worker uses, declared explicitly. `cloudflare.config.ts`
// is their source of truth.
export interface Env extends CmsSessionBrokerEnv, MarketingEnv {
	LOADER: WorkerLoader;
	DB_DO: DurableObjectNamespace;
	TENANT_BUNDLES: R2Bucket;
	RECOVERY_STORAGE: R2Bucket;
	CMS_RECOVERY_WORKFLOW: Workflow<
		import("./cms-recovery-workflow").CmsRecoveryParams
	>;
	CMS_SITE_RESTORE_WORKFLOW: Workflow<
		import("./cms-site-restore-workflow").CmsSiteRestoreParams
	>;
	PLATFORM_DB: D1Database;
	SESSION: KVNamespace;
	AI_SEARCH: TenantAiSearchNamespace;
	WEBMCP_RATE_LIMITER: RateLimit;
	/**
	 * Native Cloudflare Images binding — parent-Worker-only. Never forwarded
	 * into a Worker Loader-dispatched tenant isolate (native bindings can't be
	 * passed directly, same class of gap as R2/D1/KV); used exclusively to
	 * serve Emdash's /_image transform requests intercepted before dispatch.
	 * See imageTransformResponse() below.
	 */
	IMAGES: ImagesBinding;
	ENVIRONMENT: string;
	GIT_SHA: string;
	CF_ACCOUNT_ID: string;
	CLOUDFLARE_R2_API_TOKEN: string;
	/** Optional override for the platform API URL injected into tenant isolates. */
	PLATFORM_API_URL?: string;
	/** Descope project ID — forwarded to tenant isolates for CMS admin auth. Set via CF secret. */
	DESCOPE_PROJECT_ID?: string;
	/** Descope session issuer/JWKS base forwarded to tenant isolates. */
	DESCOPE_BASE_URL?: string;
	/** Shared secret accepted by tenant auth for Studio service-binding CMS API calls. */
	CMS_INTERNAL_AUTH_TOKEN?: string;
	EMDASH_ENCRYPTION_KEY?: string;
	/** Parent-only HMAC key for tenant-scoped lead IP pseudonyms. */
	LEAD_FORM_IP_HASH_HMAC_KEY?: string;
}

// ── Drizzle client (per-isolate; D1 binding rebound per request) ──

let cachedDb: DbClient | null = null;
let cachedDbBinding: D1Database | null = null;
function getDb(d1: D1Database): DbClient {
	if (cachedDbBinding !== d1 || !cachedDb) {
		cachedDb = createDbClient(d1);
		cachedDbBinding = d1;
	}
	return cachedDb;
}

// ── Hostname → slug ───────────────────────────────────────────────

/** Grammar, environment domains, and slug rules come from tenant-directory. */
function extractSlug(hostname: string, environment: string): string | null {
	const resolved = resolveSurfaceTenant(hostname, {
		platformDomain: platformDomainForEnvironment(environment),
		expectedSurface: "cms",
	});
	return resolved.kind === "tenant" ? resolved.slug : null;
}

async function resolveSlug(
	env: Env,
	hostname: string,
): Promise<{ slug: string; customDomain: boolean } | null> {
	if (env.MARKETING_SITE_SLUG && isMarketingHost(hostname, env))
		return { slug: env.MARKETING_SITE_SLUG, customDomain: false };
	const slug = extractSlug(hostname, env.ENVIRONMENT);
	if (slug) return { slug, customDomain: false };

	// Every custom-domain request reads the active mapping. A cached hit could
	// continue serving a removed hostname, or serve the previous tenant after a
	// domain transfer.
	const db = getDb(env.PLATFORM_DB);
	const site = await getCmsSiteByHostname(db, hostname);
	return site ? { slug: site.slug, customDomain: true } : null;
}

/** A companion hostname redirects public pages only; editor and service paths
 * must never gain tenant routing authority from the alias. */
function isWwwCompanionPublicPath(pathname: string): boolean {
	let path: string;
	try {
		path = decodeURIComponent(pathname).toLowerCase();
	} catch {
		return false;
	}
	if (path.startsWith("/_")) return false;
	return ![
		"/.well-known",
		"/admin",
		"/api",
		"/auth",
		"/callback",
		"/login",
		"/logout",
		"/mcp",
		"/oauth",
		"/session",
		"/signin",
		"/signup",
	].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

async function wwwCompanionRedirect(
	request: Request,
	url: URL,
	env: Env,
	knownSite?: Awaited<ReturnType<typeof getCmsSiteByActiveWwwAlias>>,
): Promise<Response | null> {
	if (
		(request.method !== "GET" && request.method !== "HEAD") ||
		!url.hostname.startsWith("www.") ||
		!isWwwCompanionPublicPath(url.pathname)
	)
		return null;
	// The query checks the active companion, site, and canonical apex in D1 on
	// every request. A removed or transferred alias must stop redirecting now.
	const site =
		knownSite === undefined
			? await getCmsSiteByActiveWwwAlias(getDb(env.PLATFORM_DB), url.hostname)
			: knownSite;
	if (!site?.customDomain) return null;
	const target = new URL(`https://${site.customDomain}`);
	target.pathname = url.pathname;
	target.search = url.search;
	return Response.redirect(target, 301);
}

// ── Org lookup (platform D1) ──────────────────────────────────────

interface OrgInfo {
	slug: string;
	siteId: string;
	templateSlug: string;
	r2BucketName: string;
	siteTitle: string;
	/**
	 * Per-org branding (logo, palette, fonts, social URLs) auto-extracted at
	 * app creation and editable in the dashboard. Serialized JSON injected
	 * into the tenant isolate; the SEO plugin + theme read it for sameAs,
	 * twitter handle, logo URL, etc. — without per-org content backfill.
	 */
	brandingJson: string | null;
	socialJson: string | null;
	/**
	 * Descope tenant used for CMS admin authentication.
	 *
	 * Defaults to the app owner's tenant, but can be overridden through
	 * metadata.blogConfig.authDescopeTenantId for customer-owned editorial access.
	 */
	descopeTenantId: string;
	/** Explicit platform-D1 marker for the immutable assertion-aware bundle. */
	humanAssertionBundleEtag: string | null;
	/** Custom public hostname (e.g. "blog.tedix.dev") used for routing lookup. */
	cmsDomain: string | null;
	/**
	 * Public origin/base URL. Collection paths are owned by native Emdash
	 * urlPattern, so reverse-proxy prefixes such as /ratgeber should be modeled
	 * on the collection, not encoded into this base URL.
	 * Falls back to the cms.tedix.dev URL when unset.
	 */
	publicSiteUrl: string;
	/**
	 * Optional public mount path used by customer reverse proxies. This is not
	 * part of Emdash siteUrl; it lets the edge adapt infrastructure URLs and
	 * prefix-stripping proxy requests while collection urlPattern remains the
	 * canonical content-routing source.
	 */
	publicPathPrefix: string | null;
	/** Read-only public WebMCP packs enabled for this tenant. */
	webMcpToolPacks: readonly WebMcpToolPack[];
	/** Per-org default locale; tenant middleware redirects root-locale paths
	 * to `/{locale}/...` when this is set to a non-default locale. */
	defaultLocale: string | null;
}

const orgCache = new Map<string, { info: OrgInfo | null; expiresAt: number }>();
const ORG_TTL_MS = 5 * 60 * 1000;
const HOT_THEME_PUBLIC_PATH = "/_tedix/theme.css";
const DATABASE_RUNTIME_ADMIN_PATH = "/_tedix/internal/database-runtime";
const DATABASE_DEPROVISION_ADMIN_PATH =
	"/_tedix/internal/database-runtime/deprovision";
const DATABASE_STORAGE_ADMIN_PATH = "/_tedix/internal/database-runtime/storage";
const DATABASE_RECOVERY_BOOKMARK_ADMIN_PATH =
	"/_tedix/internal/database-runtime/recovery-bookmark";
const CMS_RECOVERY_ADMIN_PATH =
	"/_tedix/internal/database-runtime/recovery-captures";
const CMS_SITE_RESTORE_ADMIN_PATH =
	"/_tedix/internal/database-runtime/site-restores";
const DATABASE_SCHEMA_DIAGNOSTIC_PATH =
	"/_tedix/internal/database-runtime/schema-diagnostic";
const MEDIA_BUCKET_ADMIN_PATH = "/_tedix/internal/media-bucket";
const MEDIA_BUCKET_INTENT_HEADER = "X-Tedix-CMS-Media-Intent";
const CMS_SITE_ID_HEADER = "X-Tedix-CMS-Site-Id";

function hotThemeCssKey(slug: string): string {
	return `hot-themes/${slug}/current.css`;
}

function hotThemeManifestKey(slug: string): string {
	return `hot-themes/${slug}/manifest.json`;
}

function publicHostFrom(publicSiteUrl: string): string | null {
	try {
		return new URL(publicSiteUrl).host;
	} catch {
		return null;
	}
}

function publicOriginFrom(publicSiteUrl: string): string | null {
	try {
		return new URL(publicSiteUrl).origin;
	} catch {
		return null;
	}
}

function normalizePublicPathPrefix(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed === "/") return null;
	const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	const normalized = withLeadingSlash
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
	if (normalized === "/" || normalized.includes("..")) return null;
	return normalized;
}

function publicPathPrefixFromOrg(org: OrgInfo): string | null {
	return org.publicPathPrefix;
}

function isPublicInfrastructurePath(pathname: string): boolean {
	return (
		pathname.startsWith("/_astro/") ||
		pathname.startsWith("/_emdash/") ||
		pathname.startsWith("/_tedix/") ||
		// Astro's default image-transform endpoint. Same category as /_astro/:
		// infrastructure, not user content, so it must not be prefix-rewritten
		// for reverse-proxied tenants — the parent-level interception in
		// imageTransformResponse() checks the unprefixed pathname.
		pathname === "/_image" ||
		pathname.startsWith("/api/") ||
		pathname === "/favicon.ico" ||
		pathname === "/robots.txt" ||
		pathname === "/rss.xml" ||
		pathname === "/llms.txt" ||
		pathname === "/sitemap.xml" ||
		/^\/sitemap-[^/]+\.xml$/.test(pathname)
	);
}

/**
 * Emdash (0.31.x) emits sitemap URLs without a trailing slash while every page
 * it renders declares the trailing-slash form as its canonical. Search Console
 * then reads the whole sitemap as non-canonical — blog.tedix.dev sat at 13
 * submitted / 0 indexed and reported "Page with redirect" against exactly these
 * URLs. Normalise the sitemap to the canonical form the pages advertise.
 *
 * Marketing-template CMS tenants use slashless canonical paths, except for
 * tedix-landing on tedix.dev, whose archived landing pages use trailing slashes.
 * Only extensionless paths are touched, so `/rss.xml` and asset URLs are left
 * alone, and only inside a sitemap document.
 */
export function canonicalizeSitemapUrls(
	xml: string,
	trailingSlash = true,
	nativeCanonicals = false,
): string {
	// Canonical-aware Emdash owns each entry URL, including mixed slash conventions.
	if (nativeCanonicals) return xml;
	if (!xml.includes("<urlset") && !xml.includes("<sitemapindex")) return xml;

	const withTrailingSlash = (rawUrl: string): string => {
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return rawUrl;
		}
		if (!trailingSlash) {
			url.pathname = url.pathname.replace(/\/+$/, "") || "/";
			return url.toString();
		}
		// authz: public — not a route: sitemap <loc> trailing-slash rewrite helper.
		if (url.pathname.endsWith("/")) return rawUrl;
		const lastSegment = url.pathname.split("/").pop() ?? "";
		if (lastSegment === "" || lastSegment.includes(".")) return rawUrl;
		url.pathname = `${url.pathname}/`;
		return url.toString();
	};

	return xml
		.replace(
			/<loc>([^<]+)<\/loc>/g,
			(_match, url: string) => `<loc>${withTrailingSlash(url.trim())}</loc>`,
		)
		.replace(
			/href="([^"]+)"/g,
			(_match, url: string) => `href="${withTrailingSlash(url.trim())}"`,
		);
}

/** The archived Tedix site is the one exception to marketing's slashless URLs. */
export function sitemapUsesTrailingSlash(
	site: Pick<OrgInfo, "slug" | "templateSlug" | "publicSiteUrl">,
	env: Pick<MarketingEnv, "MARKETING_DOMAINS">,
): boolean {
	const hostname = new URL(site.publicSiteUrl).hostname;
	if (site.slug === "tedix-landing" && hostname === "tedix.dev") return true;
	return site.templateSlug !== "marketing" && !isMarketingHost(hostname, env);
}

export function patchReverseProxyHtml(html: string, org: OrgInfo): string {
	const prefix = publicPathPrefixFromOrg(org);
	if (!prefix) return html;
	const publicOrigin = publicOriginFrom(org.publicSiteUrl);

	let patched = html
		.replaceAll('href="/"', `href="${prefix}/"`)
		.replaceAll("href='/'", `href='${prefix}/'`);

	for (const route of ["posts", "category", "tag"]) {
		const prefixedRoute =
			route === "posts" ? `${prefix}/` : `${prefix}/${route}/`;
		patched = patched
			.replaceAll(`href="/${route}/`, `href="${prefixedRoute}`)
			.replaceAll(`href='/${route}/`, `href='${prefixedRoute}`);
	}

	for (const file of ["rss.xml", "sitemap.xml", "llms.txt"]) {
		patched = patched
			.replaceAll(`href="/${file}`, `href="${prefix}/${file}`)
			.replaceAll(`href='/${file}`, `href='${prefix}/${file}`);
	}

	for (const assetPath of ["_astro", "_emdash/api/media", "_tedix"]) {
		patched = patched
			.replaceAll(`href="/${assetPath}/`, `href="${prefix}/${assetPath}/`)
			.replaceAll(`href='/${assetPath}/`, `href='${prefix}/${assetPath}/`)
			.replaceAll(`src="/${assetPath}/`, `src="${prefix}/${assetPath}/`)
			.replaceAll(`src='/${assetPath}/`, `src='${prefix}/${assetPath}/`)
			.replaceAll(`srcset="/${assetPath}/`, `srcset="${prefix}/${assetPath}/`)
			.replaceAll(`srcset='/${assetPath}/`, `srcset='${prefix}/${assetPath}/`)
			.replaceAll(
				`component-url="/${assetPath}/`,
				`component-url="${prefix}/${assetPath}/`,
			)
			.replaceAll(
				`component-url='/${assetPath}/`,
				`component-url='${prefix}/${assetPath}/`,
			)
			.replaceAll(
				`renderer-url="/${assetPath}/`,
				`renderer-url="${prefix}/${assetPath}/`,
			)
			.replaceAll(
				`renderer-url='/${assetPath}/`,
				`renderer-url='${prefix}/${assetPath}/`,
			)
			.replaceAll(`url("/${assetPath}/`, `url("${prefix}/${assetPath}/`)
			.replaceAll(`url('/${assetPath}/`, `url('${prefix}/${assetPath}/`);
		if (publicOrigin) {
			patched = patched
				.replaceAll(
					`${publicOrigin}/${assetPath}/`,
					`${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`href="${publicOrigin}/${assetPath}/`,
					`href="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`href='${publicOrigin}/${assetPath}/`,
					`href='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`src="${publicOrigin}/${assetPath}/`,
					`src="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`src='${publicOrigin}/${assetPath}/`,
					`src='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`srcset="${publicOrigin}/${assetPath}/`,
					`srcset="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`srcset='${publicOrigin}/${assetPath}/`,
					`srcset='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`component-url="${publicOrigin}/${assetPath}/`,
					`component-url="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`component-url='${publicOrigin}/${assetPath}/`,
					`component-url='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`renderer-url="${publicOrigin}/${assetPath}/`,
					`renderer-url="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`renderer-url='${publicOrigin}/${assetPath}/`,
					`renderer-url='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`url("${publicOrigin}/${assetPath}/`,
					`url("${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`url('${publicOrigin}/${assetPath}/`,
					`url('${publicOrigin}${prefix}/${assetPath}/`,
				);
		}
	}

	// Astro's transform endpoint has a query immediately after its route.
	// Prefix only root-relative/public-origin references; leave already-prefixed
	// links and unrelated hostnames alone.
	patched = patched
		.replaceAll('="/_image?', `="${prefix}/_image?`)
		.replaceAll("='/_image?", `='${prefix}/_image?`)
		.replaceAll(" /_image?", ` ${prefix}/_image?`);
	if (publicOrigin)
		patched = patched.replaceAll(
			`${publicOrigin}/_image?`,
			`${publicOrigin}${prefix}/_image?`,
		);

	if (publicOrigin) {
		patched = patched
			.replaceAll(
				`rel="canonical" href="${publicOrigin}"`,
				`rel="canonical" href="${publicOrigin}${prefix}/"`,
			)
			.replaceAll(
				`rel='canonical' href='${publicOrigin}'`,
				`rel='canonical' href='${publicOrigin}${prefix}/'`,
			);
		for (const file of [
			"rss.xml",
			"sitemap.xml",
			"sitemap-posts.xml",
			"llms.txt",
		]) {
			patched = patched.replaceAll(
				`${publicOrigin}/${file}`,
				`${publicOrigin}${prefix}/${file}`,
			);
		}
		patched = patched
			.replaceAll(
				`${publicOrigin}/_emdash/admin`,
				`${publicOrigin}${prefix}/_emdash/admin`,
			)
			.replaceAll(
				'parsed.pathname.startsWith("/_emdash/admin")',
				`(parsed.pathname.startsWith("/_emdash/admin") || parsed.pathname.startsWith("${prefix}/_emdash/admin"))`,
			)
			.replaceAll(
				'new URL("/_emdash/admin", window.location.origin)',
				`new URL("${prefix}/_emdash/admin", window.location.origin)`,
			);
	}

	return patched;
}

function ensureHotThemeLink(html: string): string {
	if (
		html.includes("data-tedix-hot-theme") ||
		html.includes(HOT_THEME_PUBLIC_PATH)
	) {
		return html;
	}
	return html.replace(
		/<\/head>/i,
		`\n\t\t<link rel="stylesheet" href="${HOT_THEME_PUBLIC_PATH}" data-tedix-hot-theme />\n$&`,
	);
}

function patchReverseProxyLocation(
	location: string | null,
	org: OrgInfo,
): string | null {
	const prefix = publicPathPrefixFromOrg(org);
	const publicOrigin = publicOriginFrom(org.publicSiteUrl);
	const publicHost = publicHostFrom(org.publicSiteUrl);
	if (!location || !prefix || !publicOrigin || !publicHost) return location;

	const isRootRelativeLocation = location.startsWith("/");
	let target: URL;
	try {
		target = new URL(location, publicOrigin);
	} catch {
		return location;
	}

	// authz: public — not a route: redirect Location prefix rewrite helper.
	if (
		isRootRelativeLocation &&
		target.host === publicHost &&
		target.pathname.startsWith(`${prefix}/`) &&
		!target.pathname.startsWith(`${prefix}/_emdash/`)
	) {
		return target.toString();
	}

	if (target.host !== publicHost || target.pathname.startsWith(`${prefix}/`)) {
		return location;
	}

	const shouldPrefix =
		target.pathname === "/" ||
		target.pathname.startsWith("/_emdash/") ||
		target.pathname.startsWith("/_astro/") ||
		target.pathname.startsWith("/posts/") ||
		target.pathname.startsWith("/category/") ||
		target.pathname.startsWith("/tag/") ||
		["/rss.xml", "/sitemap.xml", "/llms.txt"].includes(target.pathname);

	if (!shouldPrefix) return location;

	// authz: public — not a route: redirect Location prefix rewrite helper.
	if (target.pathname === "/" || target.pathname === "/posts/") {
		target.pathname = `${prefix}/`;
	} else if (target.pathname.startsWith("/posts/")) {
		target.pathname = `${prefix}/${target.pathname.slice("/posts/".length)}`;
	} else {
		target.pathname = `${prefix}${target.pathname}`;
	}
	return target.toString();
}

function publicUrlFrom(publicSiteUrl: string): URL | null {
	try {
		return new URL(publicSiteUrl);
	} catch {
		return null;
	}
}

function hostMatchesPublicSite(
	request: Request,
	requestUrl: URL,
	org: OrgInfo,
): boolean {
	const publicHost = publicHostFrom(org.publicSiteUrl);
	if (!publicHost) return false;
	return (
		effectiveRequestHost(request, requestUrl.host).toLowerCase() === publicHost
	);
}

function pathMatchesPublicPrefix(requestUrl: URL, org: OrgInfo): boolean {
	const prefix = publicPathPrefixFromOrg(org);
	if (!prefix) return false;
	return (
		requestUrl.pathname === prefix ||
		requestUrl.pathname.startsWith(`${prefix}/`)
	);
}

function publicProxyRequest(
	request: Request,
	rewrittenUrl: URL,
	publicHost: string,
): Request {
	const headers = new Headers(request.headers);
	headers.set("X-Tedix-Public-Host", publicHost);
	return new Request(rewrittenUrl, {
		body: request.body,
		headers,
		method: request.method,
		redirect: request.redirect,
	});
}

function normalizePublicProxyRequest(
	request: Request,
	requestUrl: URL,
	org: OrgInfo,
): { request: Request; url: URL } {
	const publicUrl = publicUrlFrom(org.publicSiteUrl);
	const prefix = publicPathPrefixFromOrg(org);
	const publicHostMatch =
		publicUrl !== null && hostMatchesPublicSite(request, requestUrl, org);
	if (
		!publicUrl ||
		(!publicHostMatch && !pathMatchesPublicPrefix(requestUrl, org))
	) {
		return { request, url: requestUrl };
	}

	const rewrittenUrl = new URL(requestUrl);
	rewrittenUrl.protocol = publicUrl.protocol;
	rewrittenUrl.host = publicUrl.host;

	if (!prefix)
		return {
			request: publicProxyRequest(request, rewrittenUrl, publicUrl.host),
			url: rewrittenUrl,
		};

	const hasPrefix =
		requestUrl.pathname === prefix ||
		requestUrl.pathname.startsWith(`${prefix}/`);

	if (
		publicHostMatch &&
		!hasPrefix &&
		!isPublicInfrastructurePath(requestUrl.pathname)
	) {
		if (requestUrl.pathname !== "/") {
			rewrittenUrl.pathname = `${prefix}${requestUrl.pathname}`;
		}
		return {
			request: publicProxyRequest(request, rewrittenUrl, publicUrl.host),
			url: rewrittenUrl,
		};
	}

	if (hasPrefix) {
		const unprefixedPath =
			requestUrl.pathname === prefix
				? "/"
				: requestUrl.pathname.slice(prefix.length) || "/";
		if (unprefixedPath !== "/" && isPublicInfrastructurePath(unprefixedPath)) {
			rewrittenUrl.pathname = unprefixedPath;
		}
	}
	return {
		request: publicProxyRequest(request, rewrittenUrl, publicUrl.host),
		url: rewrittenUrl,
	};
}

function shouldNoindexOrigin(requestHost: string, org: OrgInfo): boolean {
	const publicHost = publicHostFrom(org.publicSiteUrl);
	return publicHost !== null && requestHost !== publicHost;
}

function canonicalPublicUrl(
	org: OrgInfo,
	pathname: string,
	search = "",
): string | null {
	const publicUrl = publicUrlFrom(org.publicSiteUrl);
	if (!publicUrl) return null;

	const target = new URL(publicUrl.origin);
	const prefix = publicPathPrefixFromOrg(org);
	let targetPath = pathname || "/";
	if (prefix) {
		if (targetPath === "/posts" || targetPath === "/posts/") {
			targetPath = `${prefix}/`;
		} else if (targetPath.startsWith("/posts/")) {
			const rest = targetPath
				.slice("/posts/".length)
				.replace(/^\/+/, "")
				.replace(/\/+$/, "");
			targetPath = rest ? `${prefix}/${rest}` : `${prefix}/`;
		}
		const hasPrefix =
			targetPath === prefix || targetPath.startsWith(`${prefix}/`);
		const shouldPrefix =
			!hasPrefix &&
			(targetPath === "/" ||
				targetPath.startsWith("/posts/") ||
				targetPath.startsWith("/category/") ||
				targetPath.startsWith("/tag/") ||
				[
					"/rss.xml",
					"/sitemap.xml",
					"/sitemap-posts.xml",
					"/llms.txt",
				].includes(targetPath));
		if (shouldPrefix) {
			targetPath = targetPath === "/" ? `${prefix}/` : `${prefix}${targetPath}`;
		}
	}
	target.pathname = targetPath;
	target.search = search;
	return target.toString();
}

export function shouldRedirectCmsOriginRequest(
	request: Request,
	requestUrl: URL,
	env: Env,
	org: OrgInfo,
): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	// Emdash validates _preview itself. Let its signed preview reach the tenant
	// origin, including `/`, before the public canonical redirect runs.
	if (requestUrl.searchParams.has("_preview")) return false;
	const requestHost = effectiveRequestHost(
		request,
		requestUrl.host,
	).toLowerCase();
	const publicHost = publicHostFrom(org.publicSiteUrl)?.toLowerCase();
	if (!publicHost || requestHost === publicHost) return false;
	return (
		extractSlug(requestUrl.hostname, env.ENVIRONMENT) !== null ||
		(isMarketingHost(requestUrl.hostname, env) &&
			org.slug === env.MARKETING_SITE_SLUG)
	);
}

/**
 * Tenant templates answer an unknown path with `Astro.redirect("/404")`. Serve
 * that page in place instead, so a missing URL returns a real 404 rather than
 * a 302 to a 404 page that crawlers and link checkers read as a redirect.
 */
export function isSoftNotFound(response: Response, request: Request): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	if (response.status < 300 || response.status >= 400) return false;
	const location = response.headers.get("location");
	if (!location) return false;
	const target = new URL(location, request.url);
	return (
		target.origin === new URL(request.url).origin && target.pathname === "/404"
	);
}

export function isOriginRedirectablePath(pathname: string): boolean {
	return (
		pathname === "/" ||
		pathname.startsWith("/posts/") ||
		pathname.startsWith("/category/") ||
		pathname.startsWith("/tag/") ||
		["/rss.xml", "/sitemap.xml", "/sitemap-posts.xml", "/llms.txt"].includes(
			pathname,
		)
	);
}

function originRobotsResponse(org: OrgInfo): Response {
	const sitemapUrl = canonicalPublicUrl(org, "/sitemap.xml");
	const body = [
		"User-agent: *",
		"Disallow: /",
		sitemapUrl ? `Sitemap: ${sitemapUrl}` : null,
		"",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
			"X-Robots-Tag": "noindex, nofollow",
		},
	});
}

function effectiveRequestHost(request: Request, fallbackHost: string): string {
	const tedixPublicHost = request.headers.get("X-Tedix-Public-Host");
	if (tedixPublicHost)
		return tedixPublicHost.split(",")[0]?.trim() || fallbackHost;

	return (
		request.headers.get("X-Forwarded-Host")?.split(",")[0]?.trim() ||
		request.headers.get("X-Original-Host")?.split(",")[0]?.trim() ||
		fallbackHost
	);
}

function imageContentTypeFromPath(pathname: string): string | null {
	const ext = pathname.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "svg":
			return "image/svg+xml";
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "ico":
			return "image/x-icon";
		case "avif":
			return "image/avif";
		default:
			return null;
	}
}

function applyEdgeResponseHeaders(
	response: Response,
	requestHost: string,
	org: OrgInfo,
	pathname: string,
): Response {
	const headers = new Headers(response.headers);
	let changed = false;

	if (shouldNoindexOrigin(requestHost, org)) {
		headers.set("X-Robots-Tag", "noindex, nofollow");
		changed = true;
	}

	// authz: public — not a route: response header fix-up for media file responses.
	if (pathname.startsWith("/_emdash/api/media/file/")) {
		const imageContentType = imageContentTypeFromPath(pathname);
		if (imageContentType) {
			headers.set("Content-Type", imageContentType);
			headers.delete("Content-Disposition");
			headers.delete("Content-Security-Policy");
			changed = true;
		}
	}

	if (!changed) return response;

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function lookupOrg(
	env: Env,
	slug: string,
	fresh = false,
): Promise<OrgInfo | null> {
	const now = Date.now();
	const cached = orgCache.get(slug);
	if (!fresh && cached && cached.expiresAt > now) return cached.info;

	const db = getDb(env.PLATFORM_DB);
	const site = await getCmsSiteBySlug(db, slug);

	if (!site || site.status !== "active") {
		orgCache.set(slug, { info: null, expiresAt: now + ORG_TTL_MS });
		return null;
	}

	const ownerOrg = await db.query.organizations.findFirst({
		where: { id: site.organizationId },
	});
	const config = site.config ?? {};
	const blogConfig = (config.blog ?? {}) as Record<string, unknown>;
	const authDescopeTenantId =
		typeof blogConfig.authDescopeTenantId === "string"
			? blogConfig.authDescopeTenantId
			: null;
	const descopeTenantId = authDescopeTenantId ?? ownerOrg?.descopeTenantId;

	if (!descopeTenantId) {
		console.error(
			`[cms-runtime] CMS site ${slug} has no Descope auth tenant; set site config or organization.descopeTenantId`,
		);
		orgCache.set(slug, { info: null, expiresAt: now + ORG_TTL_MS });
		return null;
	}

	const r2BucketName = `tedix-cms-media-${slug}`;

	const branding = config.branding ?? null;
	const socialLinks = config.socialLinks ?? null;
	const cmsFallbackUrl =
		buildSurfaceUrl("cms", slug, {
			platformDomain: platformDomainForEnvironment(env.ENVIRONMENT),
		}) ?? `https://${slug}.cms.tedix.dev`;
	const cmsDomain = site.customDomain;
	const publicSiteUrl =
		site.canonicalUrl.replace(/\/+$/, "") ??
		(cmsDomain ? `https://${cmsDomain}` : null) ??
		cmsFallbackUrl;
	const publicPathPrefix = normalizePublicPathPrefix(site.publicPathPrefix);
	const webMcpConfig = (
		blogConfig as
			| {
					webMcp?: { enabled?: unknown; toolPacks?: unknown };
			  }
			| undefined
	)?.webMcp;
	const webMcpToolPacks =
		webMcpConfig?.enabled === false
			? []
			: normalizeWebMcpToolPacks(webMcpConfig?.toolPacks);
	const info: OrgInfo = {
		slug,
		siteId: site.id,
		templateSlug: site.templateSlug,
		r2BucketName,
		siteTitle: site.name,
		brandingJson: branding ? JSON.stringify(branding) : null,
		socialJson: socialLinks ? JSON.stringify(socialLinks) : null,
		descopeTenantId,
		humanAssertionBundleEtag:
			typeof blogConfig.humanAssertionBundleEtag === "string"
				? blogConfig.humanAssertionBundleEtag
				: null,
		cmsDomain: cmsDomain ?? null,
		publicSiteUrl,
		publicPathPrefix,
		webMcpToolPacks,
		defaultLocale:
			typeof blogConfig.defaultLocale === "string"
				? blogConfig.defaultLocale
				: null,
	};
	orgCache.set(slug, { info, expiresAt: now + ORG_TTL_MS });
	return info;
}

// ── Active bundle lookup ──────────────────────────────────────────

interface BundleManifest {
	mainModule: string;
	modules: string[];
}

interface TenantScheduledFetcher extends Fetcher {
	scheduled?: (controller: ScheduledController) => void | Promise<void>;
}

async function lookupActiveBundle(
	env: Env,
	slug: string,
): Promise<TenantBundle | null> {
	return getActiveTenantBundle(getDb(env.PLATFORM_DB), slug);
}

async function listActiveBundles(env: Env): Promise<TenantBundle[]> {
	return listActiveTenantBundles(getDb(env.PLATFORM_DB));
}

interface RecoveryBundleIdentity {
	slug: string;
	version: number;
	etag: string;
}

/** Recovery refuses duplicate active rows hidden by normal serving's LIMIT 1. */
export async function lookupUniqueRecoveryBundle(
	env: Env,
	slug: string,
): Promise<RecoveryBundleIdentity | null> {
	const versions = await listTenantBundleVersions(
		{ platformDb: env.PLATFORM_DB, bundlesBucket: env.TENANT_BUNDLES },
		slug,
	);
	const active = versions.filter((version) => version.isActive);
	return active.length === 1
		? { slug, version: active[0]!.version, etag: active[0]!.etag }
		: null;
}

// ── Per-tenant RPC entrypoints ────────────────────────────────────
//
// Dynamic Workers can't yet receive native R2 bindings via the factory `env`,
// so media remains a WorkerEntrypoint stub.

const CF_API = "https://api.cloudflare.com/client/v4";

// ── Image transforms (parent-Worker interception) ──────────────────
//
// Emdash's Astro image endpoint (image.endpoint, mounted at Astro's default
// /_image route — this repo's tenant templates don't override image.endpoint.route)
// calls the real Cloudflare Images binding chain (`env.IMAGES.input().transform().output()`)
// directly. That binding cannot be forwarded into a Worker-Loader-dispatched
// tenant isolate the way TenantR2 proxies R2 (this isn't a
// REST-shaped interface a WorkerEntrypoint can proxy — it's a chained,
// streaming transform pipeline). So /_image requests are intercepted here, at
// the parent, which has native IMAGES + R2 access, and served directly —
// mirroring how edge caching moved entirely to the parent Worker for the same
// "no native binding inside a dispatched isolate" reason.
//
// Contract mirrors `emdash/media/image-endpoint.ts` + `@emdash-cms/cloudflare`'s
// `image-endpoint.ts` exactly: `href` must resolve to the internal media route
// (`matchInternalMediaKey`), transform params are `w`/`h`/`f`/`q`
// (`parseTransformParams`). Only raster images are transformed; anything else,
// or a request this parent can't confidently handle, falls through to Worker
// Loader dispatch so the isolate's own `passthrough`-mode fallback still works.

const IMAGE_ENDPOINT_ROUTE = "/_image";

export function tenantMediaKeyFromHref(
	href: string | null,
	prefix: string | null,
): string | null {
	const directKey = matchInternalMediaKey(href);
	if (directKey || !href || !prefix) return directKey;
	try {
		const mediaUrl = new URL(href, "http://localhost");
		// authz: public — resolved tenant prefix only; the caller reads the key from that tenant's R2 bucket.
		if (!mediaUrl.pathname.startsWith(`${prefix}/_emdash/api/media/file/`))
			return null;
		mediaUrl.pathname = mediaUrl.pathname.slice(prefix.length);
		return matchInternalMediaKey(mediaUrl.href);
	} catch {
		return null;
	}
}

const IMAGE_TRANSFORM_FORMAT_MIME: Record<
	ImageTransformFormat,
	ImageOutputOptions["format"]
> = {
	webp: "image/webp",
	avif: "image/avif",
	jpeg: "image/jpeg",
	png: "image/png",
};

async function fetchTenantR2ObjectStream(
	accountId: string,
	r2Token: string,
	bucketName: string,
	key: string,
): Promise<{
	body: ReadableStream<Uint8Array>;
	contentType: string;
	etag: string | null;
} | null> {
	const res = await fetch(
		`${CF_API}/accounts/${accountId}/r2/buckets/${bucketName}/objects/${encodeURIComponent(key)}`,
		{ headers: { Authorization: `Bearer ${r2Token}` } },
	);
	if (res.status === 404) return null;
	if (!res.ok || !res.body) {
		throw new Error(`R2 get failed for image transform: ${res.status}`);
	}
	return {
		body: res.body,
		etag: res.headers.get("etag"),
		contentType: res.headers.get("content-type") ?? "application/octet-stream",
	};
}

/**
 * Handle a `/_image` request directly at the parent, or return `null` to fall
 * through to normal Worker Loader dispatch (not an image-transform request,
 * not EmDash-internal media, non-raster source, or any error — the isolate's
 * own image endpoint remains a safe fallback in every non-handled case).
 */
async function imageTransformResponse(
	env: Env,
	org: Pick<OrgInfo, "slug" | "publicPathPrefix" | "r2BucketName">,
	accountId: string,
	r2Token: string,
	url: URL,
	expectedSourceEtag?: string,
): Promise<Response | null> {
	// authz: public — public tenant-site image transform; only serves keys matchInternalMediaKey accepts.
	if (url.pathname !== IMAGE_ENDPOINT_ROUTE) return null;

	const key = tenantMediaKeyFromHref(
		url.searchParams.get("href"),
		org.publicPathPrefix,
	);
	if (!key) return null;

	const parsed = parseTransformParams(url.searchParams);
	if (!parsed.ok) return null;

	try {
		const source = await fetchTenantR2ObjectStream(
			accountId,
			r2Token,
			org.r2BucketName,
			key,
		);
		if (!source) return new Response("Not Found", { status: 404 });
		if (!(await validateImageSourceRevision(source, expectedSourceEtag)))
			return null;
		if (!source.contentType.startsWith("image/")) {
			await source.body.cancel();
			return null;
		}

		const { width, height, format, quality } = parsed.options;
		const outputMime = IMAGE_TRANSFORM_FORMAT_MIME[format] ?? "image/webp";
		const transform: ImageTransform = {};
		if (width) transform.width = width;
		if (height) transform.height = height;
		const output: ImageOutputOptions = { format: outputMime };
		const effectiveQuality = resolveTransformQuality(format, quality);
		if (effectiveQuality !== undefined) output.quality = effectiveQuality;

		const result = await env.IMAGES.input(source.body)
			.transform(transform)
			.output(output);
		const response = result.response();
		if (!response.body) return null;

		return new Response(response.body, {
			status: 200,
			headers: {
				"Content-Type": response.headers.get("Content-Type") ?? outputMime,
				"Cache-Control": MUTABLE_MEDIA_CACHE_CONTROL,
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		console.error(
			`[cms-runtime] parent-level image transform failed for ${org.slug}, falling through to isolate:`,
			error,
		);
		return null;
	}
}

interface TenantCachedAssetProps {
	siteId: string;
	slug: string;
	restoreEpoch: number;
	hostname: string;
	r2BucketName: string;
	publicPathPrefix: string | null;
	sourceEtag?: string;
}

/** Trusted loopback only. The default router checks routing and restore permits first. */
export class TenantCachedAssets extends WorkerEntrypoint<
	Env,
	TenantCachedAssetProps
> {
	async fetch(request: Request): Promise<Response> {
		// authz: public — trusted tenant props supplied after gateway routing and restore admission.
		const url = new URL(request.url);
		const props = this.ctx.props;
		const staticResponse = await staticAssetResponse(
			request,
			this.env.TENANT_BUNDLES,
			props.slug,
			url.pathname,
		);
		if (staticResponse) return staticResponse;
		if (props.sourceEtag) {
			const result = await imageTransformResponse(
				this.env,
				props,
				this.env.CF_ACCOUNT_ID,
				this.env.CLOUDFLARE_R2_API_TOKEN!,
				url,
				props.sourceEtag,
			);
			if (result?.status === 200) {
				result.headers.set(
					"Cache-Control",
					"public, max-age=31536000, immutable",
				);
				result.headers.set(
					"ETag",
					await imageRepresentationEtag(props.sourceEtag, url),
				);
				return result;
			}
		}
		return new Response(null, {
			status: 404,
			headers: { "Cache-Control": "private, no-store" },
		});
	}
}

interface DoQueryResult {
	rows: Record<string, unknown>[];
	changes?: number;
	bookmark?: string;
}

interface DoQueryStatement {
	sql: string;
	params?: unknown[];
}

interface EmDashDBStub {
	deleteTenantData(): Promise<void>;
	captureRecoveryBookmark(): Promise<string | null>;
	readSiteDrillProof(): Promise<CmsSiteDrillDigestProof>;
	executeCollectionDeletionGuard(
		input: CollectionDeletionGuardInput,
	): Promise<CollectionDeletionGuardResult>;
	query(
		sql: string,
		params?: unknown[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult>;
	batchQuery(
		statements: DoQueryStatement[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult[]>;
}

// Keep a timer active if a nested DO read RPC stalls, then retry once. The
// four-second bound sits beyond the observed production DO query tail. Only
// plain SELECTs are retried: writes can complete even when their reply is lost.
const TENANT_DB_READ_TIMEOUT_MS = 4_000;
const PLAIN_SELECT_PATTERN = /^\s*select\b/i;
const TENANT_DB_PRIMARY_TABLE_PATTERN =
	/\b(?:from|join|into|update)\s+["`]?([a-z_][a-z0-9_]*)["`]?/i;

// Diagnostic query classification. Emit only fixed categories, never a
// tenant-authored table name, SQL text, or bound values.
function tenantDbQueryFamily(sql: string): string {
	const table = TENANT_DB_PRIMARY_TABLE_PATTERN.exec(sql)?.[1]?.toLowerCase();
	switch (table) {
		case "_emdash_menus":
		case "_emdash_menu_items":
			return "menus";
		case "_emdash_widget_areas":
		case "_emdash_widgets":
			return "widgets";
		case "_emdash_taxonomy_defs":
		case "taxonomies":
		case "content_taxonomies":
			return "taxonomy";
		case "options":
			return "options";
		case "content":
			return "content";
		case "media":
			return "media";
		default:
			return "other";
	}
}

class TenantDbReadTimeout extends Error {
	constructor() {
		super("Tenant database read RPC timed out");
	}
}

async function boundedTenantDbRead<T>(call: () => Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			call(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new TenantDbReadTimeout()),
					TENANT_DB_READ_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function retryTenantDbRead<T>(
	call: () => Promise<T>,
	operation: string,
	tenant: string,
): Promise<T> {
	try {
		return await boundedTenantDbRead(call);
	} catch (error) {
		if (!(error instanceof TenantDbReadTimeout)) throw error;
		console.warn(
			`[cms-runtime] tenant database ${operation} timed out; retrying`,
			{
				tenant,
			},
		);
		return await boundedTenantDbRead(call);
	}
}

/** An outer loader permit ends when fetch returns a Response. RPCs can outlive
 * that boundary, so each tenant storage call holds its own exact-site permit. */
async function withTenantStoragePermit<T>(
	env: Env,
	identity: { siteId: string; slug: string; restoreEpoch: number },
	run: () => Promise<T>,
): Promise<T> {
	const result = await withCmsRestorePermit(
		createDbQueryClient(env.PLATFORM_DB),
		identity,
		run,
	);
	if (!result.admitted) throw new CmsRestoreFenceUnavailableError();
	return result.value;
}

export class TenantEmDashDB extends WorkerEntrypoint<
	Env,
	{ name: string; siteId: string; slug: string; restoreEpoch: number }
> {
	private withPermit<T>(run: () => Promise<T>): Promise<T> {
		return withTenantStoragePermit(this.env, this.ctx.props, run);
	}

	private stub(): EmDashDBStub {
		const id = this.env.DB_DO.idFromName(this.ctx.props.name);
		return this.env.DB_DO.get(id) as unknown as EmDashDBStub;
	}

	async executeCollectionDeletionGuard(
		input: CollectionDeletionGuardInput,
	): Promise<CollectionDeletionGuardResult> {
		return this.withPermit(() =>
			this.stub().executeCollectionDeletionGuard(input),
		);
	}

	async query(
		sql: string,
		params?: unknown[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult> {
		const selectOnly = PLAIN_SELECT_PATTERN.test(sql);
		// Diagnostic trace: identify the statement class and nested RPC
		// boundary without recording SQL or parameter values.
		console.info("[cms-runtime] tenant database query entered", {
			tenant: this.ctx.props.name,
			selectOnly,
			tableGroup: tenantDbQueryFamily(sql),
		});
		// Keep this WorkerEntrypoint invocation pending until the nested DO RPC settles.
		const result = await this.withPermit(() =>
			selectOnly
				? retryTenantDbRead(
						() => this.stub().query(sql, params, opts),
						"SELECT RPC",
						this.ctx.props.name,
					)
				: this.stub().query(sql, params, opts),
		);
		console.info("[cms-runtime] tenant database query resolved", {
			tenant: this.ctx.props.name,
			selectOnly,
		});
		return result;
	}

	async batchQuery(
		statements: DoQueryStatement[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult[]> {
		const selectOnly = statements.every((statement) =>
			PLAIN_SELECT_PATTERN.test(statement.sql),
		);
		// Diagnostic trace: Logpush keeps these lines in the same RPC
		// invocation as a hang, without recording SQL or parameter values.
		console.info("[cms-runtime] tenant database batch entered", {
			tenant: this.ctx.props.name,
			selectOnly,
			count: statements.length,
		});
		const result = await this.withPermit(() =>
			selectOnly
				? retryTenantDbRead(
						() => this.stub().batchQuery(statements, opts),
						"SELECT batch RPC",
						this.ctx.props.name,
					)
				: this.stub().batchQuery(statements, opts),
		);
		console.info("[cms-runtime] tenant database batch resolved", {
			tenant: this.ctx.props.name,
			selectOnly,
		});
		return result;
	}
}

/**
 * TenantR2 — per-tenant R2 stub via S3-compatible REST. Per Cloudflare,
 * the simplest cross-account R2 access from a Worker is the
 * `https://api.cloudflare.com/client/v4/accounts/{id}/r2/buckets/{bucket}/objects/{key}`
 * endpoint, which uses the same API token. We expose a minimal subset:
 *   get(key) → R2ObjectBody-ish
 *   put(key, value, opts?)
 *   delete(key)
 *   head(key)
 *   list({ prefix?, limit?, cursor? })
 *
 * EmDash's storage adapter consumes the object body as a stream, including
 * during site transfer. Keep reads and writes streaming across the tenant
 * boundary so a package's media does not have to fit in Worker memory.
 */
export class TenantR2 extends WorkerEntrypoint<
	Env,
	{
		bucketName: string;
		accountId: string;
		token: string;
		siteId: string;
		slug: string;
		restoreEpoch: number;
	}
> {
	private withPermit<T>(run: () => Promise<T>): Promise<T> {
		return withTenantStoragePermit(this.env, this.ctx.props, run);
	}

	private url(key: string): string {
		const p = this.ctx.props;
		return `${CF_API}/accounts/${p.accountId}/r2/buckets/${p.bucketName}/objects/${encodeURIComponent(key)}`;
	}

	async get(key: string): Promise<{
		body: ReadableStream<Uint8Array>;
		httpEtag: string;
		size: number;
		httpMetadata: { contentType?: string; cacheControl?: string };
	} | null> {
		const res = await fetch(this.url(key), {
			headers: { Authorization: `Bearer ${this.ctx.props.token}` },
		});
		if (res.status === 404) return null;
		if (!res.ok || !res.body) throw new Error(`R2 get failed: ${res.status}`);
		const contentLength = res.headers.get("content-length");
		const declaredSize = contentLength === null ? NaN : Number(contentLength);
		const size =
			Number.isSafeInteger(declaredSize) && declaredSize >= 0
				? declaredSize
				: (await this.head(key))?.size;
		if (size === undefined)
			throw new Error("R2 get failed: object disappeared");
		return {
			body: res.body,
			httpEtag: res.headers.get("etag") ?? "",
			size,
			httpMetadata: {
				contentType: res.headers.get("content-type") ?? undefined,
				cacheControl: res.headers.get("cache-control") ?? undefined,
			},
		};
	}

	async head(key: string): Promise<{ httpEtag: string; size: number } | null> {
		// Cloudflare's REST object GET omits Content-Length, and its object
		// endpoint rejects HEAD (405). The list endpoint exposes exact object
		// size without consuming the GET body stream.
		let cursor: string | undefined;
		for (;;) {
			const page = await this.list({ prefix: key, limit: 1000, cursor });
			const object = page.objects.find((item) => item.key === key);
			if (object) {
				if (!Number.isSafeInteger(object.size) || object.size < 0)
					throw new Error("R2 head failed: invalid object size");
				return {
					httpEtag: object.etag.startsWith('"')
						? object.etag
						: `"${object.etag}"`,
					size: object.size,
				};
			}
			if (!page.truncated) return null;
			if (!page.cursor || page.cursor === cursor)
				throw new Error("R2 head failed: object list cursor did not advance");
			cursor = page.cursor;
		}
	}

	async put(
		key: string,
		value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | string,
		opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
	): Promise<{ httpEtag: string; size: number }> {
		return this.withPermit(async () => {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${this.ctx.props.token}`,
			};
			if (opts?.httpMetadata?.contentType) {
				headers["Content-Type"] = opts.httpMetadata.contentType;
			}
			if (opts?.httpMetadata?.cacheControl) {
				headers["Cache-Control"] = opts.httpMetadata.cacheControl;
			}
			const res = await fetch(this.url(key), {
				method: "PUT",
				headers,
				body:
					value instanceof Uint8Array ? Uint8Array.from(value).buffer : value,
			});
			if (!res.ok) throw new Error(`R2 put failed: ${res.status}`);
			// Cloudflare's object PUT response does not report the stored byte count.
			// The native R2 adapter returns it, so read the object metadata back.
			const stored = await this.head(key);
			if (!stored) throw new Error("R2 put failed: object missing after write");
			return { httpEtag: stored.httpEtag, size: stored.size };
		});
	}

	async delete(key: string): Promise<void> {
		await this.withPermit(async () => {
			const res = await fetch(this.url(key), {
				method: "DELETE",
				headers: { Authorization: `Bearer ${this.ctx.props.token}` },
			});
			if (!res.ok && res.status !== 404) {
				throw new Error(`R2 delete failed: ${res.status}`);
			}
		});
	}

	async list(opts?: {
		prefix?: string;
		limit?: number;
		cursor?: string;
	}): Promise<{
		objects: Array<{ key: string; size: number; etag: string }>;
		truncated: boolean;
		cursor?: string;
	}> {
		const p = this.ctx.props;
		const url = new URL(
			`${CF_API}/accounts/${p.accountId}/r2/buckets/${p.bucketName}/objects`,
		);
		if (opts?.prefix) url.searchParams.set("prefix", opts.prefix);
		if (opts?.limit) url.searchParams.set("per_page", String(opts.limit));
		if (opts?.cursor) url.searchParams.set("cursor", opts.cursor);
		const res = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${p.token}` },
		});
		if (!res.ok) throw new Error(`R2 list failed: ${res.status}`);
		const data = (await res.json()) as {
			result: Array<{ key: string; size: number; etag: string }>;
			result_info?: { cursor?: string; is_truncated?: boolean };
		};
		return {
			objects: data.result ?? [],
			truncated: data.result_info?.is_truncated ?? false,
			cursor: data.result_info?.cursor,
		};
	}
}

/**
 * TenantSession — per-tenant key prefixing over shared SESSION KV. Writes
 * acquire a restore permit inside this RPC boundary before touching KV.
 */
export class TenantSession extends WorkerEntrypoint<
	Env,
	{ siteId: string; slug: string; restoreEpoch: number }
> {
	async get(key: string): Promise<string | null> {
		return await this.env.SESSION.get(`${this.ctx.props.slug}:${key}`);
	}
	async put(
		key: string,
		value: string,
		opts?: { expirationTtl?: number },
	): Promise<void> {
		await withTenantStoragePermit(this.env, this.ctx.props, () =>
			this.env.SESSION.put(`${this.ctx.props.slug}:${key}`, value, opts),
		);
	}
	async delete(key: string): Promise<void> {
		await withTenantStoragePermit(this.env, this.ctx.props, () =>
			this.env.SESSION.delete(`${this.ctx.props.slug}:${key}`),
		);
	}
}

function safeTailFrame(stack: string | undefined): string | undefined {
	const line = stack?.split("\n").at(1);
	const match = line?.match(/^\s*at\s+([\w.$<>]+)\s+\(([\w./:@-]+:\d+:\d+)\)/);
	return match ? `${match[1]} @ ${match[2]}` : undefined;
}

/** Dynamic Worker console output is otherwise discarded by Worker Loader. */
export class TenantRuntimeFailureTail extends WorkerEntrypoint<
	Env,
	{ slug: string }
> {
	async tail(events: TraceItem[]): Promise<void> {
		for (const event of events) {
			const response =
				event.event && "response" in event.event
					? event.event.response
					: undefined;
			const status = response?.status;
			const authRejectionCodes = cmsAuthRejectionCodes(event.logs);
			if (
				(status === undefined || status < 500) &&
				event.exceptions.length === 0 &&
				!event.logs.some((log) => log.level === "error") &&
				event.outcome === "ok" &&
				authRejectionCodes.length === 0
			) {
				continue;
			}
			// Keep tenant content, request URLs, SQL and error messages out of the
			// parent Logpush stream. Names and source frames locate failing code.
			console.error("[cms-runtime] tenant worker failure", {
				tenant: this.ctx.props.slug,
				status,
				outcome: event.outcome,
				wallMs: event.wallTime,
				exceptions: event.exceptions.map((error) => ({
					name: error.name,
					frame: safeTailFrame(error.stack),
				})),
				errorLogs: event.logs
					.filter((log) => log.level === "error")
					.flatMap((log) => log.errorInfo ?? [])
					.filter((error) => error !== null)
					.map((error) => ({
						name: error.name,
						frame: safeTailFrame(error.stack),
					})),
				logLevels: event.logs.map((log) => log.level),
				authRejectionCodes,
			});
		}
	}
}

// ── Bundle assembly ───────────────────────────────────────────────

type LoadedBundle = {
	mainModule: string;
	modules: Record<string, { js: string }>;
};

/**
 * Single-object form of a tenant bundle, written lazily beside the manifest.
 *
 * The parent Worker isolate does not survive between requests on a low-traffic
 * tenant, so Worker Loader's in-isolate cache is cold every time and this
 * factory re-reads the whole bundle. Reading it as hundreds of separate R2
 * objects costs seconds per request; one object costs a single round trip.
 *
 * Lives under the immutable versioned prefix (`<slug>/v<N>/`), so a new bundle
 * version writes a new prefix and the pack can never go stale. A corrupt or
 * missing pack falls through to the per-module path rather than taking the
 * tenant down.
 *
 * If you are editing this function, keep the packed fast path: dropping it
 * silently multiplies uncached request latency.
 */
const PACKED_BUNDLE_KEY = "__tedix_packed_bundle.json";
const PACKED_GZIP_BUNDLE_KEY = "__tedix_packed_bundle.json.gz";

async function writeCompressedBundle(
	env: Env,
	r2Prefix: string,
	json: string,
): Promise<void> {
	const compressed = await new Response(
		new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
	await env.TENANT_BUNDLES.put(
		`${r2Prefix}${PACKED_GZIP_BUNDLE_KEY}`,
		compressed,
		{ httpMetadata: { contentType: "application/gzip" } },
	);
}

async function writeCompressedBundleIfPermitted(
	env: Env,
	r2Prefix: string,
	json: string,
	identity: CmsRestoreFenceIdentity | undefined,
): Promise<void> {
	if (!identity) return;
	try {
		await withCmsRestorePermit(
			createDbQueryClient(env.PLATFORM_DB),
			identity,
			() => writeCompressedBundle(env, r2Prefix, json),
		);
	} catch (err) {
		console.error(
			`[cms-runtime] failed to write compressed bundle at ${r2Prefix}:`,
			err instanceof Error ? err.message : String(err),
		);
	}
}

export async function loadBundleModules(
	env: Env,
	r2Prefix: string,
	opts: {
		spans?: ParentSpans;
		restoreIdentity?: CmsRestoreFenceIdentity;
	} = {},
): Promise<LoadedBundle> {
	const { spans, restoreIdentity } = opts;

	// The versioned bundle is immutable. A compressed pack avoids transferring
	// the same large JS sources from R2 on every Worker Loader cache miss.
	const compressedObj = await env.TENANT_BUNDLES.get(
		`${r2Prefix}${PACKED_GZIP_BUNDLE_KEY}`,
	);
	if (compressedObj) {
		try {
			const packed = (await new Response(
				compressedObj.body.pipeThrough(new DecompressionStream("gzip")),
			).json()) as LoadedBundle;
			if (packed?.mainModule && packed.modules) {
				if (spans) {
					spans["bundle.packed"] = 1;
					spans["bundle.packedGzip"] = 1;
				}
				return packed;
			}
			console.error(`[cms-runtime] malformed compressed bundle at ${r2Prefix}`);
		} catch (err) {
			console.error(
				`[cms-runtime] compressed bundle unreadable at ${r2Prefix}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// Legacy pack: keep old bundles readable and upgrade them while the request
	// still owns its nested permit. A corrupt or absent pack falls through.
	const packedObj = await env.TENANT_BUNDLES.get(
		`${r2Prefix}${PACKED_BUNDLE_KEY}`,
	);
	if (packedObj) {
		try {
			const json = await packedObj.text();
			const packed = JSON.parse(json) as LoadedBundle;
			if (packed?.mainModule && packed.modules) {
				if (spans) {
					spans["bundle.packed"] = 1;
					spans["bundle.packedGzip"] = 0;
				}
				await writeCompressedBundleIfPermitted(
					env,
					r2Prefix,
					json,
					restoreIdentity,
				);
				return packed;
			}
			console.error(`[cms-runtime] malformed packed bundle at ${r2Prefix}`);
		} catch (err) {
			console.error(
				`[cms-runtime] packed bundle unreadable at ${r2Prefix}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// r2Prefix from tenant_bundles.r2_prefix already ends with `/` (e.g. "tedix/v1/")
	const manifestObj = await env.TENANT_BUNDLES.get(`${r2Prefix}manifest.json`);
	if (!manifestObj) throw new Error(`bundle manifest missing at ${r2Prefix}`);
	const manifest = JSON.parse(await manifestObj.text()) as BundleManifest;

	// Worker Loader infers module type from extension; .mjs is rejected. We pass
	// the object form { js: source } to declare ES module explicitly so Astro's
	// `entry.mjs` + chunked `chunks/*.mjs` files load correctly.
	const modules: Record<string, { js: string }> = {};
	const fetched = await Promise.all(
		manifest.modules.map(async (m) => {
			const obj = await env.TENANT_BUNDLES.get(`${r2Prefix}${m}`);
			if (!obj) throw new Error(`bundle missing module: ${r2Prefix}${m}`);
			return [m, { js: await obj.text() }] as const;
		}),
	);
	for (const [m, mod] of fetched) modules[m] = mod;

	const loaded: LoadedBundle = { mainModule: manifest.mainModule, modules };

	// Write one compressed object for subsequent cold loads. Await the nested
	// permit so a detached Worker task cannot strand it after the response.
	await writeCompressedBundleIfPermitted(
		env,
		r2Prefix,
		JSON.stringify(loaded),
		restoreIdentity,
	);

	if (spans) {
		spans["bundle.packed"] = 0;
		spans["bundle.packedGzip"] = 0;
	}
	return loaded;
}

const TENANT_RUNTIME_ENTRYPOINT_MODULE = "__tedix_cms_runtime_entrypoint.mjs";

type BundleDatabaseAdapter = "d1" | "durableObjects" | "unknown";

type BundleDatabaseAdapterReport = {
	adapter: BundleDatabaseAdapter;
	evidence: string[];
};

type ActiveBundleRuntimeReport = BundleDatabaseAdapterReport & {
	mainModule: string;
	moduleCount: number;
};

/**
 * Read the database adapter from the bundle's compiled `virtual:emdash/config`
 * module: `"database": { "entrypoint": "<module>", "config": { "binding": … } }`.
 * Astro emits that object pretty-printed, so match on whitespace-tolerant
 * patterns rather than exact minified strings.
 */
export function detectBundleDatabaseAdapter(
	modules: Record<string, { js: string }>,
): BundleDatabaseAdapterReport {
	const evidence = new Set<string>();
	for (const module of Object.values(modules)) {
		const entrypoint = module.js.match(
			/"database"\s*:\s*\{\s*"entrypoint"\s*:\s*"([^"]+)"/,
		)?.[1];
		if (entrypoint) evidence.add(`entrypoint "${entrypoint}"`);
		if (/"binding"\s*:\s*"DB_DO"/.test(module.js)) {
			evidence.add('binding "DB_DO"');
		}
	}

	const evidenceList = Array.from(evidence).sort();
	if (
		evidenceList.some(
			(item) => item.includes("do-sql") || item === 'binding "DB_DO"',
		)
	) {
		return { adapter: "durableObjects", evidence: evidenceList };
	}
	if (evidenceList.some((item) => item.includes("/db/d1"))) {
		return { adapter: "d1", evidence: evidenceList };
	}
	return { adapter: "unknown", evidence: evidenceList };
}

export function tenantRuntimeEntrypointModule(mainModule: string): {
	js: string;
} {
	return {
		js: `
import { WorkerEntrypoint } from "cloudflare:workers";
import tenantHandler from ${JSON.stringify(mainModule)};

export default class TenantRuntimeEntrypoint extends WorkerEntrypoint {
	fetch(request) {
		if (typeof tenantHandler.fetch !== "function") {
			return new Response("Tenant bundle has no fetch handler", { status: 500 });
		}
		return tenantHandler.fetch(request, this.env, this.ctx);
	}

	async scheduled(controller) {
		if (typeof tenantHandler.scheduled !== "function") return;
		const pending = new Set();
		let waitUntilFailed = false;
		let waitUntilError;
		const tenantCtx = new Proxy(this.ctx, {
			get(target, key) {
				if (key === "waitUntil") {
					return (promise) => {
						const tracked = Promise.resolve(promise).then(
							() => pending.delete(tracked),
							(error) => {
								pending.delete(tracked);
								if (!waitUntilFailed) {
									waitUntilFailed = true;
									waitUntilError = error;
								}
							},
						);
						pending.add(tracked);
						target.waitUntil(promise);
					};
				}
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		let handlerFailed = false;
		let handlerError;
		try {
			await tenantHandler.scheduled(controller, this.env, tenantCtx);
		} catch (error) {
			handlerFailed = true;
			handlerError = error;
		}
		while (pending.size > 0) await Promise.all(pending);
		if (handlerFailed) throw handlerError;
		if (waitUntilFailed) throw waitUntilError;
	}
}
`,
	};
}

/**
 * Parent-side spans for one request.
 *
 * The tenant isolate reports its own Server-Timing (`rt.*`, `render`, `db.*`),
 * which does not cover the parent: a request can spend most of its wall time
 * in `env.LOADER.get()`'s factory (hundreds of R2 module reads) while the inner
 * worker reports a short render. `loader.factory`
 * appearing at all means the Worker Loader cache missed and the bundle was
 * re-fetched — that is the signal to look at, not just its duration.
 */
type ParentSpans = { [name: string]: number };

async function span<T>(
	spans: ParentSpans,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	try {
		return await fn();
	} finally {
		spans[name] = (spans[name] ?? 0) + (Date.now() - started);
	}
}

function parentServerTiming(spans: ParentSpans): string | null {
	const entries = Object.entries(spans);
	if (entries.length === 0) return null;
	return entries
		.map(([name, dur]) => `tedix_${name};dur=${dur}`)
		.join(", ")
		.replaceAll(".", "_");
}

const tenantLoaderRecovery = new TenantLoaderRecovery();

/** An absent or mismatched site ID keeps registry execution off by default. */
export function tenantPluginCanaryEnabled(
	canarySiteId: string | undefined,
	siteId: string,
): boolean {
	return !!canarySiteId && canarySiteId === siteId;
}

export function getTenantEntrypoint(
	env: Env,
	ctx: ExecutionContext,
	args: {
		accountId: string;
		r2Token: string;
		bundle: TenantBundle;
		/**
		 * Per-tenant derivation of CMS_INTERNAL_AUTH_TOKEN — see
		 * ./tenant-internal-auth. Deterministic in (shared secret, slug, bundle
		 * version, restore epoch), so the value baked into the isolate on a loader cache miss
		 * always matches what the request path rewrites the header to.
		 */
		internalAuthToken: string | undefined;
		humanAuthKey: string | undefined;
		org: OrgInfo;
		slug: string;
		restoreEpoch: number;
		spans: ParentSpans;
	},
	loaderKey?: string,
): Fetcher {
	const {
		accountId,
		r2Token,
		bundle,
		internalAuthToken,
		humanAuthKey,
		org,
		slug,
		restoreEpoch,
		spans,
	} = args;
	const pluginCanaryEnabled = tenantPluginCanaryEnabled(
		(env as Env & { CMS_PLUGIN_CANARY_SITE_ID?: string })
			.CMS_PLUGIN_CANARY_SITE_ID,
		org.siteId,
	);
	const handle = withDynamicWorkerLoaderDiagnostics(env.LOADER, {
		surface: "cms_tenant_runtime",
		reason: "cms_tenant_bundle_lookup",
	}).get(
		`${
			loaderKey ??
			tenantLoaderRecovery.snapshot(
				`${tenantRuntimeCacheKey(slug, bundle, org, env)}@restore:${restoreEpoch}`,
			).key
		}@plugin-host:${pluginCanaryEnabled ? "canary" : "off"}`,
		async () => {
			const { mainModule, modules } = await span(
				spans,
				"loader.factory.modules",
				() =>
					loadBundleModules(env, bundle.r2Prefix, {
						spans,
						restoreIdentity: { siteId: org.siteId, slug, restoreEpoch },
					}),
			);
			spans["loader.factory.moduleCount"] = Object.keys(modules).length;
			modules[TENANT_RUNTIME_ENTRYPOINT_MODULE] =
				tenantRuntimeEntrypointModule(mainModule);

			// Per-tenant RPC stubs. `ctx.exports.<Class>({ props })` returns a
			// Fetcher/stub that hydrates the receiving entrypoint with `props`.
			// See workers-types `LoopbackServiceStub`. The runtime `ctx.exports`
			// type is generic over `Cloudflare.GlobalProps['mainModule']`, but
			// the cross-file `mainModule: typeof import("./src/index")` plumbing
			// in worker-configuration.d.ts isn't reaching the call site in this
			// workspace's tsconfig. Re-shape via a narrow interface so call
			// sites are still type-checked.
			interface TenantStubFactories {
				CmsOutboundProxy(opts: {
					props: { siteId: string; slug: string; restoreEpoch: number };
				}): Fetcher;
				TenantEmDashDB(opts: {
					props: {
						name: string;
						siteId: string;
						slug: string;
						restoreEpoch: number;
					};
				}): Fetcher;
				TenantR2(opts: {
					props: {
						accountId: string;
						bucketName: string;
						token: string;
						siteId: string;
						slug: string;
						restoreEpoch: number;
					};
				}): Fetcher;
				TenantSession(opts: {
					props: { siteId: string; slug: string; restoreEpoch: number };
				}): Fetcher;
				TenantAiSearch(opts: {
					props: {
						instanceId: string;
						siteId: string;
						slug: string;
						restoreEpoch: number;
					};
				}): Fetcher;
				TenantPluginHost(opts: {
					props: {
						tenantSlug: string;
						siteId: string;
						bucketName: string;
						accountId: string;
						r2Token: string;
						restoreEpoch: number;
					};
				}): Fetcher;
				TenantRuntimeFailureTail(opts: { props: { slug: string } }): Fetcher;
			}
			const tenantExports = ctx.exports as unknown as TenantStubFactories;
			const tenantOutbound = tenantExports.CmsOutboundProxy({
				props: { siteId: org.siteId, slug, restoreEpoch },
			});
			const tenantR2 = tenantExports.TenantR2({
				props: {
					bucketName: org.r2BucketName,
					accountId,
					token: r2Token,
					siteId: org.siteId,
					slug,
					restoreEpoch,
				},
			});
			const tenantSession = tenantExports.TenantSession({
				props: { siteId: org.siteId, slug, restoreEpoch },
			});
			const tenantEmDashDB = tenantExports.TenantEmDashDB({
				props: { name: slug, siteId: org.siteId, slug, restoreEpoch },
			});
			const tenantAiSearch = tenantExports.TenantAiSearch({
				props: {
					instanceId: await tenantAiSearchInstanceId(slug),
					siteId: org.siteId,
					slug,
					restoreEpoch,
				},
			});
			const tenantPluginHost = pluginCanaryEnabled
				? tenantExports.TenantPluginHost({
						props: {
							tenantSlug: slug,
							siteId: org.siteId,
							bucketName: org.r2BucketName,
							accountId,
							r2Token,
							restoreEpoch,
						},
					})
				: null;
			return {
				compatibilityDate: "2026-05-14",
				compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
				mainModule: TENANT_RUNTIME_ENTRYPOINT_MODULE,
				modules,
				tails: [tenantExports.TenantRuntimeFailureTail({ props: { slug } })],
				globalOutbound: tenantOutbound,
				env: {
					DB_DO: tenantEmDashDB,
					MEDIA: tenantR2,
					SESSION: tenantSession,
					AI_SEARCH: tenantAiSearch,
					...(tenantPluginHost ? { PLUGIN_HOST: tenantPluginHost } : {}),
					// ASSETS binding intentionally omitted — Worker Loader doesn't
					// support Workers Assets. @astrojs/cloudflare calls env.ASSETS.fetch()
					// only for unmatched static paths; that TypeError is caught in the
					// loaderErr handler below and returned as 404.
					ORG_SLUG: slug,
					CMS_SITE_ID: org.siteId,
					SITE_TITLE: org.siteTitle,
					ENVIRONMENT: env.ENVIRONMENT,
					// Platform discovery defaults consumed by locked Tedix
					// Emdash plugins. Search Console verification and
					// robots policy are synced into native site:seo during
					// bundle deploy, not read from runtime env fallbacks.
					PLATFORM_BRANDING: org.brandingJson ?? "",
					PLATFORM_SOCIAL_LINKS: org.socialJson ?? "",
					// Tedix platform API base URL — used by trusted plugins
					// (e.g. emdash-newsletter) to call /rpc/tediEmail/sendEmail
					// from inside the tenant isolate. Falls back to the
					// per-environment default when PLATFORM_API_URL isn't set
					// on the cms-runtime Worker.
					PLATFORM_API_URL: resolveTenantPlatformApiUrl(env),
					// Descope project ID — required by the tenant's Descope auth
					// module (./src/auth/descope.ts) to validate admin JWTs.
					// Set via CF secret on this Worker; tenant reads via cloudflare:workers env.
					...(env.DESCOPE_PROJECT_ID
						? { DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID }
						: {}),
					...(env.DESCOPE_BASE_URL
						? { DESCOPE_BASE_URL: env.DESCOPE_BASE_URL }
						: {}),
					// Not the Worker-level shared secret. `internalAuthToken` is this
					// tenant's HMAC derivation of it; the parent verifies the real
					// secret and rewrites the inbound header to this value before
					// dispatch. A compromised tenant bundle therefore cannot read a
					// credential that authenticates against any other tenant. See
					// ./tenant-internal-auth.
					...(internalAuthToken
						? { CMS_INTERNAL_AUTH_TOKEN: internalAuthToken }
						: {}),
					...(humanAuthKey
						? {
								CMS_HUMAN_AUTH_KEY: humanAuthKey,
								CMS_HUMAN_AUTH_SITE_ID: org.siteId,
								CMS_HUMAN_AUTH_BUNDLE_ETAG: bundle.etag,
							}
						: {}),
					// Never forward the fleet key: tenant bundles only receive a
					// deterministic tenant-scoped derivative. Rotation preserves the
					// upstream new,old read-key order.
					...(env.EMDASH_ENCRYPTION_KEY
						? {
								EMDASH_ENCRYPTION_KEY: await deriveTenantEmdashEncryptionKeys(
									env.EMDASH_ENCRYPTION_KEY,
									org.siteId,
								),
							}
						: {}),
					DESCOPE_TENANT_ID: org.descopeTenantId,
					// Emdash config siteUrl is origin-only. Tenant route
					// prefixes are modeled by native collection urlPattern.
					...(publicOriginFrom(org.publicSiteUrl)
						? { SITE_URL: publicOriginFrom(org.publicSiteUrl)! }
						: {}),
					// Public origin/base URL. Native Emdash SEO plus
					// Tedix discovery routes emit against this host so
					// authority accrues to the customer's domain rather
					// than *.cms.tedix.dev.
					PUBLIC_SITE_URL: org.publicSiteUrl,
					// Reverse-proxy mount path for auxiliary discovery
					// routes. Keep it separate from SITE_URL so native
					// Emdash urlPattern remains the content URL source.
					PUBLIC_PATH_PREFIX: org.publicPathPrefix ?? "",
					// Per-org default locale. When set to a non-default
					// locale (e.g. "de"), the tenant middleware redirects
					// root-locale paths to `/{locale}/...` so German content
					// can live at the site root.
					DEFAULT_LOCALE: org.defaultLocale ?? "",
				},
			};
		},
	);

	return handle.getEntrypoint();
}

async function hotThemeResponse(
	env: Env,
	slug: string,
	pathname: string,
	method: string,
): Promise<Response | null> {
	// authz: public — public tenant-site theme CSS for the resolved site.
	if (pathname !== HOT_THEME_PUBLIC_PATH) return null;
	if (method !== "GET" && method !== "HEAD") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	}

	const [cssObject, manifestObject] = await Promise.all([
		env.TENANT_BUNDLES.get(hotThemeCssKey(slug)),
		env.TENANT_BUNDLES.get(hotThemeManifestKey(slug)),
	]);
	let revision = "none";
	let updatedAt: string | undefined;
	if (manifestObject) {
		try {
			const manifest = (await manifestObject.json()) as {
				revision?: unknown;
				updatedAt?: unknown;
			};
			if (typeof manifest.revision === "string") revision = manifest.revision;
			if (typeof manifest.updatedAt === "string")
				updatedAt = manifest.updatedAt;
		} catch {
			revision = cssObject?.customMetadata?.revision ?? "unknown";
		}
	} else if (cssObject?.customMetadata?.revision) {
		revision = cssObject.customMetadata.revision;
	}

	const headers = new Headers({
		"Content-Type": "text/css; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Tedix-Hot-Theme-Revision": revision,
	});
	if (updatedAt) headers.set("X-Tedix-Hot-Theme-Updated-At", updatedAt);
	if (cssObject?.httpEtag) headers.set("ETag", cssObject.httpEtag);

	if (!cssObject) {
		return new Response(
			method === "HEAD" ? null : "/* no Tedix hot theme published */\n",
			{
				status: 200,
				headers,
			},
		);
	}

	return new Response(method === "HEAD" ? null : await cssObject.text(), {
		status: 200,
		headers,
	});
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(body, null, 2), {
		...init,
		headers,
	});
}

function isInternalCmsRequest(request: Request, env: Env): boolean {
	const token = env.CMS_INTERNAL_AUTH_TOKEN;
	if (!token) return false;
	const header = request.headers.get("X-Tedix-CMS-Internal-Auth");
	if (header === token) return true;
	const authorization = request.headers.get("Authorization");
	return authorization === `Bearer ${token}`;
}

export interface DatabaseRuntimeAdminDependencies {
	lookupActiveBundle: typeof lookupActiveBundle;
	loadBundleModules: typeof loadBundleModules;
}

const DATABASE_RUNTIME_ADMIN_DEPENDENCIES: DatabaseRuntimeAdminDependencies = {
	lookupActiveBundle,
	loadBundleModules,
};

export async function databaseRuntimeAdminResponse(
	args: {
		env: Env;
		request: Request;
		slug: string;
		url: URL;
	},
	dependencies: DatabaseRuntimeAdminDependencies = DATABASE_RUNTIME_ADMIN_DEPENDENCIES,
): Promise<Response | null> {
	const { env, request, slug, url } = args;
	if (url.pathname !== DATABASE_RUNTIME_ADMIN_PATH) return null;

	if (!isInternalCmsRequest(request, env)) {
		return jsonResponse(
			{
				ok: false,
				error: env.CMS_INTERNAL_AUTH_TOKEN
					? "unauthorized"
					: "cms-runtime missing CMS_INTERNAL_AUTH_TOKEN",
			},
			{ status: 401 },
		);
	}

	if (!["GET", "HEAD"].includes(request.method)) {
		return jsonResponse(
			{ ok: false, error: "method not allowed" },
			{ status: 405, headers: { Allow: "GET, HEAD" } },
		);
	}

	const bundle = await dependencies.lookupActiveBundle(env, slug);
	let activeBundleReport: ActiveBundleRuntimeReport | null = null;
	if (bundle) {
		const { mainModule, modules } = await dependencies.loadBundleModules(
			env,
			bundle.r2Prefix,
		);
		activeBundleReport = {
			...detectBundleDatabaseAdapter(modules),
			mainModule,
			moduleCount: Object.keys(modules).length,
		};
	}

	return jsonResponse({
		ok: true,
		slug,
		databaseRuntime: {
			currentBackend: "durableObjects",
			durableObjectName: slug,
		},
		activeBundle: bundle
			? {
					version: bundle.version,
					r2Prefix: bundle.r2Prefix,
					etag: bundle.etag,
					mainModule: activeBundleReport?.mainModule ?? bundle.mainModule,
					moduleCount: activeBundleReport?.moduleCount ?? null,
					databaseAdapter: activeBundleReport?.adapter ?? "unknown",
					databaseAdapterEvidence: activeBundleReport?.evidence ?? [],
				}
			: null,
	});
}

/** A service credential alone cannot authorize deletion of a slug-owned resource.
 * The Workflow pins the immutable site ID after draining mutations and pausing
 * the canonical site; only that exact running receipt can reach a provider. */
async function cmsDeprovisionDeleteGuard(
	env: Env,
	request: Request,
	slug: string,
): Promise<Response | null> {
	const siteId = request.headers.get(CMS_SITE_ID_HEADER);
	if (!siteId) {
		return jsonResponse(
			{ ok: false, success: false, error: "CMS site ID required" },
			{ status: 400 },
		);
	}
	try {
		const db = createDbQueryClient(env.PLATFORM_DB);
		const site = await getCmsSiteBySlug(db, slug);
		if (!site || site.id !== siteId || site.status !== "paused") {
			return jsonResponse(
				{ ok: false, success: false, error: "CMS site identity mismatch" },
				{ status: 409 },
			);
		}
		const receipt = await getCmsDeprovisionOperation(db, siteId);
		if (
			!receipt ||
			receipt.slug !== site.slug ||
			receipt.organizationId !== site.organizationId ||
			receipt.authoringAppId !== site.authoringAppId ||
			receipt.status !== "running"
		) {
			return jsonResponse(
				{
					ok: false,
					success: false,
					error: "CMS deprovision receipt required",
				},
				{ status: 409 },
			);
		}
		return null;
	} catch {
		return jsonResponse(
			{
				ok: false,
				success: false,
				error: "CMS deprovision authority unavailable",
			},
			{ status: 503 },
		);
	}
}

export async function databaseDeprovisionAdminResponse(args: {
	env: Env;
	request: Request;
	slug: string;
	url: URL;
}): Promise<Response | null> {
	const { env, request, slug, url } = args;
	if (url.pathname !== DATABASE_DEPROVISION_ADMIN_PATH) return null;
	if (!isInternalCmsRequest(request, env)) {
		return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
	}
	if (request.method !== "DELETE") {
		return jsonResponse(
			{ ok: false, error: "method not allowed" },
			{ status: 405, headers: { Allow: "DELETE" } },
		);
	}
	const denied = await cmsDeprovisionDeleteGuard(env, request, slug);
	if (denied) return denied;
	const id = env.DB_DO.idFromName(slug);
	const stub = env.DB_DO.get(id) as unknown as EmDashDBStub;
	await stub.deleteTenantData();
	return jsonResponse({
		ok: true,
		slug,
		deletedStorage: true,
	});
}

/** Inspect tenant SQLite storage without importing D1 or requiring an active site. */
export async function databaseStorageAdminResponse(args: {
	env: Env;
	request: Request;
	slug: string;
	url: URL;
}): Promise<Response | null> {
	const { env, request, slug, url } = args;
	if (url.pathname !== DATABASE_STORAGE_ADMIN_PATH) return null;
	if (!isInternalCmsRequest(request, env)) {
		return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
	}
	if (request.method !== "GET") {
		return jsonResponse(
			{ ok: false, error: "method not allowed" },
			{ status: 405, headers: { Allow: "GET" } },
		);
	}
	try {
		const id = env.DB_DO.idFromName(slug);
		const stub = env.DB_DO.get(id) as unknown as EmDashDBStub;
		const result = await stub.query(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ec_%' LIMIT 1",
		);
		return jsonResponse({
			ok: true,
			slug,
			storageState: result.rows.length > 0 ? "present" : "missing",
		});
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			},
			{ status: 502 },
		);
	}
}

/** Capture a primary SQLite PITR bookmark for an active, exact-slug site. */
export async function databaseRecoveryBookmarkAdminResponse(args: {
	env: Env;
	request: Request;
	slug: string;
	url: URL;
	siteId: string;
	bundle: RecoveryBundleIdentity | null;
	readCurrentBundle: () => Promise<RecoveryBundleIdentity | null>;
}): Promise<Response | null> {
	const { env, request, slug, url, siteId, bundle, readCurrentBundle } = args;
	if (url.pathname !== DATABASE_RECOVERY_BOOKMARK_ADMIN_PATH) return null;
	if (!isInternalCmsRequest(request, env)) {
		return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
	}
	if (request.method !== "POST") {
		return jsonResponse(
			{ ok: false, error: "method not allowed" },
			{ status: 405, headers: { Allow: "POST" } },
		);
	}
	if (!bundle || bundle.slug !== slug || !siteId) {
		return jsonResponse(
			{ ok: false, error: "active CMS site and bundle required" },
			{ status: 409 },
		);
	}
	try {
		const stub = env.DB_DO.get(
			env.DB_DO.idFromName(slug),
		) as unknown as EmDashDBStub;
		const fixedDrillSite =
			siteId === CMS_SITE_DRILL_SITE_ID && slug === CMS_SITE_DRILL_SLUG;
		const drillProof = fixedDrillSite ? await stub.readSiteDrillProof() : null;
		const bookmark =
			drillProof?.bookmark ?? (await stub.captureRecoveryBookmark());
		if (!bookmark) {
			return jsonResponse(
				{ ok: false, error: "CMS SQLite storage missing" },
				{ status: 409 },
			);
		}
		const currentBundle = await readCurrentBundle();
		if (
			!currentBundle ||
			currentBundle.slug !== slug ||
			currentBundle.version !== bundle.version ||
			currentBundle.etag !== bundle.etag
		) {
			return jsonResponse(
				{ ok: false, error: "active CMS bundle changed during capture" },
				{ status: 409, headers: { "Cache-Control": "no-store" } },
			);
		}
		return jsonResponse(
			{
				ok: true,
				siteId,
				slug,
				bundle: { version: bundle.version, etag: bundle.etag },
				bookmark,
				...(drillProof
					? {
							databaseDigest: drillProof.databaseDigest,
							schedulerHeartbeatValue: drillProof.schedulerHeartbeatValue,
							schedulerHeartbeatRevision: drillProof.schedulerHeartbeatRevision,
						}
					: {}),
				capturedAt: new Date().toISOString(),
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch {
		return jsonResponse(
			{ ok: false, error: "CMS recovery bookmark unavailable" },
			{ status: 502 },
		);
	}
}

/** Internal only. Owner responses omit raw bookmarks and private object keys. */
export async function cmsRecoveryAdminResponse(args: {
	env: Env;
	request: Request;
	slug: string;
	url: URL;
}): Promise<Response | null> {
	const { env, request, slug, url } = args;
	if (url.pathname !== CMS_RECOVERY_ADMIN_PATH) return null;
	if (!isInternalCmsRequest(request, env))
		return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
	if (!["GET", "POST", "DELETE"].includes(request.method))
		return jsonResponse(
			{ ok: false, error: "method not allowed" },
			{
				status: 405,
				headers: { Allow: "GET, POST, DELETE" },
			},
		);
	const siteId = url.searchParams.get("siteId");
	if (!siteId || !/^[0-9a-f-]{36}$/.test(siteId))
		return jsonResponse(
			{ ok: false, error: "site ID required" },
			{ status: 400 },
		);
	if (request.method === "POST") {
		const authority = await readRecoveryAuthority(env, slug);
		if (!authority || authority.siteId !== siteId)
			return jsonResponse(
				{ ok: false, error: "active exact CMS site required" },
				{ status: 404 },
			);
		const captureId = crypto.randomUUID();
		const control: CmsRecoveryControl = {
			version: 1,
			siteId,
			slug,
			captureId,
			createdAt: new Date().toISOString(),
			state: "queued",
		};
		await putCmsRecoveryControl(env.RECOVERY_STORAGE, control);
		let status: "queued" | "unknown" = "queued";
		try {
			await env.CMS_RECOVERY_WORKFLOW.create({
				id: `${siteId}-${captureId}`,
				params: { siteId, slug, captureId },
			});
		} catch {
			// The create call can fail after admission. Keep the durable receipt so
			// status/purge remain available while the true run state is reconciled.
			status = "unknown";
		}
		return jsonResponse(
			{ ok: true, siteId, captureId, status },
			{
				status: 202,
				headers: { "Cache-Control": "no-store" },
			},
		);
	}
	const captureId = url.searchParams.get("captureId");
	if (request.method === "GET" && !captureId) {
		let cursor: string | undefined;
		let latest: CmsRecoveryManifest | null = null;
		const seen = new Set<string>();
		let scanned = 0;
		do {
			const page = await env.RECOVERY_STORAGE.list({
				prefix: `recovery/${siteId}/`,
				delimiter: "/",
				cursor,
				limit: 100,
			});
			for (const capturePrefix of page.delimitedPrefixes) {
				if (++scanned > 1000)
					throw new Error("CMS recovery capture inventory exceeded limit");
				const candidateCaptureId = capturePrefix.split("/")[2];
				if (!candidateCaptureId || !/^[0-9a-f-]{36}$/.test(candidateCaptureId))
					continue;
				const identity = { siteId, slug, captureId: candidateCaptureId };
				const storedControl = await env.RECOVERY_STORAGE.get(
					cmsRecoveryControlKey(siteId, candidateCaptureId),
				);
				if (!storedControl) continue;
				let control: unknown;
				try {
					control = await storedControl.json();
				} catch {
					continue;
				}
				if (
					!isCmsRecoveryControl(control, identity) ||
					control.state !== "verified"
				)
					continue;
				const stored = await env.RECOVERY_STORAGE.get(
					`${capturePrefix}manifest.json`,
				);
				if (!stored) continue;
				let candidate: unknown;
				try {
					candidate = await stored.json();
				} catch {
					continue;
				}
				if (
					!isCmsRecoveryManifest(candidate, identity) ||
					Date.now() >= Date.parse(candidate.retainUntil)
				)
					continue;
				if (!latest || candidate.capturedAt > latest.capturedAt)
					latest = candidate;
			}
			cursor = page.truncated ? page.cursor : undefined;
			if (cursor) {
				if (seen.has(cursor))
					throw new Error("CMS recovery list cursor repeated");
				seen.add(cursor);
			}
		} while (cursor);
		return jsonResponse(
			{
				ok: true,
				siteId,
				status: latest ? "verified" : "missing",
				...(latest
					? {
							captureId: latest.captureId,
							capturedAt: latest.capturedAt,
							retainUntil: latest.retainUntil,
							bundle: latest.bundle,
							media: { count: latest.media.count, bytes: latest.media.bytes },
						}
					: {}),
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
	if (!captureId || !/^[0-9a-f-]{36}$/.test(captureId))
		return jsonResponse(
			{ ok: false, error: "capture ID required" },
			{ status: 400 },
		);
	let purgePermit: {
		db: ReturnType<typeof createDbQueryClient>;
		permitId: string;
		restoreEpoch: number;
	} | null = null;
	if (request.method === "DELETE") {
		try {
			const db = createDbQueryClient(env.PLATFORM_DB);
			const site = await getCmsSiteBySlug(db, slug);
			if (site?.id === siteId) {
				const permitId = crypto.randomUUID();
				if (
					!(await enterCmsRecoveryPurgePermit(db, {
						siteId,
						slug,
						permitId,
						restoreEpoch: site.restoreEpoch,
						kind: "nested",
					}))
				)
					return jsonResponse(
						{ ok: false, error: "CMS recovery purge is fenced" },
						{ status: 409 },
					);
				purgePermit = { db, permitId, restoreEpoch: site.restoreEpoch };
			} else {
				// A completed deprovision receipt retains purge authority after the
				// canonical site row is gone, even if another site reuses its slug.
				const receipt = await getCmsDeprovisionOperation(db, siteId);
				if (!receipt || receipt.slug !== slug || receipt.status !== "succeeded")
					return jsonResponse(
						{ ok: false, error: "CMS recovery purge authority missing" },
						{ status: 409 },
					);
			}
		} catch {
			return jsonResponse(
				{ ok: false, error: "CMS recovery purge authority unavailable" },
				{ status: 503 },
			);
		}
	}
	const respond = async (): Promise<Response> => {
		const prefix = cmsRecoveryPrefix(siteId, captureId);
		const identity = { siteId, slug, captureId };
		const storedControl = await env.RECOVERY_STORAGE.get(
			cmsRecoveryControlKey(siteId, captureId),
		);
		if (!storedControl)
			return jsonResponse(
				{ ok: false, error: "capture not found" },
				{ status: 404 },
			);
		let controlValue: unknown;
		try {
			controlValue = await storedControl.json();
		} catch {
			return jsonResponse(
				{ ok: false, error: "capture control invalid" },
				{ status: 409 },
			);
		}
		if (!isCmsRecoveryControl(controlValue, identity))
			return jsonResponse(
				{ ok: false, error: "capture ownership mismatch" },
				{ status: 409 },
			);
		const control = controlValue;
		const manifestKey = `${prefix}manifest.json`;
		const manifestObject = await env.RECOVERY_STORAGE.get(manifestKey);
		let manifestValue: unknown;
		try {
			manifestValue = manifestObject ? await manifestObject.json() : null;
		} catch {
			manifestValue = null;
		}
		const manifest = isCmsRecoveryManifest(manifestValue, identity)
			? manifestValue
			: null;
		const invalidManifest = !!manifestObject && !manifest;
		let workflow: Awaited<ReturnType<WorkflowInstance["status"]>> | null = null;
		try {
			const instance = await env.CMS_RECOVERY_WORKFLOW.get(
				`${siteId}-${captureId}`,
			);
			workflow = await instance.status();
		} catch {
			// Workflow history can expire while the private control and backup remain.
		}
		if (request.method === "GET") {
			const expired = manifest
				? Date.now() >= Date.parse(manifest.retainUntil)
				: false;
			const failed =
				invalidManifest ||
				(control.state === "verified" && !manifest) ||
				workflow?.status === "errored" ||
				workflow?.status === "terminated";
			const staleUnknown =
				!workflow &&
				(control.state === "queued" || control.state === "running") &&
				Date.now() - Date.parse(control.createdAt) >= 24 * 60 * 60 * 1000;
			const status =
				control.state === "purged" ||
				control.state === "purging" ||
				control.state === "failed"
					? control.state
					: failed
						? "failed"
						: manifest && control.state === "verified"
							? expired
								? "expired"
								: "verified"
							: staleUnknown
								? "unknown"
								: workflow?.status === "queued" ||
									  workflow?.status === "running"
									? workflow.status
									: control.state;
			return jsonResponse(
				{
					ok: true,
					siteId,
					captureId,
					status,
					...(manifest && (status === "verified" || status === "expired")
						? {
								capturedAt: manifest.capturedAt,
								retainUntil: manifest.retainUntil,
								bundle: manifest.bundle,
								media: {
									count: manifest.media.count,
									bytes: manifest.media.bytes,
								},
							}
						: {}),
				},
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		if (control.state === "purged") {
			await abortCmsCaptureCronPause(
				createDbQueryClient(env.PLATFORM_DB),
				identity,
			);
			return jsonResponse(
				{ ok: true, siteId, captureId, status: "purged" },
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		if (control.state !== "purging") {
			if (
				workflow &&
				!["complete", "errored", "terminated"].includes(workflow.status)
			)
				return jsonResponse(
					{ ok: false, error: "capture still running" },
					{ status: 409 },
				);
			if (
				!workflow &&
				control.state !== "verified" &&
				control.state !== "failed"
			)
				return jsonResponse(
					{ ok: false, error: "capture terminal state unavailable" },
					{ status: 409 },
				);
		}
		await abortCmsCaptureCronPause(
			createDbQueryClient(env.PLATFORM_DB),
			identity,
		);
		await purgeCmsRecoveryObjects(env.RECOVERY_STORAGE, control);
		return jsonResponse(
			{ ok: true, siteId, captureId, status: "purged" },
			{ headers: { "Cache-Control": "no-store" } },
		);
	};
	let outcome: { ok: true; response: Response } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, response: await respond() };
	} catch (error) {
		outcome = { ok: false, error };
	}
	if (purgePermit) {
		const { db, permitId, restoreEpoch } = purgePermit;
		try {
			if (
				!(await leaveCmsRestorePermit(db, {
					siteId,
					slug,
					permitId,
					restoreEpoch,
					kind: "nested",
				}))
			)
				throw new CmsRestoreFenceUnavailableError();
		} catch {
			throw new CmsRestoreFenceUnavailableError();
		}
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.response;
}

/** Read only the schema facts needed to diagnose a failed Emdash field create. */
function publicCmsSiteRestoreStatus(receipt: CmsSiteRestoreReceipt) {
	return {
		ok: true,
		siteId: receipt.siteId,
		captureId: receipt.captureId,
		generation: receipt.generation,
		phase: receipt.phase,
		createdAt: receipt.createdAt,
		updatedAt: receipt.updatedAt,
		...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
	};
}

/** Service-only exact-site admission and sanitized status for general restore. */
export async function cmsSiteRestoreAdminResponse(args: {
	env: Env;
	request: Request;
	slug: string;
	url: URL;
}): Promise<Response | null> {
	const { env, request, slug, url } = args;
	if (url.pathname !== CMS_SITE_RESTORE_ADMIN_PATH) return null;
	if (!isInternalCmsRequest(request, env))
		return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
	if (request.method !== "GET" && request.method !== "POST")
		return jsonResponse(
			{ ok: false, error: "method not allowed" },
			{ status: 405, headers: { Allow: "GET, POST" } },
		);
	const siteId = url.searchParams.get("siteId");
	if (!siteId || !/^[0-9a-f-]{36}$/.test(siteId))
		return jsonResponse(
			{ ok: false, error: "site ID required" },
			{ status: 400 },
		);
	const db = createDbClient(env.PLATFORM_DB);
	const site = await getCmsSiteBySlug(db, slug);
	if (site?.id !== siteId)
		return jsonResponse(
			{ ok: false, error: "exact CMS site required" },
			{ status: 404 },
		);
	if (request.method === "GET") {
		if (url.searchParams.get("list") === "1") {
			const receipts: ReturnType<typeof publicCmsSiteRestoreStatus>[] = [];
			let cursor: string | undefined;
			do {
				const page = await env.RECOVERY_STORAGE.list({
					prefix: `recovery/restores/${siteId}/`,
					...(cursor ? { cursor } : {}),
				});
				for (const object of page.objects) {
					const match = object.key.match(
						new RegExp(
							`^recovery/restores/${siteId}/([0-9a-f-]{36})/receipt\\.json$`,
						),
					);
					if (!match) continue;
					const raw = await env.RECOVERY_STORAGE.get(object.key);
					if (!raw) throw new Error("CMS restore receipt disappeared");
					const candidate =
						(await raw.json()) as Partial<CmsSiteRestoreReceipt>;
					if (typeof candidate.captureId !== "string")
						throw new Error("CMS restore receipt invalid");
					const state = await readCmsSiteRestoreReceipt(env.RECOVERY_STORAGE, {
						siteId,
						slug,
						captureId: candidate.captureId,
						generation: match[1]!,
					});
					if (!state) throw new Error("CMS restore receipt disappeared");
					receipts.push(publicCmsSiteRestoreStatus(state.receipt));
				}
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			return jsonResponse(
				{ ok: true, receipts },
				{
					headers: { "Cache-Control": "no-store" },
				},
			);
		}
		const preflightCaptureId = url.searchParams.get("preflightCaptureId");
		if (preflightCaptureId) {
			if (!/^[0-9a-f-]{36}$/.test(preflightCaptureId))
				return jsonResponse(
					{ ok: false, error: "capture ID invalid" },
					{ status: 400 },
				);
			const authority = await readRecoveryAuthority(env, slug);
			if (authority?.siteId !== siteId)
				return jsonResponse(
					{ ok: false, error: "active CMS authority unavailable" },
					{ status: 409 },
				);
			try {
				const target = await readVerifiedCmsRecoveryCapture(
					env.RECOVERY_STORAGE,
					{
						siteId,
						slug,
						captureId: preflightCaptureId,
					},
				);
				return jsonResponse(
					{
						ok: true,
						restorable:
							target.manifest.version === 2 &&
							target.manifest.digestAlgorithm ===
								CMS_RECOVERY_DIGEST_ALGORITHM &&
							target.manifest.bundle.version === authority.bundle.version &&
							target.manifest.bundle.etag === authority.bundle.etag,
					},
					{ headers: { "Cache-Control": "no-store" } },
				);
			} catch (error) {
				console.error("CMS restore preflight failed", error);
				return jsonResponse(
					{ ok: false, error: "capture verification failed" },
					{ status: 409 },
				);
			}
		}
		const generation = url.searchParams.get("generation");
		if (!generation || !/^[0-9a-f-]{36}$/.test(generation))
			return jsonResponse(
				{ ok: false, error: "generation required" },
				{ status: 400 },
			);
		const raw = await env.RECOVERY_STORAGE.get(
			`recovery/restores/${siteId}/${generation}/receipt.json`,
		);
		if (!raw)
			return jsonResponse(
				{ ok: false, error: "restore not found" },
				{ status: 404 },
			);
		const candidate = (await raw.json()) as Partial<CmsSiteRestoreReceipt>;
		if (typeof candidate.captureId !== "string")
			throw new Error("CMS restore receipt invalid");
		const state = await readCmsSiteRestoreReceipt(env.RECOVERY_STORAGE, {
			siteId,
			slug,
			captureId: candidate.captureId,
			generation,
		});
		if (!state) throw new Error("CMS restore receipt disappeared");
		return jsonResponse(publicCmsSiteRestoreStatus(state.receipt), {
			headers: { "Cache-Control": "no-store" },
		});
	}
	if (site.status !== "active")
		return jsonResponse(
			{ ok: false, error: "active CMS site required" },
			{ status: 409 },
		);
	let body: { siteId?: unknown; captureId?: unknown; mode?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return jsonResponse(
			{ ok: false, error: "invalid request" },
			{ status: 400 },
		);
	}
	if (
		body.siteId !== siteId ||
		typeof body.captureId !== "string" ||
		!/^[0-9a-f-]{36}$/.test(body.captureId) ||
		(body.mode !== "restore" && body.mode !== "roundtrip")
	)
		return jsonResponse(
			{ ok: false, error: "invalid request" },
			{ status: 400 },
		);
	const authority = await readRecoveryAuthority(env, slug);
	if (authority?.siteId !== siteId)
		return jsonResponse(
			{ ok: false, error: "active CMS authority unavailable" },
			{ status: 409 },
		);
	const identity = { siteId, slug, captureId: body.captureId };
	const target = await readVerifiedCmsRecoveryCapture(
		env.RECOVERY_STORAGE,
		identity,
	);
	if (
		target.manifest.version !== 2 ||
		target.manifest.digestAlgorithm !== CMS_RECOVERY_DIGEST_ALGORITHM ||
		target.manifest.bundle.version !== authority.bundle.version ||
		target.manifest.bundle.etag !== authority.bundle.etag
	)
		return jsonResponse(
			{ ok: false, error: "restorable v2 capture required" },
			{ status: 409 },
		);
	const generation = crypto.randomUUID();
	const now = new Date().toISOString();
	const receipt: CmsSiteRestoreReceipt = {
		version: 1,
		...identity,
		generation,
		phase: "claimed",
		mode: body.mode,
		createdAt: now,
		updatedAt: now,
		bundle: authority.bundle,
	};
	await claimCmsSiteRestoreReceipt(env.RECOVERY_STORAGE, receipt);
	try {
		await env.CMS_SITE_RESTORE_WORKFLOW.create({
			id: `${siteId}-${generation}`,
			params: { ...identity, generation, mode: body.mode },
		});
	} catch {
		// The Workflow create result can be lost after admission. The immutable
		// receipt and deterministic instance ID preserve operator reconciliation.
	}
	return jsonResponse(publicCmsSiteRestoreStatus(receipt), {
		status: 202,
		headers: { "Cache-Control": "no-store" },
	});
}

export async function databaseSchemaDiagnosticResponse(args: {
	env: Env;
	request: Request;
	slug: string;
	url: URL;
}): Promise<Response | null> {
	const { env, request, slug, url } = args;
	if (url.pathname !== DATABASE_SCHEMA_DIAGNOSTIC_PATH) return null;
	if (!isInternalCmsRequest(request, env)) {
		return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
	}
	if (request.method !== "GET") {
		return jsonResponse(
			{ ok: false, error: "method not allowed" },
			{ status: 405, headers: { Allow: "GET" } },
		);
	}
	try {
		const id = env.DB_DO.idFromName(slug);
		const stub = env.DB_DO.get(id) as unknown as EmDashDBStub;
		const [
			columns,
			fields,
			blockVersions,
			activation,
			coverage,
			coverageColumns,
		] = await Promise.all([
			stub.query("PRAGMA table_info(ec_pages)"),
			stub.query(
				"SELECT field.slug FROM _emdash_fields AS field JOIN _emdash_collections AS collection ON collection.id = field.collection_id WHERE collection.slug = ? AND field.slug = ?",
				["pages", "content"],
			),
			stub.query(
				"SELECT COUNT(*) AS total FROM _emdash_block_types AS block JOIN _emdash_block_type_versions AS version ON version.block_type_id = block.id AND version.version = block.current_version WHERE block.slug LIKE 'marketing_%'",
			),
			stub.query(
				"SELECT state FROM _emdash_media_usage_activation WHERE task_key = ?",
				["incremental_capture"],
			),
			stub.query(
				"SELECT status.capture_state, status.status, status.change_epoch, status.last_error_code, CASE WHEN status.collection_id = collection.id THEN 1 ELSE 0 END AS collection_matches FROM _emdash_media_usage_index_status AS status LEFT JOIN _emdash_collections AS collection ON collection.slug = status.scope_key WHERE status.adapter_id = ? AND status.scope_type = ? AND status.scope_key = ?",
				["content-media", "collection", "pages"],
			),
			stub.query("PRAGMA table_info(_emdash_media_usage_index_status)"),
		]);
		const coverageColumnNames = new Set(
			coverageColumns.rows.map((row) => row.name),
		);
		return jsonResponse({
			ok: true,
			slug,
			pagesTablePresent: columns.rows.length > 0,
			contentColumnPresent: columns.rows.some((row) => row.name === "content"),
			contentFieldPresent: fields.rows.length > 0,
			activeMarketingBlockVersionCount: Number(
				blockVersions.rows[0]?.total ?? 0,
			),
			mediaUsageActivationState: activation.rows[0]?.state ?? null,
			pagesMediaUsageCaptureState: coverage.rows[0]?.capture_state ?? null,
			pagesMediaUsageIndexStatus: coverage.rows[0]?.status ?? null,
			pagesMediaUsageChangeEpoch: coverage.rows[0]?.change_epoch ?? null,
			pagesMediaUsageLastErrorCode: coverage.rows[0]?.last_error_code ?? null,
			pagesMediaUsageCollectionMatches:
				coverage.rows[0]?.collection_matches === 1,
			pagesMediaUsageIndexColumnsPresent: [
				"change_epoch",
				"reconciliation_required",
				"updated_at",
			].every((name) => coverageColumnNames.has(name)),
		});
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			},
			{ status: 502 },
		);
	}
}

/** An uncertain provider create keeps its exact-site claim for reconciliation. */
async function withCmsMediaBucketPermit<T>(
	db: ReturnType<typeof createDbQueryClient>,
	identity: { siteId: string; slug: string; restoreEpoch: number },
	enter: typeof enterCmsRestorePermit,
	run: () => Promise<T>,
): Promise<{ admitted: false } | { admitted: true; value: T }> {
	const permit = {
		...identity,
		permitId: crypto.randomUUID(),
		kind: "nested" as const,
	};
	let admitted: boolean;
	try {
		admitted = await enter(db, permit);
	} catch {
		throw new CmsRestoreFenceUnavailableError();
	}
	if (!admitted) return { admitted: false };
	let unknownOutcome = false;
	try {
		return { admitted: true, value: await run() };
	} catch (error) {
		unknownOutcome = error instanceof CmsMediaBucketCreateOutcomeUnknownError;
		throw error;
	} finally {
		if (!unknownOutcome) {
			try {
				if (!(await leaveCmsRestorePermit(db, permit)))
					throw new CmsRestoreFenceUnavailableError();
			} catch {
				throw new CmsRestoreFenceUnavailableError();
			}
		}
	}
}

export async function mediaBucketAdminResponse(args: {
	accountId: string;
	env: Env;
	r2Token: string;
	request: Request;
	slug: string;
	url: URL;
}): Promise<Response | null> {
	const { accountId, env, r2Token, request, slug, url } = args;
	if (url.pathname !== MEDIA_BUCKET_ADMIN_PATH) return null;
	if (!isInternalCmsRequest(request, env)) {
		return jsonResponse(
			{ success: false, error: "unauthorized" },
			{ status: 401 },
		);
	}
	if (!["GET", "POST", "DELETE"].includes(request.method)) {
		return jsonResponse(
			{ success: false, error: "method not allowed" },
			{ status: 405, headers: { Allow: "GET, POST, DELETE" } },
		);
	}
	if (request.method === "POST") {
		const intent = request.headers.get(MEDIA_BUCKET_INTENT_HEADER);
		if (intent !== "create" && intent !== "repair") {
			return jsonResponse(
				{ success: false, error: "CMS media intent required" },
				{ status: 400 },
			);
		}
		const siteId = request.headers.get(CMS_SITE_ID_HEADER);
		if (
			!siteId ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				siteId,
			)
		) {
			return jsonResponse(
				{ success: false, error: "CMS site ID required" },
				{ status: 400 },
			);
		}
		let site: Awaited<ReturnType<typeof getCmsSiteBySlug>>;
		let db: ReturnType<typeof createDbQueryClient>;
		try {
			db = createDbQueryClient(env.PLATFORM_DB);
			site = await getCmsSiteBySlug(db, slug);
		} catch {
			return cmsRestoreFenceResponse();
		}
		if (!site || site.id !== siteId) {
			return jsonResponse(
				{ success: false, error: "CMS site identity mismatch" },
				{ status: 409 },
			);
		}
		if (intent === "repair" && site.status !== "active") {
			return jsonResponse(
				{ success: false, error: "active CMS site required" },
				{ status: 409 },
			);
		}
		try {
			const config = { accountId, apiToken: r2Token };
			const permitted = await withCmsMediaBucketPermit(
				db,
				{ siteId, slug, restoreEpoch: site.restoreEpoch },
				intent === "create"
					? enterCmsProvisioningPermit
					: enterCmsRestorePermit,
				() => provisionCmsMediaBucket(config, slug),
			);
			if (!permitted.admitted) return cmsRestoreFenceResponse();
			return jsonResponse({ success: true, ...permitted.value });
		} catch (error) {
			if (error instanceof CmsRestoreFenceUnavailableError)
				return cmsRestoreFenceResponse();
			return jsonResponse(
				{
					success: false,
					error: error instanceof Error ? error.message : String(error),
				},
				{ status: 502 },
			);
		}
	}
	try {
		const config = { accountId, apiToken: r2Token };
		if (request.method === "DELETE") {
			const denied = await cmsDeprovisionDeleteGuard(env, request, slug);
			if (denied) return denied;
			const deleted = await deleteCmsMediaBucket(config, slug);
			return jsonResponse({ success: true, deleted });
		}
		const result = await inspectCmsMediaBucket(config, slug);
		return jsonResponse({ success: true, ...result });
	} catch (error) {
		return jsonResponse(
			{
				success: false,
				error: error instanceof Error ? error.message : String(error),
			},
			{ status: 502 },
		);
	}
}

// ── Main fetch handler ────────────────────────────────────────────

async function fetchCmsSite(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	knownHost?: { slug: string; customDomain: boolean } | null,
	knownAlias?: Awaited<ReturnType<typeof getCmsSiteByActiveWwwAlias>>,
	knownRestoreEpoch?: number,
): Promise<Response> {
	const url = new URL(request.url);
	// authz: public — liveness + deployed-sha probe; serves no tenant data.
	if (
		(request.method === "GET" || request.method === "HEAD") &&
		url.hostname === "cms.tedix.dev" &&
		url.pathname === "/health"
	) {
		return Response.json(
			{
				status: "ok",
				service: "cms-runtime",
				deployedSha: env.GIT_SHA,
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
	const marketing = await marketingResponse(request, env);
	if (marketing) return marketing;
	const companionRedirect = await wwwCompanionRedirect(
		request,
		url,
		env,
		knownAlias,
	);
	if (companionRedirect) return companionRedirect;
	const resolvedHost =
		knownHost === undefined ? await resolveSlug(env, url.hostname) : knownHost;
	if (!resolvedHost) {
		return new Response("Not Found — invalid CMS hostname", { status: 404 });
	}
	const { slug } = resolvedHost;

	const accountId = env.CF_ACCOUNT_ID;
	const r2Token = env.CLOUDFLARE_R2_API_TOKEN;
	if (!accountId || !r2Token) {
		return new Response(
			"cms-runtime misconfigured: missing CF_ACCOUNT_ID or CLOUDFLARE_R2_API_TOKEN",
			{ status: 503 },
		);
	}
	// Deprovision pauses the site before invoking these service-only routes.
	// They must remain reachable even when public tenant routing is disabled.
	const databaseDeprovision = await databaseDeprovisionAdminResponse({
		env,
		request,
		slug,
		url,
	});
	if (databaseDeprovision) return databaseDeprovision;

	const databaseStorage = await databaseStorageAdminResponse({
		env,
		request,
		slug,
		url,
	});
	if (databaseStorage) return databaseStorage;
	const schemaDiagnostic = await databaseSchemaDiagnosticResponse({
		env,
		request,
		slug,
		url,
	});
	if (schemaDiagnostic) return schemaDiagnostic;

	const mediaBucketAdmin = await mediaBucketAdminResponse({
		accountId,
		env,
		r2Token,
		request,
		slug,
		url,
	});
	if (mediaBucketAdmin) return mediaBucketAdmin;

	if (url.pathname === DATABASE_RECOVERY_BOOKMARK_ADMIN_PATH) {
		if (!isInternalCmsRequest(request, env)) {
			return jsonResponse(
				{ ok: false, error: "unauthorized" },
				{ status: 401 },
			);
		}
		const activeSite = await lookupOrg(env, slug, true);
		if (!activeSite) {
			return jsonResponse(
				{ ok: false, error: "active CMS site required" },
				{ status: 404 },
			);
		}
		const bundle = await lookupUniqueRecoveryBundle(env, slug);
		return (await databaseRecoveryBookmarkAdminResponse({
			env,
			request,
			slug,
			url,
			siteId: activeSite.siteId,
			bundle,
			readCurrentBundle: () => lookupUniqueRecoveryBundle(env, slug),
		}))!;
	}
	const recoveryAdmin = await cmsRecoveryAdminResponse({
		env,
		request,
		slug,
		url,
	});
	if (recoveryAdmin) return recoveryAdmin;
	const siteRestoreAdmin = await cmsSiteRestoreAdminResponse({
		env,
		request,
		slug,
		url,
	});
	if (siteRestoreAdmin) return siteRestoreAdmin;
	const spans: ParentSpans = {};
	const preDispatchStarted = Date.now();
	const org = await span(spans, "tenant.lookupOrg", () =>
		lookupOrg(
			env,
			slug,
			resolvedHost.customDomain ||
				hasAttestedCmsHumanIdentity(request, env.CMS_INTERNAL_AUTH_TOKEN),
		),
	);
	if (!org) {
		return new Response(`Not Found — no CMS for "${slug}"`, { status: 404 });
	}

	const brokerResponse = await handleCmsSessionBroker(
		request,
		env,
		org.descopeTenantId,
		slug,
	);
	if (brokerResponse) return brokerResponse;

	const databaseRuntimeAdmin = await databaseRuntimeAdminResponse({
		env,
		request,
		slug,
		url,
	});
	if (databaseRuntimeAdmin) return databaseRuntimeAdmin;

	if (request.method === "GET" || request.method === "HEAD") {
		if (shouldRedirectCmsOriginRequest(request, url, env, org)) {
			// authz: public — public tenant-site robots.txt.
			if (url.pathname === "/robots.txt") {
				return applyEdgeCacheHeaders(
					originRobotsResponse(org),
					request.method,
					url.pathname,
				);
			}
			// authz: public — not a route: canonical-origin redirect for public GET/HEAD site pages.
			if (
				isOriginRedirectablePath(url.pathname) ||
				(isMarketingHost(url.hostname, env) &&
					!url.pathname.startsWith("/_") &&
					!url.pathname.startsWith("/api/"))
			) {
				const redirectTarget = canonicalPublicUrl(
					org,
					url.pathname,
					url.search,
				);
				if (redirectTarget) {
					return applyEdgeCacheHeaders(
						withCmsAgentDiscoveryLinks(
							Response.redirect(redirectTarget, 301),
							org,
						),
						request.method,
						url.pathname,
					);
				}
			}
		}
	}

	// Reverse-proxy-normalized, but not yet safe to hand to the isolate: the
	// Studio internal-auth header is still the raw shared secret at this
	// point. `tenantRequest` below is the authenticated, re-scoped copy.
	const { request: normalizedPublicRequest, url: tenantUrl } =
		normalizePublicProxyRequest(request, url, org);
	const normalizedRequest = withCmsProductSession(
		normalizedPublicRequest,
		env.CMS_INTERNAL_AUTH_TOKEN,
	);

	const hotTheme = await hotThemeResponse(
		env,
		slug,
		tenantUrl.pathname,
		request.method,
	);
	if (hotTheme) return hotTheme;

	// ── WebMCP bridge + JSON-RPC endpoint (/_tedix/webmcp/*) ──────────────
	// Served at the parent level, same shape as hotThemeResponse above.
	// Tenants get the read-only default packs unless metadata policy disables
	// the surface or narrows its pack list.
	// Public proxy normalization transfers the original body stream; read its
	// normalized copy so JSON-RPC POSTs remain parseable on custom domains.
	// See ./webmcp.ts for the bridge script contract and tool implementation.
	const webMcp = await handleWebMcpRequest(
		normalizedRequest,
		org,
		tenantUrl.pathname,
		env.WEBMCP_RATE_LIMITER,
	);
	if (webMcp) return webMcp;

	// ── Static assets (/_astro/*) ─────────────────────────────────────────
	// Astro's SSR bundle can't serve static assets on its own — it needs an
	// ASSETS binding that Worker Loader doesn't supply. We store content-hashed
	// assets (fonts, CSS chunks, JS) in TENANT_BUNDLES under
	// static/{slug}/{filename} during deploy and serve them here before the
	// Worker Loader is ever invoked. Cache-Control is immutable because Astro
	// content-hashes every filename.
	// authz: public — public content-hashed Astro static assets for the tenant site.
	if (
		knownRestoreEpoch !== undefined &&
		publicAssetCacheEligible(request) &&
		(tenantUrl.pathname.startsWith("/_astro/") ||
			tenantUrl.pathname === IMAGE_ENDPOINT_ROUTE)
	) {
		const props: TenantCachedAssetProps = {
			siteId: org.siteId,
			slug,
			restoreEpoch: knownRestoreEpoch,
			hostname: url.hostname,
			r2BucketName: org.r2BucketName,
			publicPathPrefix: org.publicPathPrefix,
		};
		try {
			const factories = ctx.exports as unknown as {
				TenantCachedAssets(options: { props: TenantCachedAssetProps }): Fetcher;
				TenantR2(options: {
					props: {
						bucketName: string;
						accountId: string;
						token: string;
						siteId: string;
						slug: string;
						restoreEpoch: number;
					};
				}): { head(key: string): Promise<{ httpEtag: string } | null> };
			};
			if (tenantUrl.pathname === IMAGE_ENDPOINT_ROUTE) {
				const key = tenantMediaKeyFromHref(
					tenantUrl.searchParams.get("href"),
					org.publicPathPrefix,
				);
				if (key && parseTransformParams(tenantUrl.searchParams).ok) {
					const metadata = await factories
						.TenantR2({
							props: {
								bucketName: org.r2BucketName,
								accountId,
								token: r2Token,
								siteId: org.siteId,
								slug,
								restoreEpoch: knownRestoreEpoch,
							},
						})
						.head(key);
					if (metadata?.httpEtag) props.sourceEtag = metadata.httpEtag;
				}
			}
			if (tenantUrl.pathname.startsWith("/_astro/") || props.sourceEtag) {
				const cached = await factories
					.TenantCachedAssets({ props })
					.fetch(publicAssetCacheRequest(tenantUrl));
				if (cached.status === 200)
					return publicAssetClientResponse(
						request,
						cached,
						Boolean(props.sourceEtag),
					);
				await cached.body?.cancel();
			}
		} catch (error) {
			console.error(
				"[cms-runtime] asset cache failed; serving uncached",
				error,
			);
		}
	}
	const staticAsset = await staticAssetResponse(
		request,
		env.TENANT_BUNDLES,
		slug,
		tenantUrl.pathname,
	);
	if (staticAsset) return staticAsset;

	// ── Image transforms (/_image) ────────────────────────────────────────
	// See imageTransformResponse() above: the real Cloudflare Images binding
	// can't be forwarded into the dispatched isolate, so transforms are
	// served directly from this parent Worker. Any non-match (wrong route,
	// non-EmDash media, non-raster source, or an error) falls through to
	// Worker Loader dispatch unchanged.
	const imageTransform = await imageTransformResponse(
		env,
		org,
		accountId,
		r2Token,
		tenantUrl,
	);
	if (imageTransform) return imageTransform;

	const bundle = await span(spans, "tenant.lookupBundle", () =>
		lookupActiveBundle(env, slug),
	);
	if (!bundle) {
		return new Response(`502 — no active bundle for "${slug}"`, {
			status: 502,
		});
	}

	try {
		const restoreEpoch =
			knownRestoreEpoch ??
			(await getCmsRestoreEpoch(createDbQueryClient(env.PLATFORM_DB), {
				siteId: org.siteId,
				slug,
			}));
		if (restoreEpoch === null) return cmsRestoreFenceResponse();
		const internalAuthToken = await deriveTenantInternalAuthToken(
			env.CMS_INTERNAL_AUTH_TOKEN,
			slug,
			bundle.version,
			restoreEpoch,
		);
		const humanAuthKey =
			org.humanAssertionBundleEtag === bundle.etag
				? await deriveTenantHumanAuthKey({
						sharedToken: env.CMS_INTERNAL_AUTH_TOKEN,
						siteId: org.siteId,
						slug,
						bundleEtag: bundle.etag,
					})
				: undefined;
		const tenantEntrypointArgs = {
			accountId,
			r2Token,
			bundle,
			internalAuthToken,
			humanAuthKey,
			org,
			slug,
			restoreEpoch,
			spans,
		};
		const baseLoaderKey = `${tenantRuntimeCacheKey(slug, bundle, org, env)}@restore:${restoreEpoch}`;
		const fetchTenant = (tenantFetchRequest: Request) =>
			fetchWithTenantLoaderRecovery(
				tenantFetchRequest,
				baseLoaderKey,
				tenantLoaderRecovery,
				(loaderKey) =>
					getTenantEntrypoint(env, ctx, tenantEntrypointArgs, loaderKey),
				() => {
					console.warn("[cms-runtime] tenant loader clone version retry", {
						tenant: slug,
					});
				},
			);

		// Authenticate the Studio internal-auth header here, in the parent that
		// owns the shared secret, and hand the isolate only its own derived
		// value. See ./tenant-internal-auth.
		let tenantRequest = rewriteTenantInternalAuthHeader(normalizedRequest, {
			sharedToken: env.CMS_INTERNAL_AUTH_TOKEN,
			tenantToken: internalAuthToken,
		});
		tenantRequest = await forwardCmsHumanAssertion({
			original: normalizedPublicRequest,
			tenantRequest,
			sharedToken: env.CMS_INTERNAL_AUTH_TOKEN,
			key: humanAuthKey,
			expected: {
				siteId: org.siteId,
				slug,
				bundleEtag: bundle.etag,
				tenantId: org.descopeTenantId,
			},
		});
		const protectedTenantRequest = await protectLeadFormIp(tenantRequest, {
			originalRequest: request,
			secret: env.LEAD_FORM_IP_HASH_HMAC_KEY,
			slug,
		});
		if (protectedTenantRequest instanceof Response) {
			return protectedTenantRequest;
		}
		tenantRequest = protectedTenantRequest;

		let loaderResponse: Response;
		try {
			spans["tenant.preDispatch"] = Date.now() - preDispatchStarted;
			loaderResponse = await span(spans, "loader.fetch", () =>
				fetchTenant(tenantRequest),
			);
			if (isSoftNotFound(loaderResponse, tenantRequest)) {
				loaderResponse = await span(spans, "loader.notFoundFetch", () =>
					fetchTenant(
						new Request(new URL("/404", tenantRequest.url), tenantRequest),
					),
				);
			}
		} catch (loaderErr) {
			if (loaderErr instanceof CmsRestoreFenceUnavailableError) {
				console.error(`[cms-runtime] restore permit unavailable for ${slug}`);
				return cmsRestoreFenceResponse();
			}
			const loaderMsg =
				loaderErr instanceof Error ? loaderErr.message : String(loaderErr);
			// @astrojs/cloudflare calls env.ASSETS.fetch() for unmatched static paths.
			// Worker Loader doesn't support a real ASSETS binding so we omit it;
			// the resulting TypeError means "no such static file" → 404.
			if (
				loaderMsg.includes("ASSETS") ||
				loaderMsg.includes("reading 'fetch'")
			) {
				return new Response("Not Found", { status: 404 });
			}
			console.error(`[cms-runtime] loader fetch threw for ${slug}:`, loaderErr);
			return new Response(`Loader error: ${loaderMsg}`, { status: 502 });
		}

		const brokerDiagnostic = diagnoseCmsProductSession(request, env, {
			projectId: env.DESCOPE_PROJECT_ID,
			tenantId: org.descopeTenantId,
		});
		// authz: public — not a route: diagnostic log after the tenant runtime already enforced admin auth.
		if (
			brokerDiagnostic &&
			url.pathname.startsWith("/_emdash/admin") &&
			(loaderResponse.status === 401 ||
				(loaderResponse.status >= 300 && loaderResponse.status < 400))
		) {
			console.warn(
				JSON.stringify({
					event: "cms.session_broker_tenant_rejected",
					status: loaderResponse.status,
					...brokerDiagnostic,
					...diagnoseCmsTenantRejection(tenantRequest, loaderResponse),
				}),
			);
		}

		// Buffer the response body from the Worker Loader boundary.
		// The LOADER binding returns responses as ReadableStream regardless of
		// how the inner worker serialised them (even ArrayBuffer). HTML, JSON,
		// and error responses all need to be drained here — the "content-length
		// set, unaffected" assumption was wrong: the boundary re-streams
		// everything, so JSON API error bodies arrive as empty streams without
		// this buffering step.
		let response = loaderResponse;
		const ct = loaderResponse.headers.get("content-type") ?? "";
		const shouldBuffer =
			loaderResponse.body &&
			(ct.startsWith("text/html") ||
				ct.startsWith("application/xml") ||
				ct.startsWith("text/xml") ||
				ct.startsWith("application/json") ||
				loaderResponse.status >= 400);
		if (shouldBuffer) {
			try {
				const headers = new Headers(loaderResponse.headers);
				const body = await span(spans, "loader.buffer", () =>
					loaderResponse.arrayBuffer(),
				);
				const shouldPatchReverseProxyText =
					ct.startsWith("text/html") ||
					ct.startsWith("application/xml") ||
					ct.startsWith("text/xml") ||
					ct.startsWith("text/plain");
				// `Uint8Array<ArrayBuffer>`, not bare `Uint8Array`: Emdash 0.34's
				// `db/do-sql` types side-effect import `emdash`, whose type chain
				// references `astro/client` and so pulls `lib.dom` into this
				// Worker's program. DOM's `BufferSource` accepts only an
				// `ArrayBuffer`-backed view, so the default `ArrayBufferLike`
				// type argument no longer satisfies `BodyInit`.
				let responseBody: ArrayBuffer | Uint8Array<ArrayBuffer> = body;
				if (shouldPatchReverseProxyText) {
					const decodedBody = new TextDecoder().decode(body);
					const textBody = ct.startsWith("text/html")
						? ensureWebMcpBridge(ensureHotThemeLink(decodedBody), org)
						: canonicalizeSitemapUrls(
								decodedBody,
								sitemapUsesTrailingSlash(org, env),
								loaderResponse.headers.get("X-EmDash-Sitemap-Canonical") ===
									"1",
							);
					responseBody = new TextEncoder().encode(
						patchReverseProxyHtml(textBody, org),
					);
				}
				headers.set("content-length", String(responseBody.byteLength));
				headers.delete("transfer-encoding");
				response = new Response(responseBody, {
					status: loaderResponse.status,
					statusText: loaderResponse.statusText,
					headers,
				});
			} catch (bufErr) {
				console.error(`[cms-runtime] html buffer failed for ${slug}:`, bufErr);
				response = new Response(
					`Buffer error: ${bufErr instanceof Error ? bufErr.message : String(bufErr)}`,
					{ status: 502 },
				);
			}
		}
		const location = patchReverseProxyLocation(
			response.headers.get("location"),
			org,
		);
		if (location && location !== response.headers.get("location")) {
			const headers = new Headers(response.headers);
			headers.set("location", location);
			response = new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}
		const requestHost = effectiveRequestHost(tenantRequest, tenantUrl.host);
		response = applyEdgeResponseHeaders(
			response,
			requestHost,
			org,
			tenantUrl.pathname,
		);
		response = applyContentSignal(response);
		response = applyEdgeCacheHeaders(
			response,
			request.method,
			tenantUrl.pathname,
		);

		// Emit the parent-side spans. Without this the tenant isolate's own
		// Server-Timing is all you see, and a parent-side regression (a cold
		// bundle read costing 15s) is invisible — which is exactly how the
		// packed-bundle path was dropped and went unnoticed in production.
		const parentTiming = parentServerTiming(spans);
		if (parentTiming) {
			const timed = new Headers(response.headers);
			timed.append("Server-Timing", parentTiming);
			response = new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: timed,
			});
		}

		return withCmsAgentDiscoveryLinks(response, org);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[cms-runtime] ${slug} ${url.pathname}:`, msg);
		return new Response("Internal Server Error", { status: 500 });
	}
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		// Health is installation-scoped. Service-only routes must remain reachable
		// while the public site is closed for a restore; each handler checks auth.
		if (
			(url.hostname === "cms.tedix.dev" && url.pathname === "/health") ||
			[
				DATABASE_RUNTIME_ADMIN_PATH,
				DATABASE_DEPROVISION_ADMIN_PATH,
				DATABASE_STORAGE_ADMIN_PATH,
				DATABASE_RECOVERY_BOOKMARK_ADMIN_PATH,
				CMS_RECOVERY_ADMIN_PATH,
				CMS_SITE_RESTORE_ADMIN_PATH,
				DATABASE_SCHEMA_DIAGNOSTIC_PATH,
				MEDIA_BUCKET_ADMIN_PATH,
			].includes(url.pathname)
		)
			return fetchCmsSite(request, env, ctx);
		if (url.hostname === env.CLI_DOWNLOAD_HOST)
			return fetchCmsSite(request, env, ctx);
		if (
			!env.MARKETING_SITE_SLUG &&
			(isMarketingHost(url.hostname, env) || url.hostname === "blog.tedix.dev")
		)
			return cmsRestoreFenceResponse();

		try {
			const db = createDbQueryClient(env.PLATFORM_DB);
			const isPublicAlias =
				(request.method === "GET" || request.method === "HEAD") &&
				isWwwCompanionPublicPath(url.pathname);
			const alias = isPublicAlias
				? await getCmsSiteByActiveWwwAlias(db, url.hostname)
				: null;
			const marketingSlug =
				env.MARKETING_SITE_SLUG &&
				(isMarketingHost(url.hostname, env) ||
					url.hostname === "blog.tedix.dev")
					? env.MARKETING_SITE_SLUG
					: null;
			const resolved = alias
				? null
				: marketingSlug
					? { slug: marketingSlug, customDomain: false }
					: await resolveSlug(env, url.hostname);
			const slug = alias?.slug ?? marketingSlug ?? resolved?.slug;
			if (!slug) return fetchCmsSite(request, env, ctx, resolved, alias);
			const site = alias ?? (await getCmsSiteBySlug(db, slug));
			if (!site) return cmsRestoreFenceResponse();
			const identity = {
				siteId: site.id,
				slug: site.slug,
				restoreEpoch: site.restoreEpoch,
			};
			const run = () =>
				fetchCmsSite(request, env, ctx, resolved, alias, site.restoreEpoch);
			const permitted = await withCmsRestoreResponsePermit(
				db,
				identity,
				async () => {
					if (
						request.method !== "POST" ||
						!isMarketingContactPath(url.pathname)
					)
						return run();
					const contact = await withCmsRestorePermit(db, identity, run);
					return contact.admitted ? contact.value : cmsRestoreFenceResponse();
				},
			);
			return permitted.admitted ? permitted.value : cmsRestoreFenceResponse();
		} catch (error) {
			console.error("[cms-runtime] public restore permit unavailable:", error);
			return cmsRestoreFenceResponse();
		}
	},

	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		const startedAt = Date.now();
		const accountId = env.CF_ACCOUNT_ID;
		const r2Token = env.CLOUDFLARE_R2_API_TOKEN;
		if (!accountId || !r2Token) {
			console.error(
				"[cms-runtime] scheduled fanout misconfigured: missing CF_ACCOUNT_ID or CLOUDFLARE_R2_API_TOKEN",
			);
			return;
		}

		let bundles: TenantBundle[];
		try {
			bundles = await listActiveBundles(env);
		} catch (err) {
			console.error(
				"[cms-runtime] scheduled fanout bundle lookup failed:",
				err,
			);
			return;
		}

		const counters = {
			attempted: 0,
			succeeded: 0,
			skipped: 0,
			failed: 0,
		};

		for (const bundle of bundles) {
			const slug = bundle.slug;
			try {
				const org = await lookupOrg(env, slug);
				if (!org) {
					counters.skipped += 1;
					console.warn(
						`[cms-runtime] scheduled fanout skipped ${slug}: no CMS org`,
					);
					continue;
				}
				const pause = await fixedSiteCronPauseDecision(env.RECOVERY_STORAGE, {
					siteId: org.siteId,
					slug,
				});
				if (pause.pause) {
					counters.skipped += 1;
					console.warn(
						`[cms-runtime] scheduled fanout skipped ${slug}: ${pause.reason}`,
					);
					continue;
				}
				const restoreEpoch = await getCmsRestoreEpoch(
					createDbQueryClient(env.PLATFORM_DB),
					{ siteId: org.siteId, slug },
				);
				if (restoreEpoch === null) {
					counters.skipped += 1;
					continue;
				}

				const permitted = await withCmsRestorePermit(
					createDbQueryClient(env.PLATFORM_DB),
					{ siteId: org.siteId, slug, restoreEpoch },
					async () => {
						const tenantEntrypoint = getTenantEntrypoint(env, ctx, {
							accountId,
							r2Token,
							bundle,
							// Same deterministic derivation as the request path, so a cron
							// fanout that wins the loader cache miss bakes an identical env.
							internalAuthToken: await deriveTenantInternalAuthToken(
								env.CMS_INTERNAL_AUTH_TOKEN,
								slug,
								bundle.version,
								restoreEpoch,
							),
							humanAuthKey:
								org.humanAssertionBundleEtag === bundle.etag
									? await deriveTenantHumanAuthKey({
											sharedToken: env.CMS_INTERNAL_AUTH_TOKEN,
											siteId: org.siteId,
											slug,
											bundleEtag: bundle.etag,
										})
									: undefined,
							org,
							slug,
							restoreEpoch,
							// Off-request: there is no response to carry Server-Timing, so
							// this is a sink for the loader factory's own instrumentation.
							spans: {},
						}) as TenantScheduledFetcher;

						if (typeof tenantEntrypoint.scheduled !== "function") {
							counters.skipped += 1;
							console.warn(
								`[cms-runtime] scheduled fanout skipped ${slug}: tenant entrypoint has no scheduled handler`,
							);
							return false;
						}

						counters.attempted += 1;
						await tenantEntrypoint.scheduled({
							cron: controller.cron,
							scheduledTime: controller.scheduledTime,
						} as ScheduledController);
						return true;
					},
					undefined,
					"scheduled",
				);
				if (!permitted.admitted) {
					counters.skipped += 1;
					console.warn(
						`[cms-runtime] scheduled fanout skipped ${slug}: scheduled write permit unavailable`,
					);
				} else if (permitted.value) {
					counters.succeeded += 1;
				}
			} catch (err) {
				counters.failed += 1;
				console.error(
					`[cms-runtime] scheduled fanout failed for ${slug}:`,
					err,
				);
			}
		}

		console.log(
			`[cms-runtime] scheduled fanout complete cron=${controller.cron} tenants=${bundles.length} attempted=${counters.attempted} succeeded=${counters.succeeded} skipped=${counters.skipped} failed=${counters.failed} durationMs=${Date.now() - startedAt}`,
		);
	},
} satisfies ExportedHandler<Env>;
