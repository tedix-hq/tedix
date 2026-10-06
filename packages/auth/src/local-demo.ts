import type { JWTPayload } from "./types";

export const LOCAL_DEMO_PROJECT_ID = "local-development-disabled";
export const LOCAL_DEMO_TOKEN = "tedix-local-demo";
export const LOCAL_DEMO_ISSUER = "http://localhost/tedix-local-demo";
export const LOCAL_DEMO_USER_ID = "local-demo-owner";
export const LOCAL_DEMO_USER_EMAIL = "owner@localhost.invalid";
export const LOCAL_DEMO_USER_NAME = "Local Owner";
export const LOCAL_DEMO_ORGANIZATION_ID =
	"00000000-0000-4000-8000-000000000001";
export const LOCAL_DEMO_ORGANIZATION_NAME = "Local Tedix";
export const LOCAL_DEMO_ORGANIZATION_SLUG = "local-tedix";
export const LOCAL_DEMO_TENANT_ID = `personal_${LOCAL_DEMO_USER_ID}`;
export const LOCAL_DEMO_TEDI_ID = "00000000-0000-4000-8000-000000000004";

export function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized === "127.0.0.1" ||
		normalized === "::1"
	);
}

export function isLoopbackUrl(value: string | URL): boolean {
	try {
		return isLoopbackHostname(
			typeof value === "string" ? new URL(value).hostname : value.hostname,
		);
	} catch {
		return false;
	}
}

export function isLocalDemoProject(projectId: string | undefined): boolean {
	return projectId === LOCAL_DEMO_PROJECT_ID;
}

export function isLocalDemoRequest(input: {
	environment: string | undefined;
	projectId: string | undefined;
	url: string | URL;
	hostname?: string;
	enabled?: boolean;
}): boolean {
	return (
		input.environment === "development" &&
		isLocalDemoProject(input.projectId) &&
		(input.enabled === true ||
			isLoopbackUrl(input.url) ||
			(input.hostname !== undefined && isLoopbackHostname(input.hostname)))
	);
}

export function createLocalDemoUserPayload(now = Date.now()): JWTPayload {
	const issuedAt = Math.floor(now / 1_000);
	return {
		sub: LOCAL_DEMO_USER_ID,
		email: LOCAL_DEMO_USER_EMAIL,
		name: LOCAL_DEMO_USER_NAME,
		roles: ["owner"],
		permissions: [],
		iat: issuedAt,
		exp: issuedAt + 24 * 60 * 60,
		iss: LOCAL_DEMO_ISSUER,
		aud: LOCAL_DEMO_PROJECT_ID,
		dct: LOCAL_DEMO_TENANT_ID,
	};
}

export function resolveLocalDemoUser(input: {
	environment: string | undefined;
	projectId: string | undefined;
	token: string;
	url: string | URL;
	hostname?: string;
	enabled?: boolean;
}): JWTPayload | null {
	if (input.token !== LOCAL_DEMO_TOKEN || !isLocalDemoRequest(input)) {
		return null;
	}
	return createLocalDemoUserPayload();
}
