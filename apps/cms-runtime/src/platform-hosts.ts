import { hostSetting } from "@tedix/worker-kit/platform-hosts";

export interface CmsRuntimePlatformHostEnv {
	/** Parent host of tenant sites (`{slug}.<suffix>`). Default `cms.tedix.dev`. */
	CMS_TENANT_HOST_SUFFIX?: string;
	/** Older blog host that also serves the marketing site. Default `blog.tedix.dev`. */
	MARKETING_BLOG_HOST?: string;
}

/** The CMS runtime's own hostnames; unset vars keep Tedix Cloud's hosts. */
export function cmsRuntimePlatformHosts(env: CmsRuntimePlatformHostEnv) {
	return {
		/** The bare suffix host answers the installation health check. */
		healthHostname: hostSetting(env.CMS_TENANT_HOST_SUFFIX, "cms.tedix.dev"),
		marketingBlogHostname: hostSetting(
			env.MARKETING_BLOG_HOST,
			"blog.tedix.dev",
		),
	};
}
