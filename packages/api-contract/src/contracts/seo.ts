import "@orpc/openapi/extensions/route";
/**
 * SEO Contract for oRPC
 * Search research, Google Search Console, and IndexNow integration for apps.
 *
 * All endpoints are scoped to a specific `appId` and operate on the app's
 * `metadata.seoConfig` plus live calls to the Google Search Console API.
 *
 * Auth: Caller must own (or have access to) the app via the standard
 * organization-scoped auth flow. Procedures that mutate `seoConfig` require
 * `apps:write` scope; read procedures require `apps:read`.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { JsonValueSchema } from "../schemas/common";

// =============================================================================
// SHARED SCHEMAS
// =============================================================================

const AppIdInputSchema = z.object({
	appId: z.uuid(),
});

const SeoMarketInputSchema = z.object({
	locationCode: z
		.number()
		.int()
		.positive()
		.default(2840)
		.describe("Data provider location code. Defaults to the United States."),
	languageCode: z
		.string()
		.regex(/^[a-z]{2,3}$/)
		.default("en")
		.describe("Search language code."),
});

const SeoProviderReceiptSchema = z.object({
	provider: z.literal("dataforseo"),
	providerTaskId: z.string(),
	endpoint: z.string(),
	costMicros: z.number().int().nonnegative(),
	statusCode: z.number().int(),
	statusMessage: z.string().nullable(),
	billing: z.object({
		credentialMode: z.enum(["managed", "byok"]),
		rateCardId: z.string().nullable(),
		creditsDebited: z.number().int().nonnegative(),
		creditsRemaining: z.number().int().nonnegative().nullable(),
	}),
});

const SeoProviderFailureReceiptSchema = z.object({
	providerTaskId: z.string(),
	endpoint: z.string(),
	path: z.array(z.string()),
	costMicros: z.number().int().nonnegative(),
	statusCode: z.number().int(),
	statusMessage: z.string().nullable(),
});

export const SeoProviderFailureDataSchema = z.object({
	provider: z.literal("dataforseo"),
	providerStatusCode: z.number().int().nullable(),
	recoveryAction: z.enum(["verify_account"]).nullable(),
	receipt: SeoProviderFailureReceiptSchema.nullable(),
});

const NullableMetricSchema = z.number().finite().nullable();

export const SeoConfigSchema = z.object({
	googleVerification: z.string().nullable().optional(),
	/** Per-site verification tokens, keyed by siteUrl (e.g. "https://blog.tedix.dev/"). Issued by `registerGoogleProperty`. */
	googleVerifications: z.record(z.string(), z.string()).optional(),
	indexNowKey: z.string().nullable().optional(),
	gscPropertyUrl: z.string().nullable().optional(),
});

const SearchAnalyticsRowSchema = z.object({
	keys: z.array(z.string()).optional(),
	clicks: z.number().optional(),
	impressions: z.number().optional(),
	ctr: z.number().optional(),
	position: z.number().optional(),
});

const SitemapSchema = z.object({
	path: z.string(),
	lastSubmitted: z.string().nullable().optional(),
	isPending: z.boolean().optional(),
	isSitemapsIndex: z.boolean().optional(),
	type: z.string().optional(),
	lastDownloaded: z.string().nullable().optional(),
	warnings: z.number().optional(),
	errors: z.number().optional(),
	contents: z.array(JsonValueSchema).optional(),
});

const GoogleVerificationMethodSchema = z.enum(["META", "DNS_TXT"]);
const GoogleVerificationSiteTypeSchema = z.enum(["SITE", "INET_DOMAIN"]);

// =============================================================================
// CONTRACT
// =============================================================================

export const seoContract = oc
	.route({ tags: ["seo"], prefix: "/seo" })
	.errors({
		...baseErrors,
		BAD_GATEWAY: {
			message: "SEO data provider request failed",
			data: SeoProviderFailureDataSchema.optional(),
		},
	})
	.router({
		/**
		 * Provider-neutral keyword research for a tenant app.
		 * POST /seo/research-keywords
		 */
		researchKeywords: oc
			.route({
				method: "POST",
				path: "/research-keywords",
				summary: "Research keyword opportunities",
				description:
					"Return normalized keyword opportunities and an auditable provider-cost receipt. This is a paid open-world research call.",
			})
			.input(
				AppIdInputSchema.extend(SeoMarketInputSchema.shape).extend({
					keyword: z.string().trim().min(1).max(700),
					limit: z.number().int().min(1).max(100).default(25),
				}),
			)
			.output(
				z.object({
					keyword: z.string(),
					locationCode: z.number().int(),
					languageCode: z.string(),
					items: z.array(
						z.object({
							keyword: z.string(),
							searchVolume: NullableMetricSchema,
							cpc: NullableMetricSchema,
							competition: NullableMetricSchema,
							competitionLevel: z.string().nullable(),
							keywordDifficulty: NullableMetricSchema,
						}),
					),
					receipt: SeoProviderReceiptSchema,
				}),
			),

		/**
		 * Live Google SERP research for a tenant app.
		 * POST /seo/get-serp-results
		 */
		getSerpResults: oc
			.route({
				method: "POST",
				path: "/get-serp-results",
				summary: "Get live SERP results",
				description:
					"Return normalized live Google search results and an auditable provider-cost receipt. This is a paid open-world research call.",
			})
			.input(
				AppIdInputSchema.extend(SeoMarketInputSchema.shape).extend({
					keyword: z.string().trim().min(1).max(700),
					depth: z.number().int().min(10).max(100).default(20),
					device: z.enum(["desktop", "mobile"]).default("desktop"),
				}),
			)
			.output(
				z.object({
					keyword: z.string(),
					locationCode: z.number().int(),
					languageCode: z.string(),
					device: z.enum(["desktop", "mobile"]),
					items: z.array(
						z.object({
							type: z.string(),
							rank: NullableMetricSchema,
							domain: z.string().nullable(),
							title: z.string().nullable(),
							url: z.string().nullable(),
							description: z.string().nullable(),
						}),
					),
					receipt: SeoProviderReceiptSchema,
				}),
			),

		/**
		 * Organic visibility overview for a domain.
		 * POST /seo/get-domain-overview
		 */
		getDomainOverview: oc
			.route({
				method: "POST",
				path: "/get-domain-overview",
				summary: "Get domain organic visibility",
				description:
					"Return provider-neutral organic traffic and ranking-keyword estimates for a domain, with an auditable provider-cost receipt. This is a paid open-world research call.",
			})
			.input(
				AppIdInputSchema.extend(SeoMarketInputSchema.shape).extend({
					domain: z.string().trim().min(1).max(253),
				}),
			)
			.output(
				z.object({
					domain: z.string(),
					locationCode: z.number().int(),
					languageCode: z.string(),
					organicTraffic: NullableMetricSchema,
					organicKeywords: NullableMetricSchema,
					receipt: SeoProviderReceiptSchema,
				}),
			),

		/**
		 * Current backlink profile overview for a domain or page.
		 * POST /seo/get-backlinks-overview
		 */
		getBacklinksOverview: oc
			.route({
				method: "POST",
				path: "/get-backlinks-overview",
				summary: "Get backlink profile overview",
				description:
					"Return normalized backlink and referring-domain metrics for a domain or page, with an auditable provider-cost receipt. This is a paid open-world research call.",
			})
			.input(
				AppIdInputSchema.extend({
					target: z.string().trim().min(1).max(2048),
					includeSubdomains: z.boolean().default(true),
				}),
			)
			.output(
				z.object({
					target: z.string(),
					rank: NullableMetricSchema,
					backlinks: NullableMetricSchema,
					referringPages: NullableMetricSchema,
					referringDomains: NullableMetricSchema,
					brokenBacklinks: NullableMetricSchema,
					newBacklinks: NullableMetricSchema,
					lostBacklinks: NullableMetricSchema,
					spamScore: NullableMetricSchema,
					receipt: SeoProviderReceiptSchema,
				}),
			),

		/**
		 * GSC Search Analytics: rows of clicks/impressions/CTR/position for a
		 * date range, optionally grouped by dimension(s).
		 * POST /seo/query-search-analytics
		 */
		querySearchAnalytics: oc
			.route({
				method: "POST",
				path: "/query-search-analytics",
				summary: "Query GSC Search Analytics",
				description:
					"Query Google Search Console search analytics (clicks, impressions, CTR, position) for the app's verified property.",
			})
			.input(
				AppIdInputSchema.extend({
					/** Optional override for site URL (defaults to seoConfig.gscPropertyUrl). */
					siteUrl: z.string().optional(),
					/** ISO date YYYY-MM-DD */
					startDate: z.string(),
					/** ISO date YYYY-MM-DD */
					endDate: z.string(),
					dimensions: z
						.array(z.enum(["page", "query", "date", "country", "device"]))
						.optional(),
					rowLimit: z.number().int().min(1).max(25000).optional(),
					startRow: z.number().int().min(0).optional(),
				}),
			)
			.output(
				z.object({
					siteUrl: z.string(),
					rows: z.array(SearchAnalyticsRowSchema),
					responseAggregationType: z.string().optional(),
				}),
			),

		/**
		 * GSC URL Inspection: per-URL indexing status.
		 * POST /seo/get-indexing-status
		 */
		getIndexingStatus: oc
			.route({
				method: "POST",
				path: "/get-indexing-status",
				summary: "Get URL indexing status",
				description:
					"Inspect a specific URL via the Google Search Console URL Inspection API. Returns indexing verdict, coverage state, last crawl, etc.",
			})
			.input(
				AppIdInputSchema.extend({
					/** Fully-qualified URL to inspect. */
					urlInspect: z.string(),
					/** Optional GSC property URL override. */
					siteUrl: z.string().optional(),
				}),
			)
			.output(
				z.object({
					indexed: z.boolean(),
					indexabilityVerdict: z.string().nullable(),
					coverageState: z.string().nullable(),
					lastCrawled: z.string().nullable(),
					pageFetchState: z.string().nullable(),
					robotsTxtState: z.string().nullable(),
					raw: JsonValueSchema.optional(),
				}),
			),

		/**
		 * GSC: list submitted sitemaps for a property.
		 * POST /seo/list-sitemaps
		 */
		listSitemaps: oc
			.route({
				method: "GET",
				path: "/list-sitemaps",
				summary: "List submitted sitemaps",
				description:
					"List sitemaps submitted to Google Search Console for the app's verified property.",
			})
			.input(
				AppIdInputSchema.extend({
					siteUrl: z.string().optional(),
				}),
			)
			.output(
				z.object({
					siteUrl: z.string(),
					sitemaps: z.array(SitemapSchema),
				}),
			),

		/**
		 * GSC: submit a sitemap URL.
		 * POST /seo/submit-sitemap
		 */
		submitSitemap: oc
			.route({
				method: "POST",
				path: "/submit-sitemap",
				summary: "Submit sitemap to GSC",
				description:
					"Submit (or resubmit) a sitemap to Google Search Console for the app's verified property.",
			})
			.input(
				AppIdInputSchema.extend({
					siteUrl: z.string().optional(),
					/** Sitemap URL. Defaults to https://{primaryDomain}/sitemap-index.xml */
					sitemapUrl: z.string().optional(),
				}),
			)
			.output(
				z.object({
					success: z.literal(true),
					siteUrl: z.string(),
					sitemapUrl: z.string(),
				}),
			),

		/**
		 * GSC: verify property via the configured Site Verification method.
		 * POST /seo/verify-google
		 */
		verifyGoogle: oc
			.route({
				method: "POST",
				path: "/verify-google",
				summary: "Verify GSC property",
				description:
					"Verify ownership of the app's GSC property via META or DNS_TXT. Requires register_google_property first so the verification token is live.",
			})
			.input(
				AppIdInputSchema.extend({
					siteUrl: z.string().optional(),
					verificationMethod: GoogleVerificationMethodSchema.optional(),
					siteType: GoogleVerificationSiteTypeSchema.optional(),
				}),
			)
			.output(
				z.object({
					verified: z.boolean(),
					method: z.string(),
					siteType: GoogleVerificationSiteTypeSchema.optional(),
					siteUrl: z.string(),
				}),
			),

		/**
		 * Aggregate read: GSC verification + last sitemap submission +
		 * indexed page count proxy.
		 * POST /seo/get-status
		 */
		getStatus: oc
			.route({
				method: "GET",
				path: "/get-status",
				summary: "Get search-discovery status",
				description:
					"Aggregate status: GSC verification, last sitemap submission, and an indexed-page-count proxy from a 28-day search analytics query.",
			})
			.input(AppIdInputSchema)
			.output(
				z.object({
					verified: z.boolean(),
					propertyUrl: z.string().nullable(),
					lastSubmittedSitemap: z
						.object({
							path: z.string(),
							lastSubmitted: z.string().nullable(),
						})
						.nullable(),
					indexedPageCount: z.number().nullable(),
					seoConfig: SeoConfigSchema,
				}),
			),

		/**
		 * Programmatically register the service account as Owner of a Google
		 * Search Console property. Calls Google's siteVerification/v1/token to
		 * issue a META or DNS_TXT token, persists it to
		 * `app.metadata.seoConfig.googleVerifications[siteUrl]`, and returns
		 * the token the caller must render on the public site or publish in DNS before
		 * calling `verify_google_property` to claim ownership.
		 *
		 * POST /seo/register-google-property
		 */
		registerGoogleProperty: oc
			.route({
				method: "POST",
				path: "/register-google-property",
				summary: "Register GSC property (issue verification token)",
				description:
					"Request a Google Search Console verification token for the given site and persist it to the app's seoConfig. Use DNS_TXT for sc-domain properties and META for URL-prefix properties.",
			})
			.input(
				AppIdInputSchema.extend({
					/** Property URL to verify (e.g. https://blog.tedix.dev/). Defaults to the app's primary domain. */
					siteUrl: z.string().optional(),
					/** Verification method. META verifies URL-prefix properties; DNS_TXT verifies domain properties. */
					verificationMethod: GoogleVerificationMethodSchema.optional(),
					/** Site Verification resource type. Defaults from verificationMethod/siteUrl. */
					siteType: GoogleVerificationSiteTypeSchema.optional(),
				}),
			)
			.output(
				z.object({
					success: z.literal(true),
					siteUrl: z.string(),
					siteType: GoogleVerificationSiteTypeSchema,
					verificationMethod: GoogleVerificationMethodSchema,
					token: z.string(),
					metaTag: z.string().nullable(),
					dnsTxtRecord: z.string().nullable(),
					message: z.string(),
				}),
			),

		/**
		 * Remove a property from Google Search Console (and optionally relinquish
		 * the SA's verification ownership). Idempotent — safe to call when the
		 * property is already gone.
		 *
		 * POST /seo/delete-google-property
		 */
		deleteGoogleProperty: oc
			.route({
				method: "POST",
				path: "/delete-google-property",
				summary: "Delete GSC property",
				description:
					"Remove a property from Google Search Console for the given site URL, and (by default) also relinquish the service account's verification ownership. Useful when retiring customer subdomains so Google stops reporting analytics and coverage for dead URLs. Idempotent.",
			})
			.input(
				AppIdInputSchema.extend({
					/** Property URL to remove (e.g. https://blog.tedix.dev/). Defaults to the app's primary domain. */
					siteUrl: z.string().optional(),
					/** Also DELETE the siteVerification webResource (default true). Set false to keep ownership but drop the GSC property. */
					releaseVerification: z.boolean().optional(),
				}),
			)
			.output(
				z.object({
					success: z.literal(true),
					siteUrl: z.string(),
					gscRemoved: z.boolean(),
					gscStatus: z.number(),
					verificationReleased: z.boolean(),
					verificationStatus: z.number().nullable(),
				}),
			),

		/**
		 * Mutate per-app `seoConfig`. Any subset of fields can be provided.
		 * PATCH /seo/configure
		 */
		configure: oc
			.route({
				method: "PATCH",
				path: "/configure",
				summary: "Configure search discovery",
				description:
					"Update the app's seoConfig (googleVerification token, IndexNow key, GSC property URL). Pass only the fields you want to change.",
			})
			.input(
				AppIdInputSchema.extend({
					googleVerification: z.string().nullable().optional(),
					indexNowKey: z.string().nullable().optional(),
					gscPropertyUrl: z.string().nullable().optional(),
				}),
			)
			.output(
				z.object({
					success: z.literal(true),
					seoConfig: SeoConfigSchema,
				}),
			),
	});

export type SeoContract = typeof seoContract;
