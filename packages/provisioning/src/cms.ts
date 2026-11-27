/**
 * CMS bundle publication and resource teardown.
 *
 * Tenant bundles live in R2 and are activated through platform tenant_bundles
 * rows for apps/cms-runtime Worker Loader. Tenant content uses EmDashDB Durable
 * Object SQLite; the core store tracks bundle publication metadata.
 *
 * Resource teardown requires a Cloudflare token with R2 bucket deletion
 * permissions. Bundle publication uses caller-supplied bindings.
 * See docs/engineering/emdash/cms.md for storage ownership.
 */

import {
	readCmsBundle,
	readCmsBundleModule,
	compressCmsBundle,
	COMPRESSED_CMS_BUNDLE_KEY,
	type CmsBundle,
} from "./cms-bundle";
import {
	cmsQueryDb,
	type CmsDatabase,
	activateCmsBundle,
	deleteCmsBundles,
	getCmsBundle,
	listCmsBundleVersions,
	readCmsBundleGeneration,
	readCmsHumanAuthMarker,
	reserveCmsBundle,
} from "@tedix/db/queries/cms-control-plane";
import { sha256Hex } from "@tedix/worker-kit/crypto";

// Minimal structural types — each caller worker has its own auto-generated
// CloudflareEnv (from `wrangler types`) that resolves to a different
// physical @cloudflare/workers-types install via bun's hoisting. Importing
// the upstream types here makes the package non-portable. We declare the
// surface we actually call.

interface R2HttpMetadata {
	contentType?: string;
	cacheControl?: string;
}
interface R2PutOptions {
	httpMetadata?: R2HttpMetadata;
}
interface R2Object {
	key: string;
}
interface R2ListResult {
	objects: R2Object[];
	truncated: boolean;
	cursor?: string;
}
interface R2Bucket {
	get(
		key: string,
	): Promise<{ body: ReadableStream<Uint8Array<ArrayBuffer>> } | null>;
	put(
		key: string,
		value: ArrayBuffer | Uint8Array,
		opts?: R2PutOptions,
	): Promise<unknown>;
	delete(keys: string | string[]): Promise<void>;
	list(opts: { prefix?: string; cursor?: string }): Promise<R2ListResult>;
}

export interface CmsProvisioningConfig {
	accountId: string;
	apiToken: string;
	/** R2 jurisdiction of tenant media buckets, such as "eu"; unset for the default. */
	r2Jurisdiction?: string;
}

/**
 * Bindings the caller must supply for any operation that touches the
 * tenant_bundles row or the bundles R2 bucket. The provisioning package
 * is environment-agnostic — it doesn't know how to acquire these — so
 * each caller supplies its own runtime bindings.
 */
export interface CmsBundlesBindings {
	bundlesBucket: R2Bucket;
	platformDb: CmsDatabase;
}

/** Read the immutable compiled target before changing the active bundle pointer. */
export interface VerifiedTenantBundle {
	bundle?: CmsBundle;
	id?: string;
	error?: string;
	etag?: string;
	r2Prefix?: string;
	modules?: string[];
}

export async function verifyTenantBundleDirectDo(
	bindings: CmsBundlesBindings,
	slug: string,
	version: number,
): Promise<VerifiedTenantBundle> {
	const stored = await getCmsBundle(
		cmsQueryDb(bindings.platformDb),
		slug,
		version,
	);
	const row = stored
		? { ...stored, modulesJson: JSON.stringify(stored.modulesJson) }
		: null;
	if (!row) return { error: `version ${version} not found for ${slug}` };
	const incompatible = (reason: string) => ({
		error: `version ${version} for ${slug} cannot activate: ${reason}`,
	});
	if (row.r2Prefix !== `${slug}/v${version}/`)
		return incompatible("bundle prefix does not match tenant and version");
	try {
		const modules = JSON.parse(row.modulesJson) as unknown;
		if (
			!Array.isArray(modules) ||
			modules.some((module) => typeof module !== "string") ||
			!modules.includes(row.mainModule)
		)
			return incompatible("invalid module catalog");
		const bundle = await readCmsBundle(bindings.bundlesBucket, row.r2Prefix, {
			mainModule: row.mainModule,
			modules,
		});
		const configs = modules.filter((module) =>
			/^chunks\/config_[^/]+\.mjs$/.test(module),
		);
		const dialects = modules.filter((module) =>
			/^chunks\/dialect_[^/]+\.mjs$/.test(module),
		);
		if (configs.length === 0 || dialects.length === 0)
			return incompatible("compiled database adapter is missing");
		const read = async (module: string) => bundle.modules[module]!.js;
		const compiledVersion = await readCompiledEmdashVersion(modules, read);
		if (!isSupportedCompiledEmdashVersion(compiledVersion))
			return incompatible(
				`compiled Emdash ${compiledVersion} is no longer supported`,
			);
		const configSources = await Promise.all(configs.map(read));
		const dialectSources = await Promise.all(dialects.map(read));
		const databases = configSources
			.filter((source) => source.includes("virtual:emdash/config"))
			.map((source) => readCompiledDatabaseDescriptor(source));
		if (databases.length !== 1)
			return incompatible("ambiguous database config");
		const database = databases[0];
		if (
			!database ||
			database.type !== "sqlite" ||
			database.supportsRequestScope !== true ||
			!String(database.entrypoint).endsWith(
				"/src/lib/worker-loader-do-sql-runtime.ts",
			) ||
			!database.config ||
			database.config.binding !== "DB_DO" ||
			database.config.name !== slug
		)
			return incompatible(
				"database config is not the direct tenant DO adapter",
			);
		if (
			!dialectSources.some(
				(source) =>
					source.includes("binding.query") &&
					source.includes("binding.batchQuery"),
			) ||
			dialectSources.some((source) => source.includes("idFromName"))
		)
			return incompatible(
				"compiled dialect does not use direct DO query/batch",
			);
		return {
			id: row.id,
			etag: row.etag,
			r2Prefix: row.r2Prefix,
			modules,
			bundle,
		};
	} catch (cause) {
		return incompatible(
			cause instanceof Error
				? cause.message
				: "compiled bundle could not be verified",
		);
	}
}

async function readCompiledEmdashVersion(
	modules: string[],
	read: (module: string) => Promise<string>,
): Promise<string> {
	// Emdash 1.5 also emits a `version-*` chunk for site-settings revisions;
	// only the release chunk declares `VERSION`.
	const candidates = modules.filter((module) =>
		/^chunks\/version-[^/]+\.mjs$/.test(module),
	);
	const versions: string[] = [];
	for (const module of candidates) {
		for (const match of (await read(module)).matchAll(
			/\b(?:var|let|const)\s+VERSION\s*=\s*["']([^"']+)["']/g,
		))
			versions.push(match[1]!);
	}
	if (versions.length !== 1)
		throw new Error("compiled Emdash version is missing or ambiguous");
	return versions[0]!;
}

function isSupportedCompiledEmdashVersion(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 0 || minor >= 39;
}

function readCompiledDatabaseDescriptor(source: string): {
	type?: unknown;
	entrypoint?: unknown;
	supportsRequestScope?: unknown;
	config?: { binding?: unknown; name?: unknown };
} | null {
	const marker = source.indexOf("virtual:emdash/config");
	const match =
		marker < 0 ? null : /"database"\s*:\s*\{/.exec(source.slice(marker));
	if (!match) return null;
	const start = marker + match.index + match[0].lastIndexOf("{");
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = start; index < source.length; index++) {
		const char = source[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0)
			return JSON.parse(source.slice(start, index + 1));
	}
	return null;
}

export interface CmsDeprovisionResult {
	success: boolean;
	slug: string;
	deletedR2: boolean;
	deletedBundles: boolean;
	errors: string[];
}

export interface TenantBundleUpload {
	orgSlug: string;
	mainModule: string;
	files: Record<string, Uint8Array | ArrayBuffer>;
	summary?: string;
	deployedBy?: string;
	/** Reserved at workflow admission so retries publish one generation. */
	version?: number;
	/** Active version observed when `version` was reserved; null for first deploy. */
	expectedActiveVersion?: number | null;
	/** Immutable identity of the editable source used to build this bundle. */
	sourceRevision: TenantBundleSourceRevision;
}

export type TenantBundleSourceRevision =
	| { kind: "artifacts_commit"; value: string }
	| { kind: "editable_source_digest"; value: string };

export interface TenantBundleResult {
	slug: string;
	version: number;
	etag: string;
	r2Prefix: string;
	mainModule: string;
	modules: string[];
	deployedAt: string;
	sourceRevision: TenantBundleSourceRevision;
	humanAuthority: CmsHumanAuthorityCarry;
}

const ARTIFACTS_COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const EDITABLE_SOURCE_DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

function serializeSourceRevision(source: TenantBundleSourceRevision): string {
	if (!source || typeof source.value !== "string") {
		throw new Error("Invalid CMS bundle source revision");
	}
	const value = source.value.trim().toLowerCase();
	if (source.kind === "artifacts_commit") {
		if (!ARTIFACTS_COMMIT_PATTERN.test(value)) {
			throw new Error(
				"Invalid CMS Artifacts source commit: expected a full 40-character Git SHA-1",
			);
		}
		return `artifacts-commit:${value}`;
	}
	if (source.kind !== "editable_source_digest") {
		throw new Error("Invalid CMS bundle source revision kind");
	}
	if (!EDITABLE_SOURCE_DIGEST_PATTERN.test(value)) {
		throw new Error(
			"Invalid CMS editable-source digest: expected a 64-character SHA-256",
		);
	}
	return `editable-sha256:${value}`;
}

function parseSourceRevision(
	value: string | null,
): TenantBundleSourceRevision | null {
	if (!value) return null;
	const [prefix, revision, ...rest] = value.split(":");
	if (rest.length > 0 || !revision) return null;
	if (
		prefix === "artifacts-commit" &&
		ARTIFACTS_COMMIT_PATTERN.test(revision)
	) {
		return { kind: "artifacts_commit", value: revision.toLowerCase() };
	}
	if (
		prefix === "editable-sha256" &&
		EDITABLE_SOURCE_DIGEST_PATTERN.test(revision)
	) {
		return { kind: "editable_source_digest", value: revision.toLowerCase() };
	}
	return null;
}

const CF_API = "https://api.cloudflare.com/client/v4";

async function cfFetch<T = unknown>(
	config: CmsProvisioningConfig,
	path: string,
	init?: RequestInit,
): Promise<{
	status: number;
	success: boolean;
	result: T;
	errors: Array<{ message: string }>;
}> {
	const res = await fetch(`${CF_API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${config.apiToken}`,
			"Content-Type": "application/json",
			// R2 only finds or creates a jurisdiction bucket when the request names it.
			...(config.r2Jurisdiction && path.includes("/r2/buckets")
				? { "cf-r2-jurisdiction": config.r2Jurisdiction }
				: {}),
			...(init?.headers as Record<string, string>),
		},
	});
	const body = (await res.json()) as {
		success: boolean;
		result: T;
		errors: Array<{ message: string }>;
	};
	return { ...body, status: res.status };
}

export interface CmsMediaBucketInspection {
	bucketName: string;
	exists: boolean;
}

export interface CmsMediaBucketProvisionResult extends CmsMediaBucketInspection {
	created: boolean;
}

/** The create request may have reached R2 even though its result was not observed. */
export class CmsMediaBucketCreateOutcomeUnknownError extends Error {
	constructor(cause: unknown) {
		super("R2 bucket creation outcome unknown", { cause });
		this.name = "CmsMediaBucketCreateOutcomeUnknownError";
	}
}

function cmsMediaBucketName(slug: string): string {
	return `tedix-cms-media-${slug}`;
}

/** Read the provider-owned state instead of inferring it from the CMS row. */
export async function inspectCmsMediaBucket(
	config: CmsProvisioningConfig,
	slug: string,
): Promise<CmsMediaBucketInspection> {
	const bucketName = cmsMediaBucketName(slug);
	const result = await cfFetch(
		config,
		`/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(bucketName)}`,
	);
	if (result.success) return { bucketName, exists: true };
	if (result.status === 404) return { bucketName, exists: false };
	throw new Error(
		`R2 bucket inspection failed: ${result.errors.map((error) => error.message).join("; ") || `HTTP ${result.status}`}`,
	);
}

/** Idempotently create the media bucket required by one CMS tenant. */
export async function provisionCmsMediaBucket(
	config: CmsProvisioningConfig,
	slug: string,
): Promise<CmsMediaBucketProvisionResult> {
	const current = await inspectCmsMediaBucket(config, slug);
	if (current.exists) return { ...current, created: false };

	let created: Awaited<ReturnType<typeof cfFetch>>;
	try {
		created = await cfFetch(
			config,
			`/accounts/${config.accountId}/r2/buckets`,
			{
				method: "POST",
				body: JSON.stringify({ name: current.bucketName }),
			},
		);
	} catch (error) {
		throw new CmsMediaBucketCreateOutcomeUnknownError(error);
	}
	if (typeof created.success !== "boolean" || !Array.isArray(created.errors))
		throw new CmsMediaBucketCreateOutcomeUnknownError(
			new Error("R2 bucket creation response invalid"),
		);
	if (!created.success) {
		// A concurrent repair may have won between the inspection and create.
		const afterConflict = await inspectCmsMediaBucket(config, slug);
		if (afterConflict.exists) return { ...afterConflict, created: false };
		throw new Error(
			`R2 bucket creation failed: ${created.errors.map((error) => error.message).join("; ") || `HTTP ${created.status}`}`,
		);
	}
	try {
		const confirmed = await inspectCmsMediaBucket(config, slug);
		if (!confirmed.exists)
			throw new Error("R2 bucket absent after successful creation");
		return { ...confirmed, created: true };
	} catch (error) {
		throw new CmsMediaBucketCreateOutcomeUnknownError(error);
	}
}

export async function deleteCmsMediaBucket(
	config: CmsProvisioningConfig,
	slug: string,
): Promise<boolean> {
	const bucketName = cmsMediaBucketName(slug);
	const basePath = `/accounts/${config.accountId}/r2/buckets/${bucketName}`;
	const bucket = await cfFetch(config, basePath);
	if (bucket.status === 404) return true;
	if (!bucket.success)
		throw new Error(
			`R2 bucket inspection failed: ${bucket.errors.map((error) => error.message).join("; ") || `HTTP ${bucket.status}`}`,
		);

	// Cloudflare refuses to delete a nonempty bucket. The bucket is dedicated to
	// this tenant; remove its objects in bounded batches before deleting it.
	for (let page = 0; page < 1_000; page++) {
		const list = await cfFetch<Array<{ key: string }>>(
			config,
			`${basePath}/objects?per_page=1000`,
		);
		if (!list.success)
			throw new Error(
				`R2 object listing failed: ${list.errors.map((error) => error.message).join("; ") || `HTTP ${list.status}`}`,
			);
		if (list.result.length === 0) break;
		for (let offset = 0; offset < list.result.length; offset += 20) {
			const outcomes = await Promise.allSettled(
				list.result.slice(offset, offset + 20).map(async ({ key }) => {
					const objectPath = key.split("/").map(encodeURIComponent).join("/");
					const deleted = await cfFetch(
						config,
						`${basePath}/objects/${objectPath}`,
						{ method: "DELETE" },
					);
					if (!deleted.success && deleted.status !== 404)
						throw new Error(
							`R2 object deletion failed: ${deleted.errors.map((error) => error.message).join("; ") || `HTTP ${deleted.status}`}`,
						);
				}),
			);
			const failed = outcomes.find(
				(outcome): outcome is PromiseRejectedResult =>
					outcome.status === "rejected",
			);
			if (failed) throw failed.reason;
		}
		if (page === 999)
			throw new Error("R2 bucket cleanup exceeded 1,000 object batches");
	}
	const deleted = await cfFetch(config, basePath, { method: "DELETE" });
	if (deleted.success || deleted.status === 404) return true;
	throw new Error(
		`R2 bucket deletion failed: ${deleted.errors.map((error) => error.message).join("; ") || `HTTP ${deleted.status}`}`,
	);
}

function asArrayBuffer(content: Uint8Array | ArrayBuffer): ArrayBuffer {
	if (content instanceof ArrayBuffer) return content;
	return content.buffer.slice(
		content.byteOffset,
		content.byteOffset + content.byteLength,
	) as ArrayBuffer;
}

export async function computeBundleEtag(
	files: Record<string, Uint8Array | ArrayBuffer>,
): Promise<string> {
	const parts: string[] = [];
	const sortedPaths = Object.keys(files).sort();
	for (const path of sortedPaths) {
		const content = files[path];
		if (!content) continue;
		const buf = asArrayBuffer(content);
		const fileHash = await crypto.subtle.digest("SHA-256", buf);
		const bytes = new Uint8Array(fileHash);
		let hex = "";
		for (const b of bytes) hex += b.toString(16).padStart(2, "0");
		parts.push(`${path}:${hex}`);
	}
	return sha256Hex(parts.join("\n"));
}

function uuid(): string {
	return crypto.randomUUID();
}

interface TenantBundleGeneration {
	activeVersion: number | null;
	activeEtag: string | null;
	activeCount: number;
	nextVersion: number;
}

async function readTenantBundleGeneration(
	db: CmsDatabase,
	slug: string,
): Promise<TenantBundleGeneration> {
	return readCmsBundleGeneration(cmsQueryDb(db), slug);
}

/** The locked middleware root that imports the reviewed human auth chunk. */
export const CMS_HUMAN_AUTH_MODULE = "virtual_astro_middleware.mjs";
// Reviewed fingerprints of the compiled verifier and its reachable auth dispatch
// in the current shared-module bundle. These slices permit unrelated theme changes
// while failing closed if compilation changes the authentication path.
const HUMAN_AUTH_VERIFIER_SHA256 =
	"b1206e2205006a7b8f5ed4071bba53a53b8245c131476ab28012911836d62b3c";
const HUMAN_AUTH_DISPATCH_SHA256 =
	"79e3cb40520aea3074cee32dd800ec7101c90aaab22750c43fd548c5a94e8de0";
const HUMAN_AUTH_MODULE_MAX_BYTES = 1024 * 1024;
// Shared chunks include theme dependencies; the reviewed marketing artifact is 1.58 MB.
export const CMS_HUMAN_AUTH_CHUNK_MAX_BYTES = 2 * 1024 * 1024;

/**
 * True when a compiled middleware graph resolves exactly the reviewed human
 * assertion verifier and auth dispatch. This is the one compatibility check
 * behind both the manual `set_human_auth_activation` opt-in and the automatic
 * marker carry-forward on bundle activation.
 */
export async function hasReviewedCmsHumanAuth(
	source: string,
	graph?: {
		modules: readonly string[];
		readModule: (module: string) => Promise<string | null>;
	},
): Promise<boolean> {
	if (new TextEncoder().encode(source).byteLength > HUMAN_AUTH_MODULE_MAX_BYTES)
		return false;
	if (graph && new Set(graph.modules).size !== graph.modules.length)
		return false;
	if (!graph) return false;
	// Emitted imports/functions cannot be declarations hidden in comments or quoted examples.
	const quotedOrComment =
		/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
	const hiddenAuthority = (text: string) =>
		[...text.matchAll(quotedOrComment)].some((match) =>
			/(?:async function authenticate(?:HumanAssertion)?\(|var authenticate = authenticate\$1;|await authenticate\(request, authMode\.config\)|import \{[^\n]*authenticate\$1|export \{[^\n]*authenticate as )/.test(
				match[0],
			),
		);
	if (hiddenAuthority(source)) return false;
	const binding = "var authenticate = authenticate$1;";
	const invocation = "await authenticate(request, authMode.config)";
	if (
		source.split(binding).length !== 2 ||
		source.split(invocation).length !== 2 ||
		source.indexOf(invocation) <= source.indexOf(binding)
	)
		return false;
	// Exact emitted named-import syntax: one immutable reviewed auth export, one hop.
	const imports = [
		...source.matchAll(/^import \{ ([^{}\n]+) \} from "([^"\n]+)";$/gm),
	].filter((match) =>
		match[1]!.split(", ").some((spec) => spec.endsWith(" as authenticate$1")),
	);
	if (imports.length !== 1) return false;
	const imported = imports[0]!;
	if (source.indexOf(imported[0]) >= source.indexOf(binding)) return false;
	const specs = imported[1]!
		.split(", ")
		.filter((spec) => spec.endsWith(" as authenticate$1"));
	if (
		specs.length !== 1 ||
		!/^[A-Za-z_$][\w$]* as authenticate\$1$/.test(specs[0]!)
	)
		return false;
	// Reject additional local declarations and shadowing; accept only this emitted alias.
	if (
		source.match(/\bauthenticate\$1\b/g)?.length !== 2 ||
		source.match(/\bauthenticate\s*=/g)?.length !== 1 ||
		/(?:function|(?:const|let|var)) authenticate\$1\b/.test(source)
	)
		return false;
	const path = imported[2]!;
	if (!/^\.\/chunks\/[A-Za-z0-9_-]+\.mjs$/.test(path)) return false;
	const module = path.slice(2);
	if (graph.modules.filter((value) => value === module).length !== 1)
		return false;
	const chunk = await graph.readModule(module);
	if (
		chunk === null ||
		new TextEncoder().encode(chunk).byteLength > CMS_HUMAN_AUTH_CHUNK_MAX_BYTES
	)
		return false;
	if (hiddenAuthority(chunk)) return false;
	const exportedName = specs[0]!.split(" as ")[0]!;
	const exports = [...chunk.matchAll(/^export \{ ([^{}\n]+) \};$/gm)];
	if (
		exports.length !== 1 ||
		exports[0]![1]!
			.split(", ")
			.filter((spec) => spec.endsWith(` as ${exportedName}`)).length !== 1 ||
		!exports[0]![1]!.split(", ").includes(`authenticate as ${exportedName}`)
	)
		return false;
	if (
		chunk.match(/\basync function authenticate\(/g)?.length !== 1 ||
		/\bauthenticate\s*=/.test(chunk) ||
		chunk.match(/\bfunction authenticateHumanAssertion\(/g)?.length !== 1
	)
		return false;
	const start = chunk.indexOf("async function authenticateHumanAssertion(");
	const end = chunk.indexOf("\nfunction readStringArray(", start);
	const dispatch = chunk.indexOf("async function authenticate(", end);
	const dispatchEnd = chunk.indexOf(
		"const projectId = resolveProjectId(",
		dispatch,
	);
	if (start < 0 || end <= start || dispatch <= end || dispatchEnd <= dispatch)
		return false;
	const [verifierHash, dispatchHash] = await Promise.all([
		sha256Hex(chunk.slice(start, end)),
		sha256Hex(chunk.slice(dispatch, dispatchEnd)),
	]);
	return (
		verifierHash === HUMAN_AUTH_VERIFIER_SHA256 &&
		dispatchHash === HUMAN_AUTH_DISPATCH_SHA256
	);
}

/**
 * What bundle activation did to the site's human OAuth marker
 * (`config.blog.humanAssertionBundleEtag`):
 * - `carried`: the marker matched the outgoing bundle and the incoming bundle
 *   carries the reviewed verifier, so it now names the new active etag.
 * - `needs_review`: the marker matched the outgoing bundle but the incoming
 *   bundle's verifier or dispatch differs from the reviewed fingerprints (or
 *   the carry lost its CAS); human access stays off until a platform admin
 *   reviews and runs `set_human_auth_activation`.
 * - `unchanged`: no marker, or the marker was already stale before this
 *   activation; nothing was touched.
 */
export type CmsHumanAuthorityCarry = "carried" | "needs_review" | "unchanged";

export interface CmsHumanAuthorityCarryPlan {
	carry: { previousEtag: string; targetEtag: string } | null;
	outcome: CmsHumanAuthorityCarry;
}

/** The reviewed capability is checked before the query owner atomically activates and carries its marker. */
export async function planCmsHumanAuthorityCarry(
	db: CmsDatabase,
	input: {
		slug: string;
		previousActiveEtag: string | null;
		targetEtag: string;
		modules: string[];
		readModule: (module: string) => Promise<string | null>;
	},
): Promise<CmsHumanAuthorityCarryPlan> {
	if (input.previousActiveEtag === null)
		return { carry: null, outcome: "unchanged" };
	const marker = await readCmsHumanAuthMarker(cmsQueryDb(db), input.slug);
	if (typeof marker !== "string" || marker !== input.previousActiveEtag)
		return { carry: null, outcome: "unchanged" };
	try {
		if (
			input.modules.filter((module) => module === CMS_HUMAN_AUTH_MODULE)
				.length !== 1
		)
			return { carry: null, outcome: "needs_review" };
		const source = await input.readModule(CMS_HUMAN_AUTH_MODULE);
		if (
			source === null ||
			source.length > HUMAN_AUTH_MODULE_MAX_BYTES ||
			!(await hasReviewedCmsHumanAuth(source, input))
		)
			return { carry: null, outcome: "needs_review" };
	} catch {
		return { carry: null, outcome: "needs_review" };
	}
	return {
		outcome: "carried",
		carry: {
			previousEtag: input.previousActiveEtag,
			targetEtag: input.targetEtag,
		},
	};
}

export function resolveCmsHumanAuthorityCarry(
	plan: CmsHumanAuthorityCarryPlan,
	carried: boolean,
): CmsHumanAuthorityCarry {
	return plan.carry ? (carried ? "carried" : "needs_review") : plan.outcome;
}

function assertBundleVersion(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
}

/**
 * Reserve a tenant bundle generation, upload it to R2, and activate it only
 * if the predecessor observed at admission is still active.
 */
export async function uploadTenantBundle(
	bindings: CmsBundlesBindings,
	upload: TenantBundleUpload,
): Promise<TenantBundleResult> {
	const { orgSlug, mainModule, files, summary, deployedBy } = upload;

	const modules = Object.keys(files).sort();
	if (!modules.includes(mainModule)) {
		throw new Error(`mainModule "${mainModule}" not present in bundle files`);
	}
	// Validate all inputs before any R2 PUT can start. A missing late module
	// must not leave earlier module uploads running after this function throws.
	for (const path of modules) {
		if (!files[path]) throw new Error(`missing content for ${path}`);
	}
	const compiledVersion = await readCompiledEmdashVersion(
		modules,
		async (module) => new TextDecoder().decode(files[module]),
	);
	if (!isSupportedCompiledEmdashVersion(compiledVersion))
		throw new Error(
			`compiled Emdash ${compiledVersion} is no longer supported`,
		);
	const sourceRevision = serializeSourceRevision(upload.sourceRevision);
	const normalizedSourceRevision = parseSourceRevision(sourceRevision);
	if (!normalizedSourceRevision) {
		throw new Error("Invalid CMS bundle source revision");
	}

	const etag = await computeBundleEtag(files);

	const generation = await readTenantBundleGeneration(
		bindings.platformDb,
		orgSlug,
	);
	if (generation.activeCount > 1) {
		throw new Error(`CMS tenant ${orgSlug} has multiple active bundles`);
	}
	if (
		(upload.version === undefined) !==
		(upload.expectedActiveVersion === undefined)
	) {
		throw new Error(
			"CMS bundle version and expected active version must be provided together",
		);
	}
	const version = upload.version ?? generation.nextVersion;
	const expectedActiveVersion =
		upload.version === undefined
			? generation.activeVersion
			: (upload.expectedActiveVersion ?? null);
	assertBundleVersion(version, "CMS bundle version");
	if (expectedActiveVersion !== null) {
		assertBundleVersion(
			expectedActiveVersion,
			"expected active CMS bundle version",
		);
	}
	const r2Prefix = `${orgSlug}/v${version}/`;
	const deployedAt = new Date().toISOString();
	const modulesJson = JSON.stringify(modules);
	const reservationId = uuid();

	// Reserve the version before writing R2 so competing publishers cannot
	// overwrite the same immutable prefix with different bytes.
	const db = cmsQueryDb(bindings.platformDb);
	await reserveCmsBundle(db, {
		id: reservationId,
		slug: orgSlug,
		version,
		r2Prefix,
		mainModule,
		etag,
		modulesJson: modules,
		sourceRevision,
		isActive: false,
		deployedAt,
		deployedBy: deployedBy ?? null,
		summary: summary ?? null,
	});
	const stored = await getCmsBundle(db, orgSlug, version);
	const reserved =
		stored && stored.deployedBy === (deployedBy ?? null)
			? { ...stored, modulesJson: JSON.stringify(stored.modulesJson) }
			: null;
	if (
		!reserved ||
		reserved.r2Prefix !== r2Prefix ||
		reserved.mainModule !== mainModule ||
		reserved.etag !== etag ||
		reserved.modulesJson !== modulesJson ||
		reserved.sourceRevision !== sourceRevision
	) {
		throw new Error(
			`CMS bundle version ${version} for ${orgSlug} is already reserved by another deploy`,
		);
	}
	if (reserved.isActive) {
		return {
			slug: orgSlug,
			version,
			etag,
			r2Prefix,
			mainModule,
			modules,
			deployedAt: reserved.deployedAt ?? deployedAt,
			sourceRevision: normalizedSourceRevision,
			humanAuthority: "unchanged",
		};
	}

	// Publish the single immutable runtime object before activating its core-store row.
	const compressed = await compressCmsBundle(
		mainModule,
		modules,
		async (path) => new TextDecoder().decode(files[path]!),
	);
	await bindings.bundlesBucket.put(
		`${r2Prefix}${COMPRESSED_CMS_BUNDLE_KEY}`,
		compressed,
		{
			httpMetadata: {
				contentType: "application/gzip",
				cacheControl: "public, max-age=31536000, immutable",
			},
		},
	);

	// The marker follows a winning activation only when the new bundle carries
	// the reviewed verifier and the marker still names the captured predecessor.
	const humanAuthority = await planCmsHumanAuthorityCarry(bindings.platformDb, {
		slug: orgSlug,
		previousActiveEtag:
			expectedActiveVersion !== null &&
			generation.activeVersion === expectedActiveVersion
				? generation.activeEtag
				: null,
		targetEtag: etag,
		modules,
		readModule: async (module) =>
			files[module] &&
			files[module].byteLength <=
				(module === CMS_HUMAN_AUTH_MODULE
					? HUMAN_AUTH_MODULE_MAX_BYTES
					: CMS_HUMAN_AUTH_CHUNK_MAX_BYTES)
				? new TextDecoder().decode(files[module])
				: null,
	});
	const activation = await activateCmsBundle(db, {
		slug: orgSlug,
		targetId: reserved.id,
		expectedActiveVersion,
		carry: humanAuthority.carry,
	});
	if (!activation.activated)
		throw new Error(
			`CMS bundle ${orgSlug} v${version} lost the active-version compare-and-swap`,
		);
	const active = await readTenantBundleGeneration(bindings.platformDb, orgSlug);
	if (active.activeCount !== 1 || active.activeVersion !== version) {
		throw new Error(`CMS bundle ${orgSlug} v${version} is not uniquely active`);
	}

	return {
		slug: orgSlug,
		version,
		etag,
		r2Prefix,
		mainModule,
		modules,
		deployedAt,
		sourceRevision: normalizedSourceRevision,
		humanAuthority: resolveCmsHumanAuthorityCarry(
			humanAuthority,
			activation.carried,
		),
	};
}

/**
 * Activate a previously-uploaded version (manual rollback) using the active
 * version observed immediately before activation as a compare-and-swap.
 */
export async function activateTenantBundleVersion(
	bindings: CmsBundlesBindings,
	slug: string,
	version: number,
): Promise<{
	success: boolean;
	error?: string;
	humanAuthority?: CmsHumanAuthorityCarry;
}> {
	const target = await verifyTenantBundleDirectDo(bindings, slug, version);
	if (
		!target.id ||
		!target.etag ||
		!target.r2Prefix ||
		!target.modules ||
		!target.bundle
	)
		return { success: false, error: target.error };
	const generation = await readTenantBundleGeneration(
		bindings.platformDb,
		slug,
	);
	if (generation.activeCount > 1) {
		return { success: false, error: `${slug} has multiple active bundles` };
	}
	if (generation.activeVersion === version)
		return { success: true, humanAuthority: "unchanged" };
	const { etag: targetEtag, bundle } = target;
	const humanAuthority = await planCmsHumanAuthorityCarry(bindings.platformDb, {
		slug,
		previousActiveEtag: generation.activeEtag,
		targetEtag,
		modules: target.modules,
		readModule: async (module) =>
			readCmsBundleModule(
				bundle,
				module,
				module === CMS_HUMAN_AUTH_MODULE
					? HUMAN_AUTH_MODULE_MAX_BYTES
					: CMS_HUMAN_AUTH_CHUNK_MAX_BYTES,
			),
	});
	const activation = await activateCmsBundle(cmsQueryDb(bindings.platformDb), {
		slug,
		targetId: target.id,
		expectedActiveVersion: generation.activeVersion,
		carry: humanAuthority.carry,
	});
	if (!activation.activated)
		return {
			success: false,
			error: `version ${version} lost a concurrent activation race for ${slug}`,
		};
	const active = await readTenantBundleGeneration(bindings.platformDb, slug);
	if (active.activeCount !== 1 || active.activeVersion !== version) {
		return {
			success: false,
			error: `version ${version} is not uniquely active for ${slug}`,
		};
	}
	return {
		success: true,
		humanAuthority: resolveCmsHumanAuthorityCarry(
			humanAuthority,
			activation.carried,
		),
	};
}

/**
 * List all bundle versions for an app, newest first.
 */
export async function listTenantBundleVersions(
	bindings: CmsBundlesBindings,
	slug: string,
): Promise<
	Array<{
		version: number;
		etag: string;
		isActive: boolean;
		deployedAt: string | null;
		summary: string | null;
		sourceRevision: TenantBundleSourceRevision | null;
	}>
> {
	const rows = await listCmsBundleVersions(
		cmsQueryDb(bindings.platformDb),
		slug,
	);
	return rows.map((r) => ({
		version: r.version,
		etag: r.etag,
		isActive: r.isActive,
		deployedAt: r.deployedAt,
		summary: r.summary,
		sourceRevision: parseSourceRevision(r.sourceRevision),
	}));
}

/**
 * Delete every published bundle and static object for a slug, then clear `tenant_bundles`
 * rows. Used during deprovision and not exposed otherwise.
 */
async function purgeBundlesForSlug(
	bindings: CmsBundlesBindings,
	slug: string,
): Promise<boolean> {
	for (const prefix of [`${slug}/`, `static/${slug}/`]) {
		// Restart at the first page after deletion: an R2 cursor over a changing
		// prefix can skip keys that moved into the deleted page.
		for (let page = 0; page < 10_000; page++) {
			const list = await bindings.bundlesBucket.list({ prefix });
			const keys = list.objects.map((object) => object.key);
			if (keys.length === 0) break;
			await bindings.bundlesBucket.delete(keys);
			if (page === 9_999)
				throw new Error(
					`CMS bundle cleanup exceeded 10,000 batches for ${prefix}`,
				);
		}
	}

	await deleteCmsBundles(cmsQueryDb(bindings.platformDb), slug);
	return true;
}

/**
 * Deprovision a CMS app — delete its R2 media bucket and every bundle artifact
 * plus tenant_bundles row. Historical D1 databases are retired separately.
 * Errors are collected;
 * partial cleanup is preferred to none.
 */
export async function deprovisionCms(
	bindings: CmsBundlesBindings,
	slug: string,
	deleteMediaBucket: () => Promise<boolean>,
): Promise<CmsDeprovisionResult> {
	const errors: string[] = [];

	let deletedR2 = false;
	let deletedBundles = false;

	try {
		deletedR2 = await deleteMediaBucket();
	} catch (err) {
		errors.push(`R2: ${err instanceof Error ? err.message : String(err)}`);
	}

	try {
		deletedBundles = await purgeBundlesForSlug(bindings, slug);
	} catch (err) {
		errors.push(`Bundles: ${err instanceof Error ? err.message : String(err)}`);
	}

	return {
		success: errors.length === 0,
		slug,
		deletedR2,
		deletedBundles,
		errors,
	};
}
