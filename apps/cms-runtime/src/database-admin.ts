import {
	CMS_SITE_DRILL_SITE_ID,
	CMS_SITE_DRILL_SLUG,
} from "./cms-site-restore-drill-workflow";
import {
	CmsRestoreFenceUnavailableError,
	cmsRestoreFenceResponse,
} from "./tenant-restore-fence";
import {
	CmsMediaBucketCreateOutcomeUnknownError,
	deleteCmsMediaBucket,
	inspectCmsMediaBucket,
	provisionCmsMediaBucket,
} from "@tedix/provisioning/cms";
import { createDbQueryClient } from "@tedix/db/query-client";
import { getCmsDeprovisionOperation } from "@tedix/db/queries/cms-deprovision-operations";
import {
	enterCmsProvisioningPermit,
	enterCmsRestorePermit,
	leaveCmsRestorePermit,
} from "@tedix/db/queries/cms-restore-fences";
import { getCmsSiteBySlug } from "@tedix/db/queries/cms-sites";
import { type EmDashDBStub } from "./emdash-db";
import { type Env } from "./env";
import {
	DATABASE_DEPROVISION_ADMIN_PATH,
	DATABASE_STORAGE_ADMIN_PATH,
	DATABASE_RECOVERY_BOOKMARK_ADMIN_PATH,
	DATABASE_SCHEMA_DIAGNOSTIC_PATH,
	MEDIA_BUCKET_ADMIN_PATH,
	MEDIA_BUCKET_INTENT_HEADER,
	CMS_SITE_ID_HEADER,
	jsonResponse,
	isInternalCmsRequest,
} from "./internal-admin-http";

export interface RecoveryBundleIdentity {
	slug: string;
	version: number;
	etag: string;
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
