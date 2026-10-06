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
	API_SERVICE?: Fetcher;
	API_URL: string;
	SESSION: KVNamespace;
	CLI_RELEASES: R2Bucket;
	TENANT_BUNDLES: R2Bucket;
	CLI_DOWNLOAD_HOST: string;
	MARKETING_SITE_SLUG: string;
	MARKETING_DOMAINS: string;
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

/**
 * blog.tedix.dev was folded into tedix.dev/blog. Posts that moved
 * keep their slug; retired posts point at their closest moved post, and every
 * other path lands on the index. Frozen: nothing publishes on the old host.
 * Unmapped `/_emdash/*` still reaches the old tenant while it is active.
 */
const LEGACY_BLOG_HOST = "blog.tedix.dev";
const RETIRED_BLOG_FAVICON_PATH = "/_tedix/retired-media/blog-favicon.ico";
const RETIRED_BLOG_FAVICON_SHA256 =
	"45ceb0cbbed0426333f7bdd77df942d1bd4cd7a257467a1de0980d132d256262";
// Outside the old tenant's bundle prefix, which site deprovision deletes.
const RETIRED_BLOG_FAVICON_KEY = `retired-media/blog.tedix.dev/${RETIRED_BLOG_FAVICON_SHA256}.ico`;

/** Exact public paths from the preserved old-blog media inventory. */
const LEGACY_BLOG_MEDIA_TARGETS: Record<string, string> = {
	"/_emdash/api/media/file/01KT568RETPJQQ0DM7YXE62BKB.png":
		"/_emdash/api/media/file/01M3HVQ56JFTGGEMT9DWJDBKDY.png",
	"/_emdash/api/media/file/01KT568R52PCBPNDCGWPC0DCAN.png":
		"/_emdash/api/media/file/01M3HVQEFF0NTV62Y7ZDJ41XG4.png",
	"/_emdash/api/media/file/01KT568NFTMTTWEH9TRH8PQYJ5.png":
		"/_emdash/api/media/file/01M3HVQRGJGJF3BESR0J7R08ST.png",
	"/_emdash/api/media/file/01KT568BQTDFCNNSEN1VMWEJG6.png":
		"/_emdash/api/media/file/01M3HVQY8HW7XC122QVNZ1Z53Y.png",
	"/_emdash/api/media/file/brand/default-og.png":
		"/_emdash/api/media/file/01M2Y7CVAQSA2VFR24PBEXQ8VW.png",
	"/_emdash/api/media/file/brand/logo.png":
		"/_emdash/api/media/file/01M2Y7CMEYFS5XYSJG1CYQ71N3.png",
	"/_emdash/api/media/file/brand/favicon.ico": RETIRED_BLOG_FAVICON_PATH,
	"/_emdash/api/media/file/posts/how-to-make-your-mcp-app-discoverable/1777633015682.png":
		"/_emdash/api/media/file/01M3HVR6WN0YKVNFHWMS1NHF2B.png",
	"/_emdash/api/media/file/posts/chatgpt-app-discoverability-guide/1777633011723.png":
		"/_emdash/api/media/file/01M3HNKSHSB2R32QPEYK4691N3.png",
	"/_emdash/api/media/file/posts/mechanics-of-selling-in-chatgpt/1777633007880.png":
		"/_emdash/api/media/file/01M3HNKK9WF5N37CH2GWCTSFVM.png",
	"/_emdash/api/media/file/posts/agentic-commerce/1777633001593.png":
		"/_emdash/api/media/file/01M3HNKC1R1BKMYP2HJBRZCZY7.png",
	"/_emdash/api/media/file/posts/how-brands-can-sell-in-chatgpt/1777632998022.png":
		"/_emdash/api/media/file/01M3HNK5EXQ3MJZKW6W9MPQJSD.png",
	"/_emdash/api/media/file/posts/lead-generation-ai-chats/1777632994219.png":
		"/_emdash/api/media/file/01M3HNJX4ASC79FXZJ57J84JN4.png",
	"/_emdash/api/media/file/posts/mcp-as-a-service-explained-why-model-context-protocol-matters-for-enterprise-ai/1777632989839.png":
		"/_emdash/api/media/file/01M3HNJMTVRSHC13AF4K88DVF8.png",
	"/_emdash/api/media/file/posts/autonomous-ai-agents-architecture-memory-and-skill-learning/1777632983781.png":
		"/_emdash/api/media/file/01M3HVRG9KXQPG1BZMJDYZQ6CT.png",
	"/_emdash/api/media/file/posts/crewai-vs-tedix-vs-langgraph-ai-agent-platform-comparison-2026/1777632979667.png":
		"/_emdash/api/media/file/01M3HVRTRY8APG5N0XV36GS565.png",
};

function legacyBlogMediaRedirect(request: Request, url: URL): Response | null {
	if (
		url.hostname !== LEGACY_BLOG_HOST ||
		(request.method !== "GET" && request.method !== "HEAD")
	)
		return null;
	const target = LEGACY_BLOG_MEDIA_TARGETS[url.pathname];
	if (!target) return null;
	return new Response(null, {
		status: 301,
		headers: {
			Location: `https://tedix.dev${target}`,
			"Cache-Control": "public, max-age=86400",
		},
	});
}

async function retiredBlogFaviconResponse(
	request: Request,
	env: MarketingEnv,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (
		url.hostname !== "tedix.dev" ||
		url.pathname !== RETIRED_BLOG_FAVICON_PATH
	)
		return null;
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	const object = await env.TENANT_BUNDLES.get(RETIRED_BLOG_FAVICON_KEY);
	if (!object) return new Response("Media unavailable", { status: 503 });
	const bytes = await object.arrayBuffer();
	if ((await sha256Hex(bytes)) !== RETIRED_BLOG_FAVICON_SHA256)
		return new Response("Media integrity check failed", { status: 503 });
	return new Response(request.method === "HEAD" ? null : bytes, {
		headers: {
			"Content-Type": "image/x-icon",
			"Content-Length": String(bytes.byteLength),
			"Cache-Control": "public, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
const LEGACY_BLOG_POSTS: Record<string, string> = {
	"autonomous-ai-agents-architecture-memory-and-skill-learning":
		"autonomous-ai-agents-architecture-memory-and-skill-learning",
	"how-to-make-your-mcp-app-discoverable":
		"how-to-make-your-mcp-app-discoverable",
	"mcp-tools-the-api-for-ai-agents": "mcp-tools-the-api-for-ai-agents",
	"crewai-vs-tedix-vs-langgraph-ai-agent-platform-comparison-2026":
		"crewai-vs-tedix-vs-langgraph-ai-agent-platform-comparison-2026",
	"introducing-emdash-cms-for-tedix": "introducing-emdash-cms-for-tedix",
	"chatgpt-app-discoverability-guide": "how-to-make-your-mcp-app-discoverable",
	"mcp-as-a-service-explained-why-model-context-protocol-matters-for-enterprise-ai":
		"mcp-tools-the-api-for-ai-agents",
	"meet-your-tedi-autonomous-digital-workers":
		"autonomous-ai-agents-architecture-memory-and-skill-learning",
	"what-makes-a-tedix-digital-worker-durable":
		"autonomous-ai-agents-architecture-memory-and-skill-learning",
	"workflow-automation-vs-durable-digital-workers":
		"autonomous-ai-agents-architecture-memory-and-skill-learning",
};

export function legacyBlogRedirect(url: URL): Response | null {
	if (url.hostname !== LEGACY_BLOG_HOST || url.pathname.startsWith("/_emdash/"))
		return null;
	const slug = url.pathname.match(/^\/posts\/([^/]+)\/?$/)?.[1];
	const target =
		url.pathname === "/rss.xml"
			? "/rss.xml"
			: slug && LEGACY_BLOG_POSTS[slug]
				? `/blog/${LEGACY_BLOG_POSTS[slug]}`
				: "/blog";
	return new Response(null, {
		status: 301,
		headers: {
			Location: `https://tedix.dev${target}`,
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
	const retainedMedia = await retiredBlogFaviconResponse(request, env);
	if (retainedMedia) return retainedMedia;
	const legacyMedia = legacyBlogMediaRedirect(request, url);
	if (legacyMedia) return legacyMedia;
	const legacyBlog = legacyBlogRedirect(url);
	if (legacyBlog) return legacyBlog;
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const isMarketingTenantOrigin =
		Boolean(env.MARKETING_SITE_SLUG) &&
		url.hostname === `${env.MARKETING_SITE_SLUG}.cms.tedix.dev`;
	const isTenantAdapterPath =
		isMarketingContactPath(url.pathname) ||
		((request.method === "GET" || request.method === "HEAD") &&
			path.startsWith("/api/catalog/"));
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
	if (path === "/waitlist") return redirect("https://os.tedix.dev/", 308);
	if (path === "/tedixpay-demo") return redirect("/tedixpay/");
	if (path === "/eurolabs") return redirect("/EuroLabs");
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
			case "/api/catalog/app": {
				const slug = q.get("slug");
				if (!slug || slug.length > 256)
					return json({ error: "App slug required" }, 400);
				result = await client.catalog.getBySlug({ slug });
				if (!result) return json({ error: "App not found" }, 404);
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
			path === "/api/catalog/app" &&
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
