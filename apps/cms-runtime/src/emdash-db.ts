import { PublicRestorePermits } from "./public-restore-permits";
import { createHash } from "node:crypto";
import { EmDashDB as EmdashSqlDB } from "@emdash-cms/cloudflare/db/do-sql";
import {
	CMS_PITR_SELF_TEST_DO_NAME,
	CMS_PITR_SELF_TEST_RECEIPT_KEY,
	type CmsPitrSelfTestReceipt,
} from "./cms-pitr-self-test-workflow";
import {
	insertSiteDrillSentinel,
	readSiteDrillCapture,
	readSiteDrillIdentity,
	readSiteDrillReceipt,
	writeSiteDrillReceipt,
	type CmsSiteDrillIdentity,
	type CmsSiteDrillProof,
} from "./cms-site-restore-drill-workflow";
import {
	readCmsSiteRestoreReceipt,
	type CmsSiteRestoreIdentity,
} from "./cms-site-restore-receipt";
import {
	CmsRestoreFenceUnavailableError,
	type CmsRestoreFenceIdentity,
	withCmsRestorePermit,
} from "./tenant-restore-fence";
import type {
	CollectionDeletionGuardInput,
	CollectionDeletionGuardResult,
} from "emdash";
import { createDbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	countCmsRestorePermitsForSite,
	getCmsRestoreFenceState,
} from "@tedix/db/queries/cms-restore-fences";
import { rotateCmsSitePageCacheRevision } from "@tedix/db/queries/cms-sites";
import {
	CMS_RECOVERY_DIGEST_ALGORITHM,
	cmsRecoveryPrefix,
	isCmsRecoveryControl,
	isCmsRecoveryManifest,
	readRecoveryAuthority,
} from "./cms-recovery-workflow";
import { type Env } from "./env";
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
	private databasePermits = new PublicRestorePermits();

	private async withPageCacheInvalidation<
		T extends DoQueryResult | DoQueryResult[],
	>(
		identity: CmsRestoreFenceIdentity,
		statements: DoQueryStatement[],
		run: () => Promise<T>,
	): Promise<T> {
		let results: DoQueryResult[] | undefined;
		try {
			const result = await run();
			results = Array.isArray(result) ? result : [result];
			return result;
		} finally {
			if (
				statements.some(({ sql, params }, index) => {
					if (sql.includes(";")) return true;
					if (PLAIN_SELECT_PATTERN.test(sql)) return false;
					// Native maintenance does not alter public content.
					const normalized = sql
						.replaceAll('"', "")
						.replaceAll("`", "")
						.replace(/\s+/g, " ")
						.trim()
						.toLowerCase();
					if (results?.[index]?.changes === 0) {
						const target = sql.match(
							/^\s*(?:insert\s+into|update|delete\s+from)\s+(?:"([a-z_][a-z0-9_]*)"|`([a-z_][a-z0-9_]*)`|([a-z_][a-z0-9_]*))(?=\s|\()/i,
						);
						const table = (
							target?.[1] ??
							target?.[2] ??
							target?.[3]
						)?.toLowerCase();
						// changes() excludes trigger writes, including INSTEAD OF
						// triggers on views. Unknown SQL and failed batches invalidate.
						if (
							table &&
							this.ctx.storage.sql
								.exec(
									"SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) = ? LIMIT 1",
									table,
								)
								.toArray().length === 0
						)
							return false;
					}
					if (
						/^(?:insert into|update|delete from) (?:_emdash_404_log|_emdash_cron_tasks|_plugin_indexes)\b/.test(
							normalized,
						)
					)
						return false;
					if (
						/^create (?:unique )?index if not exists u?idx_plugin_[a-z0-9_-]+ on _plugin_storage\s*\(/.test(
							normalized,
						) ||
						/^drop index if exists u?idx_plugin_[a-z0-9_-]+$/.test(normalized)
					)
						return false;
					if (
						params?.length === 5 &&
						params[0] === "system:scheduler:last_completed_at" &&
						normalized ===
							"insert into options (name, value, revision) values (?, ?, ?) on conflict (name) do update set value = ?, revision = ?"
					)
						return false;
					return true;
				})
			) {
				await rotateCmsSitePageCacheRevision(
					createDbQueryClient(this.siteDrillEnv().PLATFORM_DB),
					{ ...identity, revision: crypto.randomUUID() },
				);
				console.info("[cms-runtime] page cache revision advanced", {
					tenant: identity.slug,
					statements: statements.map(({ sql, params }) => ({
						tableGroup: tenantDbQueryFamily(sql),
						parameterCount: params?.length ?? 0,
						multipleStatements: sql.includes(";"),
						schedulerHeartbeat:
							params?.includes("system:scheduler:last_completed_at") ?? false,
					})),
				});
			}
		}
	}

	private async withDatabasePermit<T>(
		identity: CmsRestoreFenceIdentity,
		run: () => Promise<T>,
	): Promise<T> {
		const env = this.siteDrillEnv();
		if (
			this.ctx.id.toString() !== env.DB_DO.idFromName(identity.slug).toString()
		)
			throw new CmsRestoreFenceUnavailableError();
		const queries = this.databasePermits.forRequest((task) =>
			this.ctx.waitUntil(task),
		);
		const result = await withCmsRestorePermit(
			createDbQueryClient(env.PLATFORM_DB),
			identity,
			run,
			{
				// Publish the cold reservation before the next caller enters.
				enter: (db, permit) =>
					this.ctx.blockConcurrencyWhile(() => queries.enter(db, permit)),
				leave: queries.leave,
			},
		);
		if (!result.admitted) throw new CmsRestoreFenceUnavailableError();
		return result.value;
	}

	/** Tenant storage, session and egress operations run in the caller's
	 * isolate but borrow this object's shared nested reservation. The borrower
	 * lasts until the caller's callback settles or its isolate disconnects. */
	async runWithRestorePermit(
		identity: CmsRestoreFenceIdentity,
		run: () => Promise<void>,
	): Promise<void> {
		const primary = (
			this.ctx.storage as DurableObjectStorage & { primary?: EmDashDBStub }
		).primary;
		if (primary) return await primary.runWithRestorePermit(identity, run);
		await this.withDatabasePermit(identity, run);
	}

	async queryWithRestorePermit(
		identity: CmsRestoreFenceIdentity,
		sql: string,
		params?: unknown[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult> {
		const primary = (
			this.ctx.storage as DurableObjectStorage & { primary?: EmDashDBStub }
		).primary;
		if (primary)
			return await primary.queryWithRestorePermit(identity, sql, params, opts);
		return await this.withDatabasePermit(identity, () =>
			this.withPageCacheInvalidation(identity, [{ sql, params }], () =>
				super.query(sql, params, opts),
			),
		);
	}

	async batchQueryWithRestorePermit(
		identity: CmsRestoreFenceIdentity,
		statements: DoQueryStatement[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult[]> {
		const primary = (
			this.ctx.storage as DurableObjectStorage & { primary?: EmDashDBStub }
		).primary;
		if (primary)
			return await primary.batchQueryWithRestorePermit(
				identity,
				statements,
				opts,
			);
		return await this.withDatabasePermit(identity, () =>
			this.withPageCacheInvalidation(identity, statements, () =>
				super.batchQuery(statements, opts),
			),
		);
	}

	private siteDrillEnv(): Pick<
		Env,
		"DB_DO" | "RECOVERY_STORAGE" | "PLATFORM_DB" | "TENANT_BUNDLES"
	> {
		return this.env as unknown as Pick<
			Env,
			"DB_DO" | "RECOVERY_STORAGE" | "PLATFORM_DB" | "TENANT_BUNDLES"
		>;
	}

	private async siteDrill(): Promise<CmsSiteDrillIdentity> {
		const drill = await readSiteDrillIdentity(
			this.siteDrillEnv().RECOVERY_STORAGE,
		);
		if (!drill)
			throw new Error("CMS site restore drill is not configured");
		if (
			this.ctx.id.toString() !==
			this.siteDrillEnv().DB_DO.idFromName(drill.slug).toString()
		)
			throw new Error("CMS site restore drill object identity mismatch");
		return drill;
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
		await this.siteDrill();
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
		const drill = await this.siteDrill();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.prepareSiteDrillMutation();
		const env = this.siteDrillEnv();
		const receipt = await readSiteDrillReceipt(env.RECOVERY_STORAGE, drill);
		if (receipt?.phase === "mutated" || receipt?.phase === "media-deleted")
			return;
		if (receipt?.phase !== "claimed")
			throw new Error("CMS site restore drill not claimed");
		const { manifest, records } = await readSiteDrillCapture(
			env.RECOVERY_STORAGE,
			drill,
		);
		const authority = await readRecoveryAuthority(env as Env, drill.slug);
		if (
			authority?.siteId !== drill.siteId ||
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
			await writeSiteDrillReceipt(env.RECOVERY_STORAGE, drill, {
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
		await writeSiteDrillReceipt(env.RECOVERY_STORAGE, drill, {
			...receipt,
			phase: "mutated",
		});
	}

	async scheduleSiteDrillRestore(): Promise<void> {
		const drill = await this.siteDrill();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.scheduleSiteDrillRestore();
		const env = this.siteDrillEnv();
		const receipt = await readSiteDrillReceipt(env.RECOVERY_STORAGE, drill);
		if (receipt?.phase === "restore-scheduled") return;
		if (receipt?.phase !== "media-deleted")
			throw new Error("CMS site restore drill media deletion not verified");
		if (this.siteDrillSentinel() !== "after")
			throw new Error("CMS site restore drill sentinel mutation unavailable");
		const { manifest } = await readSiteDrillCapture(
			env.RECOVERY_STORAGE,
			drill,
		);
		const undoBookmark = await this.ctx.storage.onNextSessionRestoreBookmark(
			manifest.bookmark,
		);
		await writeSiteDrillReceipt(env.RECOVERY_STORAGE, drill, {
			...receipt,
			phase: "restore-scheduled",
			undoBookmark,
		});
	}

	async restartSiteDrill(): Promise<void> {
		const drill = await this.siteDrill();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.restartSiteDrill();
		const receipt = await readSiteDrillReceipt(
			this.siteDrillEnv().RECOVERY_STORAGE,
			drill,
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
		const drill = await this.siteDrill();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.scheduleSiteDrillUndo();
		const env = this.siteDrillEnv();
		const receipt = await readSiteDrillReceipt(env.RECOVERY_STORAGE, drill);
		if (receipt?.phase === "undo-scheduled") return;
		if (receipt?.phase !== "restored" || !receipt.undoBookmark)
			throw new Error("CMS site restore drill undo unavailable");
		if (this.siteDrillSentinel() !== "absent")
			throw new Error("CMS site restore drill restore not observed");
		const redoBookmark = await this.ctx.storage.onNextSessionRestoreBookmark(
			receipt.undoBookmark,
		);
		await writeSiteDrillReceipt(env.RECOVERY_STORAGE, drill, {
			...receipt,
			phase: "undo-scheduled",
			redoBookmark,
		});
	}

	async scheduleSiteDrillFinalRestore(): Promise<void> {
		const drill = await this.siteDrill();
		const primary = this.siteDrillPrimary();
		if (primary) return primary.scheduleSiteDrillFinalRestore();
		const env = this.siteDrillEnv();
		const receipt = await readSiteDrillReceipt(env.RECOVERY_STORAGE, drill);
		if (receipt?.phase === "final-scheduled") return;
		if (receipt?.phase !== "undone" || !receipt.redoBookmark)
			throw new Error("CMS site restore drill final restore unavailable");
		if (this.siteDrillSentinel() !== "after")
			throw new Error("CMS site restore drill undo not observed");
		const { manifest } = await readSiteDrillCapture(
			env.RECOVERY_STORAGE,
			drill,
		);
		const finalUndoBookmark =
			await this.ctx.storage.onNextSessionRestoreBookmark(manifest.bookmark);
		await writeSiteDrillReceipt(env.RECOVERY_STORAGE, drill, {
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

export interface DoQueryResult {
	rows: Record<string, unknown>[];
	changes?: number;
	bookmark?: string;
}

export interface DoQueryStatement {
	sql: string;
	params?: unknown[];
}

export interface EmDashDBStub {
	runWithRestorePermit(
		identity: CmsRestoreFenceIdentity,
		run: () => Promise<void>,
	): Promise<void>;
	queryWithRestorePermit(
		identity: CmsRestoreFenceIdentity,
		sql: string,
		params?: unknown[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult>;
	batchQueryWithRestorePermit(
		identity: CmsRestoreFenceIdentity,
		statements: DoQueryStatement[],
		opts?: { bookmark?: string },
	): Promise<DoQueryResult[]>;
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

export const PLAIN_SELECT_PATTERN = /^\s*select\b/i;
const TENANT_DB_PRIMARY_TABLE_PATTERN =
	/\b(?:from|join|into|update)\s+["`]?([a-z_][a-z0-9_]*)["`]?/i;

// Diagnostic query classification. Emit only fixed categories, never a
// tenant-authored table name, SQL text, or bound values.
export function tenantDbQueryFamily(sql: string): string {
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
