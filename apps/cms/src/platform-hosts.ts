import { hostSetting, platformDomains } from "@tedix/worker-kit/platform-hosts";

export interface CmsPlatformHostEnv {
	/** Parent host of tenant sites (`{slug}.<suffix>`). Default `cms.tedix.dev`. */
	CMS_TENANT_HOST_SUFFIX?: string;
	/** Public host of the Site Builder. Default `builder.tedix.dev`. */
	SITE_BUILDER_HOSTNAME?: string;
	/** Comma-separated domains whose HTTPS subdomains may call the Site Builder. */
	PLATFORM_DOMAINS?: string;
}

/** The Site Builder's own hostnames; unset vars keep Tedix Cloud's hosts. */
export function cmsPlatformHosts(env: CmsPlatformHostEnv) {
	const tenantHostSuffix = hostSetting(
		env.CMS_TENANT_HOST_SUFFIX,
		"cms.tedix.dev",
	);
	return {
		siteBuilderHostname: hostSetting(
			env.SITE_BUILDER_HOSTNAME,
			"builder.tedix.dev",
		),
		platformDomains: platformDomains(env),
		/** Origin the CMS runtime routes to the tenant site `slug`. */
		tenantOrigin: (slug: string) => `https://${slug}.${tenantHostSuffix}`,
	};
}
