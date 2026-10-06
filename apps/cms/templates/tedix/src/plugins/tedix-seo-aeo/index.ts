/**
 * @tedix/seo-aeo — Tedix GEO/AEO metadata extensions for Emdash
 *
 * Emdash core owns the standard SEO surface: title, description, canonical,
 * OpenGraph/Twitter image tags, robots, default social image, Search Console
 * verification, WebSite JSON-LD, and BlogPosting JSON-LD.
 *
 * This plugin only adds Tedix-specific discovery and enrichment signals that
 * are not native Emdash settings yet.
 *
 * What it emits via `page:metadata`:
 *   - Explicit Organization or Person site-owner identity
 *   - CollectionPage JSON-LD  (index, post index, tag/category pages)
 *   - BreadcrumbList JSON-LD     (post detail pages, based on page.content)
 *   - Native BlogPosting/WebSite graph enrichment (one primary graph)
 *   - Person JSON-LD             (article pages with a primary byline)
 *   - <meta property="article:section">         (article + primary category)
 *   - <meta property="article:tag">             (article + each tag)
 *   - <meta name="twitter:site"> + twitter:creator (settings.social.twitter|.x)
 *   - <meta name="content-signal">              (always — AI training signal)
 *
 * What it does not touch (left to EmDashHead native + theme):
 *   - <title>, <meta description>, canonical, OpenGraph, Twitter image/card,
 *     og:locale, hreflang, robots, favicon, default social image
 *   - Standard BlogPosting/WebSite fields (native Emdash builders own them)
 *   - google-site-verification / msvalidate.01
 *   - Theme chrome, RSS link, markdown alternate link, /llms.txt, etc.
 *
 * Native site settings read (set via cms_*.settings_update):
 *   social.twitter | social.x       — twitter:site + twitter:creator + Org sameAs
 *   social.linkedin                 — Org sameAs
 *   social.github                   — Org sameAs
 *   logo (string URL or { url })    — Org logo
 *   tagline | description           — Org description
 *   title                           — Org/site name
 *   url                             — Org/site URL override
 */

import { env as cfEnv } from "cloudflare:workers";
import { getCollectionInfo, getSiteSettings } from "emdash";
import type { SandboxedPlugin } from "emdash/plugin";
import { buildBlogPostingJsonLd, buildWebSiteJsonLd } from "emdash/page";
import { t } from "../../i18n/strings";

interface BylineSummary {
	displayName?: string | null;
	bio?: string | null;
	websiteUrl?: string | null;
	jobTitle?: string | null;
	sameAs?: string[] | null;
	email?: string | null;
	awards?: string[] | null;
	knowsAbout?: string[] | null;
	avatarMediaId?: string | null;
	avatarStorageKey?: string | null;
	avatarAlt?: string | null;
	image?: string | null;
	customFields?: Record<string, unknown> | null;
}

interface ContentBylineCredit {
	byline?: BylineSummary | null;
}

interface FaqItem {
	q: string;
	a: string;
}

interface SettingsShape {
	seo?: { defaultOgImage?: { url?: string } | string | null };
	title?: string;
	url?: string;
	logo?: string | { url?: string };
	tagline?: string;
	description?: string;
	social?: {
		twitter?: string;
		x?: string;
		linkedin?: string;
		github?: string;
	};
}

interface PlatformBranding {
	logo?: string;
	homepageUrl?: string;
	description?: string;
	social: Record<string, string | undefined>;
}

// Neutral defaults — this template ships across many customer orgs, so we
// must not bake Tedix-specific social handles, logo, or description here.
// Absent per-org settings means "don't emit" rather than substituting
// platform values into customer Organization JSON-LD / Twitter metas.
const THEME_DEFAULTS: {
	social: Record<string, string | undefined>;
	logo: string | null;
	tagline: string | undefined;
} = {
	social: {},
	logo: null,
	tagline: undefined,
};

function readPlatformBranding(
	env: Record<string, string | undefined>,
): PlatformBranding {
	const result: PlatformBranding = { social: {} };
	if (env.PLATFORM_BRANDING) {
		try {
			const branding = JSON.parse(env.PLATFORM_BRANDING) as {
				logo?: string | null;
				images?: { logo?: string | null };
				homepageUrl?: string | null;
				homeUrl?: string | null;
				description?: string | null;
			};
			if (typeof branding.logo === "string") result.logo = branding.logo;
			else if (typeof branding.images?.logo === "string") {
				result.logo = branding.images.logo;
			}
			if (typeof branding.homepageUrl === "string") {
				result.homepageUrl = branding.homepageUrl;
			} else if (typeof branding.homeUrl === "string") {
				result.homepageUrl = branding.homeUrl;
			}
			if (typeof branding.description === "string") {
				result.description = branding.description;
			}
		} catch {
			// Branding is optional; malformed JSON should not block rendering.
		}
	}
	if (env.PLATFORM_SOCIAL_LINKS) {
		try {
			result.social = JSON.parse(env.PLATFORM_SOCIAL_LINKS) as Record<
				string,
				string | undefined
			>;
		} catch {
			// Social links are optional.
		}
	}
	return result;
}

function normaliseTwitterHandle(raw: string): string {
	if (raw.startsWith("@")) return raw;
	if (raw.startsWith("http")) {
		// strip x.com/ or twitter.com/ prefix
		return `@${raw.replace(/^https?:\/\/(?:x\.com|twitter\.com)\//, "")}`;
	}
	return `@${raw.replace(/^@/, "")}`;
}

function buildSameAs(social: Record<string, string | undefined>): string[] {
	const handle = social.twitter ?? social.x;
	const out: string[] = [];
	if (handle) {
		out.push(
			handle.startsWith("http")
				? handle
				: `https://x.com/${handle.replace(/^@/, "")}`,
		);
	}
	if (social.linkedin) {
		out.push(
			social.linkedin.startsWith("http")
				? social.linkedin
				: `https://linkedin.com/company/${social.linkedin}`,
		);
	}
	if (social.github) {
		out.push(
			social.github.startsWith("http")
				? social.github
				: `https://github.com/${social.github}`,
		);
	}
	return out;
}

function isAbsoluteHttpUrl(value: string | null | undefined): value is string {
	if (!value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function stringField(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function stringArrayField(value: unknown): string[] {
	if (Array.isArray(value))
		return value.map(stringField).filter(Boolean) as string[];
	const raw = stringField(value);
	return raw
		? raw
				.split(/\r?\n|,/)
				.map((item) => item.trim())
				.filter(Boolean)
		: [];
}

function bylineField(byline: BylineSummary, ...keys: string[]): string | null {
	const custom = byline.customFields ?? {};
	for (const key of keys) {
		const value = stringField(custom[key]);
		if (value) return value;
	}
	return null;
}

function bylineArrayField(byline: BylineSummary, ...keys: string[]): string[] {
	const custom = byline.customFields ?? {};
	for (const key of keys) {
		const value = stringArrayField(custom[key]);
		if (value.length > 0) return value;
	}
	return [];
}

function collectionIndexPathFromPattern(pattern: string): string | null {
	const withLeadingSlash = pattern.startsWith("/") ? pattern : `/${pattern}`;
	const normalized = withLeadingSlash
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
	const match = normalized.match(/^(.*)\/\{(?:slug|id)\}$/);
	if (!match) return null;

	const parent = (match[1] ?? "").replace(/\/+$/, "");
	if (parent.includes("{") || parent.includes("}")) return null;
	return parent.length > 0 ? `${parent}/` : "/";
}

function collectionIndexPathForPattern(
	pattern: string | null | undefined,
	collection: string,
	localePrefix: string,
): string {
	const patternIndexPath = pattern
		? collectionIndexPathFromPattern(pattern)
		: null;
	return normalisePathKey(
		patternIndexPath
			? `${localePrefix}${patternIndexPath}`
			: `${localePrefix}/${collection}/`,
	);
}

async function collectionIndexUrl(
	siteBase: string,
	collection: string,
	localePrefix: string,
): Promise<string> {
	try {
		const info = await getCollectionInfo(collection);
		const pattern = info?.urlPattern?.trim();
		const path = collectionIndexPathForPattern(
			pattern,
			collection,
			localePrefix,
		);
		return `${siteBase}${path === "/" ? "/" : `${path}/`}`.replace(
			/([^:]\/)\/+/g,
			"$1",
		);
	} catch {
		// Metadata enrichment must never block the page.
	}
	return `${siteBase}${localePrefix}/${collection}/`.replace(
		/([^:]\/)\/+/g,
		"$1",
	);
}

function normalisePathKey(path: string): string {
	const pathname = (path.split("?")[0] || "/").replace(/\/{2,}/g, "/");
	const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return withLeadingSlash === "/" ? "/" : withLeadingSlash.replace(/\/+$/, "");
}

async function collectionIndexPathFor(
	collection: string,
	localePrefix: string,
): Promise<string> {
	try {
		const info = await getCollectionInfo(collection);
		const pattern = info?.urlPattern?.trim();
		return collectionIndexPathForPattern(pattern, collection, localePrefix);
	} catch {
		// Metadata enrichment must never block the page.
	}
	return normalisePathKey(`${localePrefix}/${collection}/`);
}

function withPublicBase(raw: string, base: string): string {
	if (!raw) return raw;
	try {
		return new URL(raw, base.endsWith("/") ? base : `${base}/`).toString();
	} catch {
		return raw;
	}
}

function firstNonEmptyString(
	...values: Array<string | null | undefined>
): string | undefined {
	return values.find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
}

function portableBlockText(block: any): string {
	if (!block || typeof block !== "object") return "";
	const children = Array.isArray(block.children) ? block.children : [];
	return children
		.map((child: any) => (typeof child?.text === "string" ? child.text : ""))
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

function normaliseFaqEntries(raw: unknown): FaqItem[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry): FaqItem[] => {
		if (!entry || typeof entry !== "object") return [];
		const e = entry as Record<string, unknown>;
		const q = typeof e.question === "string" ? e.question.trim() : "";
		const a = typeof e.answer === "string" ? e.answer.trim() : "";
		return q && a ? [{ q, a }] : [];
	});
}

function normaliseMarketingFaqBlock(block: unknown): FaqItem[] {
	if (!block || typeof block !== "object") return [];
	const rawItems = (block as Record<string, unknown>).items;
	return normaliseFaqEntries(rawItems);
}

function isFaqHeading(text: string): boolean {
	const normalised = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return [
		"faq",
		"faqs",
		"frequently asked questions",
		"haufig gestellte fragen",
		"preguntas frecuentes",
		"questions frequentes",
		"domande frequenti",
		"perguntas frequentes",
		"veelgestelde vragen",
	].includes(normalised);
}

function extractFaqFromPortableContent(rawContent: unknown): FaqItem[] {
	if (!Array.isArray(rawContent)) return [];

	const items: FaqItem[] = [];
	let inFaqSection = false;
	let currentQuestion: string | null = null;
	let answerParts: string[] = [];

	const flush = () => {
		const answer = answerParts.join("\n\n").trim();
		if (currentQuestion && answer) {
			items.push({ q: currentQuestion, a: answer });
		}
		currentQuestion = null;
		answerParts = [];
	};

	for (const block of rawContent) {
		if (!block || typeof block !== "object") continue;
		if ((block as Record<string, unknown>)._type === "marketing.faq") {
			flush();
			items.push(...normaliseMarketingFaqBlock(block));
			continue;
		}
		const style = typeof block.style === "string" ? block.style : "normal";
		const text = portableBlockText(block);
		if (!text) continue;

		const isHeading = /^h[1-6]$/.test(style);
		if (isHeading && isFaqHeading(text)) {
			flush();
			inFaqSection = true;
			continue;
		}
		if (!inFaqSection) continue;
		if (style === "h2") {
			flush();
			break;
		}

		const looksLikeQuestion = /^h[3-6]$/.test(style) || /\?\s*$/.test(text);
		if (looksLikeQuestion) {
			flush();
			currentQuestion = text;
			continue;
		}
		if (currentQuestion) {
			answerParts.push(text);
		}
	}
	flush();

	return items.slice(0, 12);
}

export default {
	hooks: {
		"page:metadata": async (event: { page: any }, ctx: any) => {
			const { page } = event;
			const settings = (await getSiteSettings()) as SettingsShape;
			const env = cfEnv as unknown as Record<string, string | undefined>;
			const platform = readPlatformBranding(env);
			const identityType =
				(await ctx.settings?.get("identityType")) === "Person"
					? "Person"
					: "Organization";

			// Site title + canonical/origin
			const siteTitle =
				firstNonEmptyString(
					settings.title,
					page.siteName,
					env.SITE_TITLE,
					ctx.site?.name,
				) ?? "Site";
			const canonicalOverride = firstNonEmptyString(settings.url);
			// hostname-only origin (used for internal API paths like /_emdash/api/media/*)
			const origin = (() => {
				try {
					if (page.canonical) return new URL(page.canonical).origin;
					return new URL(page.url).origin;
				} catch {
					return ctx.site?.url ?? "";
				}
			})();
			// Public base URL. Collection path segments come from native Emdash
			// urlPattern, so this plugin does not need deployment-specific route
			// prefix logic.
			const siteBase = page.siteUrl?.replace(/\/+$/, "") || origin;
			const orgUrl =
				firstNonEmptyString(platform.homepageUrl, canonicalOverride) ??
				siteBase;
			const orgId = `${orgUrl.replace(/\/+$/, "")}#${identityType === "Person" ? "person" : "organization"}`;
			const webSiteId = `${siteBase}/#website`;
			const path: string = page.path ?? "";
			const canonicalUrl = page.canonical ?? page.url ?? `${siteBase}${path}`;

			// Social handles + Org sameAs
			const social: Record<string, string | undefined> = {
				...THEME_DEFAULTS.social,
				...platform.social,
				...((settings.social ?? {}) as Record<string, string | undefined>),
			};
			const twitterHandle = social.twitter ?? social.x;
			const sameAs = buildSameAs(social);

			// Logo + description
			const logoUrl =
				typeof settings.logo === "string"
					? settings.logo
					: ((settings.logo as { url?: string } | undefined)?.url ??
						platform.logo ??
						THEME_DEFAULTS.logo);
			const resolvedLogoUrl = logoUrl?.startsWith("http")
				? logoUrl
				: logoUrl
					? withPublicBase(logoUrl, origin || siteBase)
					: null;
			const orgDescription = firstNonEmptyString(
				settings.tagline,
				settings.description,
				platform.description,
				THEME_DEFAULTS.tagline,
			);

			const contributions: any[] = [];
			const pathKey = normalisePathKey(path || "/");
			const localeMatch = path.match(/^\/([a-z]{2})(?:\/|$)/);
			const localePrefix = localeMatch?.[1] ? `/${localeMatch[1]}` : "";
			const pageLocale =
				firstNonEmptyString(
					typeof page.locale === "string" ? page.locale : undefined,
					typeof page.currentLocale === "string"
						? page.currentLocale
						: undefined,
					localeMatch?.[1],
					env.DEFAULT_LOCALE,
				) ?? "en";
			const postsIndexPath = await collectionIndexPathFor(
				"posts",
				localePrefix,
			);

			// ── Explicit site owner identity ────────────────────────
			const orgSchema: Record<string, unknown> = {
				"@context": "https://schema.org",
				"@type": identityType,
				"@id": orgId,
				name: siteTitle,
				url: orgUrl,
			};
			if (resolvedLogoUrl) {
				orgSchema[identityType === "Person" ? "image" : "logo"] = {
					"@type": "ImageObject",
					url: resolvedLogoUrl,
				};
			}
			if (orgDescription) orgSchema.description = orgDescription;
			if (sameAs.length > 0) orgSchema.sameAs = sameAs;
			contributions.push({
				kind: "jsonld",
				id: "tedix-seo-aeo:identity",
				graph: orgSchema,
			});

			const website = buildWebSiteJsonLd(page);
			if (website)
				contributions.push({
					kind: "jsonld",
					id: page.pageType === "article" ? "tedix-seo-aeo:website" : "primary",
					graph: { ...website, "@id": webSiteId, publisher: { "@id": orgId } },
				});
			const fallbackImage =
				typeof settings.seo?.defaultOgImage === "string"
					? settings.seo.defaultOgImage
					: settings.seo?.defaultOgImage?.url;
			const nativeArticle = buildBlogPostingJsonLd(
				page,
				fallbackImage ? withPublicBase(fallbackImage, origin) : null,
			);
			if (nativeArticle)
				contributions.push({
					kind: "jsonld",
					id: "primary",
					graph: {
						...nativeArticle,
						"@id": `${canonicalUrl}#article`,
						isPartOf: { "@id": webSiteId },
						publisher: { "@id": orgId },
					},
				});

			// ── CollectionPage JSON-LD ──────────────────────────────
			const isCollectionPage =
				pathKey === "/" ||
				pathKey === postsIndexPath ||
				/^\/[a-z]{2}$/.test(pathKey) ||
				/^(\/[a-z]{2})?\/(?:tag|category)\/[^/]+$/.test(pathKey);
			if (isCollectionPage) {
				const pageDescription = page.seo?.ogDescription || page.description;
				const pageSchema: Record<string, unknown> = {
					"@context": "https://schema.org",
					"@type": "CollectionPage",
					"@id": `${canonicalUrl}#webpage`,
					url: canonicalUrl,
					name: page.pageTitle ?? page.title ?? siteTitle,
					isPartOf: { "@id": webSiteId },
					publisher: { "@id": orgId },
				};
				if (pageDescription) pageSchema.description = pageDescription;
				if (page.image) {
					pageSchema.primaryImageOfPage = {
						"@type": "ImageObject",
						url: page.image,
					};
				}
				contributions.push({
					kind: "jsonld",
					id: "tedix-seo-aeo:collection-page",
					graph: pageSchema,
				});
			}

			// ── Twitter site/creator (when handle configured) ────────
			if (twitterHandle) {
				const handle = normaliseTwitterHandle(twitterHandle);
				contributions.push({
					kind: "meta",
					name: "twitter:site",
					content: handle,
					key: "twitter:site",
				});
				contributions.push({
					kind: "meta",
					name: "twitter:creator",
					content: handle,
					key: "twitter:creator",
				});
			}

			// ── BreadcrumbList JSON-LD (post detail) ─────────────────
			const isPostDetail =
				page.pageType === "article" && page.content?.collection === "posts";
			if (isPostDetail) {
				const postsIndexUrl = await collectionIndexUrl(
					siteBase,
					"posts",
					localePrefix,
				);
				const titleForCrumb = page.pageTitle ?? page.title ?? "Article";
				contributions.push({
					kind: "jsonld",
					id: "tedix-seo-aeo:breadcrumbs",
					graph: {
						"@context": "https://schema.org",
						"@type": "BreadcrumbList",
						itemListElement: [
							{
								"@type": "ListItem",
								position: 1,
								name: "Home",
								item: `${siteBase}/`,
							},
							{
								"@type": "ListItem",
								position: 2,
								name: t("articles", pageLocale),
								item: postsIndexUrl,
							},
							{
								"@type": "ListItem",
								position: 3,
								name: titleForCrumb,
								item: canonicalUrl,
							},
						],
					},
				});
			}

			// ── FAQPage JSON-LD ──────────────────────────────────────
			// Prefer the free-form `faq` field. For migrated/generated posts
			// that only have a `## FAQ` section in Portable Text, derive the
			// same FAQPage JSON-LD from question/answer blocks as a fallback.
			if (
				page.pageType === "article" &&
				page.content?.collection &&
				page.content?.id
			) {
				try {
					const faqEntry = await ctx.content?.get(
						page.content.collection,
						page.content.id,
					);
					const data = faqEntry?.data as Record<string, unknown> | undefined;
					const structuredFaq = normaliseFaqEntries(data?.faq);
					const items =
						structuredFaq.length > 0
							? structuredFaq
							: extractFaqFromPortableContent(data?.content);
					if (items.length > 0) {
						contributions.push({
							kind: "jsonld",
							id: "tedix-seo-aeo:faq",
							graph: {
								"@context": "https://schema.org",
								"@type": "FAQPage",
								mainEntity: items.map(({ q, a }) => ({
									"@type": "Question",
									name: q,
									acceptedAnswer: { "@type": "Answer", text: a },
								})),
							},
						});
					}
				} catch {
					// Non-fatal; base SEO still ships.
				}
			}

			if (
				page.pageType === "article" &&
				page.content?.collection &&
				page.content?.id
			) {
				const collection = page.content.collection;
				const entryId = page.content.id;

				// Pull bylines from the entry's data (no separate API). The
				// content access is gated by `read:content`, but article pages
				// have it because this plugin needs it for AEO. If unavailable
				// we skip silently — base SEO still works.
				let bylines: ContentBylineCredit[] = [];
				let entryData: Record<string, unknown> | null = null;
				let primaryByline: BylineSummary | null = null;
				const pageBylines = Array.isArray(page.bylines)
					? (page.bylines as ContentBylineCredit[])
					: [];
				try {
					const entry = await ctx.content?.get(collection, entryId);
					if (entry) {
						entryData = (entry.data as Record<string, unknown>) ?? null;
						const raw = entryData?.bylines;
						if (Array.isArray(raw)) {
							bylines = raw as ContentBylineCredit[];
							primaryByline = bylines[0]?.byline ?? null;
						}
					}
				} catch {
					// Content access may be unavailable in some contexts; non-fatal.
				}
				if (!primaryByline && pageBylines.length > 0) {
					bylines = pageBylines;
					primaryByline = pageBylines[0]?.byline ?? null;
				}

				if (primaryByline?.displayName) {
					const profileUrl =
						primaryByline.websiteUrl ??
						bylineField(
							primaryByline,
							"linkedin_url",
							"linkedin",
							"profile_url",
						);
					const personSameAs = Array.from(
						new Set(
							[
								...(primaryByline.sameAs ?? []),
								...bylineArrayField(primaryByline, "same_as", "sameAs"),
								isAbsoluteHttpUrl(profileUrl) ? profileUrl : null,
							].filter(isAbsoluteHttpUrl),
						),
					);
					const jobTitle =
						primaryByline.jobTitle ??
						bylineField(primaryByline, "job_title", "jobTitle");
					const email =
						primaryByline.email ?? bylineField(primaryByline, "email");
					const awards = [
						...(primaryByline.awards ?? []),
						...bylineArrayField(primaryByline, "awards", "credentials"),
					];
					const knowsAbout = [
						...(primaryByline.knowsAbout ?? []),
						...bylineArrayField(primaryByline, "knows_about", "expertise"),
					];
					const image =
						primaryByline.image ??
						bylineField(primaryByline, "image", "image_url");
					const personGraph: Record<string, unknown> = {
						"@context": "https://schema.org",
						"@type": "Person",
						"@id": `${canonicalUrl}#author`,
						name: primaryByline.displayName,
						...(identityType === "Organization"
							? { worksFor: { "@id": orgId } }
							: {}),
					};
					if (profileUrl) personGraph.url = profileUrl;
					if (primaryByline.bio) personGraph.description = primaryByline.bio;
					if (jobTitle) personGraph.jobTitle = jobTitle;
					if (personSameAs.length > 0) personGraph.sameAs = personSameAs;
					if (email) personGraph.email = email;
					if (awards.length > 0) {
						personGraph.awards = awards;
					}
					if (knowsAbout.length > 0) {
						personGraph.knowsAbout = knowsAbout;
					}
					if (image) {
						personGraph.image = image;
					} else if (primaryByline.avatarStorageKey) {
						personGraph.image = `${origin}/_emdash/api/media/file/${primaryByline.avatarStorageKey}`;
					} else if (primaryByline.avatarMediaId) {
						personGraph.image = `${origin}/_emdash/api/media/file/${primaryByline.avatarMediaId}`;
					}
					contributions.push({
						kind: "jsonld",
						id: "tedix-seo-aeo:person",
						graph: personGraph,
					});
				}

				const hydratedTerms = entryData?.terms as
					| Record<string, Array<{ label: string; slug?: string }>>
					| undefined;
				const categories = hydratedTerms?.category ?? [];
				const tags = hydratedTerms?.tag ?? [];
				const primaryCategory = categories[0];
				if (primaryCategory) {
					contributions.push({
						kind: "property",
						property: "article:section",
						content: primaryCategory.label,
						key: "article:section",
					});
				}
				for (const tag of tags) {
					contributions.push({
						kind: "property",
						property: "article:tag",
						content: tag.label,
						// no `key` -- multiple article:tag entries are valid
					});
				}

				if (nativeArticle && primaryByline?.displayName) {
					nativeArticle.author = {
						"@type": "Person",
						"@id": `${canonicalUrl}#author`,
						name: primaryByline.displayName,
						...(primaryByline.websiteUrl
							? { url: primaryByline.websiteUrl }
							: {}),
					};
					const primary = contributions.find(
						(c: any) => c.kind === "jsonld" && c.id === "primary",
					);
					if (primary) primary.graph.author = nativeArticle.author;
				}
			}

			// ── content-signal (always) ──────────────────────────────
			// AI-training signal — declares the page allows search + AI input
			// but not unrestricted training. Always emit.
			contributions.push({
				kind: "meta",
				name: "content-signal",
				content: "ai-train=no, search=yes, ai-input=yes",
				key: "content-signal",
			});

			return contributions;
		},
	},
} satisfies SandboxedPlugin;
