import { env } from "cloudflare:workers";

/**
 * Public site URL for SEO emission. cms-runtime injects PUBLIC_SITE_URL per
 * isolate from `apps.metadata.publicSiteUrl`, falling back to the
 * `*.cms.tedix.dev` origin host. Collection paths come from native Emdash
 * urlPattern so SEO authority accrues to the customer's public route shape
 * without encoding route policy into the site base URL.
 */
export function getPublicSiteUrl(): string {
	const value = (env as unknown as Record<string, string | undefined>)
		.PUBLIC_SITE_URL;
	if (value && value.length > 0) return value.replace(/\/+$/, "");
	const slug =
		(env as unknown as Record<string, string | undefined>).ORG_SLUG ??
		"preview";
	return `https://${slug}.cms.tedix.dev`;
}
