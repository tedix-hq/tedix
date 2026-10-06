/**
 * Run directly: `bun run src/platform-client-factory.test.ts`.
 */
import assert from "node:assert/strict";
import { encryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import { TEDI_RUNTIME_API_SCOPES_CLAIM } from "@tedix/auth/tedi-identity";
import type { HttpPlatformClient } from "./brain/platform-client";
import {
	findMissingRuntimeApiScopes,
	isMissingDescopeAccessKeySecretError,
	loadTediSecrets,
	MissingTediSecretError,
	resolveBrainBridgePlatformClient,
	TEDI_RUNTIME_SERVICE_BINDING_SCOPES,
	tediRuntimeServiceBindingHeaders,
} from "./platform-client-factory";

assert.deepEqual(
	tediRuntimeServiceBindingHeaders("tedi-acme", "apps:read"),
	{
		"X-Service-Binding": "true",
		"X-Tedix-Org-Id": "system",
		"X-Tedix-Tedi-Id": "tedi-acme",
		"X-Tedix-Tedi-Scopes": "apps:read",
	},
	"model-policy reads delegate only apps:read and preserve Tedi identity",
);
assert.deepEqual(
	tediRuntimeServiceBindingHeaders("tedi-acme", "apps:write"),
	{
		"X-Service-Binding": "true",
		"X-Tedix-Org-Id": "system",
		"X-Tedix-Tedi-Id": "tedi-acme",
		"X-Tedix-Tedi-Scopes": "apps:write",
	},
	"config projection delegates only apps:write and preserves Tedi identity",
);
assert.equal(
	TEDI_RUNTIME_SERVICE_BINDING_SCOPES.includes("mcp:memory.read"),
	true,
	"brain digest may read the calling Tedi's rationale chain",
);
assert.equal(
	new Set<string>(TEDI_RUNTIME_SERVICE_BINDING_SCOPES).has("*") ||
		new Set<string>(TEDI_RUNTIME_SERVICE_BINDING_SCOPES).has("platform:admin"),
	false,
	"runtime service binding never receives wildcard or platform authority",
);

assert.deepEqual(
	findMissingRuntimeApiScopes({
		[TEDI_RUNTIME_API_SCOPES_CLAIM]: [
			"tedis:read",
			"tedis:write",
			"billing:read",
			"mcp:messaging.read",
			"mcp:messaging.write",
		],
		scope: "ignored:reserved",
		scopes: ["also:ignored"],
	}),
	[],
	"Tedix-owned runtime scope claim satisfies the isolate access-key guard",
);

assert.deepEqual(
	findMissingRuntimeApiScopes({
		tediId: "tedi-1",
		entityType: "tedi",
		descopeUserId: "user-1",
	}),
	[
		"tedis:read",
		"tedis:write",
		"billing:read",
		"mcp:messaging.read",
		"mcp:messaging.write",
	],
	"identity-only access-key JWTs must be rotated",
);

const missingSecretEnv = {
	DB: {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							return null;
						},
					};
				},
			};
		},
	},
} as unknown as Cloudflare.Env;

await assert.rejects(
	() => loadTediSecrets(missingSecretEnv, "tedi-missing-secret"),
	(err) =>
		isMissingDescopeAccessKeySecretError(err) &&
		err.tediId === "tedi-missing-secret",
	"missing DESCOPE_ACCESS_KEY rows surface as a typed expected condition",
);

{
	const warnings: unknown[][] = [];
	const missingSecretWarns = new Set<string>();
	const makeClient = async () => {
		throw new MissingTediSecretError(
			"tedi-missing-secret",
			"DESCOPE_ACCESS_KEY",
		);
	};

	assert.equal(
		await resolveBrainBridgePlatformClient({
			env: {} as Cloudflare.Env,
			tediId: "tedi-missing-secret",
			orgId: "org-1",
			makeClient,
			warn: (...args) => warnings.push(args),
			missingSecretWarns,
		}),
		null,
		"missing DESCOPE_ACCESS_KEY yields a null platform client",
	);
	assert.equal(
		await resolveBrainBridgePlatformClient({
			env: {} as Cloudflare.Env,
			tediId: "tedi-missing-secret",
			orgId: "org-1",
			makeClient,
			warn: (...args) => warnings.push(args),
			missingSecretWarns,
		}),
		null,
		"repeated missing DESCOPE_ACCESS_KEY still yields a null platform client",
	);
	assert.equal(warnings.length, 1, "missing-secret warning is throttled");
	assert.equal(
		warnings[0]?.length,
		1,
		"missing-secret warning logs a single quiet line without an Error object",
	);
	assert.match(
		String(warnings[0]?.[0]),
		/DESCOPE_ACCESS_KEY secret is not configured/,
	);
}

{
	const fakeClient = {} as HttpPlatformClient;
	const calls: Array<{ tediId: string; orgId: string }> = [];
	const warnings: unknown[][] = [];

	const client = await resolveBrainBridgePlatformClient({
		env: {} as Cloudflare.Env,
		tediId: "tedi-present-secret",
		orgId: "org-1",
		makeClient: async (_env, tediId, orgId) => {
			calls.push({ tediId, orgId });
			return fakeClient;
		},
		warn: (...args) => warnings.push(args),
	});

	assert.equal(
		client,
		fakeClient,
		"present-secret path returns the platform client",
	);
	assert.deepEqual(
		calls,
		[{ tediId: "tedi-present-secret", orgId: "org-1" }],
		"present-secret path still calls the platform-client factory",
	);
	assert.deepEqual(warnings, [], "present-secret path stays quiet");
}

{
	// A service binding authenticates the transport, not the procedure:
	// `tedis/rotateAccessKey` sits behind `apps:write`, delegated only by
	// `X-Tedix-Tedi-Scopes`. Hand-rolled headers here 403 every rotation and
	// leave a scope-stale tedi replaying its old key.
	const masterKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
	const encrypted = await encryptTediSecret(
		masterKey,
		"tedi-stale",
		"stale-key",
	);
	const rotations: Request[] = [];
	const staleEnv = {
		SECRETS_MASTER_KEY: masterKey,
		DB: {
			prepare: () => ({
				bind: () => ({ first: async () => ({ encrypted_value: encrypted }) }),
			}),
		},
		// No Descope project: the key cannot be proven scoped, so it rotates.
		API_SERVICE: {
			fetch: async (request: Request) => {
				rotations.push(request);
				return Response.json({ ok: true });
			},
		},
	} as unknown as Cloudflare.Env;
	const originalWarn = console.warn;
	const originalLog = console.log;
	console.warn = () => {};
	console.log = () => {};
	try {
		await loadTediSecrets(staleEnv, "tedi-stale");
	} finally {
		console.warn = originalWarn;
		console.log = originalLog;
	}
	assert.equal(rotations.length, 1);
	assert.match(new URL(rotations[0]!.url).pathname, /tedis\/rotateAccessKey/);
	for (const [name, value] of Object.entries(
		tediRuntimeServiceBindingHeaders("tedi-stale", "apps:write"),
	))
		assert.equal(
			rotations[0]!.headers.get(name),
			value,
			`access-key rotation must send ${name}: ${value}`,
		);
}
