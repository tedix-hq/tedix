import {
	APP_RUNTIME_ENTRY,
	APP_RUNTIME_SERVER_MODULE,
	type AppRuntimeFiles,
	type AppRuntimeOperation,
	type AppRuntimeRole,
} from "../schemas/os-app-runtime";
import type { OsGadgetManifest } from "../schemas/os-workspaces";
import type { JsonValue } from "../schemas/common";

/** True when a manifest describes an app that runs its own code. */
export function isAppRuntimeManifest(
	manifest: Pick<OsGadgetManifest, "entry"> | null | undefined,
): boolean {
	return manifest?.entry.trim() === APP_RUNTIME_ENTRY;
}

export interface AppRuntimeCodeIdParts {
	organizationId: string;
	workspaceId: string;
	gadgetId: string;
	revision: number;
	/** Present for a chat draft; the draft runs under its own id and storage. */
	draftId?: string;
	/** Digest of the signed files, so a cached isolate never outlives its code. */
	codeDigest?: string;
}

/**
 * The identity a loaded program is cached under. The host asks the Worker
 * Loader for this id and the loader keeps one isolate per id, so the id has to
 * change whenever the code can: a new revision, a different draft or
 * different files.
 */
export function appRuntimeCodeId(parts: AppRuntimeCodeIdParts): string {
	const base = `${parts.organizationId}:${parts.workspaceId}:${parts.gadgetId}:r${parts.revision}`;
	const id = parts.draftId ? `${base}:draft:${parts.draftId}` : base;
	return parts.codeDigest ? `${id}:${parts.codeDigest}` : id;
}

export const APP_RUNTIME_DEFAULT_COMPATIBILITY_DATE = "2026-10-01";

const INVOCATION_MODULE_NAME = "__tedix_invocation.js";
const INVOCATION_MODULE = `
import { DurableObject } from 'cloudflare:workers';
import { AsyncLocalStorage } from 'node:async_hooks';
import { App } from './server.js';
const consoleContext = new AsyncLocalStorage();
for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...values) => {
    original(...values);
    const active = consoleContext.getStore();
    if (!active || active.sequence >= 200) return;
    let message;
    try { message = JSON.stringify(values); } catch { message = values.map(String).join(' '); }
    // Console delivery cannot fail the app; the native tail remains the final record.
    try { active.ctx.waitUntil(active.sink.write(level, message.slice(0, 2000), Date.now(), ++active.sequence).catch(() => {})); } catch {}
  };
}
export class AppInvocation extends DurableObject {
  async invoke(method, args, capability, traceToken, sink) {
    if (traceToken) console.info('__tedix_app_trace__', traceToken);
    const descriptor = Object.getOwnPropertyDescriptor(App.prototype, method);
    if (!descriptor || typeof descriptor.value !== 'function' || method === 'constructor')
      throw new Error('Unknown app method');
    const run = async () => {
      const app = new App(this.ctx, { CONFIG: this.env.CONFIG, TEDIX: capability });
      return await descriptor.value.apply(app, args);
    };
    return sink ? await consoleContext.run({ sink, ctx: this.ctx, sequence: 0 }, run) : await run();
  }
}`;

interface AppRuntimeLoaderOptions<TTail> {
	compatibilityDate?: string;
	invocation?: { config: Record<string, JsonValue>; tails: TTail[] };
}

/**
 * What the host hands to the Worker Loader for one revision. Only `.js` files
 * become modules the program can import; `.json` and `.txt` ride along as text
 * modules the code reads by name. Network access is never inherited.
 */
export function appRuntimeLoaderManifest<TTail = never>(
	files: AppRuntimeFiles,
	options: AppRuntimeLoaderOptions<TTail> = {},
) {
	const modules = Object.fromEntries(
		Object.entries(files).filter(([path]) => path !== "README.md"),
	);
	return {
		compatibilityDate:
			options.compatibilityDate ?? APP_RUNTIME_DEFAULT_COMPATIBILITY_DATE,
		// Agent-written code must never reach bindings ambiently.
		compatibilityFlags: ["disallow_importable_env", "nodejs_als"],
		mainModule: options.invocation
			? INVOCATION_MODULE_NAME
			: APP_RUNTIME_SERVER_MODULE,
		modules: (options.invocation
			? { ...modules, [INVOCATION_MODULE_NAME]: INVOCATION_MODULE }
			: modules) as Record<string, string>,
		env: { CONFIG: options.invocation?.config ?? {} },
		tails: options.invocation?.tails ?? [],
		// Always null: an app reaches the outside world only through capabilities.
		globalOutbound: null,
	};
}

export type AppRuntimeLoaderManifest<TTail = never> = ReturnType<
	typeof appRuntimeLoaderManifest<TTail>
>;

/** Keep Loader calls at the same approved site as their sandbox policy. */
export function loadAppRuntimeWorker<TWorker, TTail>(
	LOADER: {
		get(
			id: string,
			code: () => Promise<AppRuntimeLoaderManifest<TTail>>,
		): TWorker;
	},
	id: string,
	files: AppRuntimeFiles,
	options: AppRuntimeLoaderOptions<TTail>,
): TWorker {
	return LOADER.get(id, async () => ({
		...appRuntimeLoaderManifest(files, options),
		compatibilityFlags: ["disallow_importable_env", "nodejs_als"],
		globalOutbound: null,
	}));
}

/**
 * The one table that says what a role may ask the host for. A grant on the
 * manifest (`resourceGrants`) is necessary for anything that touches a
 * resource; the role decides how far that grant reaches. The matrix is data so
 * the UI, the API and the host all read the same answer.
 */
const ROLE_OPERATIONS: Record<AppRuntimeRole, readonly AppRuntimeOperation[]> =
	{
		owner: [
			"app.call",
			"outputs.read",
			"outputs.write",
			"connections.call",
			"skills.run",
		],
		build: [
			"app.call",
			"outputs.read",
			"outputs.write",
			"connections.call",
			"skills.run",
		],
		use: ["app.call", "outputs.read"],
		viewer: [],
	};

/** Operations that need a matching slot grant on the manifest before the role is consulted. */
const GRANT_GATED: ReadonlySet<AppRuntimeOperation> = new Set([
	"outputs.read",
	"outputs.write",
	"connections.call",
	"skills.run",
]);

export interface AppRuntimePermissionInput {
	role: AppRuntimeRole;
	operation: AppRuntimeOperation;
	/** Slots the manifest grants, with the operations each slot allows. */
	grants: ReadonlyArray<{ slot: string; operations: readonly string[] }>;
	/** The slot the call names; required for grant-gated operations. */
	slot?: string;
}

export type AppRuntimePermission =
	| { allowed: true }
	| {
			allowed: false;
			reason: "role" | "no_grant" | "grant_operation" | "slot_required";
	  };

export function appRuntimePermission(
	input: AppRuntimePermissionInput,
): AppRuntimePermission {
	if (!appRuntimeOperationsForRole(input.role).includes(input.operation))
		return { allowed: false, reason: "role" };
	if (!GRANT_GATED.has(input.operation)) return { allowed: true };
	if (!input.slot) return { allowed: false, reason: "slot_required" };
	const grant = input.grants.find((candidate) => candidate.slot === input.slot);
	if (!grant) return { allowed: false, reason: "no_grant" };
	if (!grant.operations.includes(input.operation))
		return { allowed: false, reason: "grant_operation" };
	return { allowed: true };
}

/** The operations a role may use at all, for display and for capability minting. */
export function appRuntimeOperationsForRole(
	role: AppRuntimeRole,
): readonly AppRuntimeOperation[] {
	// Default deny: a name outside the matrix (including Object.prototype keys) has no operations.
	return Object.hasOwn(ROLE_OPERATIONS, role) ? ROLE_OPERATIONS[role] : [];
}

/** Total length of all files; the stored `code_length`. */
export function appRuntimeCodeLength(files: AppRuntimeFiles): number {
	return Object.values(files).reduce((sum, text) => sum + text.length, 0);
}

export async function appRuntimeCodeDigest(
	files: AppRuntimeFiles,
): Promise<string> {
	const canonical = JSON.stringify(
		Object.keys(files)
			.sort()
			.map((key) => [key, files[key]]),
	);
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
