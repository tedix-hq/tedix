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

	// A share-link guest using a runtime app: open its client, call its server,
	// read a granted Output. Each call re-resolves the share session; every
	// refusal is the same 404 as an unknown link.
	// authz: public — the share session token is the only credential; apps/api binds it to one link, role use.
	app.post("/os-shared/app/open", async (c) => {
		const [{ handleGuestAppOpen }, { createDbQueryClient }] = await Promise.all(
			[import("../lib/os-share-app-runtime"), import("@tedix/db/query-client")],
		);
		return handleGuestAppOpen(
			c.env,
			createDbQueryClient(c.env.DB),
			await c.req.json().catch(() => null),
		);
	});
	// authz: public — same share session token; the signed app session must match it and the link.
	app.post("/os-shared/app/call", async (c) => {
		const [{ handleGuestAppCall }, { createDbQueryClient }] = await Promise.all(
			[import("../lib/os-share-app-runtime"), import("@tedix/db/query-client")],
		);
		return handleGuestAppCall(
			c.env,
			createDbQueryClient(c.env.DB),
			await c.req.json().catch(() => null),
		);
	});
	// authz: public — same share session token; reads only granted, sourceless Outputs.
	app.post("/os-shared/app/read", async (c) => {
		const [{ handleGuestAppRead }, { createDbQueryClient }] = await Promise.all(
			[import("../lib/os-share-app-runtime"), import("@tedix/db/query-client")],
		);
		return handleGuestAppRead(
			createDbQueryClient(c.env.DB),
			await c.req.json().catch(() => null),
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
