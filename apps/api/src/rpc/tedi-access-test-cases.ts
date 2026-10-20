/**
 * Test-only principal matrix for `requireTediAccess` policies.
 *
 * Every router that guards a caller-supplied tedi id runs the same rows
 * through its own policy and pins one outcome per row, so a policy change
 * shows up as a diff in that router's expectation table rather than as a
 * silent widening. Rows are named so an exhaustive `Record<CaseName, …>`
 * fails to compile when a case is added here but not pinned by a caller.
 */
import type { JWTPayload } from "@tedix/auth/types";
import type { BaseContext } from "./orpc";

export const TEDI_ACCESS_TARGET = {
	id: "tedi-target",
	organizationId: "org-target",
	policyPackId: null,
	runtimeOverrides: null,
};

export const MISSING_TEDI_ID = "tedi-missing";

export type TediAccessOutcome =
	| "allow"
	| "FORBIDDEN"
	| "UNAUTHORIZED"
	| "NOT_FOUND";

function user(claims: { roles: string[]; scope?: string }): JWTPayload {
	return { sub: "user-1", exp: 2, iss: "https://auth.tedix.test", ...claims };
}

function apiKey(scopes: string[]): BaseContext["apiKey"] {
	return { id: "key-1", organizationId: "org-other", name: "test", scopes };
}

function serviceAccount(scope: string): BaseContext["serviceAccount"] {
	return { clientId: "client-1", scope };
}

const tenantUser = user({ roles: [] });
const operatorAppHeaders = { "X-Tedix-Mcp-App-Slug": "tedix-unified" };

export const TEDI_ACCESS_CASES = [
	{
		name: "same-org user",
		context: {
			authType: "user",
			organizationId: "org-target",
			user: tenantUser,
		},
	},
	{
		name: "cross-org user",
		context: {
			authType: "user",
			organizationId: "org-other",
			user: tenantUser,
		},
	},
	{
		name: "cross-org user with platform-admin role",
		context: {
			authType: "user",
			organizationId: "org-other",
			user: user({ roles: ["platform-admin"] }),
		},
	},
	{
		name: "cross-org user with platform:admin scope",
		context: {
			authType: "user",
			organizationId: "org-other",
			user: user({ roles: [], scope: "platform:admin" }),
		},
	},
	{
		name: "cross-org api key with platform:admin",
		context: {
			authType: "apikey",
			organizationId: "org-other",
			apiKey: apiKey(["platform:admin"]),
		},
	},
	{
		name: "cross-org api key with wildcard scope",
		context: {
			authType: "apikey",
			organizationId: "org-other",
			apiKey: apiKey(["*"]),
		},
	},
	{
		name: "cross-org api key with tenant scopes",
		context: {
			authType: "apikey",
			organizationId: "org-other",
			apiKey: apiKey(["mcp:tedis.admin"]),
		},
	},
	{
		name: "cross-org m2m with platform:admin",
		context: {
			authType: "m2m",
			organizationId: "org-other",
			serviceAccount: serviceAccount("platform:admin"),
		},
	},
	{
		name: "system service binding",
		context: { authType: "service-binding", organizationId: "system" },
	},
	{
		name: "verified MCP edge identity lookup",
		context: {
			authType: "service-binding",
			organizationId: "system",
			serviceBindingPrincipal: "mcp-edge",
		},
	},
	{
		name: "missing sibling tedi",
		tediId: MISSING_TEDI_ID,
		context: {
			authType: "tedi",
			organizationId: "org-target",
			tediId: "tedi-sibling",
		},
	},
	{
		name: "system organization on a user call",
		context: { authType: "user", organizationId: "system", user: tenantUser },
	},
	{
		name: "cross-org service binding",
		context: { authType: "service-binding", organizationId: "org-other" },
	},
	{
		name: "tenant tedi forwarded by verified MCP binding",
		context: {
			authType: "service-binding",
			serviceBindingPrincipal: "mcp-edge",
			organizationId: "org-other",
			tediId: "tedi-other",
			tediScopes: ["apps:read"],
		},
	},
	{
		name: "untrusted binding forwarding platform headers",
		context: {
			authType: "service-binding",
			organizationId: "org-other",
			tediScopes: ["platform:admin"],
		},
	},
	{
		name: "untrusted binding forwarding operator app headers",
		context: {
			authType: "service-binding",
			organizationId: "org-other",
			headers: new Headers(operatorAppHeaders),
		},
	},
	{
		name: "cross-org service binding forwarding a platform tedi",
		context: {
			authType: "service-binding",
			serviceBindingPrincipal: "mcp-edge",
			organizationId: "org-other",
			tediId: "tedi-cto",
			tediScopes: ["platform:admin"],
		},
	},
	{
		name: "cross-org service binding from the operator MCP app",
		context: {
			authType: "service-binding",
			serviceBindingPrincipal: "mcp-edge",
			organizationId: "org-other",
			headers: new Headers(operatorAppHeaders),
		},
	},
	{
		name: "operator MCP app slug on a user call",
		context: {
			authType: "user",
			organizationId: "org-other",
			user: tenantUser,
			headers: new Headers(operatorAppHeaders),
		},
	},
	{
		name: "self tedi",
		context: {
			authType: "tedi",
			organizationId: "org-target",
			tediId: "tedi-target",
		},
	},
	{
		name: "self tedi without organization",
		context: { authType: "tedi", tediId: "tedi-target" },
	},
	{
		name: "self tedi with a cross-org context",
		context: {
			authType: "tedi",
			organizationId: "org-other",
			tediId: "tedi-target",
		},
	},
	{
		name: "sibling tedi in the same org",
		context: {
			authType: "tedi",
			organizationId: "org-target",
			tediId: "tedi-sibling",
		},
	},
	{
		name: "sibling platform tedi in the same org",
		context: {
			authType: "tedi",
			organizationId: "org-target",
			tediId: "tedi-sibling",
			tediScopes: ["platform:admin"],
		},
	},
	{
		name: "cross-org tedi",
		context: {
			authType: "tedi",
			organizationId: "org-other",
			tediId: "tedi-other",
		},
	},
	{
		name: "user without organization",
		context: { authType: "user", user: tenantUser },
	},
	{
		name: "platform-admin user without organization",
		context: { authType: "user", user: user({ roles: ["platform-admin"] }) },
	},
	{
		name: "platform api key without organization",
		context: { authType: "apikey", apiKey: apiKey(["platform:admin"]) },
	},
	{
		name: "missing tedi for a same-org user",
		tediId: MISSING_TEDI_ID,
		context: {
			authType: "user",
			organizationId: "org-target",
			user: tenantUser,
		},
	},
	{
		name: "missing tedi for a cross-org user",
		tediId: MISSING_TEDI_ID,
		context: {
			authType: "user",
			organizationId: "org-other",
			user: tenantUser,
		},
	},
	{
		name: "missing tedi for a user without organization",
		tediId: MISSING_TEDI_ID,
		context: { authType: "user", user: tenantUser },
	},
	{
		name: "missing tedi for a platform api key without organization",
		tediId: MISSING_TEDI_ID,
		context: { authType: "apikey", apiKey: apiKey(["platform:admin"]) },
	},
] as const satisfies readonly {
	name: string;
	tediId?: string;
	context: Partial<BaseContext>;
}[];

export type TediAccessCaseName = (typeof TEDI_ACCESS_CASES)[number]["name"];

export function tediAccessContext(
	overrides: Partial<BaseContext>,
): BaseContext {
	return {
		db: {},
		headers: new Headers(),
		url: new URL("https://api.test/rpc/tedis/get"),
		...overrides,
	} as BaseContext;
}

/** `getTediById` stand-in: the target exists, every other id is absent. */
export async function lookupTediAccessTarget(
	_db: unknown,
	tediId: string,
): Promise<typeof TEDI_ACCESS_TARGET | null> {
	return tediId === TEDI_ACCESS_TARGET.id ? TEDI_ACCESS_TARGET : null;
}
