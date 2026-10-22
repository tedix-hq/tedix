import {
	publicAssetCacheEligible,
	publicAssetCacheRequest,
	publicAssetClientResponse,
	imageRepresentationEtag,
} from "./tenant-public-cache";
import {
	anonymousPageRequest,
	cachedTenantPage,
	pageCacheEligible,
	pageCacheKey,
} from "./tenant-page-cache";
import { staticAssetResponse } from "./static-assets";
import {
	publicRestorePermitEligible,
	publicRestorePermitQueries,
} from "./public-restore-permits";
import {
	isMarketingHost,
	isMarketingContactPath,
	marketingResponse,
} from "./marketing";
import { WorkerEntrypoint } from "cloudflare:workers";
import { withDynamicWorkerLoaderDiagnostics } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { fixedSiteCronPauseDecision } from "./cms-site-cron-pause";
import {
	CmsRestoreFenceUnavailableError,
	cmsRestoreFenceResponse,
	type CmsRestoreFenceIdentity,
	withCmsRestorePermit,
	withCmsRestoreResponsePermit,
	withSharedCmsRestorePermit,
} from "./tenant-restore-fence";
import type {
	CollectionDeletionGuardInput,
	CollectionDeletionGuardResult,
} from "emdash";
import { listTenantBundleVersions } from "@tedix/provisioning/cms";
import { createDbQueryClient } from "@tedix/db/query-client";
import { getCmsRestoreEpoch } from "@tedix/db/queries/cms-restore-fences";
import {
	getCmsSiteByActiveWwwAlias,
	getCmsSiteBySlug,
} from "@tedix/db/queries/cms-sites";
import {
	getActiveTenantBundle,
	listActiveTenantBundles,
} from "@tedix/db/queries/tenant-bundles";
import type { TenantBundle } from "@tedix/db/schema/tenant-bundles";
import { parseTransformParams } from "emdash/media/image-endpoint";
import {
	applyContentSignal,
	applyEdgeCacheHeaders,
} from "./edge-cache-headers";
import { withCmsAgentDiscoveryLinks } from "./agent-discovery";
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
	cmsAuthRejectionCodes,
	diagnoseCmsProductSession,
	diagnoseCmsTenantRejection,
	handleCmsSessionBroker,
	withCmsProductSession,
} from "./session-broker";
import { ensureWebMcpBridge, handleWebMcpRequest } from "./webmcp";
import {
	type DoQueryResult,
	type DoQueryStatement,
	type EmDashDBStub,
	PLAIN_SELECT_PATTERN,
	tenantDbQueryFamily,
} from "./emdash-db";
import {
	getDb,
	resolveSlug,
	isWwwCompanionPublicPath,
	wwwCompanionRedirect,
	type OrgInfo,
	HOT_THEME_PUBLIC_PATH,
	hotThemeCssKey,
	hotThemeManifestKey,
	publicOriginFrom,
	canonicalizeSitemapUrls,
	sitemapUsesTrailingSlash,
	patchReverseProxyHtml,
	ensureHotThemeLink,
	patchReverseProxyLocation,
	normalizePublicProxyRequest,
	canonicalPublicUrl,
	shouldRedirectCmsOriginRequest,
	isSoftNotFound,
	isOriginRedirectablePath,
	originRobotsResponse,
	effectiveRequestHost,
	applyEdgeResponseHeaders,
	lookupOrg,
} from "./public-proxy";
import {
	CF_API,
	IMAGE_ENDPOINT_ROUTE,
	tenantMediaKeyFromHref,
	imageTransformResponse,
} from "./tenant-media";
import { type Env } from "./env";
import {
	DATABASE_RUNTIME_ADMIN_PATH,
	DATABASE_DEPROVISION_ADMIN_PATH,
	DATABASE_STORAGE_ADMIN_PATH,
	DATABASE_RECOVERY_BOOKMARK_ADMIN_PATH,
	CMS_RECOVERY_ADMIN_PATH,
	CMS_SITE_RESTORE_ADMIN_PATH,
	DATABASE_SCHEMA_DIAGNOSTIC_PATH,
	MEDIA_BUCKET_ADMIN_PATH,
	jsonResponse,
	isInternalCmsRequest,
} from "./internal-admin-http";
import {
	databaseDeprovisionAdminResponse,
	databaseStorageAdminResponse,
	databaseRecoveryBookmarkAdminResponse,
	databaseSchemaDiagnosticResponse,
	mediaBucketAdminResponse,
	type RecoveryBundleIdentity,
} from "./database-admin";
import {
	cmsRecoveryAdminResponse,
	cmsSiteRestoreAdminResponse,
} from "./recovery-admin";

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

// Keep a timer active if a nested DO read RPC stalls, then retry once. The
// four-second bound sits beyond the observed production DO query tail. Only
// plain SELECTs are retried: writes can complete even when their reply is lost.
const TENANT_DB_READ_TIMEOUT_MS = 4_000;

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
function withTenantStoragePermit<T>(
	env: Env,
	identity: { siteId: string; slug: string; restoreEpoch: number },
	run: () => Promise<T>,
): Promise<T> {
	return withSharedCmsRestorePermit(env.DB_DO, identity, run);
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
		const selectOnly = PLAIN_SELECT_PATTERN.test(sql) && !sql.includes(";");
		// Diagnostic trace: identify the statement class and nested RPC
		// boundary without recording SQL or parameter values.
		console.info("[cms-runtime] tenant database query entered", {
			tenant: this.ctx.props.name,
			selectOnly,
			tableGroup: tenantDbQueryFamily(sql),
		});
		// Keep this WorkerEntrypoint invocation pending until the nested DO RPC settles.
		const result = selectOnly
			? await retryTenantDbRead(
					() =>
						this.stub().queryWithRestorePermit(
							this.ctx.props,
							sql,
							params,
							opts,
						),
					"SELECT RPC",
					this.ctx.props.name,
				)
			: await this.stub().queryWithRestorePermit(
					this.ctx.props,
					sql,
					params,
					opts,
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
		const selectOnly = statements.every(
			(statement) =>
				PLAIN_SELECT_PATTERN.test(statement.sql) &&
				!statement.sql.includes(";"),
		);
		// Diagnostic trace: Logpush keeps these lines in the same RPC
		// invocation as a hang, without recording SQL or parameter values.
		console.info("[cms-runtime] tenant database batch entered", {
			tenant: this.ctx.props.name,
			selectOnly,
			count: statements.length,
		});
		const result = selectOnly
			? await retryTenantDbRead(
					() =>
						this.stub().batchQueryWithRestorePermit(
							this.ctx.props,
							statements,
							opts,
						),
					"SELECT batch RPC",
					this.ctx.props.name,
				)
			: await this.stub().batchQueryWithRestorePermit(
					this.ctx.props,
					statements,
					opts,
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
		await withSharedCmsRestorePermit(env.DB_DO, identity, () =>
			writeCompressedBundle(env, r2Prefix, json),
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

// ── Main fetch handler ────────────────────────────────────────────

async function fetchCmsSite(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	knownHost?: { slug: string; customDomain: boolean } | null,
	knownAlias?: Awaited<ReturnType<typeof getCmsSiteByActiveWwwAlias>>,
	knownRestoreEpoch?: number,
	knownPageCacheRevision?: string,
	knownBundle?: TenantBundle | null,
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

	const bundle =
		knownBundle === undefined
			? await span(spans, "tenant.lookupBundle", () =>
					lookupActiveBundle(env, slug),
				)
			: knownBundle;
	if (!bundle) {
		return new Response(`502 — no active bundle for "${slug}"`, {
			status: 502,
		});
	}

	try {
		const site =
			knownPageCacheRevision === undefined
				? await getCmsSiteBySlug(createDbQueryClient(env.PLATFORM_DB), slug)
				: null;
		const pageRevision =
			knownPageCacheRevision ?? site?.config?.pageCacheRevision ?? "0";
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
		// Publication must also discard EmDash's isolate-lifetime settings cache.
		const publicPageEligible = pageCacheEligible(request, tenantUrl.pathname);
		const baseLoaderKey = `${tenantRuntimeCacheKey(slug, bundle, org, env, publicPageEligible ? pageRevision : undefined)}@restore:${restoreEpoch}`;
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
			const pageKey = publicPageEligible
				? await pageCacheKey(request, tenantUrl, {
						siteId: org.siteId,
						slug,
						restoreEpoch,
						bundleEtag: bundle.etag,
						bundleVersion: bundle.version,
						contentRevision: pageRevision,
					})
				: null;
			loaderResponse = await span(spans, "loader.fetch", () =>
				pageKey
					? cachedTenantPage({
							// Emdash's types pull in lib.dom, whose CacheStorage lacks `default`.
							cache: (caches as unknown as { default: Cache }).default,
							key: pageKey,
							templateSlug: org.templateSlug,
							waitUntil: (promise) => ctx.waitUntil(promise),
							render: () => fetchTenant(anonymousPageRequest(tenantRequest)),
						})
					: fetchTenant(tenantRequest),
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
			pageCacheEligible(request, tenantUrl.pathname) &&
				["HIT", "MISS", "STALE"].includes(
					response.headers.get("X-Tedix-Page-Cache") ?? "",
				),
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
			// Both reads stay fresh. Overlap platform metadata I/O before admission;
			// tenant content and cache bodies still require the restore permit.
			const [site, bundle] = await Promise.all([
				alias ?? getCmsSiteBySlug(db, slug),
				pageCacheEligible(request, url.pathname)
					? lookupActiveBundle(env, slug)
					: undefined,
			]);
			if (!site) {
				// Only an unclaimed platform subdomain is provably absent; the
				// marketing site and custom domains keep failing closed.
				if (!marketingSlug && resolved && !resolved.customDomain)
					return new Response("CMS site not found", {
						status: 404,
						headers: { "Cache-Control": "no-store" },
					});
				return cmsRestoreFenceResponse();
			}
			const identity = {
				siteId: site.id,
				slug: site.slug,
				restoreEpoch: site.restoreEpoch,
			};
			const run = () =>
				fetchCmsSite(
					request,
					env,
					ctx,
					resolved,
					alias,
					site.restoreEpoch,
					site.config?.pageCacheRevision ?? "0",
					bundle,
				);
			const restoreQueries = publicRestorePermitEligible(request)
				? () => publicRestorePermitQueries((task) => ctx.waitUntil(task))
				: undefined;
			const permitted = await withCmsRestoreResponsePermit(
				db,
				identity,
				async () => {
					if (
						request.method !== "POST" ||
						!isMarketingContactPath(url.pathname)
					)
						return run();
					return withSharedCmsRestorePermit(env.DB_DO, identity, run);
				},
				undefined,
				restoreQueries?.(),
				restoreQueries,
				request,
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

				// Cron pauses drain exact scheduled permits separately from shared nested work.
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

export { EmDashDB } from "./emdash-db";
