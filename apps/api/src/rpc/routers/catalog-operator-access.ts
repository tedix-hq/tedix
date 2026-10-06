import {
	getTenantPermissions,
	getTenantRoles,
	isPlatformPrincipal,
	type JWTPayload,
} from "@tedix/auth/types";
import { type BaseContext, createError, ErrorCodes } from "../orpc";

type CatalogOperatorContext = Pick<
	BaseContext,
	"apiKey" | "authType" | "organizationId" | "serviceAccount" | "user"
>;

export type TenantOpenApiImportTarget = {
	organizationId: string | null;
	sourceAppId?: string | null;
	metadata?: unknown;
	catalogToolSource?: string | null;
};

type TenantOpenApiImportIntent = {
	spec?: unknown;
	specUrl?: unknown;
};

const CATALOG_OPERATOR_SCOPES = new Set([
	"*",
	"platform:admin",
	"catalog:manage",
]);

const CATALOG_OPERATOR_ROLES = new Set(["platform-admin", "catalog-operator"]);

function hasCatalogScope(scopes: readonly string[] | undefined): boolean {
	return Boolean(scopes?.some((scope) => CATALOG_OPERATOR_SCOPES.has(scope)));
}

function hasCatalogOperatorUserGrant(user: JWTPayload | undefined): boolean {
	if (!user) return false;
	if (isPlatformPrincipal({ user })) return true;

	const roles = getTenantRoles(user);
	if (roles.some((role) => CATALOG_OPERATOR_ROLES.has(role))) return true;

	const permissions = getTenantPermissions(user);
	return hasCatalogScope(permissions);
}

function hasOpenApiSyncConfig(metadata: unknown): boolean {
	if (typeof metadata !== "object" || metadata === null) return false;
	const mcpConfig = (metadata as { mcpConfig?: unknown }).mcpConfig;
	if (typeof mcpConfig !== "object" || mcpConfig === null) return false;
	const openApiSync = (mcpConfig as { openApiSync?: unknown }).openApiSync;
	if (typeof openApiSync !== "object" || openApiSync === null) return false;
	return (openApiSync as { enabled?: unknown }).enabled === true;
}

export function hasTenantOpenApiImportAccess(
	context: CatalogOperatorContext,
	target: TenantOpenApiImportTarget | null | undefined,
	intent: TenantOpenApiImportIntent = {},
): boolean {
	if (!context.organizationId || !target) return false;
	if (target.organizationId !== context.organizationId) return false;
	if (target.sourceAppId) return false;

	const hasExplicitSpec =
		typeof intent.specUrl === "string" || intent.spec != null;
	return (
		target.catalogToolSource === "openapi" ||
		hasOpenApiSyncConfig(target.metadata) ||
		hasExplicitSpec
	);
}

export function hasCatalogOperatorAccess(
	context: CatalogOperatorContext,
): boolean {
	if (context.authType === "service-binding") {
		return true;
	}

	if (context.authType === "apikey") {
		return hasCatalogScope(context.apiKey?.scopes);
	}

	if (context.authType === "m2m") {
		return hasCatalogScope(context.serviceAccount?.scope?.split(/\s+/));
	}

	if (context.authType === "user") {
		return hasCatalogOperatorUserGrant(context.user);
	}

	return false;
}

export function requireCatalogOperatorAccess(
	context: CatalogOperatorContext,
): void {
	if (!hasCatalogOperatorAccess(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Platform catalog operator access required",
		);
	}
}
