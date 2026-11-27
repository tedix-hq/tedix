import type { Hono } from "hono";
import { guestAppStage } from "../lib/os-guest-app-stage";

export function registerOsSharedRoutes(app: Hono<{ Bindings: CloudflareEnv }>) {
	// authz: public — published launcher/panel branding for one tenant slug, which
	// the host already exposes in its script tag. The widget needs it before any
	// signed session exists, so it is an allowlisted read with no tenant data.
	app.get("/widget/branding/:tenant", async (c) => {
		const { handleWidgetBranding } = await import("../lib/widget-branding");
		const { coreDb, isD1CoreStore } =
			await import("@tedix/db/core-store/scope");
		return handleWidgetBranding(
			c.req.param("tenant"),
			c.env.DB || !isD1CoreStore(c.env) ? coreDb(c.env) : undefined,
			c.req.query("locale"),
			{
				request: c.req.raw,
				waitUntil: (work) => c.executionCtx.waitUntil(work),
			},
		);
	});

	// The public viewer keeps the link secret in the URL fragment, which
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

	// authz: public — link secret redemption; a session credential, when
	// the host proxy forwards one, only identifies the recipient of an
	// organization or invited link and grants nothing by itself.
	app.post("/os-shared/redeem", async (c) => {
		const [{ handleOsShareRedemption }, { coreQueryDb }, recipient] =
			await Promise.all([
				import("../lib/os-share-redemption"),
				import("@tedix/db/core-store/scope"),
				shareRecipient(c.req.raw, c.env),
			]);
		return handleOsShareRedemption(
			coreQueryDb(c.env),
			bodyString(await c.req.json().catch(() => null), "token"),
			recipient.authorize,
			recipient.identify,
			recipient.mayManage,
		);
	});

	// authz: public — proof of an invited email; uniform send reply and atomic rate limits.
	app.post("/os-shared/email/request", async (c) => {
		const [{ requestOsShareEmailCode }, { coreQueryDb }] = await Promise.all([
			import("../lib/os-share-email-code"),
			import("@tedix/db/core-store/scope"),
		]);
		const body = await c.req.json().catch(() => null);
		return requestOsShareEmailCode(
			c.env,
			coreQueryDb(c.env),
			{
				id: bodyString(body, "id"),
				email: bodyString(body, "email"),
				ip: c.req.header("CF-Connecting-IP") ?? "unknown",
				hostTenantId: c.req.header("X-Tedix-Tenant-Id") ?? null,
			},
			(work) => c.executionCtx.waitUntil(work),
		);
	});
	// authz: public — single-use email proof bound to this link; creates only a share session.
	app.post("/os-shared/email/verify", async (c) => {
		const [{ verifyOsShareEmailCode }, { coreQueryDb }] = await Promise.all([
			import("../lib/os-share-email-code"),
			import("@tedix/db/core-store/scope"),
		]);
		const body = await c.req.json().catch(() => null);
		return verifyOsShareEmailCode(c.env, coreQueryDb(c.env), {
			id: bodyString(body, "id"),
			email: bodyString(body, "email"),
			code: bodyString(body, "code"),
			hostTenantId: c.req.header("X-Tedix-Tenant-Id") ?? null,
		});
	});

	// The permanent address behind `/s/<id>` on the organization's own host.
	// The OS Worker asserts the host's tenant; a link answers only there.
	// authz: public — resolves by unguessable public id; refusals are the same 404 as an unknown link.
	app.post("/os-shared/open", async (c) => {
		const [{ handleOsShareOpen }, { coreQueryDb }, recipient] =
			await guestAppStage("share_open", "recipient", () =>
				Promise.all([
					import("../lib/os-share-redemption"),
					import("@tedix/db/core-store/scope"),
					shareRecipient(c.req.raw, c.env),
				]),
			);
		const id = bodyString(await c.req.json().catch(() => null), "id");
		return guestAppStage("share_open", "redemption", () =>
			handleOsShareOpen(
				coreQueryDb(c.env),
				id,
				c.req.header("X-Tedix-Tenant-Id") ?? null,
				recipient.authorize,
				recipient.identify,
				recipient.mayManage,
			),
		);
	});

	// What a pasted `/s/<id>` shows in chat apps and social sites. The OS
	// Worker asks for it when it serves the share document on the host.
	// authz: public — names content only for a link a signed-out stranger could open on this host; anything else gets the generic answer.
	app.post("/os-shared/preview", async (c) => {
		const [{ handleOsSharePreview }, { coreQueryDb }] = await Promise.all([
			import("../lib/os-share-redemption"),
			import("@tedix/db/core-store/scope"),
		]);
		return handleOsSharePreview(
			coreQueryDb(c.env),
			bodyString(await c.req.json().catch(() => null), "id"),
			c.req.header("X-Tedix-Tenant-Id") ?? null,
		);
	});

	app.post("/os-shared/session", async (c) => {
		const [{ handleOsShareSessionRead }, { coreQueryDb }, recipient] =
			await Promise.all([
				import("../lib/os-share-redemption"),
				import("@tedix/db/core-store/scope"),
				shareRecipient(c.req.raw, c.env),
			]);
		const body = await c.req.json().catch(() => null);
		return handleOsShareSessionRead(
			coreQueryDb(c.env),
			bodyString(body, "sessionToken"),
			recipient.authorize,
			recipient.identify,
			recipient.mayManage,
			// The file version the page already shows: unchanged, it is not resent.
			bodyString(body, "knownRevisionId") || undefined,
		);
	});

	// One document, sheet or slide deck a workspace link lists, read through the
	// link's session; it rechecks the link and the file on every read.
	// authz: public — the share session token is the credential; only files without connected data, same 404 for every refusal.
	app.post("/os-shared/output", async (c) => {
		const [{ handleOsShareSessionOutput }, { coreQueryDb }, recipient] =
			await Promise.all([
				import("../lib/os-share-redemption"),
				import("@tedix/db/core-store/scope"),
				shareRecipient(c.req.raw, c.env),
			]);
		const body = await c.req.json().catch(() => null);
		return handleOsShareSessionOutput(
			coreQueryDb(c.env),
			bodyString(body, "sessionToken"),
			bodyString(body, "outputId"),
			recipient.authorize,
			recipient.identify,
		);
	});

	// The uploaded file a shared document carries (a video, image, PDF or
	// download), served through the link and never the owner's workspace.
	// authz: public — the share session token is the credential; it names only the file of an Output the link shows, same 404 for every refusal.
	app.post("/os-shared/file", async (c) => {
		const [{ handleOsShareFile }, { coreQueryDb }, recipient] =
			await Promise.all([
				import("../lib/os-share-files"),
				import("@tedix/db/core-store/scope"),
				shareRecipient(c.req.raw, c.env),
			]);
		const body = await c.req.json().catch(() => null);
		return handleOsShareFile(
			c.env,
			coreQueryDb(c.env),
			bodyString(body, "sessionToken"),
			bodyString(body, "outputId"),
			recipient.authorize,
			recipient.identify,
		);
	});
	// authz: public — signed per session, Output and file; every range read rechecks the session, link and file.
	app.get("/os-shared/file/:sessionId/:outputId", async (c) => {
		const [{ serveOsShareFile }, { coreQueryDb }, recipient] =
			await Promise.all([
				import("../lib/os-share-files"),
				import("@tedix/db/core-store/scope"),
				shareRecipient(c.req.raw, c.env),
			]);
		return serveOsShareFile(
			c.req.raw,
			c.env,
			coreQueryDb(c.env),
			{
				sessionId: c.req.param("sessionId"),
				outputId: c.req.param("outputId"),
			},
			recipient.authorize,
			recipient.identify,
		);
	});

	// A share-link guest using a runtime app: open its client, call its server,
	// read a granted Output. Each call re-resolves the share session; every
	// refusal is the same 404 as an unknown link.
	// authz: public — the share session token is the only credential; apps/api binds it to one link, role use.
	app.post("/os-shared/app/open", async (c) => {
		const [{ handleGuestAppOpen }, { coreQueryDb }, body] = await guestAppStage(
			"open",
			"request",
			() =>
				Promise.all([
					import("../lib/os-share-app-runtime"),
					import("@tedix/db/core-store/scope"),
					c.req.json().catch(() => null),
				]),
		);
		return handleGuestAppOpen(c.env, coreQueryDb(c.env), body);
	});
	// authz: public — same share session token; the signed app session must match it and the link.
	app.post("/os-shared/app/call", async (c) => {
		const [{ handleGuestAppCall }, { coreQueryDb }, body] = await guestAppStage(
			"call",
			"request",
			() =>
				Promise.all([
					import("../lib/os-share-app-runtime"),
					import("@tedix/db/core-store/scope"),
					c.req.json().catch(() => null),
				]),
		);
		return handleGuestAppCall(c.env, coreQueryDb(c.env), body, (work) =>
			c.executionCtx.waitUntil(work),
		);
	});
	// authz: public — same share session token; reads only granted, sourceless Outputs.
	app.post("/os-shared/app/read", async (c) => {
		const [{ handleGuestAppRead }, { coreQueryDb }] = await Promise.all([
			import("../lib/os-share-app-runtime"),
			import("@tedix/db/core-store/scope"),
		]);
		return handleGuestAppRead(
			coreQueryDb(c.env),
			await c.req.json().catch(() => null),
		);
	});
	// authz: public — same share session token; saves only for an invited,
	// email-verified visitor of a link that lets its people edit.
	app.post("/os-shared/app/save", async (c) => {
		const [{ handleGuestAppSave }, { coreQueryDb }] = await Promise.all([
			import("../lib/os-share-app-runtime"),
			import("@tedix/db/core-store/scope"),
		]);
		return handleGuestAppSave(
			coreQueryDb(c.env),
			await c.req.json().catch(() => null),
		);
	});
	// authz: public — same share session token; reads only granted, sourceless Outputs.
	app.post("/os-shared/app/changes", async (c) => {
		const [{ handleGuestAppChanges }, { coreQueryDb }] = await Promise.all([
			import("../lib/os-share-app-runtime"),
			import("@tedix/db/core-store/scope"),
		]);
		return handleGuestAppChanges(
			coreQueryDb(c.env),
			await c.req.json().catch(() => null),
		);
	});
	// authz: public — same share session token; reads only granted, sourceless Outputs.
	app.post("/os-shared/app/revision", async (c) => {
		const [{ handleGuestAppRevision }, { coreQueryDb }] = await Promise.all([
			import("../lib/os-share-app-runtime"),
			import("@tedix/db/core-store/scope"),
		]);
		return handleGuestAppRevision(
			coreQueryDb(c.env),
			await c.req.json().catch(() => null),
		);
	});
	// authz: public — same share session token; reads only images stored with a granted, sourceless Output.
	app.post("/os-shared/app/image", async (c) => {
		const [{ handleGuestAppImage }, { coreQueryDb }] = await Promise.all([
			import("../lib/os-share-app-runtime"),
			import("@tedix/db/core-store/scope"),
		]);
		return handleGuestAppImage(
			coreQueryDb(c.env),
			await c.req.json().catch(() => null),
		);
	});

	// Unknown, revoked, and expired tokens are indistinguishable 404s.
	app.get("/os-shared/:token", async (c) => {
		const [{ handleOsShareRedemption }, { coreQueryDb }, recipient] =
			await Promise.all([
				import("../lib/os-share-redemption"),
				import("@tedix/db/core-store/scope"),
				shareRecipient(c.req.raw, c.env),
			]);
		return handleOsShareRedemption(
			coreQueryDb(c.env),
			c.req.param("token"),
			recipient.authorize,
			recipient.identify,
			recipient.mayManage,
		);
	});
}

function bodyString(body: unknown, key: string): string {
	if (typeof body !== "object" || body === null) return "";
	const value = (body as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

/** The two recipient checks a share handler runs against the caller's own credential. */
async function shareRecipient(request: Request, env: CloudflareEnv) {
	const {
		authorizeOsShareRecipient,
		identifyOsShareRecipient,
		osShareCallerMayManage,
	} = await import("../rpc/orpc");
	return {
		authorize: (
			link: { organizationId: string },
			role: "viewer" | "use" | "edit" | "build",
			accessEnvelope?: import("@tedix/api-contract/schemas/os-workspaces").OsDerivedAccessEnvelope,
		) =>
			authorizeOsShareRecipient(request, env, {
				organizationId: link.organizationId,
				role,
				accessEnvelope,
			}),
		identify: () => identifyOsShareRecipient(request, env),
		mayManage: (link: { organizationId: string }) =>
			osShareCallerMayManage(request, env, link.organizationId),
	};
}
