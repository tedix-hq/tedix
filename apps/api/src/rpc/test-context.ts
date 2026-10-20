/**
 * Test-only `BaseContext` builders for router tests.
 *
 * Every authz test that pins the two-plane rule (apps/api/AGENTS.md,
 * "Authorization is two planes") needs a user principal and an API-key
 * principal. These builders carry the shape once so a `BaseContext` change is
 * one edit; each test passes only the literals its assertions depend on.
 *
 * Defaults are the values the tests shared before this module existed:
 * organization `org-1`, tenant `tenant-1`, user `user-1`, key `key-1`.
 */
import type { JWTPayload } from "@tedix/auth/types";
import { createDbClient } from "@tedix/db/client";
import type { BaseContext } from "./orpc";

const DEFAULT_URL = "https://api.tedix.test/rpc";

export interface TestContextOptions {
	/** Resolved organization. `null` leaves the context without one. */
	organizationId?: string | null;
	/** Worker bindings. Defaults to `{ ENVIRONMENT: "test" }`. */
	env?: CloudflareEnv;
	/** Database client. Defaults to a client over `env.DB`, or an empty stub when the env has no `DB`. */
	db?: BaseContext["db"];
	/** Request URL. Defaults to `https://api.tedix.test/rpc`. */
	url?: string | URL;
	headers?: Headers | Record<string, string>;
	userRole?: string;
	crossTenantOverrideActive?: boolean;
	/** Stable Tedix user id (`BaseContext.userId`). */
	userId?: string;
}

export interface UserContextOptions extends TestContextOptions {
	permissions?: string[];
	roles?: string[];
	/** JWT `sub` claim. */
	sub?: string;
	/** JWT `dct` claim. `null` omits it. */
	tenantId?: string | null;
	/** Extra JWT claims merged last, such as `su` or `email`. */
	claims?: Partial<JWTPayload>;
}

export interface ApiKeyContextOptions extends TestContextOptions {
	scopes?: string[];
	keyId?: string;
	keyName?: string;
	/** Organization owning the key. Defaults to the context organization. */
	keyOrganizationId?: string;
}

function sharedFields(options: TestContextOptions): Partial<BaseContext> {
	const env =
		options.env ?? ({ ENVIRONMENT: "test" } as unknown as CloudflareEnv);
	const context: Partial<BaseContext> = {
		db:
			options.db ??
			(env.DB
				? (createDbClient(env.DB) as BaseContext["db"])
				: ({} as BaseContext["db"])),
		env,
		headers:
			options.headers instanceof Headers
				? options.headers
				: new Headers(options.headers),
		url:
			options.url instanceof URL
				? options.url
				: new URL(options.url ?? DEFAULT_URL),
	};
	const organizationId =
		options.organizationId === undefined ? "org-1" : options.organizationId;
	if (organizationId !== null) context.organizationId = organizationId;
	if (options.userRole !== undefined) context.userRole = options.userRole;
	if (options.crossTenantOverrideActive !== undefined)
		context.crossTenantOverrideActive = options.crossTenantOverrideActive;
	if (options.userId !== undefined) context.userId = options.userId;
	return context;
}

/** An interactive Descope-authenticated caller. */
export function userContext(options: UserContextOptions = {}): BaseContext {
	const tenantId =
		options.tenantId === undefined ? "tenant-1" : options.tenantId;
	return {
		...sharedFields(options),
		authType: "user",
		user: {
			aud: "test",
			...(tenantId === null ? {} : { dct: tenantId }),
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: options.permissions ?? [],
			roles: options.roles ?? [],
			sub: options.sub ?? "user-1",
			...options.claims,
		},
	} as BaseContext;
}

/** An organization-scoped API key caller. */
export function apiKeyContext(options: ApiKeyContextOptions = {}): BaseContext {
	const shared = sharedFields(options);
	return {
		...shared,
		apiKey: {
			id: options.keyId ?? "key-1",
			name: options.keyName ?? "test",
			organizationId:
				options.keyOrganizationId ?? shared.organizationId ?? "org-1",
			scopes: options.scopes ?? [],
		},
		authType: "apikey",
	} as BaseContext;
}

/**
 * Bind file-level defaults (typically the router URL and organization) so each
 * call site passes only what varies between tests. `user` and `apiKey` hold
 * defaults for one principal kind only.
 */
export function bindTestContexts({
	user,
	apiKey,
	...shared
}: TestContextOptions & {
	user?: UserContextOptions;
	apiKey?: ApiKeyContextOptions;
}) {
	return {
		userContext: (options: UserContextOptions = {}) =>
			userContext({ ...shared, ...user, ...options }),
		apiKeyContext: (options: ApiKeyContextOptions = {}) =>
			apiKeyContext({ ...shared, ...apiKey, ...options }),
	};
}
