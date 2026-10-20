import type { Hono } from "hono";

export function registerOsSharedRoutes(app: Hono<{ Bindings: CloudflareEnv }>) {
	// authz: public — published launcher/panel branding for one tenant slug, which
	// the host already exposes in its script tag. The widget needs it before any
	// signed session exists, so it is an allowlisted read with no tenant data.
	app.get("/widget/branding/:tenant", async (c) => {
		const { handleWidgetBranding } = await import("../lib/widget-branding");
		return handleWidgetBranding(
			c.req.param("tenant"),
			c.env.DB,
			c.req.query("locale"),
			{
				request: c.req.raw,
				waitUntil: (work) => c.executionCtx.waitUntil(work),
			},
		);
	});

	// The public viewer keeps the one-time capability in the URL fragment, which
	// never reaches an HTTP request, proxy log, or referrer. Its same-origin POST
	// exchanges that in-memory token for the current read-only output. The legacy
	// path-token redemption remains for already-minted links.
	// authz: public — inert viewer shell; the capability remains in the URL fragment.
	app.get("/os-shared", async (_c) => {
		const { handleOsShareViewer } = await import("../lib/os-share-viewer");
		return handleOsShareViewer();
	});

	// authz: public — static share-viewer asset with no embedded capability or tenant data.
	app.get("/os-shared/viewer.js", async (_c) => {
		const { handleOsShareViewerScript } =
			await import("../lib/os-share-viewer");
		return handleOsShareViewerScript();
	});

	// authz: public — static share-viewer asset with no embedded capability or tenant data.
	app.get("/os-shared/viewer.css", async (_c) => {
		const { handleOsShareViewerStyles } =
			await import("../lib/os-share-viewer");
		return handleOsShareViewerStyles();
	});

	// authz: public — one-time capability redemption accepts no ambient browser authority.
	app.post("/os-shared/redeem", async (c) => {
		const [
			{ handleOsShareRedemption },
			{ createDbQueryClient },
			{ authorizeOsShareRecipient },
		] = await Promise.all([
			import("../lib/os-share-redemption"),
			import("@tedix/db/query-client"),
			import("../rpc/orpc"),
		]);
		const body = await c.req.json().catch(() => null);
		const token =
			typeof body === "object" && body !== null && "token" in body
				? (body as { token?: unknown }).token
				: null;
		return handleOsShareRedemption(
			createDbQueryClient(c.env.DB),
			typeof token === "string" ? token : "",
			(link, role, accessEnvelope) =>
				authorizeOsShareRecipient(c.req.raw, c.env, {
					organizationId: link.organizationId,
					role,
					accessEnvelope,
				}),
		);
	});

	app.post("/os-shared/session", async (c) => {
		const [
			{ handleOsShareSessionRead },
			{ createDbQueryClient },
			{ authorizeOsShareRecipient },
		] = await Promise.all([
			import("../lib/os-share-redemption"),
			import("@tedix/db/query-client"),
			import("../rpc/orpc"),
		]);
		const body = await c.req.json().catch(() => null);
		const sessionToken =
			typeof body === "object" && body !== null && "sessionToken" in body
				? (body as { sessionToken?: unknown }).sessionToken
				: null;
		return handleOsShareSessionRead(
			createDbQueryClient(c.env.DB),
			typeof sessionToken === "string" ? sessionToken : "",
			(link, role, accessEnvelope) =>
				authorizeOsShareRecipient(c.req.raw, c.env, {
					organizationId: link.organizationId,
					role,
					accessEnvelope,
				}),
		);
	});

	// Unknown, revoked, and expired tokens are indistinguishable 404s.
	app.get("/os-shared/:token", async (c) => {
		const [
			{ handleOsShareRedemption },
			{ createDbQueryClient },
			{ authorizeOsShareRecipient },
		] = await Promise.all([
			import("../lib/os-share-redemption"),
			import("@tedix/db/query-client"),
			import("../rpc/orpc"),
		]);
		return handleOsShareRedemption(
			createDbQueryClient(c.env.DB),
			c.req.param("token"),
			(link, role, accessEnvelope) =>
				authorizeOsShareRecipient(c.req.raw, c.env, {
					organizationId: link.organizationId,
					role,
					accessEnvelope,
				}),
		);
	});
}
