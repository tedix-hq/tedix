import type { Hono } from "hono";
import { resolveUntrustedContentOrigin } from "../lib/untrusted-origin";
import { resolveMediaRouteOrgId, untrustedContentRedirect } from "./shared";

export function registerArtifactRoutes(app: Hono<{ Bindings: CloudflareEnv }>) {
	// =============================================================================
	// ARTIFACT SERVING
	// =============================================================================
	// Open a durable tedi deliverable (`record_artifact` → `tedi_artifacts`) in the
	// browser. Two access modes mirror the skill-media routes above:
	//   - Signed share token (public; the URL IS the capability, org-checked at mint):
	//       GET /artifacts/s/:tediId/:artifactId?exp=&sig=
	//   - Operator session (DS cookie / Bearer JWT, org-scoped ownership):
	//       GET /artifacts/:tediId/:artifactId
	// Both stream the raw R2 object via streamArtifactObject() — HTML renders,
	// PDF/image open inline, CSV/blob download, video Range-scrubs.
	// BUNDLE artifacts (`metadata.bundle === true`, uri = r2 prefix) additionally
	// serve subpaths — `/artifacts[/s]/:tediId/:artifactId/js/app.js` — so a
	// multi-file interactive dashboard resolves its own subresources relative to
	// the artifact URL. The signed token covers (tediId, artifactId); subpaths
	// ride the same capability.

	/** Resolve the streamable target for an artifact row + optional bundle subpath. */
	async function streamArtifactRow(
		env: CloudflareEnv,
		artifact: {
			organizationId: string;
			tediId: string;
			uri: string | null;
			mimeType: string | null;
			metadata: unknown;
		},
		subpath: string,
		rangeHeader: string | null,
		requestUrl: string,
	): Promise<Response> {
		const { isBundleArtifact, resolveBundleObject, streamArtifactObject } =
			await import("../lib/artifact-serve");
		const { isOwnedArtifactR2Uri } =
			await import("../lib/artifact-uri-ownership");
		const ownsUri = (uri: string | null) =>
			isOwnedArtifactR2Uri({
				uri,
				organizationId: artifact.organizationId,
				tediId: artifact.tediId,
			});
		if (!ownsUri(artifact.uri)) {
			return new Response("Not found", { status: 404 });
		}
		if (isBundleArtifact(artifact.metadata)) {
			// Browser base-URL correctness: the entrypoint must be served from a
			// trailing-slash URL, else relative refs (`js/app.js`, `data.json`)
			// resolve one level above the bundle. Relative Location is legal
			// (RFC 9110) and survives the Tedix OS proxy unchanged.
			const url = new URL(requestUrl);
			if (subpath === "" && !url.pathname.endsWith("/")) {
				return new Response(null, {
					status: 302,
					headers: { Location: `${url.pathname}/${url.search}` },
				});
			}
			const target = resolveBundleObject(artifact, subpath);
			if (!target || !ownsUri(target.uri)) {
				return new Response("Not found", { status: 404 });
			}
			return streamArtifactObject(env, target, rangeHeader);
		}
		if (subpath) {
			// Subpaths only exist on bundles; a single-file artifact has none.
			return new Response("Not found", { status: 404 });
		}
		return streamArtifactObject(
			env,
			{ uri: artifact.uri, mimeType: artifact.mimeType },
			rangeHeader,
		);
	}

	/**
	 * Bundle subpath from the RAW pathname by position: segment 0 is "" (leading
	 * slash); `skip` names how many known segments precede the subpath. Positional
	 * split sidesteps how the artifactId segment was percent-encoded by the
	 * caller; `resolveBundleObject` decodes the remaining segments itself.
	 */
	function artifactSubpath(url: string, skip: number): string {
		return new URL(url).pathname.split("/").slice(skip).join("/");
	}

	const handleSignedArtifact = async (c: {
		env: CloudflareEnv;
		req: {
			param: (k: string) => string;
			query: (k: string) => string | undefined;
			header: (k: string) => string | undefined;
			url: string;
		};
		text: (body: string, status: 403 | 404) => Response;
	}) => {
		const bounce = untrustedContentRedirect(c.env, c.req.url);
		if (bounce) return bounce;
		const tediId = c.req.param("tediId");
		const artifactId = c.req.param("artifactId");
		const exp = Number(c.req.query("exp"));
		const sig = c.req.query("sig") ?? "";
		const version = c.req.query("v");
		// Only reviewed-release (v=2) links exist; an unversioned bearer URL is dead.
		if (version === undefined) return c.text("Not found", 404);
		const approvalId = c.req.query("approval") ?? "";
		const contentDigest = c.req.query("digest") ?? "";
		const { verifyArtifactReleaseToken } = await import("../lib/artifact-url");
		const ok =
			version === "2" &&
			(await verifyArtifactReleaseToken({
				secret: c.env.SECRETS_MASTER_KEY,
				tediId,
				artifactId,
				approvalId,
				contentDigest,
				exp,
				sig,
				nowMs: Date.now(),
			}));
		if (!ok) return c.text("Invalid or expired artifact token", 403);

		const { createDbClient } = await import("@tedix/db/client");
		const { getTediArtifactById } =
			await import("@tedix/db/queries/kernel-runtime-events");
		const db = createDbClient(c.env.DB);
		const artifact = await getTediArtifactById(db, { tediId, artifactId });
		if (!artifact) return c.text("Artifact not found", 404);
		if (artifactSubpath(c.req.url, 5) || c.req.header("Range"))
			return c.text("Artifact not found", 404);
		const { getActiveArtifactReleaseApproval } =
			await import("@tedix/db/queries/artifact-policy/releases");
		const active = await getActiveArtifactReleaseApproval(db, {
			organizationId: artifact.organizationId,
			childArtifactId: artifact.id,
			approvalId,
			childContentDigest: contentDigest,
		});
		if (
			!active ||
			artifact.contentDigest !== contentDigest ||
			active.candidate.organizationId !== artifact.organizationId ||
			active.candidate.tediId !== artifact.tediId ||
			active.candidate.childArtifactId !== artifact.id
		)
			return c.text("Artifact not found", 404);
		const { readVerifiedPrivateTextArtifact } =
			await import("../services/artifact-immutable-publication");
		let body;
		try {
			body = await readVerifiedPrivateTextArtifact(
				c.env.TEDI_R2_BUCKET,
				artifact,
			);
		} catch {
			return c.text("Artifact not found", 404);
		}
		const stillActive = await getActiveArtifactReleaseApproval(db, {
			organizationId: artifact.organizationId,
			childArtifactId: artifact.id,
			approvalId,
			childContentDigest: contentDigest,
		});
		const stillValid = await verifyArtifactReleaseToken({
			secret: c.env.SECRETS_MASTER_KEY,
			tediId,
			artifactId,
			approvalId,
			contentDigest,
			exp,
			sig,
			nowMs: Date.now(),
		});
		if (!stillActive || !stillValid) return c.text("Artifact not found", 404);
		return new Response(body.bytes, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Length": String(body.bytes.byteLength),
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; sandbox",
			},
		});
	};

	app.get("/artifacts/s/:tediId/:artifactId/*", handleSignedArtifact);
	app.get("/artifacts/s/:tediId/:artifactId", handleSignedArtifact);

	const handleSessionArtifact = async (c: {
		env: CloudflareEnv;
		req: {
			param: (k: string) => string;
			header: (k: string) => string | undefined;
			url: string;
			raw: Request;
		};
		text: (body: string, status: 401 | 403 | 404) => Response;
	}) => {
		const tediId = c.req.param("tediId");
		const artifactId = c.req.param("artifactId");

		const { extractRequestToken } = await import("../lib/request-token");
		const { validateToken } = await import("@tedix/auth/jwt");
		const token = extractRequestToken((name) => c.req.header(name));
		if (!token) return c.text("Unauthorized", 401);
		let payload: Awaited<ReturnType<typeof validateToken>>;
		try {
			payload = await validateToken(token, {
				projectId: c.env.DESCOPE_PROJECT_ID,
				baseUrl: c.env.DESCOPE_BASE_URL,
			});
		} catch {
			return c.text("Unauthorized", 401);
		}

		const { createDbClient } = await import("@tedix/db/client");
		const db = createDbClient(c.env.DB);
		const orgId = await resolveMediaRouteOrgId(
			db,
			payload,
			c.req.header("X-Tedix-Tenant-Id") ?? undefined,
		);
		if (!orgId) return c.text("No organization context", 403);

		const { getTediArtifactById } =
			await import("@tedix/db/queries/kernel-runtime-events");
		const artifact = await getTediArtifactById(db, {
			organizationId: orgId,
			tediId,
			artifactId,
		});
		// Org-ownership is the real gate (any valid Descope subject in the owning org
		// may open it); a row from another org is indistinguishable from "not found".
		if (!artifact) {
			return c.text("Not found", 404);
		}
		if (artifact.accessClassification !== null) {
			const { createContext } = await import("../rpc/orpc");
			const { authorizeAuthenticatedArtifactBytes } =
				await import("../lib/artifact-access");
			const artifactContext = createContext(c.req.raw, c.env);
			artifactContext.organizationId = orgId;
			artifactContext.authType = "user";
			artifactContext.user = payload;
			artifactContext.descopeUserId = payload.sub;
			if (
				!(await authorizeAuthenticatedArtifactBytes(artifactContext, artifact))
					.allowed
			) {
				return c.text("Not found", 404);
			}
		}
		const { isOwnedArtifactR2Uri } =
			await import("../lib/artifact-uri-ownership");
		if (
			!isOwnedArtifactR2Uri({
				uri: artifact.uri,
				organizationId: artifact.organizationId,
				tediId: artifact.tediId,
			})
		) {
			return c.text("Not found", 404);
		}

		// The cookie-isolated untrusted-content origin serves only reviewed-release
		// links, so a configured origin never streams session bytes here.
		if (resolveUntrustedContentOrigin(c.env).state === "configured")
			return c.text("Not found", 404);

		return streamArtifactRow(
			c.env,
			artifact,
			// ["", "artifacts", tediId, artifactId, ...subpath] → skip 4.
			artifactSubpath(c.req.url, 4),
			c.req.header("Range") ?? null,
			c.req.url,
		);
	};

	app.get("/artifacts/:tediId/:artifactId/*", handleSessionArtifact);
	app.get("/artifacts/:tediId/:artifactId", handleSessionArtifact);
}
