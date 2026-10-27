import {
	assertCustomHostname,
	type CmsCustomHostnameEnv,
} from "./cms-custom-hostnames";

/** Private ops supplies the OS SaaS zone; the CMS fallback origin must not serve OS hosts. */
export interface OrganizationCustomHostnameEnv {
	CF_OS_SAAS_ZONE_ID?: string;
	CF_OS_HOSTNAMES_TOKEN?: string;
	CF_OS_SAAS_TARGET_DOMAIN?: string;
}
export function organizationHostnameProvider(
	env: OrganizationCustomHostnameEnv,
): CmsCustomHostnameEnv {
	if (
		!env.CF_OS_SAAS_ZONE_ID ||
		!env.CF_OS_HOSTNAMES_TOKEN ||
		env.CF_OS_SAAS_TARGET_DOMAIN !== "os.tedix.dev"
	)
		throw new Error(
			"Organization custom domains are not configured for this installation",
		);
	return {
		CF_CMS_SAAS_ZONE_ID: env.CF_OS_SAAS_ZONE_ID,
		CF_CMS_HOSTNAMES_TOKEN: env.CF_OS_HOSTNAMES_TOKEN,
	};
}
export function organizationDomainVerificationName(hostname: string) {
	return `_tedix-os.${assertCustomHostname(hostname)}`;
}
