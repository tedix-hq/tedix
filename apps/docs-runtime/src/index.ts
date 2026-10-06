import { createDbQueryClient } from "@tedix/db/query-client";
import type { SessionBrokerRpc } from "@tedix/auth/session-broker";
import { authorizeDocsSiteRequest, handleDocsSessionBroker } from "./access";
import { contentFreeDocsException, docsLogger } from "./log";
import { parseHostAliases, resolveSiteSlug, serveDocsSite } from "./serving";
import { getRuntimeDocsSiteBySlug } from "./site-adapter";

type DocsRuntimeEnv = {
	DB: D1Database;
	DOCS_BUILDS: R2Bucket;
	ENVIRONMENT: string;
	GIT_SHA: string;
	DOCS_BASE_DOMAIN: string;
	DOCS_ROOT_SITE_SLUG: string;
	DOCS_HOST_ALIASES: string;
	DESCOPE_PROJECT_ID: string;
	DESCOPE_BASE_URL: string;
	DOCS_SESSION_BROKER?: SessionBrokerRpc;
};

export default {
	async fetch(request: Request, env: DocsRuntimeEnv): Promise<Response> {
		try {
			const url = new URL(request.url);
			// authz: public — liveness + deployed-sha probe; serves no tenant data.
			if (url.pathname === "/health") {
				return Response.json({
					status: "ok",
					service: "docs-runtime",
					deployedSha: env.GIT_SHA,
				});
			}
			if (request.method !== "GET" && request.method !== "HEAD") {
				return new Response("Method Not Allowed", {
					status: 405,
					headers: { Allow: "GET, HEAD" },
				});
			}
			const slug = resolveSiteSlug(
				url.hostname,
				env.DOCS_BASE_DOMAIN,
				env.DOCS_ROOT_SITE_SLUG,
				parseHostAliases(env.DOCS_HOST_ALIASES),
			);
			if (!slug) return new Response("Not Found", { status: 404 });
			const site = await getRuntimeDocsSiteBySlug(
				createDbQueryClient(env.DB),
				slug,
			);
			if (!site) return new Response("Not Found", { status: 404 });
			const brokerResponse = await handleDocsSessionBroker(request, env, site);
			if (brokerResponse) return brokerResponse;
			const accessResponse = await authorizeDocsSiteRequest(request, env, site);
			if (accessResponse) return accessResponse;
			return await serveDocsSite(request, env.DOCS_BUILDS, site);
		} catch (error) {
			docsLogger.error("Docs runtime request failed", {
				event: "docs.request.failed",
				failure: contentFreeDocsException(error),
			});
			return new Response("Internal Server Error", { status: 500 });
		}
	},
} satisfies ExportedHandler<DocsRuntimeEnv>;
