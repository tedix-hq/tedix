import { readCmsBundle } from "@tedix/provisioning/cms-bundle";
import {
	themeCandidateEtag,
	type CmsThemeCandidate,
} from "@tedix/provisioning/cms-theme-candidate";
import type { Env } from "./env";
import type { OrgInfo } from "./public-proxy";
import type { ThemePreviewProps } from "./theme-preview-bindings";

/** Separate isolate and capabilities; the candidate's modules are never rewritten. */
export function themePreviewEntrypoint(
	env: Env,
	ctx: ExecutionContext,
	candidate: CmsThemeCandidate,
	org: OrgInfo,
): Fetcher {
	const handle = env.LOADER.get(
		`cms-theme-preview:${candidate.siteId}:${candidate.restoreEpoch}:${candidate.id}:${candidate.etag}`,
		async () => {
			const bundle = await readCmsBundle(
				env.TENANT_BUNDLES,
				candidate.r2Prefix,
			);
			if ((await themeCandidateEtag(bundle.modules)) !== candidate.etag)
				throw new Error("Candidate bundle digest changed");
			const previewExports = ctx.exports as unknown as {
				ThemePreviewDatabase(options: { props: ThemePreviewProps }): Fetcher;
				ThemePreviewMedia(options: { props: ThemePreviewProps }): Fetcher;
				ThemePreviewSession(options: { props: Record<string, never> }): Fetcher;
			};
			const props: ThemePreviewProps = {
				siteId: candidate.siteId,
				slug: candidate.slug,
				restoreEpoch: candidate.restoreEpoch,
				expiresAt: candidate.expiresAt,
				bucketName: org.r2BucketName,
			};
			const wrapper = "__tedix_theme_preview_entrypoint.mjs";
			return {
				compatibilityDate: "2026-05-14",
				compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
				globalOutbound: null,
				mainModule: wrapper,
				modules: {
					...bundle.modules,
					[wrapper]: {
						js: `
import { WorkerEntrypoint } from "cloudflare:workers";
import handler from ${JSON.stringify(bundle.mainModule)};
export default class ThemePreview extends WorkerEntrypoint {
	fetch(request) {
		process.env.EMDASH_MIGRATIONS_MODE = "check";
		return handler.fetch(request, this.env, this.ctx);
	}
}`,
					},
				},
				env: {
					DB_DO: previewExports.ThemePreviewDatabase({ props }),
					MEDIA: previewExports.ThemePreviewMedia({ props }),
					SESSION: previewExports.ThemePreviewSession({ props: {} }),
					ORG_SLUG: candidate.slug,
					CMS_SITE_ID: candidate.siteId,
					SITE_TITLE: org.siteTitle,
					ENVIRONMENT: env.ENVIRONMENT,
					PUBLIC_SITE_URL: org.publicSiteUrl,
					SITE_URL: new URL(org.publicSiteUrl).origin,
					PUBLIC_PATH_PREFIX: org.publicPathPrefix ?? "",
					DEFAULT_LOCALE: org.defaultLocale ?? "",
					PLATFORM_BRANDING: org.brandingJson ?? "",
					PLATFORM_SOCIAL_LINKS: org.socialJson ?? "",
					EMDASH_MIGRATIONS_MODE: "check",
				},
			};
		},
	);
	return handle.getEntrypoint();
}
