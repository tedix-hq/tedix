import {
	THEME_PREVIEW_PATH,
	themeCandidateKey,
	verifyThemePreview,
	type CmsThemeCandidate,
} from "@tedix/provisioning/cms-theme-candidate";
import type { Env } from "./env";
import { getDb, lookupOrg, resolveSlug, type OrgInfo } from "./public-proxy";
import { getCmsRestoreEpoch } from "@tedix/db/queries/cms-restore-fences";
import { withSharedCmsRestorePermit } from "./tenant-restore-fence";
import { imageTransformResponse } from "./tenant-media";

function privateThemePreview(response: Response) {
	const result = new Response(response.body, response);
	result.headers.set("Cache-Control", "private, no-store");
	result.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
	result.headers.set("Referrer-Policy", "no-referrer");
	result.headers.delete("Set-Cookie");
	return result;
}

/** Runs before all public routing, canonical redirects and edge caches. */
export async function serveThemePreview(
	request: Request,
	env: Env,
	render: (
		candidate: CmsThemeCandidate,
		org: OrgInfo,
		request: Request,
	) => Promise<Response>,
): Promise<Response> {
	const reject = () =>
		privateThemePreview(
			new Response("Theme preview unavailable", { status: 404 }),
		);
	if (request.method !== "GET" && request.method !== "HEAD") return reject();
	const url = new URL(request.url);
	const parts = url.pathname.slice(THEME_PREVIEW_PATH.length).split("/");
	const [id, token, ...path] = parts;
	const slug = (await resolveSlug(env, url.hostname))?.slug;
	if (!slug || !id || !token || !/^cms-[a-z0-9-]+$/.test(id)) return reject();
	const object = await env.TENANT_BUNDLES.get(themeCandidateKey(slug, id));
	if (!object) return reject();
	const candidate = await object.json<CmsThemeCandidate>();
	if (
		candidate.id !== id ||
		candidate.slug !== slug ||
		!(await verifyThemePreview(env.CMS_INTERNAL_AUTH_TOKEN, candidate, token))
	)
		return reject();
	const org = await lookupOrg(env, slug, true);
	const restoreEpoch = await getCmsRestoreEpoch(getDb(env.PLATFORM_DB), {
		siteId: candidate.siteId,
		slug,
	});
	if (
		!org ||
		org.siteId !== candidate.siteId ||
		restoreEpoch !== candidate.restoreEpoch
	)
		return reject();
	const base = `${THEME_PREVIEW_PATH}${id}/${token}`;
	const tenantUrl = new URL(request.url);
	tenantUrl.pathname = `/${path.join("/")}`;
	const publicOrigin = new URL(org.publicSiteUrl);
	tenantUrl.protocol = publicOrigin.protocol;
	tenantUrl.host = publicOrigin.host;
	// Never forward content preview, session, service auth or editing capabilities.
	tenantUrl.searchParams.delete("_preview");
	tenantUrl.searchParams.delete("_edit");
	const mediaPath = tenantUrl.pathname.startsWith("/_emdash/api/media/file/");
	if (tenantUrl.pathname.startsWith("/_emdash") && !mediaPath) return reject();
	const tenantRequest = new Request(tenantUrl, {
		method: request.method,
		headers: { Accept: request.headers.get("Accept") ?? "text/html" },
	});
	try {
		return await withSharedCmsRestorePermit(env, candidate, async () => {
			let response: Response;
			if (tenantUrl.pathname.startsWith("/_astro/")) {
				const filename = tenantUrl.pathname.split("/").pop()!;
				const asset = await env.TENANT_BUNDLES.get(
					`${candidate.r2Prefix}static/${filename}`,
				);
				if (!asset) return reject();
				const types: Record<string, string> = {
					css: "text/css",
					js: "application/javascript",
					mjs: "application/javascript",
					woff2: "font/woff2",
					woff: "font/woff",
					svg: "image/svg+xml",
				};
				response = new Response(request.method === "HEAD" ? null : asset.body, {
					headers: {
						"Content-Type":
							types[filename.split(".").pop()!] ?? "application/octet-stream",
					},
				});
			} else {
				response =
					(await imageTransformResponse(
						env,
						org,
						env.CF_ACCOUNT_ID,
						env.CLOUDFLARE_R2_API_TOKEN,
						tenantUrl,
					)) ?? (await render(candidate, org, tenantRequest));
			}
			const rewrite = (value: string) => {
				try {
					const target = new URL(value, tenantUrl);
					if (
						target.origin !== tenantUrl.origin &&
						target.origin !== url.origin
					)
						return value;
					if (value.startsWith("#")) return value;
					return `${url.origin}${base}${target.pathname}${target.search}${target.hash}`;
				} catch {
					return value;
				}
			};
			if (
				response.headers.get("Content-Type")?.startsWith("text/css") &&
				request.method !== "HEAD"
			) {
				const css = (await response.text()).replace(
					/url\((["']?)([^)"']+)\1\)/g,
					(_match, quote: string, value: string) =>
						`url(${quote}${rewrite(value)}${quote})`,
				);
				response = new Response(css, response);
				response.headers.delete("Content-Length");
			}
			response = privateThemePreview(response);
			response.headers.set("X-Tedix-CMS-Candidate", candidate.id);
			response.headers.set("X-Tedix-CMS-Source-Commit", candidate.sourceCommit);

			const location = response.headers.get("Location");
			if (location) response.headers.set("Location", rewrite(location));
			if (response.headers.get("Content-Type")?.includes("text/html")) {
				response = new HTMLRewriter()
					.on("[href], [src], [srcset], [action], astro-island", {
						element(element) {
							if (
								element.tagName === "link" &&
								/canonical|alternate/.test(element.getAttribute("rel") ?? "")
							)
								return;
							for (const attr of [
								"href",
								"src",
								"action",
								"component-url",
								"renderer-url",
								"before-hydration-url",
							]) {
								const value = element.getAttribute(attr);
								if (value) element.setAttribute(attr, rewrite(value));
							}
							const props = element.getAttribute("props");
							if (element.tagName === "astro-island" && props) {
								// HTMLRewriter returns encoded attributes. Preserve Astro's serialized
								// tuples and entities while prefixing asset strings and srcset entries.
								element.setAttribute(
									"props",
									props.replace(
										/(&quot;|"|,\s+)(\/(?:_astro\/|_image\?|_emdash\/api\/media\/file\/))/g,
										(_match, separator: string, path: string) =>
											`${separator}${url.origin}${base}${path}`,
									),
								);
							}
							const srcset = element.getAttribute("srcset");
							if (srcset)
								element.setAttribute(
									"srcset",
									srcset
										.split(",")
										.map((part) => {
											const [url, ...rest] = part.trim().split(/\s+/);
											return [rewrite(url!), ...rest].join(" ");
										})
										.join(", "),
								);
						},
					})
					.transform(response);
			}
			// Consume under the restore permit; no preview body can read across a restore.
			return new Response(
				request.method === "HEAD" ? null : await response.arrayBuffer(),
				response,
			);
		});
	} catch (error) {
		console.error("cms.theme-preview.failed", { candidateId: id, error });
		return privateThemePreview(
			new Response("Theme preview failed", { status: 503 }),
		);
	}
}

/** Scan one catalog page per tick; retain the cursor so newer candidates cannot starve expiry. */
export async function cleanupThemeCandidates(
	bucket: R2Bucket,
	now = Date.now(),
) {
	const checkpoint = "theme-candidate-cleanup-cursor.json";
	const saved = await bucket.get(checkpoint);
	const cursor = saved
		? (await saved.json<{ cursor?: string }>()).cursor
		: undefined;
	const page = await bucket.list({
		prefix: "theme-candidates/",
		limit: 100,
		cursor,
	});
	for (const item of page.objects) {
		const object = await bucket.get(item.key);
		if (!object) continue;
		const candidate = await object.json<CmsThemeCandidate>();
		if (Date.parse(candidate.expiresAt) > now) continue;
		if (
			item.key !== themeCandidateKey(candidate.slug, candidate.id) ||
			candidate.r2Prefix !==
				`themes/${candidate.slug}/staging/${candidate.stagingAttemptId}/`
		)
			throw new Error("Invalid candidate cleanup prefix");
		let filesCursor: string | undefined;
		do {
			const files = await bucket.list({
				prefix: candidate.r2Prefix,
				cursor: filesCursor,
			});
			if (files.objects.length)
				await bucket.delete(files.objects.map((file) => file.key));
			filesCursor = files.truncated ? files.cursor : undefined;
		} while (filesCursor);
		await bucket.delete(item.key);
	}
	await bucket.put(
		checkpoint,
		JSON.stringify({ cursor: page.truncated ? page.cursor : undefined }),
	);
}
