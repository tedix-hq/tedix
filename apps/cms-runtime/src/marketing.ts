import type { SiteRoutingPolicy } from "@tedix/api-contract/schemas/site-routing";
import { createDbClient } from "@tedix/db/client";
import { getSiteRoutingPolicy } from "@tedix/db/queries/site-routing";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";

import { getOrganizationServiceClient } from "./marketing-api";
import {
	demandRateLimitKey,
	demandSourceIntentId,
	demandWorkItemTitle,
	isSyntheticDemand,
	parseDemandIntake,
} from "./marketing-demand";

const MAX_SUBMISSIONS_PER_HOUR = 5;

type MarketingFailureEvent =
	| "cms.marketing_rate_limit_storage_failed"
	| "cms.marketing_work_item_capture_failed"
	| "cms.marketing_catalog_unavailable";

type ExceptionTopology = {
	type: string;
	cause?: ExceptionTopology;
	errors?: ExceptionTopology[];
	truncated?: true;
};

const SAFE_EXCEPTION_TYPES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
	"DOMException",
	"NullThrown",
	"FunctionThrown",
	"ObjectThrown",
	"CircularCause",
	"TruncatedCause",
	"UninspectableThrown",
]);

function logMarketingFailure(
	event: MarketingFailureEvent,
	error: unknown,
): void {
	const project = (exception: SerializedException): ExceptionTopology => ({
		type: SAFE_EXCEPTION_TYPES.has(exception.type)
			? exception.type
			: "UnknownThrown",
		...(exception.cause && { cause: project(exception.cause) }),
		...(exception.errors && { errors: exception.errors.map(project) }),
		...(exception.truncated && { truncated: true }),
	});
	console.error({
		component: "cms-runtime",
		event,
		exception: project(serializeException(error)),
	});
}

function json(body: Record<string, unknown>, status = 200): Response {
	return Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "application/json",
		},
	});
}

async function withinRateLimit(
	request: Request,
	env: MarketingEnv,
): Promise<boolean> {
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const key = await demandRateLimitKey(ip);
	try {
		const current = Number((await env.SESSION?.get(key)) ?? "0");
		if (current >= MAX_SUBMISSIONS_PER_HOUR) return false;
		await env.SESSION?.put(key, String(current + 1), {
			expirationTtl: 60 * 60,
		});
		return true;
	} catch (error) {
		logMarketingFailure("cms.marketing_rate_limit_storage_failed", error);
		return true;
	}
}

async function contact(request: Request, env: MarketingEnv): Promise<Response> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json({ success: false, error: "Send a valid JSON request." }, 400);
	}
	const parsed = parseDemandIntake(raw);
	if (!parsed.ok) {
		return json({ success: false, error: parsed.error }, 400);
	}
	const intake = parsed.data;

	// Honeypot: make automation believe it succeeded without creating board work.
	if (intake.website) {
		return json({ success: true, receiptId: "accepted" });
	}
	if (!(await withinRateLimit(request, env))) {
		return json(
			{
				success: false,
				error: "Too many submissions. Please try again in an hour.",
			},
			429,
		);
	}

	const requiredConfig = {
		organizationId: env.TEDIX_MARKETING_ORG_ID,
		cmoTediId: env.TEDIX_CMO_TEDI_ID,
		objectiveId: env.TEDIX_DEMAND_OBJECTIVE_ID,
		projectId: env.TEDIX_DEMAND_PROJECT_ID,
		parentWorkItemId: env.TEDIX_DEMAND_INTAKE_PARENT_ID,
	};
	if (Object.values(requiredConfig).some((value) => !value)) {
		console.error({
			component: "cms-runtime",
			event: "cms.marketing_config_incomplete",
		});
		return json(
			{ success: false, error: "Contact intake is temporarily unavailable." },
			503,
		);
	}

	const receivedAt = new Date().toISOString();
	const synthetic = isSyntheticDemand(intake.email);
	const sourceIntentId = await demandSourceIntentId(
		intake.email,
		intake.process,
	);
	const referrer =
		intake.referrer ?? request.headers.get("Referer") ?? undefined;

	try {
		const client = getOrganizationServiceClient(
			env,
			requiredConfig.organizationId,
		);
		const item = await client.workItems.create({
			title: demandWorkItemTitle(intake.process),
			description: [
				`Recurring process: ${intake.process}`,
				`Current owner: ${intake.currentOwner}`,
				`Systems involved: ${intake.systems}`,
				...(intake.context ? [`Additional context: ${intake.context}`] : []),
				`Contact: ${intake.email}`,
				synthetic
					? "Validation: synthetic reserved-domain submission; do not treat as demand."
					: "Consent: contact permitted for this process inquiry.",
			].join("\n"),
			workKind: "operations",
			riskLevel: synthetic ? "low" : "medium",
			priority: synthetic ? "low" : "high",
			accountableOwnerType: "tedi",
			accountableOwnerId: requiredConfig.cmoTediId,
			stewardType: "tedi",
			stewardId: requiredConfig.cmoTediId,
			objectiveId: requiredConfig.objectiveId,
			projectId: requiredConfig.projectId,
			parentWorkItemId: requiredConfig.parentWorkItemId,
			sourceSessionKey: `landing-contact:${intake.utmCampaign ?? "direct"}`,
			sourceIntentId,
			provenance: {
				source: "landing.contact",
				pageUrl: intake.pageUrl ?? null,
				referrer: referrer ?? null,
				receivedAt,
			},
			metadata: {
				intake: {
					email: intake.email,
					process: intake.process,
					currentOwner: intake.currentOwner,
					systems: intake.systems,
					context: intake.context ?? null,
				},
				attribution: {
					source: intake.utmSource ?? null,
					medium: intake.utmMedium ?? null,
					campaign: intake.utmCampaign ?? null,
					content: intake.utmContent ?? null,
					term: intake.utmTerm ?? null,
					referrer: referrer ?? null,
					pageUrl: intake.pageUrl ?? null,
				},
				consent: true,
				synthetic,
				receivedAt,
			},
		});

		return json({
			success: true,
			receiptId: item.id,
			synthetic,
		});
	} catch (error) {
		logMarketingFailure("cms.marketing_work_item_capture_failed", error);
		return json(
			{
				success: false,
				error:
					"We could not save your process right now. Email hello@tedix.dev instead.",
			},
			502,
		);
	}
}

export interface MarketingEnv {
	PLATFORM_DB: D1Database;
	API_SERVICE?: Fetcher;
	API_URL: string;
	SESSION: KVNamespace;
	CLI_RELEASES: R2Bucket;
	TENANT_BUNDLES: R2Bucket;
	CLI_DOWNLOAD_HOST: string;
	MARKETING_SITE_SLUG: string;
	MARKETING_DOMAINS: string;
	GIT_SHA?: string;
	TEDIX_MARKETING_ORG_ID: string;
	TEDIX_CMO_TEDI_ID: string;
	TEDIX_DEMAND_OBJECTIVE_ID: string;
	TEDIX_DEMAND_PROJECT_ID: string;
	TEDIX_DEMAND_INTAKE_PARENT_ID: string;
}

import { getCatalogClient } from "./marketing-api";
import { serveCliDownload } from "./marketing-downloads";

export function isMarketingHost(
	host: string,
	env: Pick<MarketingEnv, "MARKETING_DOMAINS">,
): boolean {
	return (env.MARKETING_DOMAINS ?? "")
		.split(",")
		.map((s) => s.trim())
		.includes(host);
}

/** RFC 9116. Renew `Expires` before it lapses. */
const SECURITY_TXT = `Contact: mailto:security@tedix.dev
Contact: https://github.com/tedix-hq/tedix/security/advisories/new
Expires: 2027-09-25T00:00:00.000Z
Preferred-Languages: en, de
Policy: https://github.com/tedix-hq/tedix/blob/main/SECURITY.md
`;

function legacyBlogMediaRedirect(
	request: Request,
	url: URL,
	policy: SiteRoutingPolicy | null,
): Response | null {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const route = policy?.legacyBlogs.find(
		(entry) => entry.sourceHost === url.hostname,
	);
	const target =
		route && Object.hasOwn(route.mediaTargets, url.pathname)
			? route.mediaTargets[url.pathname]
			: undefined;
	if (!route || !target) return null;
	return new Response(null, {
		status: 301,
		headers: {
			Location: `${route.targetOrigin}${target}`,
			"Cache-Control": "public, max-age=86400",
		},
	});
}

async function retainedMediaResponse(
	request: Request,
	env: MarketingEnv,
	policy: SiteRoutingPolicy | null,
): Promise<Response | null> {
	const url = new URL(request.url);
	const media = policy?.retainedMedia.find(
		(entry) => entry.host === url.hostname && entry.path === url.pathname,
	);
	if (!media) return null;
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	const object = await env.TENANT_BUNDLES.get(media.key);
	if (!object) return new Response("Media unavailable", { status: 503 });
	const bytes = await object.arrayBuffer();
	if ((await sha256Hex(bytes)) !== media.sha256)
		return new Response("Media integrity check failed", { status: 503 });
	return new Response(request.method === "HEAD" ? null : bytes, {
		headers: {
			"Content-Type": media.contentType,
			"Content-Length": String(bytes.byteLength),
			"Cache-Control": "public, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export function legacyBlogRedirect(
	url: URL,
	policy: SiteRoutingPolicy | null,
): Response | null {
	const route = policy?.legacyBlogs.find(
		(entry) => entry.sourceHost === url.hostname,
	);
	if (!route || url.pathname.startsWith("/_emdash/")) return null;
	const slug = url.pathname.match(/^\/posts\/([^/]+)\/?$/)?.[1];
	const target =
		url.pathname === "/rss.xml"
			? route.feedPath
			: slug && Object.hasOwn(route.postTargets, slug)
				? `${route.indexPath}/${route.postTargets[slug]}`
				: route.indexPath;
	return new Response(null, {
		status: 301,
		headers: {
			Location: `${route.targetOrigin}${target}`,
			"Cache-Control": "public, max-age=86400",
		},
	});
}

export function isMarketingContactPath(pathname: string): boolean {
	return pathname.replace(/\/+$/, "") === "/api/contact";
}

/** Public website adapters only. Never forward arbitrary RPC paths or caller auth. */
export async function marketingResponse(
	request: Request,
	env: MarketingEnv,
): Promise<Response | null> {
	const url = new URL(request.url);
	const download = await serveCliDownload(
		request,
		env.CLI_RELEASES,
		env.CLI_DOWNLOAD_HOST,
	);
	if (download) return download;
	const routing = await getSiteRoutingPolicy(createDbClient(env.PLATFORM_DB));
	const retainedMedia = await retainedMediaResponse(request, env, routing);
	if (retainedMedia) return retainedMedia;
	const legacyMedia = legacyBlogMediaRedirect(request, url, routing);
	if (legacyMedia) return legacyMedia;
	const legacyBlog = legacyBlogRedirect(url, routing);
	if (legacyBlog) return legacyBlog;
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const isMarketingTenantOrigin =
		Boolean(env.MARKETING_SITE_SLUG) &&
		url.hostname === `${env.MARKETING_SITE_SLUG}.cms.tedix.dev`;
	const isTenantAdapterPath =
		isMarketingContactPath(url.pathname) ||
		((request.method === "GET" || request.method === "HEAD") &&
			(path === "/health" || path.startsWith("/api/catalog/")));
	if (
		!isMarketingHost(url.hostname, env) &&
		!(isMarketingTenantOrigin && isTenantAdapterPath)
	)
		return null;
	if (isMarketingContactPath(url.pathname)) {
		return request.method === "POST"
			? contact(request, env)
			: new Response("Method Not Allowed", {
					status: 405,
					headers: { Allow: "POST" },
				});
	}
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const redirect = (target: string, status = 301) => {
		const dest = new URL(target, url);
		dest.search = url.search;
		return new Response(null, {
			status,
			headers: { Location: dest.toString(), "Cache-Control": "no-store" },
		});
	};
	if (path === "/.well-known/security.txt") {
		return new Response(SECURITY_TXT, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=86400",
			},
		});
	}
	if (url.pathname === "/health" || url.pathname === "/tedixpay-demo") {
		const target = new URL(`${url.pathname}/`, url);
		const publicHost = request.headers.get("X-Tedix-Public-Host");
		if (
			isMarketingTenantOrigin &&
			publicHost &&
			isMarketingHost(publicHost, env)
		)
			target.host = publicHost;
		return redirect(target.href, 308);
	}
	if (path === "/health")
		return Response.json({
			status: "ok",
			deployedSha: String(env.GIT_SHA || "unknown"),
		});
	if (path === "/waitlist") return redirect("https://os.tedix.dev/", 308);
	if (path === "/tedixpay-demo") return redirect("/tedixpay/");
	if (path === "/eurolabs") return redirect("/EuroLabs/");
	if (path === "/install")
		return redirect(`https://${env.CLI_DOWNLOAD_HOST}/install.sh`, 302);
	// Posts are served at /blog/{slug}; /posts is the collection's former path.
	// The Markdown mirrors (/posts/{slug}.md) stay where the template serves them.
	if (path === "/posts") return redirect("/blog");
	if (path.startsWith("/posts/") && !path.endsWith(".md"))
		return redirect("/blog/" + path.slice("/posts/".length));
	// The marketing template, sitemap, and article canonicals use slashless URLs.
	// Redirect before Worker Loader so alias hosts also reach tedix.dev in one hop.
	if (/^\/blog\/[^/]+\/$/.test(url.pathname))
		return redirect(`https://tedix.dev${path}`);
	if (path === "/docs" || path.startsWith("/docs/"))
		return redirect("https://docs.tedix.dev" + (path.slice(5) || "/"));
	if (!path.startsWith("/api/catalog/")) return null;
	const client = getCatalogClient(env);
	const q = url.searchParams;
	try {
		let result: unknown;
		switch (path) {
			case "/api/catalog/apps": {
				const oneOf = <const T extends readonly string[]>(
					key: string,
					values: T,
				): T[number] | undefined => {
					const v = q.get(key);
					return v && values.includes(v) ? (v as T[number]) : undefined;
				};
				const number = (key: string, fallback: number, max: number) => {
					const v = Number(q.get(key) ?? fallback);
					return Number.isSafeInteger(v) && v >= 0
						? Math.min(v, max)
						: fallback;
				};
				result = await client.catalog.list({
					search: q.get("search") || q.get("q") || undefined,
					category: q.get("category") || undefined,
					connectorType: oneOf("connectorType", [
						"MCP",
						"SERVICE",
						"FIRST_PARTY_ECOSYSTEM",
						"NATIVE",
					]),
					healthStatus: oneOf("healthStatus", [
						"healthy",
						"degraded",
						"unhealthy",
						"requires_auth",
						"blocked",
						"unsupported",
						"unknown",
					]),
					source: oneOf("source", [
						"chatgpt",
						"claude",
						"gemini",
						"copilot",
						"official",
						"tedix",
						"tedi",
						"community",
						"manual",
					]),
					sortBy: oneOf("sortBy", [
						"name",
						"sourceCreatedAt",
						"updatedAt",
						"lastSyncedAt",
						"relevance",
					]),
					sortDir: oneOf("sortDir", ["asc", "desc"]),
					hasInteractive: q.get("hasInteractive") === "true" || undefined,
					hasWrites: q.get("hasWrites") === "true" || undefined,
					limit: Math.max(1, number("limit", 24, 200)),
					offset: number("offset", 0, 1000000),
				});
				break;
			}
			case "/api/catalog/tools.json":
			case "/api/catalog/app": {
				const slug = q.get("slug");
				if (!slug || slug.length > 256)
					return json({ error: "App slug required" }, 400);
				const app = await client.catalog.getBySlug({ slug });
				if (!app) return json({ error: "App not found" }, 404);
				result = path === "/api/catalog/tools.json" ? (app.tools ?? []) : app;
				break;
			}
			case "/api/catalog/categories":
				result = await client.catalog.getCategories({});
				break;
			case "/api/catalog/stats":
				result = await client.catalog.getStats({});
				break;
			case "/api/catalog/health-summary":
				result = await client.catalog.getHealthSummary({});
				break;
			case "/api/catalog/tool-test-stats":
				result = await client.catalog.getToolTestStats({});
				break;
			default:
				return new Response("Not Found", { status: 404 });
		}
		return Response.json(result, {
			headers: { "Cache-Control": "public, max-age=60" },
		});
	} catch (error) {
		if (
			(path === "/api/catalog/app" || path === "/api/catalog/tools.json") &&
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "NOT_FOUND"
		)
			return json({ error: "App not found" }, 404);
		logMarketingFailure("cms.marketing_catalog_unavailable", error);
		return json({ error: "Catalog temporarily unavailable" }, 503);
	}
}
