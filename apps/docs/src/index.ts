import {
	enforceModernMcpProtocol,
	mountMcp,
} from "@tedix/mcp-shared/transport";
import {
	MCP_CORS_EXPOSE_HEADERS,
	MCP_CORS_HEADERS,
	MCP_CORS_METHODS,
} from "@tedix/worker-kit/cors";
import { installHonoErrorHandlers } from "@tedix/worker-kit/errors";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authorizeDocsRequest, requestedOrg } from "./auth";
import { serveDocsPreview, withDocsPreviewRobotsPolicy } from "./preview";
import { authorizePreviewAccess, previewAccessOrg } from "./preview-access";
import { buildDocsMcpServer } from "./tools";
import type { AppEnv } from "./types";

export { DocsBuildSandbox } from "./container/docs-build-sandbox";
export { DocsBuildWorkflow } from "./workflow";

const app = new Hono<AppEnv>();

installHonoErrorHandlers(app, { service: "docs" });

app.use(
	"/mcp",
	cors({
		origin: (origin) => origin || "*",
		allowMethods: [...MCP_CORS_METHODS],
		allowHeaders: [
			...MCP_CORS_HEADERS,
			"X-Tedix-Connection-Label",
			"X-Tedix-Delegated-Scope",
			"X-Forwarded-Authorization",
			"X-Tedix-Actor-Type",
			"X-Tedix-Actor-Id",
			"X-Tedix-Agent-Session-Id",
		],
		exposeHeaders: [...MCP_CORS_EXPOSE_HEADERS],
	}),
);

// authz: public — liveness and deployed-sha provenance only; no tenant data.
app.get("/health", (context) =>
	context.json({
		status: "ok",
		service: "docs-control",
		renderer: "@cloudflare/nimbus-docs",
		// Release tooling reads this to tell what is deployed; a surface that
		// cannot report what is live has invisible deploy lag.
		deployedSha: String(context.env.GIT_SHA ?? "unknown"),
	}),
);

async function handleMcp(context: {
	req: { raw: Request; header(name: string): string | undefined };
	env: AppEnv["Bindings"];
}): Promise<Response> {
	const protocolError = enforceModernMcpProtocol(context.req.raw);
	if (protocolError) return protocolError;
	try {
		const auth = await authorizeDocsRequest(context.req.raw, context.env);
		const server = buildDocsMcpServer({
			env: context.env,
			orgSlug: auth.orgSlug,
			platformAdmin: auth.platformAdmin,
			scopes: auth.scopes,
			actor: auth.actor,
			providerAuthorization: context.req.raw.headers.get(
				"X-Tedix-Provider-Authorization",
			),
		});
		return mountMcp(server, context.req.raw, {
			route: "/mcp",
			cors: { origin: context.req.header("Origin") ?? "*" },
			discover: {
				serverInfo: { name: "Tedix Docs MCP", version: "0.1.0" },
				capabilities: { tools: {} },
			},
		});
	} catch (error) {
		return new Response(
			JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
			}),
			{
				status: 401,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

app.post("/mcp", (context) => handleMcp(context));
app.delete("/mcp", (context) => handleMcp(context));
app.get("/mcp", async (context) => {
	const accept = context.req.header("Accept") ?? "";
	if (accept.includes("text/event-stream")) return handleMcp(context);
	return context.json({
		name: "Tedix Docs MCP",
		transport: "Streamable HTTP",
		hint: "POST JSON-RPC requests to /mcp?org=tenant-slug",
	});
});

async function handlePreview(context: {
	req: {
		raw: Request;
		param(name: string): string;
	};
	env: AppEnv["Bindings"];
}): Promise<Response> {
	try {
		const url = new URL(context.req.raw.url);
		const buildId = context.req.param("buildId");
		const requested =
			requestedOrg(context.req.raw) ?? previewAccessOrg(context.req.raw);
		const access =
			requested && context.env.PLATFORM_SERVICE_TOKEN
				? await authorizePreviewAccess({
						buildId,
						env: context.env,
						orgSlug: requested,
						request: context.req.raw,
					})
				: null;
		const auth = access
			? { orgSlug: requested! }
			: await authorizeDocsRequest(context.req.raw, context.env);
		const marker = `/preview/${buildId}`;
		const pathname = url.pathname.startsWith(marker)
			? url.pathname.slice(marker.length) || "/"
			: "/";
		const response = withDocsPreviewRobotsPolicy(
			await serveDocsPreview({
				buildId,
				env: context.env,
				orgSlug: auth.orgSlug,
				pathname,
				request: context.req.raw,
			}),
		);
		if (access?.setCookie) {
			response.headers.set("Set-Cookie", access.setCookie);
		}
		return response;
	} catch (error) {
		return withDocsPreviewRobotsPolicy(
			new Response(
				JSON.stringify({
					error: error instanceof Error ? error.message : String(error),
				}),
				{ status: 401, headers: { "Content-Type": "application/json" } },
			),
		);
	}
}

app.get("/preview/:buildId/*", (context) => handlePreview(context));
app.on("HEAD", "/preview/:buildId/*", (context) => handlePreview(context));
app.get("/preview/:buildId", (context) => handlePreview(context));
app.on("HEAD", "/preview/:buildId", (context) => handlePreview(context));

export default app;
