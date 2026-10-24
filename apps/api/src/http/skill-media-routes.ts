import type { Hono } from "hono";
import { resolveUntrustedContentOrigin } from "../lib/untrusted-origin";
import { resolveMediaRouteOrgId, untrustedContentRedirect } from "./shared";

/**
 * TTL for a signed URL minted purely to bounce a session-authed byte request
 * onto the untrusted-content origin. The browser follows immediately; short
 * because it is a hop, not a share link.
 */
const SESSION_BYTE_REDIRECT_TTL_SECONDS = 300;

interface StoredSkillMediaArtifact {
	mimeType: string;
	contentInline: string | null;
	contentR2Key: string | null;
}

async function readSkillMedia(
	env: CloudflareEnv,
	artifact: StoredSkillMediaArtifact,
): Promise<
	| {
			bytes: ArrayBuffer | Uint8Array<ArrayBufferLike>;
			mimeType: string;
	  }
	| null
	| undefined
> {
	const { extractMediaBytes, isMediaMimeType } =
		await import("../lib/skill-media-url");
	if (
		artifact.contentR2Key &&
		isMediaMimeType(artifact.mimeType) &&
		/^(?:audio|image|video)\//.test(artifact.mimeType)
	) {
		const object = await (
			env as unknown as { SKILL_ARTIFACTS?: R2Bucket }
		).SKILL_ARTIFACTS?.get(artifact.contentR2Key);
		return object
			? { bytes: await object.arrayBuffer(), mimeType: artifact.mimeType }
			: undefined;
	}

	let content = artifact.contentInline;
	if (content == null && artifact.contentR2Key) {
		const object = await (
			env as unknown as { SKILL_ARTIFACTS?: R2Bucket }
		).SKILL_ARTIFACTS?.get(artifact.contentR2Key);
		content = object ? await object.text() : null;
	}
	if (content == null) return undefined;
	return extractMediaBytes(content);
}

export function registerSkillMediaRoutes(
	app: Hono<{ Bindings: CloudflareEnv }>,
) {
	/** 302 to a freshly minted signed URL on the untrusted-content origin. */
	function signedByteRedirect(signedUrl: string): Response {
		return new Response(null, {
			status: 302,
			headers: { Location: signedUrl, "Cache-Control": "private, no-store" },
		});
	}

	// authz: public signed tenant-bound upload capability; verifies HMAC, expiry and exact part size.
	app.put(
		"/workspace-file-uploads/:organizationId/:workspaceId/:resourceId/:partNumber",
		async (c) => {
			const { uploadWorkspaceFilePart } =
				await import("../lib/workspace-file-routes");
			return uploadWorkspaceFilePart(c.req.raw, c.env, c.req.param());
		},
	);
	app.on(
		["GET", "HEAD"],
		"/workspace-files/:organizationId/:workspaceId/:resourceId/media",
		async (c) => {
			const { serveWorkspaceFile } =
				await import("../lib/workspace-file-routes");
			return serveWorkspaceFile(c.req.raw, c.env, c.req.param());
		},
	);

	/**
	 * Skill-run media: serve decoded bytes from a base64-in-JSON artifact, browser-
	 * viewable. No JWT — gated by a short-lived HMAC token (exp + sig) minted by
	 * `skills.getRunArtifact({ mediaUrl: true })`. The base64 decode runs in this
	 * plain handler (no workflow/durable-step/bridge context), so the in-step
	 * large-decode stall does not apply.
	 */
	app.get("/skill-media/:runId/:path{.+}", async (c) => {
		const bounce = untrustedContentRedirect(c.env, c.req.url);
		if (bounce) return bounce;
		const runId = c.req.param("runId");
		const path = c.req.param("path");
		const exp = Number(c.req.query("exp"));
		const sig = c.req.query("sig") ?? "";
		const downloadName = c.req.query("download") || undefined;
		const { verifyMediaToken } = await import("../lib/skill-media-url");
		const ok = await verifyMediaToken({
			secret: c.env.SECRETS_MASTER_KEY,
			runId,
			path,
			exp,
			sig,
			nowMs: Date.now(),
			downloadName,
		});
		if (!ok) return c.text("Invalid or expired media token", 403);

		const { getRunArtifact } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const { createDbClient } = await import("@tedix/db/client");
		const artifact = await getRunArtifact(
			createDbClient(c.env.DB),
			runId,
			path,
		);
		if (!artifact) return c.text("Artifact not found", 404);

		const media = await readSkillMedia(c.env, artifact);
		if (media === undefined) return c.text("Artifact content unavailable", 404);
		if (!media) return c.text("Artifact is not decodable media", 415);

		return new Response(media.bytes, {
			headers: {
				"Content-Type": media.mimeType,
				"Content-Length": String(media.bytes.byteLength),
				"Cache-Control": "private, max-age=900",
				"Content-Disposition": downloadName
					? `attachment; filename="${downloadName}"`
					: "inline",
			},
		});
	});

	/**
	 * Session-authed media read — the foundation for Tedix OS inline rendering
	 * of generated media in durable transcripts. Same decoded-media streaming as
	 * /skill-media, but gated by the user's Descope SESSION (Bearer JWT *or* the
	 * `DS` cookie) + org-ownership of the run — NOT a bearer token.
	 *
	 * Because it accepts the session cookie, a browser `<img>`/`<video>` tag can
	 * point straight at this stable path and render it on every scrollback without
	 * embedding a short-lived signed URL in the transcript (which would 404 after
	 * its TTL). Stable path shape, bound by Tedix OS + the "list my media" view:
	 *   GET /skill-runs/:runId/media/:path
	 */
	app.get("/skill-runs/:runId/media/:path{.+}", async (c) => {
		const runId = c.req.param("runId");
		const path = c.req.param("path");

		// --- Session auth: Bearer JWT or browser session cookie (DS) ---
		const { extractRequestToken } = await import("../lib/request-token");
		const { validateToken } = await import("@tedix/auth/jwt");
		const token = extractRequestToken((name) => c.req.header(name));
		if (!token) return c.text("Unauthorized", 401);
		// Accept any valid Descope token (human user session OR tedi) — the real
		// security gate is org-ownership of the run below, which is org-scoped
		// regardless of subject. Tedix OS passes the human's session cookie; a tedi can
		// also read its own org's media with its token.
		let payload: Awaited<ReturnType<typeof validateToken>>;
		try {
			payload = await validateToken(token, {
				projectId: c.env.DESCOPE_PROJECT_ID,
				baseUrl: c.env.DESCOPE_BASE_URL,
			});
		} catch {
			return c.text("Unauthorized", 401);
		}

		// --- Resolve org from the Descope tenant claim, then check run ownership ---
		const { createDbClient } = await import("@tedix/db/client");
		const db = createDbClient(c.env.DB);
		const orgId = await resolveMediaRouteOrgId(
			db,
			payload,
			c.req.header("X-Tedix-Tenant-Id") ?? undefined,
		);
		if (!orgId) return c.text("No organization context", 403);

		const { getSkillRun } = await import("@tedix/db/queries/skill-runs");
		const run = await getSkillRun(db, runId, orgId, c.env.ENVIRONMENT);
		if (!run) return c.text("Not found", 404); // ownership enforced by getSkillRun(orgId)

		// Origin switch: org-ownership has just been proven from the session, so
		// convert that proof into a short-lived signed URL and hand the bytes off to
		// the untrusted-content origin. The redirect crosses a site boundary, so the
		// session cookie does not follow it — which is the point; the token carries
		// the capability instead.
		const mediaOrigin = resolveUntrustedContentOrigin(c.env);
		if (mediaOrigin.state === "configured") {
			const { signMediaUrl } = await import("../lib/skill-media-url");
			const signed = await signMediaUrl({
				baseUrl: mediaOrigin.origin,
				secret: c.env.SECRETS_MASTER_KEY,
				runId,
				path,
				nowMs: Date.now(),
				ttlSeconds: SESSION_BYTE_REDIRECT_TTL_SECONDS,
			});
			return signedByteRedirect(signed.url);
		}

		const { getRunArtifact } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const artifact = await getRunArtifact(db, runId, path);
		if (!artifact) return c.text("Artifact not found", 404);

		const media = await readSkillMedia(c.env, artifact);
		if (media === undefined) return c.text("Artifact content unavailable", 404);
		if (!media) return c.text("Artifact is not decodable media", 415);

		return new Response(media.bytes, {
			headers: {
				"Content-Type": media.mimeType,
				"Content-Length": String(media.bytes.byteLength),
				"Cache-Control": "private, max-age=300",
				"Content-Disposition": "inline",
			},
		});
	});
}
