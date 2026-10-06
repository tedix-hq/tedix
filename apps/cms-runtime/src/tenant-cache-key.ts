export interface TenantRuntimeEnvHashOrg {
	brandingJson: string | null;
	defaultLocale: string | null;
	descopeTenantId: string;
	humanAssertionBundleEtag?: string | null;
	publicPathPrefix: string | null;
	publicSiteUrl: string;
	r2BucketName: string;
	siteTitle: string;
	socialJson: string | null;
}

export interface TenantRuntimeBundleHashBundle {
	etag: string;
	mainModule: string;
	modulesJson: string[];
	r2Prefix: string;
	version: number;
}

export interface TenantRuntimeEnvHashEnv {
	CLOUDFLARE_R2_API_TOKEN?: string;
	CMS_INTERNAL_AUTH_TOKEN?: string;
	EMDASH_ENCRYPTION_KEY?: string;
	DESCOPE_PROJECT_ID?: string;
	ENVIRONMENT: string;
	PLATFORM_API_URL?: string;
}

/**
 * Bump whenever parent-owned Worker Loader policy or injected RPC capability
 * shape changes. Loader handles survive parent deploys, so bundle and env
 * hashes alone do not guarantee that a corrected factory is re-evaluated.
 */
export const TENANT_RUNTIME_LOADER_POLICY_VERSION = "10";

function shortHash(input: string): string {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function tenantEnvSecretFingerprint(value: string | undefined): string {
	return value ? `set:${value.length}:${shortHash(value)}` : "unset";
}

export function resolveTenantPlatformApiUrl(
	env: Pick<TenantRuntimeEnvHashEnv, "ENVIRONMENT" | "PLATFORM_API_URL">,
): string {
	return (
		env.PLATFORM_API_URL ??
		(env.ENVIRONMENT === "production"
			? "https://api.tedix.dev"
			: "https://api.tedix.tech")
	);
}

export function tenantRuntimeEnvHash(
	org: TenantRuntimeEnvHashOrg,
	env: TenantRuntimeEnvHashEnv,
): string {
	return shortHash(
		[
			org.r2BucketName,
			org.siteTitle,
			org.brandingJson ?? "",
			org.socialJson ?? "",
			org.descopeTenantId,
			org.humanAssertionBundleEtag ?? "",
			org.publicSiteUrl,
			org.publicPathPrefix ?? "",
			org.defaultLocale ?? "",
			env.ENVIRONMENT,
			resolveTenantPlatformApiUrl(env),
			tenantEnvSecretFingerprint(env.CLOUDFLARE_R2_API_TOKEN),
			tenantEnvSecretFingerprint(env.CMS_INTERNAL_AUTH_TOKEN),
			tenantEnvSecretFingerprint(env.EMDASH_ENCRYPTION_KEY),
			tenantEnvSecretFingerprint(env.DESCOPE_PROJECT_ID),
		].join("\u001f"),
	);
}

export function tenantRuntimeBundleHash(
	bundle: TenantRuntimeBundleHashBundle,
): string {
	return shortHash(
		[
			bundle.version,
			bundle.r2Prefix,
			bundle.mainModule,
			bundle.etag,
			...bundle.modulesJson,
		].join("\u001f"),
	);
}

export function tenantRuntimeCacheKey(
	slug: string,
	bundle: TenantRuntimeBundleHashBundle,
	org: TenantRuntimeEnvHashOrg,
	env: TenantRuntimeEnvHashEnv,
): string {
	return [
		slug,
		`loader:${TENANT_RUNTIME_LOADER_POLICY_VERSION}`,
		String(bundle.version),
		tenantRuntimeBundleHash(bundle),
		tenantRuntimeEnvHash(org, env),
	].join("@");
}
