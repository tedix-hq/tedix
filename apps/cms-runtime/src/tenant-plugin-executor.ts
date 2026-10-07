import { exports as workerExports, WorkerEntrypoint } from "cloudflare:workers";
import { withDynamicWorkerLoaderDiagnostics } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { generatePluginWrapper } from "@emdash-cms/cloudflare/sandbox";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	createSandboxRouteError,
	getSandboxRouteErrorEnvelope,
	pluginManifestSchema,
	type PluginManifest,
	type SerializedRequest,
} from "emdash";
import {
	CmsRestoreFenceUnavailableError,
	withCmsRestorePermit,
} from "./tenant-restore-fence";

/** The parent owns both bindings. Neither is forwarded to a tenant or plugin Worker. */
interface PluginHostEnv {
	LOADER: WorkerLoader;
	DB_DO: DurableObjectNamespace;
	PLATFORM_DB: D1Database;
}

export interface TenantPluginScope {
	/** Resolved by the parent CMS router, never supplied by plugin code. */
	tenantSlug: string;
	siteId: string;
	restoreEpoch: number;
	pluginId: string;
	pluginVersion: string;
	/** Plugin-owned KV only; broader Emdash host capabilities remain unsupported. */
	grants: Array<"kv:read" | "kv:write">;
}

interface PluginDbStub {
	query(
		sql: string,
		params?: unknown[],
	): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface TenantPluginHostScope {
	/** These are pinned by the parent tenant loader, never accepted from RPC arguments. */
	tenantSlug: string;
	siteId: string;
	restoreEpoch: number;
	bucketName: string;
	accountId: string;
	r2Token: string;
}

interface PluginKvBridgeStub {
	kvBegin(invocationId: string): Promise<void>;
	kvEnd(invocationId: string): Promise<void>;
	kvGet(key: string): Promise<unknown>;
	kvSet(key: string, value: unknown): Promise<void>;
	kvGetVersioned(
		key: string,
	): Promise<{ value: unknown; revision: string } | null>;
	kvCompareAndSet(
		key: string,
		expectedRevision: string | null,
		value: unknown,
	): Promise<{ applied: boolean; revision?: string }>;
	kvCompareAndDelete(
		key: string,
		expectedRevision: string,
	): Promise<{ applied: boolean }>;
	kvDelete(key: string): Promise<boolean>;
	kvList(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_-]{0,127}$/;
const PLUGIN_VERSION_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/i;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_REVISION_LENGTH = 128;
const MAX_LIST_ENTRIES = 100;
const MAX_PLUGIN_CODE_BYTES = 1024 * 1024;
const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
const MAX_INVOCATION_WALL_MS = 30_000;
const activeInvocations = new Set<string>();

interface PluginInvocationScope extends TenantPluginScope {
	invocationId: string;
}

function validateScope(scope: TenantPluginScope): void {
	if (!SLUG_PATTERN.test(scope.tenantSlug))
		throw new Error("Invalid plugin tenant scope");
	if (
		!scope.siteId ||
		!Number.isSafeInteger(scope.restoreEpoch) ||
		scope.restoreEpoch < 0 ||
		!scope.pluginId ||
		!scope.pluginVersion
	) {
		throw new Error("Incomplete plugin scope");
	}
}

function validateKey(key: string): void {
	if (
		typeof key !== "string" ||
		!key ||
		key.length > MAX_KEY_LENGTH ||
		key.startsWith("settings:")
	) {
		throw new Error("Invalid plugin KV key");
	}
}

function validatePrefix(prefix: string): void {
	if (
		typeof prefix !== "string" ||
		prefix.length > MAX_KEY_LENGTH ||
		prefix.startsWith("settings:")
	) {
		throw new Error("Invalid plugin KV prefix");
	}
}

function validateRevision(revision: string): void {
	if (
		typeof revision !== "string" ||
		!revision ||
		revision.length > MAX_REVISION_LENGTH
	) {
		throw new Error("Invalid plugin KV revision");
	}
}

function encodeValue(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (
		encoded === undefined ||
		new TextEncoder().encode(encoded).byteLength > MAX_VALUE_BYTES
	) {
		throw new Error("Invalid plugin KV value");
	}
	return encoded;
}

/**
 * A parent-hosted loopback binding passed only to a parent-created plugin Worker.
 * Its DO name and plugin ID are fixed in ctx.props, so plugin arguments cannot
 * select another tenant's database or another plugin's rows.
 */
export class TenantPluginKvBridge extends WorkerEntrypoint<
	PluginHostEnv,
	PluginInvocationScope
> {
	kvBegin(invocationId: string): void {
		if (invocationId !== this.ctx.props.invocationId) {
			throw new Error("Invalid plugin KV invocation");
		}
		activeInvocations.add(invocationId);
	}

	kvEnd(invocationId: string): void {
		if (invocationId !== this.ctx.props.invocationId) {
			throw new Error("Invalid plugin KV invocation");
		}
		activeInvocations.delete(invocationId);
	}

	private assertOpen(): void {
		if (!activeInvocations.has(this.ctx.props.invocationId)) {
			throw new Error("Plugin KV request context closed");
		}
	}

	private db(): PluginDbStub {
		this.assertOpen();
		validateScope(this.ctx.props);
		const id = this.env.DB_DO.idFromName(this.ctx.props.tenantSlug);
		return this.env.DB_DO.get(id) as unknown as PluginDbStub;
	}

	private requireGrant(grant: TenantPluginScope["grants"][number]): void {
		this.assertOpen();
		if (!this.ctx.props.grants.includes(grant))
			throw new Error(`Missing capability: ${grant}`);
	}

	/** Hold the permit until the actual DO RPC settles, even if the caller times out. */
	private async write<T>(run: (db: PluginDbStub) => Promise<T>): Promise<T> {
		const db = this.db();
		const result = await withCmsRestorePermit(
			createDbQueryClient(this.env.PLATFORM_DB),
			{
				siteId: this.ctx.props.siteId,
				slug: this.ctx.props.tenantSlug,
				restoreEpoch: this.ctx.props.restoreEpoch,
			},
			() => run(db),
		);
		if (!result.admitted) throw new CmsRestoreFenceUnavailableError();
		return result.value;
	}

	async kvGet(key: string): Promise<unknown> {
		this.requireGrant("kv:read");
		validateKey(key);
		const result = await this.db().query(
			"SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id = ?",
			[this.ctx.props.pluginId, key],
		);
		const data = result.rows[0]?.data;
		if (typeof data !== "string") return null;
		return JSON.parse(data) as unknown;
	}

	async kvSet(key: string, value: unknown): Promise<void> {
		this.requireGrant("kv:write");
		validateKey(key);
		const encoded = encodeValue(value);
		await this.write((db) =>
			db.query(
				"INSERT INTO _plugin_storage (plugin_id, collection, id, data, revision, updated_at) VALUES (?, '__kv', ?, ?, ?, datetime('now')) ON CONFLICT (plugin_id, collection, id) DO UPDATE SET data = excluded.data, revision = excluded.revision, updated_at = excluded.updated_at",
				[this.ctx.props.pluginId, key, encoded, crypto.randomUUID()],
			),
		);
	}

	async kvGetVersioned(
		key: string,
	): Promise<{ value: unknown; revision: string } | null> {
		this.requireGrant("kv:read");
		validateKey(key);
		const result = await this.db().query(
			"SELECT data, revision FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id = ?",
			[this.ctx.props.pluginId, key],
		);
		const row = result.rows[0];
		if (!row) return null;
		if (typeof row.data !== "string" || typeof row.revision !== "string") {
			throw new Error("Invalid plugin KV row");
		}
		return { value: JSON.parse(row.data) as unknown, revision: row.revision };
	}

	async kvCompareAndSet(
		key: string,
		expectedRevision: string | null,
		value: unknown,
	): Promise<{ applied: boolean; revision?: string }> {
		this.requireGrant("kv:write");
		validateKey(key);
		if (expectedRevision !== null) validateRevision(expectedRevision);
		const encoded = encodeValue(value);
		const revision = crypto.randomUUID();
		const result = await this.write((db) =>
			expectedRevision === null
				? db.query(
						"INSERT INTO _plugin_storage (plugin_id, collection, id, data, revision, updated_at) VALUES (?, '__kv', ?, ?, ?, datetime('now')) ON CONFLICT (plugin_id, collection, id) DO NOTHING RETURNING revision",
						[this.ctx.props.pluginId, key, encoded, revision],
					)
				: db.query(
						"UPDATE _plugin_storage SET data = ?, revision = ?, updated_at = datetime('now') WHERE plugin_id = ? AND collection = '__kv' AND id = ? AND revision = ? RETURNING revision",
						[encoded, revision, this.ctx.props.pluginId, key, expectedRevision],
					),
		);
		return result.rows.length > 0
			? { applied: true, revision }
			: { applied: false };
	}

	async kvCompareAndDelete(
		key: string,
		expectedRevision: string,
	): Promise<{ applied: boolean }> {
		this.requireGrant("kv:write");
		validateKey(key);
		validateRevision(expectedRevision);
		const result = await this.write((db) =>
			db.query(
				"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id = ? AND revision = ? RETURNING id",
				[this.ctx.props.pluginId, key, expectedRevision],
			),
		);
		return { applied: result.rows.length > 0 };
	}

	async kvDelete(key: string): Promise<boolean> {
		this.requireGrant("kv:write");
		validateKey(key);
		const result = await this.write((db) =>
			db.query(
				"DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND id = ? RETURNING id",
				[this.ctx.props.pluginId, key],
			),
		);
		return result.rows.length > 0;
	}

	async kvList(prefix = ""): Promise<Array<{ key: string; value: unknown }>> {
		this.requireGrant("kv:read");
		validatePrefix(prefix);
		const result = await this.db().query(
			"SELECT id, data FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv' AND substr(id, 1, length(?)) = ? AND substr(id, 1, 9) <> 'settings:' ORDER BY id LIMIT ?",
			[this.ctx.props.pluginId, prefix, prefix, MAX_LIST_ENTRIES + 1],
		);
		if (result.rows.length > MAX_LIST_ENTRIES) {
			throw new Error("Plugin KV list exceeds limit");
		}
		return result.rows.map((row) => {
			if (typeof row.id !== "string" || typeof row.data !== "string") {
				throw new Error("Invalid plugin KV row");
			}
			return { key: row.id, value: JSON.parse(row.data) as unknown };
		});
	}
}

function hasNoAdminExtensions(manifestInput: unknown): boolean {
	if (
		!manifestInput ||
		typeof manifestInput !== "object" ||
		Array.isArray(manifestInput)
	) {
		return false;
	}
	const admin: unknown = Reflect.get(manifestInput, "admin");
	if (!admin || typeof admin !== "object" || Array.isArray(admin)) {
		return false;
	}
	// Emdash emits these empty arrays even when a plugin has no admin UI.
	// Check the raw object because its schema strips unknown keys on parse.
	return Object.entries(admin).every(
		([key, value]) =>
			(key === "pages" || key === "widgets") &&
			Array.isArray(value) &&
			value.length === 0,
	);
}

function assertSupportedManifest(
	manifest: PluginManifest,
	code: string,
	manifestInput: unknown,
): void {
	if (
		!manifest ||
		typeof manifest.id !== "string" ||
		typeof manifest.version !== "string" ||
		!manifest.id ||
		!manifest.version ||
		typeof code !== "string" ||
		!code ||
		new TextEncoder().encode(code).byteLength > MAX_PLUGIN_CODE_BYTES
	) {
		throw new Error("Invalid sandbox plugin bundle");
	}
	if (
		!Array.isArray(manifest.capabilities) ||
		manifest.capabilities.length > 0 ||
		!Array.isArray(manifest.allowedHosts) ||
		manifest.allowedHosts.length > 0 ||
		Object.keys(manifest.declaredAccess ?? {}).length > 0 ||
		Object.keys(manifest.storage ?? {}).length > 0 ||
		!hasNoAdminExtensions(manifestInput) ||
		manifest.mcp !== undefined ||
		!Array.isArray(manifest.hooks) ||
		!manifest.hooks.some(
			(hook) =>
				(typeof hook === "string" ? hook : hook.name) === "plugin:install",
		) ||
		manifest.hooks.some(
			(hook) =>
				(typeof hook === "string" ? hook : hook.name) !== "plugin:install",
		) ||
		!Array.isArray(manifest.routes) ||
		manifest.routes.some(
			(route) =>
				typeof route !== "string" &&
				(route.public === true ||
					(route.permission !== undefined &&
						route.permission !== "plugins:manage") ||
					route.response === "raw"),
		)
	) {
		throw new Error("Sandbox plugin declares unsupported host access");
	}
}

/**
 * Loopback RPC available only to the matching tenant isolate. The plugin Worker
 * gets a narrower KV bridge, never this entrypoint or the parent Loader.
 */
export class TenantPluginHost extends WorkerEntrypoint<
	PluginHostEnv,
	TenantPluginHostScope
> {
	/** A side-effect-free policy check used before Emdash persists a registry bundle. */
	validateBundle(manifestInput: unknown, code: string): PluginHostResult {
		try {
			const parsed = pluginManifestSchema.safeParse(manifestInput);
			if (!parsed.success) throw new Error("Invalid sandbox plugin manifest");
			assertSupportedManifest(
				parsed.data as unknown as PluginManifest,
				code,
				manifestInput,
			);
			return { ok: true, value: null };
		} catch (error) {
			return hostFailure(error);
		}
	}

	private async activePlugin(
		pluginId: string,
		pluginVersion: string,
	): Promise<{
		scope: TenantPluginScope;
		manifest: PluginManifest;
		code: string;
	}> {
		const { tenantSlug, siteId, restoreEpoch, bucketName, accountId, r2Token } =
			this.ctx.props;
		if (
			!SLUG_PATTERN.test(tenantSlug) ||
			!siteId ||
			!Number.isSafeInteger(restoreEpoch) ||
			restoreEpoch < 0 ||
			!bucketName ||
			!accountId ||
			!r2Token ||
			typeof pluginId !== "string" ||
			!PLUGIN_ID_PATTERN.test(pluginId) ||
			typeof pluginVersion !== "string" ||
			!PLUGIN_VERSION_PATTERN.test(pluginVersion) ||
			pluginVersion.includes("..")
		) {
			throw new Error("Invalid plugin tenant scope");
		}
		const id = this.env.DB_DO.idFromName(tenantSlug);
		const db = this.env.DB_DO.get(id) as unknown as PluginDbStub;
		const result = await db.query(
			"SELECT version, status, source FROM _plugin_state WHERE plugin_id = ?",
			[pluginId],
		);
		const row = result.rows[0];
		if (
			row?.version !== pluginVersion ||
			row.status !== "active" ||
			row.source !== "registry"
		) {
			throw new Error("Plugin is not active for this tenant and version");
		}
		const factories = workerExports as unknown as {
			TenantR2(options: {
				props: {
					bucketName: string;
					accountId: string;
					token: string;
					siteId: string;
					slug: string;
					restoreEpoch: number;
				};
			}): {
				get(key: string): Promise<{
					body: ReadableStream<Uint8Array>;
					size: number;
				} | null>;
			};
		};
		const r2 = factories.TenantR2({
			props: {
				bucketName,
				accountId,
				token: r2Token,
				siteId,
				slug: tenantSlug,
				restoreEpoch,
			},
		});
		const prefix = `registry/${pluginId}/${pluginVersion}`;
		const [manifestObject, codeObject] = await Promise.all([
			r2.get(`${prefix}/manifest.json`),
			r2.get(`${prefix}/backend.js`),
		]);
		if (
			!manifestObject ||
			!codeObject ||
			manifestObject.size > MAX_PLUGIN_MANIFEST_BYTES ||
			codeObject.size > MAX_PLUGIN_CODE_BYTES
		) {
			throw new Error("Canonical plugin bundle is unavailable or too large");
		}
		const manifestText = await new Response(manifestObject.body).text();
		const code = await new Response(codeObject.body).text();
		if (
			new TextEncoder().encode(manifestText).byteLength >
				MAX_PLUGIN_MANIFEST_BYTES ||
			new TextEncoder().encode(code).byteLength > MAX_PLUGIN_CODE_BYTES
		) {
			throw new Error("Canonical plugin bundle is too large");
		}
		const manifestInput: unknown = JSON.parse(manifestText);
		const parsed = pluginManifestSchema.safeParse(manifestInput);
		if (!parsed.success) throw new Error("Invalid canonical plugin manifest");
		// The validated wire manifest is structurally narrower at its admin UI
		// fields; only the no-capability subset below may execute here.
		const manifest = parsed.data as unknown as PluginManifest;
		assertSupportedManifest(manifest, code, manifestInput);
		if (manifest.id !== pluginId || manifest.version !== pluginVersion) {
			throw new Error("Canonical plugin identity mismatch");
		}
		return {
			manifest,
			code,
			scope: {
				tenantSlug,
				siteId,
				restoreEpoch,
				pluginId,
				pluginVersion,
				// Native ctx.kv is plugin-owned storage, available without a manifest
				// capability. Scope is pinned from canonical active state above.
				grants: ["kv:read", "kv:write"],
			},
		};
	}

	async invokeHook(
		pluginId: string,
		pluginVersion: string,
		hookName: string,
		event: unknown,
	): Promise<PluginHostResult> {
		try {
			const { scope, manifest, code } = await this.activePlugin(
				pluginId,
				pluginVersion,
			);
			if (
				!manifest.hooks.some(
					(hook) => (typeof hook === "string" ? hook : hook.name) === hookName,
				)
			) {
				throw new Error("Plugin hook is not declared");
			}
			const value = await invokeTenantSandboxedPlugin(
				this.env,
				scope,
				manifest,
				code,
				(entrypoint, invocationId) =>
					entrypoint.invokeHook(hookName, event, invocationId),
			);
			return { ok: true, value };
		} catch (error) {
			return hostFailure(error);
		}
	}

	async invokeRoute(
		pluginId: string,
		pluginVersion: string,
		routeName: string,
		input: unknown,
		request: SerializedRequest,
	): Promise<PluginHostResult> {
		try {
			const { scope, manifest, code } = await this.activePlugin(
				pluginId,
				pluginVersion,
			);
			if (
				!manifest.routes.some(
					(route) =>
						(typeof route === "string" ? route : route.name) === routeName,
				)
			) {
				throw new Error("Plugin route is not declared");
			}
			const result = await invokeTenantSandboxedPlugin(
				this.env,
				scope,
				manifest,
				code,
				(entrypoint, invocationId) =>
					entrypoint.invokeRoute(routeName, input, request, invocationId),
			);
			const envelope = getSandboxRouteErrorEnvelope(result);
			if (envelope) throw createSandboxRouteError(envelope.error.code);
			return { ok: true, value: result };
		} catch (error) {
			return hostFailure(error);
		}
	}
}

interface SandboxedEntrypoint {
	invokeHook(
		hookName: string,
		event: unknown,
		invocationId: string,
	): Promise<unknown>;
	invokeRoute(
		routeName: string,
		input: unknown,
		request: SerializedRequest,
		invocationId: string,
	): Promise<unknown>;
}

export type PluginHostResult =
	| { ok: true; value: unknown }
	| { ok: false; error: string; code?: string };

function hostFailure(error: unknown): PluginHostResult {
	const message =
		error instanceof Error ? error.message : "Plugin invocation failed";
	const code =
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: undefined;
	return { ok: false, error: message.slice(0, 500), ...(code ? { code } : {}) };
}

async function invokeTenantSandboxedPlugin(
	env: PluginHostEnv,
	scope: TenantPluginScope,
	manifest: PluginManifest,
	code: string,
	invoke: (
		entrypoint: SandboxedEntrypoint,
		invocationId: string,
	) => Promise<unknown>,
): Promise<unknown> {
	const wrapper = generatePluginWrapper(manifest);
	return invokeTenantPluginModules(
		env,
		scope,
		{
			"plugin.mjs": { js: wrapper },
			"sandbox-plugin.js": { js: code },
		},
		(entrypoint, invocationId) =>
			invoke(entrypoint as SandboxedEntrypoint, invocationId),
	);
}

/**
 * Parent-side transport primitive. Each invocation creates a fresh bridge and
 * isolate so a cached Worker cannot retain a prior request's BRIDGE binding.
 * The tenant receives only TenantPluginHost RPC. Registry activation stays
 * disabled until the tenant-side Emdash adapter and install fence are shipped.
 */
export async function invokeTenantPluginTransport<T>(
	env: PluginHostEnv,
	scope: TenantPluginScope,
	pluginModule: string,
	invoke: (entrypoint: {
		invoke(...args: unknown[]): Promise<T>;
	}) => Promise<T>,
): Promise<T> {
	return invokeTenantPluginModules(
		env,
		scope,
		{ "plugin.mjs": { js: pluginModule } },
		(entrypoint) =>
			invoke(entrypoint as { invoke(...args: unknown[]): Promise<T> }),
	);
}

async function invokeTenantPluginModules<T>(
	env: PluginHostEnv,
	scope: TenantPluginScope,
	modules: Record<string, { js: string }>,
	invoke: (entrypoint: unknown, invocationId: string) => Promise<T>,
): Promise<T> {
	validateScope(scope);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([
				scope.siteId,
				scope.tenantSlug,
				scope.restoreEpoch,
				scope.pluginId,
				scope.pluginVersion,
				scope.grants,
				modules,
			]),
		),
	);
	const codeHash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const factories = workerExports as unknown as {
		TenantPluginKvBridge(options: {
			props: PluginInvocationScope;
		}): PluginKvBridgeStub;
	};
	const invocationId = crypto.randomUUID();
	const bridge = factories.TenantPluginKvBridge({
		props: { ...scope, invocationId },
	});
	await bridge.kvBegin(invocationId);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const worker = withDynamicWorkerLoaderDiagnostics(env.LOADER, {
			surface: "cms_tenant_plugin",
			reason: "cms_tenant_plugin_invocation",
		}).get(`cms-plugin:${scope.siteId}:${codeHash}:${invocationId}`, () => ({
			compatibilityDate: "2026-05-14",
			compatibilityFlags: ["disallow_importable_env"],
			mainModule: "plugin.mjs",
			modules,
			globalOutbound: null,
			limits: { cpuMs: 50, subRequests: 10 },
			env: { BRIDGE: bridge },
		}));
		return await Promise.race([
			invoke(worker.getEntrypoint(), invocationId),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Plugin invocation exceeded wall-time limit")),
					MAX_INVOCATION_WALL_MS,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		await bridge.kvEnd(invocationId);
	}
}
