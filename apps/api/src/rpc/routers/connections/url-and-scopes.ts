import { TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";
import {
	type ConnectionCredentialProfile,
	type ConnectionProviderTemplate,
} from "@tedix/api-contract/schemas/connection-provider-templates";
import { validateUrl } from "@tedix/ssrf-guard";

/**
 * True when a provider MCP endpoint / audit URL must not be fetched. Shared
 * guard: every private/loopback/link-local/metadata IP form, localhost and
 * local-resolution suffixes, unparseable and non-http(s) URLs. Tedix-served
 * endpoints (`{slug}.mcp.tedix.dev`) stay reachable, as before.
 */
export function isPrivateOrLoopbackUrl(url: string): boolean {
	return validateUrl(url, { allowHttp: true, allowTedixHosts: true }) !== null;
}

export function slugFromName(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "mcp-provider";
}

export function renderableLogoUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return trimmed;
	return null;
}

export function resolveProviderLogoUrl(input: {
	descopeLogo?: unknown;
	templateIcon?: unknown;
}): string | null {
	return (
		renderableLogoUrl(input.descopeLogo) ??
		renderableLogoUrl(input.templateIcon)
	);
}

export function parseScopesField(
	scopes: string[] | string | null | undefined,
): string[] {
	if (!scopes) return [];
	if (Array.isArray(scopes)) return scopes;
	try {
		const parsed = JSON.parse(scopes) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter(
				(scope): scope is string => typeof scope === "string",
			);
		}
	} catch {
		// Fall through to the legacy comma/whitespace format.
	}
	return scopes
		.split(/[,\s]+/)
		.map((scope) => scope.trim())
		.filter(Boolean);
}

export function normalizeRequestedScopes(
	scopes: string | string[] | null | undefined,
): string[] | undefined {
	const parsed = parseScopesField(scopes);
	if (parsed.length === 0) return undefined;
	return [...new Set(parsed.map((scope) => scope.trim()).filter(Boolean))];
}

export function chooseEffectiveConsentScopes(input: {
	requestedScopes?: string | string[] | null;
	connectionScopes?: string[];
	credentialProfile?: ConnectionCredentialProfile | null;
	provider?: ConnectionProviderTemplate | null;
}): string[] | undefined {
	return (
		normalizeRequestedScopes(input.requestedScopes) ??
		normalizeRequestedScopes(input.connectionScopes) ??
		normalizeRequestedScopes(input.credentialProfile?.defaultScopes) ??
		normalizeRequestedScopes(
			input.provider?.credentialProfile?.defaultScopes,
		) ??
		normalizeRequestedScopes(input.provider?.requiredScopes)
	);
}

export function mapConnectionRecord(input: {
	appId: string;
	providerName: string;
	status: "connected" | "expired" | "revoked" | "reconnect_needed";
	connectedAt: number | null;
	tokenExpiresAt: number | null;
	scopes: string[] | string | null | undefined;
	tokenScope?: "tenant" | "user";
	connectedByUserId?: string | null;
	connectedByEmail?: string | null;
}) {
	return {
		appId: input.appId,
		providerName: input.providerName,
		status: input.status,
		connectedAt: input.connectedAt,
		tokenExpiresAt: input.tokenExpiresAt,
		scopes: parseScopesField(input.scopes),
		tokenScope: input.tokenScope ?? ("tenant" as const),
		connectedByUserId: input.connectedByUserId ?? null,
		connectedByEmail: input.connectedByEmail ?? null,
	};
}

export function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

export function booleanOrNull(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

export function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function urlParamsArray(value: unknown): Array<{
	key: string;
	value: string;
}> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const candidate = item as {
			key?: unknown;
			value?: unknown;
		};
		if (
			typeof candidate.key !== "string" ||
			typeof candidate.value !== "string"
		) {
			return [];
		}
		return [
			{
				key: candidate.key,
				value: candidate.value,
			},
		];
	});
}

export function getUrlParam(
	params: Array<{
		key: string;
		value: string;
	}>,
	key: string,
): string | null {
	return params.find((param) => param.key === key)?.value ?? null;
}

export function inferOutboundConnectionType(
	app: Record<string, unknown>,
): "oauth" | "api_key" {
	const useDcr = booleanOrNull(app.useDcr);
	return app.appType === "oauth" ||
		stringOrNull(app.authorizationUrl) ||
		stringOrNull(app.discoveryUrl) ||
		stringOrNull(app.tokenUrl) ||
		stringOrNull(app.clientId) ||
		useDcr === true
		? "oauth"
		: "api_key";
}

export function inferOAuthRegistrationMode(
	app: Record<string, unknown>,
	connectionType = inferOutboundConnectionType(app),
): "cimd" | "dcr" | "pre_registered" | "invalid" | null {
	if (connectionType !== "oauth") return null;
	const clientId = stringOrNull(app.clientId);
	if (clientId === TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID) return "cimd";
	if (booleanOrNull(app.useDcr) === true) return "dcr";
	return clientId ? "pre_registered" : "invalid";
}

export function logoKind(
	value: unknown,
): "data" | "url" | "missing" | "invalid" {
	if (typeof value !== "string" || value.trim().length === 0) return "missing";
	const trimmed = value.trim();
	if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return "data";
	if (/^https?:\/\//i.test(trimmed)) return "url";
	return "invalid";
}

export function comparableUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
		return `${url.origin}${path}${url.search}${url.hash}`;
	} catch {
		return value.replace(/\/+$/, "");
	}
}

export function urlsEquivalent(a: string | null, b: string | null): boolean {
	return comparableUrl(a) === comparableUrl(b);
}

export const COMMON_IDENTITY_SCOPES = new Set([
	"openid",
	"email",
	"profile",
	"offline_access",
	"https://www.googleapis.com/auth/userinfo.profile",
]);
