/**
 * Platform client factory for the isolate tedi runtime.
 *
 * Loads the tedi's encrypted Descope access-key from D1 `tedi_secrets`,
 * decrypts it with the Worker's `SECRETS_MASTER_KEY` via the shared HKDF +
 * AES-GCM helper in `@tedix/db`, and constructs an `HttpPlatformClient`
 * (from `src/brain/`) that can talk to `apps/api` over /rpc.
 *
 * The platform client manages its own Descope access-key → V2 JWT exchange
 * and caches the resulting bearer token until ~80% of its lifetime —
 * callers should cache the client instance for the lifetime of the
 * Durable Object so the JWT survives between turns.
 */

import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { DescopeAccessKeyExchange } from "@tedix/auth/access-key-exchange";
import {
	extractTediRuntimeApiScopes,
	TEDI_RUNTIME_API_SCOPES,
} from "@tedix/auth/tedi-identity";
import { HttpPlatformClient } from "./brain/platform-client";
import { getTediRuntimeEncryptedSecret } from "@tedix/db/queries/tedi-runtime-bootstrap";
import { decryptTediSecret } from "@tedix/db/utils/secrets-encryption";

const DESCOPE_ACCESS_KEY_NAME = "DESCOPE_ACCESS_KEY";
const ACCESS_KEY_VALIDATION_TTL_MS = 10 * 60 * 1000;

/**
 * Finite API capabilities delegated by the runtime's trusted service binding.
 *
 * Direct Tedi JWTs retain the narrower `TEDI_RUNTIME_API_SCOPES` claim. The
 * service binding additionally needs to read the calling Tedi's own rationale
 * chain while compiling its brain digest. Keep this separate so the internal
 * transport capability does not silently widen every Descope access key.
 */
export const TEDI_RUNTIME_SERVICE_BINDING_SCOPES = [
	...TEDI_RUNTIME_API_SCOPES,
	"mcp:memory.read",
] as const;

/** Exact headers for one trusted runtime -> API service-binding procedure. */
export function tediRuntimeServiceBindingHeaders(
	tediId: string,
	scope: "apps:read" | "apps:write",
): Record<string, string> {
	return {
		"X-Service-Binding": "true",
		"X-Tedix-Org-Id": "system",
		"X-Tedix-Tedi-Id": tediId,
		"X-Tedix-Tedi-Scopes": scope,
	};
}

interface ValidatedAccessKeyCacheEntry {
	encryptedValue: string;
	expiresAt: number;
}

const validatedAccessKeyCache = new Map<string, ValidatedAccessKeyCacheEntry>();

export class MissingTediSecretError extends Error {
	readonly tediId: string;
	readonly secretName: string;

	constructor(tediId: string, secretName: string) {
		super(`tedi_secrets row missing for tediId=${tediId} name=${secretName}`);
		this.name = "MissingTediSecretError";
		this.tediId = tediId;
		this.secretName = secretName;
	}
}

export function isMissingTediSecretError(
	err: unknown,
	secretName?: string,
): err is MissingTediSecretError {
	return (
		err instanceof MissingTediSecretError &&
		(!secretName || err.secretName === secretName)
	);
}

export function isMissingDescopeAccessKeySecretError(
	err: unknown,
): err is MissingTediSecretError {
	return isMissingTediSecretError(err, DESCOPE_ACCESS_KEY_NAME);
}

type PlatformClientFactory = (
	env: Cloudflare.Env,
	tediId: string,
	orgId: string,
) => Promise<HttpPlatformClient>;

type WarnFn = (message?: unknown, ...optionalParams: unknown[]) => void;

const missingPlatformClientSecretWarns = new Set<string>();

function parseJwtPayload(jwt: string): Record<string, unknown> | null {
	const payload = jwt.split(".")[1];
	if (!payload) return null;
	try {
		const base64 = payload
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(payload.length / 4) * 4, "=");
		return JSON.parse(atob(base64)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function findMissingRuntimeApiScopes(
	payload: Record<string, unknown> | null,
): string[] {
	const scopes = new Set(extractTediRuntimeApiScopes(payload));
	return TEDI_RUNTIME_API_SCOPES.filter((scopeName) => !scopes.has(scopeName));
}

async function exchangeAccessKey(
	env: Cloudflare.Env,
	descopeAccessKey: string,
): Promise<
	{ ok: true; missingScopes: string[] } | { ok: false; error: string }
> {
	if (!env.DESCOPE_PROJECT_ID) {
		return { ok: false, error: "DESCOPE_PROJECT_ID missing from Worker env" };
	}
	const baseUrl = env.DESCOPE_BASE_URL || "https://auth.tedix.dev";
	try {
		const sessionJwt = await new DescopeAccessKeyExchange({
			descopeAccessKey,
			descopeProjectId: env.DESCOPE_PROJECT_ID,
			descopeBaseUrl: baseUrl,
			timeoutMs: 10_000,
		}).getToken();
		return {
			ok: true,
			missingScopes: findMissingRuntimeApiScopes(parseJwtPayload(sessionJwt)),
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function readEncryptedTediSecret(
	env: Cloudflare.Env,
	tediId: string,
	name: string,
): Promise<string> {
	const encryptedValue = await getTediRuntimeEncryptedSecret(
		env.DB,
		tediId,
		name,
	);
	if (!encryptedValue) {
		throw new MissingTediSecretError(tediId, name);
	}
	return encryptedValue;
}

async function decryptAccessKey(
	env: Cloudflare.Env,
	tediId: string,
	encryptedValue: string,
): Promise<string> {
	if (!env.SECRETS_MASTER_KEY) {
		throw new Error("SECRETS_MASTER_KEY missing from Worker env");
	}
	return decryptTediSecret(env.SECRETS_MASTER_KEY, tediId, encryptedValue);
}

async function ensureScopedAccessKey(
	env: Cloudflare.Env,
	tediId: string,
	encryptedValue: string,
	descopeAccessKey: string,
): Promise<{ descopeAccessKey: string; encryptedValue: string }> {
	const cache = validatedAccessKeyCache.get(tediId);
	if (
		cache &&
		cache.encryptedValue === encryptedValue &&
		cache.expiresAt > Date.now()
	) {
		return { descopeAccessKey, encryptedValue };
	}

	const probe = await exchangeAccessKey(env, descopeAccessKey);
	if (probe.ok && probe.missingScopes.length === 0) {
		validatedAccessKeyCache.set(tediId, {
			encryptedValue,
			expiresAt: Date.now() + ACCESS_KEY_VALIDATION_TTL_MS,
		});
		return { descopeAccessKey, encryptedValue };
	}

	const reason = probe.ok
		? `missing runtime API scopes: ${probe.missingScopes.join(", ")}`
		: probe.error;

	if (!env.API_SERVICE) {
		console.warn(
			`[isolate-access-key-guard] ${tediId}: access key stale (${reason}); API_SERVICE missing, cannot rotate`,
		);
		return { descopeAccessKey, encryptedValue };
	}

	console.warn(
		`[isolate-access-key-guard] ${tediId}: access key stale (${reason}), rotating...`,
	);

	try {
		await callRpc(
			"tedis/rotateAccessKey",
			{ tediId },
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(env.API_SERVICE),
				// A service binding authenticates the transport, not the procedure:
				// `tedis/rotateAccessKey` is behind `apps:write`, which only
				// `X-Tedix-Tedi-Scopes` delegates. Hand-rolling these headers without
				// it 403s every rotation, so a tedi whose key is missing scopes keeps
				// replaying the stale key indefinitely.
				headers: tediRuntimeServiceBindingHeaders(tediId, "apps:write"),
			},
		);
	} catch (error) {
		console.error(
			`[isolate-access-key-guard] ${tediId}: rotation API call failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { descopeAccessKey, encryptedValue };
	}

	const nextEncryptedValue = await readEncryptedTediSecret(
		env,
		tediId,
		DESCOPE_ACCESS_KEY_NAME,
	);
	const nextAccessKey = await decryptAccessKey(env, tediId, nextEncryptedValue);
	validatedAccessKeyCache.set(tediId, {
		encryptedValue: nextEncryptedValue,
		expiresAt: Date.now() + ACCESS_KEY_VALIDATION_TTL_MS,
	});
	console.log(
		`[isolate-access-key-guard] ${tediId}: rotated and reloaded Descope access key`,
	);
	return {
		descopeAccessKey: nextAccessKey,
		encryptedValue: nextEncryptedValue,
	};
}

export async function loadTediSecrets(
	env: Cloudflare.Env,
	tediId: string,
): Promise<{ descopeAccessKey: string }> {
	const encryptedValue = await readEncryptedTediSecret(
		env,
		tediId,
		DESCOPE_ACCESS_KEY_NAME,
	);
	const descopeAccessKey = await decryptAccessKey(env, tediId, encryptedValue);
	const scoped = await ensureScopedAccessKey(
		env,
		tediId,
		encryptedValue,
		descopeAccessKey,
	);
	return { descopeAccessKey: scoped.descopeAccessKey };
}

export async function makePlatformClient(
	env: Cloudflare.Env,
	tediId: string,
	orgId: string,
): Promise<HttpPlatformClient> {
	if (!env.API_URL) {
		throw new Error("API_URL missing from Worker env");
	}

	// Service-binding transport (preferred): route brain/skills/rationale RPC over
	// the in-account `API_SERVICE` binding instead of the public edge. This keeps
	// internal post-turn traffic (~5-8 /rpc/* calls per turn) off the public
	// `API_RATE_LIMITER` (100 req/60s per `tedi:{id}`), which otherwise throttles
	// memory/skills/rationale writes under concurrency.
	//
	// Trust + attribution: apps/api `isServiceBinding()` trusts the marker the
	// client stamps only on its InternalEntrypoint, which only in-account
	// Workers can reach through the binding. tedi identity is preserved because the client
	// carries `tediId`/`orgId` in every RPC payload AND `X-Tedix-Tedi-Id` /
	// `X-Tedix-Org-Id` headers — write handlers attribute from `input.tediId`,
	// org-scoped by `X-Tedix-Org-Id`. This mirrors how the kernel/MCP already call
	// apps/api over service-binding.
	if (env.API_SERVICE) {
		return new HttpPlatformClient({
			apiBaseUrl: env.API_URL,
			apiAuthMode: "service-binding",
			fetch: env.API_SERVICE.fetch.bind(env.API_SERVICE),
			tediId,
			organizationId: orgId || undefined,
			serviceBindingScopes: TEDI_RUNTIME_SERVICE_BINDING_SCOPES,
		});
	}

	// Fallback: no service binding available (e.g. misconfigured env). Use the
	// Descope-authenticated public-edge path. Subject to the public rate limiter.
	const { descopeAccessKey } = await loadTediSecrets(env, tediId);
	if (!env.DESCOPE_PROJECT_ID) {
		throw new Error("DESCOPE_PROJECT_ID missing from Worker env");
	}
	return new HttpPlatformClient({
		apiBaseUrl: env.API_URL,
		descopeAccessKey,
		descopeProjectId: env.DESCOPE_PROJECT_ID,
		descopeBaseUrl: env.DESCOPE_BASE_URL,
		tediId,
		organizationId: orgId || undefined,
	});
}

export async function resolveBrainBridgePlatformClient({
	env,
	tediId,
	orgId,
	currentClient = null,
	makeClient = makePlatformClient,
	warn = console.warn,
	missingSecretWarns = missingPlatformClientSecretWarns,
}: {
	env: Cloudflare.Env;
	tediId: string;
	orgId: string;
	currentClient?: HttpPlatformClient | null;
	makeClient?: PlatformClientFactory;
	warn?: WarnFn;
	missingSecretWarns?: Set<string>;
}): Promise<HttpPlatformClient | null> {
	if (currentClient) return currentClient;
	try {
		return await makeClient(env, tediId, orgId);
	} catch (err) {
		if (isMissingDescopeAccessKeySecretError(err)) {
			const warnKey = `${tediId}:${err.secretName}`;
			if (!missingSecretWarns.has(warnKey)) {
				missingSecretWarns.add(warnKey);
				warn(
					`[isolate-brain-bridge] platform client unavailable for tediId=${tediId}: DESCOPE_ACCESS_KEY secret is not configured; skipping brain bridge work until provisioned`,
				);
			}
			return null;
		}
		warn("[isolate-brain-bridge] platform client init failed:", err);
		return null;
	}
}
