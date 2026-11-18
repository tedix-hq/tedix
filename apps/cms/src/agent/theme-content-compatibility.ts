import { z } from "zod";
import type { AppBindings } from "../types";
import { buildCmsAuthHeaderCandidates } from "./cms-proxy-auth";
import { executeCmsRestRequest } from "./cms-proxy-rest";
import {
	cmsApiBaseUrl,
	cmsDoFetch,
	type CmsProxyContext,
} from "./cms-proxy-runtime";
import { CmsDeployFailure } from "./deploy-failure";
import {
	collectBlockVersions,
	requireSupportedBlocks,
	type ThemeRelease,
} from "./theme-release";

const collectionsSchema = z.object({
	items: z.array(z.object({ slug: z.string().min(1) })),
});
const pageSchema = z.object({
	items: z.array(z.object({ data: z.record(z.string(), z.unknown()) })),
	nextCursor: z.string().min(1).optional(),
});

/** No locale filter: native admin content lists include all locales. */
export async function checkLiveThemeCompatibility(
	env: AppBindings,
	orgSlug: string,
	release: ThemeRelease,
): Promise<void> {
	await visitPublishedContent(env, orgSlug, (data) =>
		requireSupportedBlocks(data, release),
	);
}

/**
 * Template defaults plus every block version the site already publishes.
 * Used once for themes created before release manifests: what is published
 * renders today, so it is supported by definition.
 */
export async function withPublishedBlocks(
	env: AppBindings,
	orgSlug: string,
	defaults: ThemeRelease["supportedBlocks"],
	maxPages = Infinity,
): Promise<ThemeRelease["supportedBlocks"]> {
	const blocks: Record<string, number[]> = Object.fromEntries(
		Object.entries(defaults).map(([type, versions]) => [type, [...versions]]),
	);
	await visitPublishedContent(
		env,
		orgSlug,
		(data) => collectBlockVersions(data, blocks),
		maxPages,
	);
	return blocks;
}

async function visitPublishedContent(
	env: AppBindings,
	orgSlug: string,
	visit: (data: Record<string, unknown>) => void,
	maxPages = Infinity,
): Promise<void> {
	const ctx: CmsProxyContext = {
		orgSlug,
		forwardedAuth: undefined,
		serviceApiKey: undefined,
		internalAuthToken: env.CMS_INTERNAL_AUTH_TOKEN,
		environment: env.ENVIRONMENT,
		cmsDispatch: env.CMS_DISPATCH,
	};
	const read = async (path: string): Promise<unknown> => {
		const result = await executeCmsRestRequest(
			buildCmsAuthHeaderCandidates(ctx),
			cmsDoFetch(ctx),
			"GET",
			`${cmsApiBaseUrl(ctx)}${path}`,
			undefined,
		);
		if (!result.ok) throw new Error("Native content read failed");
		const envelope = z
			.object({ success: z.literal(true), data: z.unknown() })
			.parse(result.json);
		return envelope.data;
	};
	try {
		const collections = collectionsSchema.parse(
			await read("/schema/collections"),
		);
		let pages = 0;
		for (const { slug } of collections.items) {
			let cursor: string | undefined;
			const seen = new Set<string>();
			do {
				if (++pages > maxPages)
					throw new Error("Native content page limit exceeded");
				const query = new URLSearchParams({
					status: "published",
					limit: "100",
				});
				if (cursor) query.set("cursor", cursor);
				const page = pageSchema.parse(
					await read(`/content/${encodeURIComponent(slug)}?${query}`),
				);
				for (const item of page.items) visit(item.data);
				cursor = page.nextCursor;
				if (cursor && seen.has(cursor))
					throw new Error("Repeated native content cursor");
				if (cursor) seen.add(cursor);
			} while (cursor);
		}
	} catch (error) {
		if (error instanceof CmsDeployFailure) throw error;
		throw new CmsDeployFailure(
			"THEME_CONTENT_UNAVAILABLE",
			"Cannot verify published block versions; restore native CMS read access before deploying",
		);
	}
}
