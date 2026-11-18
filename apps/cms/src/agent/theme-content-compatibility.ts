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
import { requireSupportedBlocks, type ThemeRelease } from "./theme-release";

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
		for (const { slug } of collections.items) {
			let cursor: string | undefined;
			const seen = new Set<string>();
			do {
				const query = new URLSearchParams({
					status: "published",
					limit: "100",
				});
				if (cursor) query.set("cursor", cursor);
				const page = pageSchema.parse(
					await read(`/content/${encodeURIComponent(slug)}?${query}`),
				);
				for (const item of page.items)
					requireSupportedBlocks(item.data, release);
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
