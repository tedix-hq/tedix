import type { Hono } from "hono";
import { resolveMediaRouteOrgId } from "./shared";

export function registerExportsAndRenders(
	app: Hono<{ Bindings: CloudflareEnv }>,
) {
	app.get("/video-renders/:renderId/media", async (c) => {
		const renderId = c.req.param("renderId");
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				renderId,
			)
		) {
			return c.text("Not found", 404);
		}
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
		const orgId = await resolveMediaRouteOrgId(
			createDbClient(c.env.DB),
			payload,
			c.req.header("X-Tedix-Tenant-Id") ?? undefined,
		);
		if (!orgId) return c.text("No organization context", 403);

		// Historical renders from the retired video-renderer Worker. The MP4 was
		// written once, on completion, under the organization's own prefix.
		const object = await c.env.TEDI_R2_BUCKET.get(
			`video-renders/${orgId}/${renderId}/output.mp4`,
			{ range: c.req.raw.headers },
		);
		if (!object) return c.text("Not found", 404);
		const headers = new Headers({
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, max-age=300",
			"Content-Disposition": "inline",
			"Content-Type": "video/mp4",
		});
		const range = c.req.header("Range") ? object.range : undefined;
		if (!range) {
			headers.set("Content-Length", String(object.size));
			return new Response(object.body, { headers });
		}
		const offset =
			"suffix" in range ? object.size - range.suffix : (range.offset ?? 0);
		const length =
			"suffix" in range ? range.suffix : (range.length ?? object.size - offset);
		headers.set("Content-Length", String(length));
		headers.set(
			"Content-Range",
			`bytes ${offset}-${offset + length - 1}/${object.size}`,
		);
		return new Response(object.body, { status: 206, headers });
	});

	// Bulk portable snapshots use a scoped bearer minted by the governed oRPC
	// procedure. The byte path stays outside Code Mode's bounded result envelope.
	app.get("/portable/tedis/:tediId/snapshot/:section", async (c) => {
		const authorization = c.req.header("Authorization");
		if (!authorization?.startsWith("Bearer ")) {
			return c.text("Unauthorized", 401);
		}
		const { verifyPortableSnapshotTicket } =
			await import("../lib/portable-snapshot-ticket");
		const ticket = await verifyPortableSnapshotTicket({
			secret: c.env.SECRETS_MASTER_KEY,
			token: authorization.slice("Bearer ".length),
			nowMs: Date.now(),
		});
		if (!ticket || ticket.tediId !== c.req.param("tediId")) {
			return c.text("Unauthorized", 401);
		}
		const { PortableTediSnapshotSectionSchema } =
			await import("@tedix/api-contract/schemas/portable-tedi");
		const section = PortableTediSnapshotSectionSchema.safeParse(
			c.req.param("section"),
		);
		const limitText = c.req.query("limit") ?? "500";
		const limit = Number(limitText);
		const afterId = c.req.query("afterId");
		if (
			!section.success ||
			!/^\d{1,3}$/.test(limitText) ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 500 ||
			(afterId !== undefined && (afterId.length < 1 || afterId.length > 200))
		) {
			return c.text("Invalid portable snapshot page", 400);
		}
		const { createDbClient } = await import("@tedix/db/client");
		const { readPortableSnapshotPageForOrganization } =
			await import("../rpc/routers/tedis/portable-snapshot");
		try {
			const page = await readPortableSnapshotPageForOrganization(
				createDbClient(c.env.DB),
				ticket.organizationId,
				{ tediId: ticket.tediId, section: section.data, limit, afterId },
			);
			c.header("Cache-Control", "no-store");
			return c.json(page);
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "NOT_FOUND"
			) {
				return c.text("Not found", 404);
			}
			throw error;
		}
	});

	// Import pages use a different HMAC purpose from export reads. The token is
	// issued only to an interactive org user and the target stays paused.
	app.post("/portable/tedis/:tediId/import/:section", async (c) => {
		const authorization = c.req.header("Authorization");
		if (!authorization?.startsWith("Bearer ")) {
			return c.text("Unauthorized", 401);
		}
		const { verifyPortableImportTicket } =
			await import("../lib/portable-import-ticket");
		const ticket = await verifyPortableImportTicket({
			secret: c.env.SECRETS_MASTER_KEY,
			token: authorization.slice("Bearer ".length),
			nowMs: Date.now(),
		});
		if (
			!ticket ||
			ticket.tediId !== c.req.param("tediId") ||
			c.req.header("X-Tedix-Portable-Manifest") !== ticket.manifestSha256
		) {
			return c.text("Unauthorized", 401);
		}
		const maxBytes = 32 * 1024 * 1024;
		const declaredBytes = Number(c.req.header("Content-Length") ?? "0");
		if (declaredBytes > maxBytes) return c.text("Import page too large", 413);
		const stream = c.req.raw.body;
		if (!stream) return c.text("Missing portable import page", 400);
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let byteLength = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				await reader.cancel();
				return c.text("Import page too large", 413);
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return c.text("Invalid portable import JSON", 400);
		}
		const { PortableTediImportPageSchema } =
			await import("@tedix/api-contract/schemas/portable-tedi");
		const page = PortableTediImportPageSchema.safeParse(raw);
		if (!page.success || page.data.section !== c.req.param("section")) {
			return c.text("Invalid portable import page", 400);
		}
		const { createDbClient } = await import("@tedix/db/client");
		const { writePortableImportPage } =
			await import("../rpc/routers/tedis/portable-import");
		try {
			const acceptedRows = await writePortableImportPage(
				createDbClient(c.env.DB),
				ticket,
				page.data,
			);
			c.header("Cache-Control", "no-store");
			return c.json({ acceptedRows });
		} catch (error) {
			if (error instanceof Error && "code" in error) {
				if (error.code === "NOT_FOUND") return c.text("Not found", 404);
				if (error.code === "CONFLICT") return c.text(error.message, 409);
			}
			throw error;
		}
	});

	/**
	 * Tedix OS output exports: stream a governed PDF/PNG produced by
	 * `osWorkspaces.outputs.export` from R2. Auth mirrors /skill-runs media above:
	 * Bearer JWT or browser session cookie (DS), org resolved through
	 * the membership-gated `resolveMediaRouteOrgId`, and the output must belong to
	 * the caller's org — a foreign output id is indistinguishable from "not
	 * found". The R2 key embeds the resolved org id, so a caller can never address
	 * another tenant's bytes even with a guessed output id.
	 */
	app.get("/os-exports/:outputId/:file", async (c) => {
		const outputId = c.req.param("outputId");
		const file = c.req.param("file");
		const match = /^rev-(\d+)\.(pdf|png|xlsx|docx|pptx|md|html|csv|zip)$/.exec(
			file,
		);
		if (!match) return c.text("Not found", 404);

		const { extractRequestToken } = await import("../lib/request-token");
		const { validateToken } = await import("@tedix/auth/jwt");
		const { resolveLocalDemoUser } = await import("@tedix/auth/local-demo");
		const token = extractRequestToken((name) => c.req.header(name));
		if (!token) return c.text("Unauthorized", 401);
		let payload: Awaited<ReturnType<typeof validateToken>>;
		try {
			payload =
				resolveLocalDemoUser({
					environment: c.env.ENVIRONMENT,
					projectId: c.env.DESCOPE_PROJECT_ID,
					token,
					url: c.req.url,
					enabled:
						(c.env as CloudflareEnv & { TEDIX_LOCAL_DEMO_ENABLED?: string })
							.TEDIX_LOCAL_DEMO_ENABLED === "true",
				}) ??
				(await validateToken(token, {
					projectId: c.env.DESCOPE_PROJECT_ID,
					baseUrl: c.env.DESCOPE_BASE_URL,
				}));
		} catch {
			return c.text("Unauthorized", 401);
		}

		const { createDbClient } = await import("@tedix/db/client");
		const orgId = await resolveMediaRouteOrgId(
			createDbClient(c.env.DB),
			payload,
			c.req.header("X-Tedix-Tenant-Id") ?? undefined,
		);
		if (!orgId) return c.text("No organization context", 403);

		const { createDbQueryClient } = await import("@tedix/db/query-client");
		const { getOsOutput, getOsOutputRevisionByNumber } =
			await import("@tedix/db/queries/os-workspaces/outputs");
		const db = createDbQueryClient(c.env.DB);
		const output = await getOsOutput(db, {
			organizationId: orgId,
			outputId,
		});
		if (!output) return c.text("Not found", 404);
		if (output.workspaceId) {
			const { getOsWorkspace, isOsWorkspaceVisibleTo } =
				await import("@tedix/db/queries/os-workspaces/workspaces");
			const workspace = await getOsWorkspace(db, {
				organizationId: orgId,
				workspaceId: output.workspaceId,
			});
			if (
				workspace &&
				!isOsWorkspaceVisibleTo(workspace, {
					userIds: typeof payload.sub === "string" ? [payload.sub] : [],
				})
			)
				return c.text("Not found", 404);
		}
		const revision = await getOsOutputRevisionByNumber(db, {
			organizationId: orgId,
			outputId,
			revision: Number(match[1]),
		});
		if (!revision) return c.text("Export not found", 404);
		const { parseDerivedAccessEnvelope } =
			await import("../services/os-derived-resource-access");
		const accessEnvelope = parseDerivedAccessEnvelope(revision.accessEnvelope);
		if (!accessEnvelope) return c.text("Forbidden", 403);
		const { authorizeOsOutputExportRecipient } = await import("../rpc/orpc");
		if (
			!(await authorizeOsOutputExportRecipient(c.req.raw, c.env, {
				organizationId: orgId,
				accessEnvelope,
			}))
		) {
			return c.text("Forbidden", 403);
		}

		const object = await c.env.R2_BUCKET.get(
			`os-exports/${orgId}/${outputId}/${file}`,
		);
		if (!object) return c.text("Export not found", 404);
		const extension = match[2] as
			| "pdf"
			| "png"
			| "xlsx"
			| "docx"
			| "pptx"
			| "md"
			| "html"
			| "csv"
			| "zip";
		const fallbackTypes = {
			pdf: "application/pdf",
			png: "image/png",
			md: "text/markdown; charset=utf-8",
			html: "text/html; charset=utf-8",
			csv: "text/csv; charset=utf-8",
			zip: "application/zip",
			xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		} as const;
		// A PDF or an image is viewable in place. An Office file is not, and
		// serving it as an attachment is also what keeps this route inert on the
		// trusted origin — see isAgentAuthoredBytePath in lib/untrusted-origin.ts.
		const disposition =
			extension === "pdf" || extension === "png"
				? "inline"
				: // The filename is built only from values this route has already
					// constrained: the revision digits from the regex and the literal
					// extension. `outputId` is an unvalidated path param, and
					// interpolating it here would let a quote break out of the quoted
					// filename. It is not needed to name the file usefully.
					`attachment; filename="rev-${match[1]}.${extension}"`;
		return new Response(object.body, {
			headers: {
				"X-Content-Type-Options": "nosniff",
				...(extension !== "pdf" && extension !== "png"
					? {
							"Content-Security-Policy":
								"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
						}
					: {}),
				"Content-Type":
					object.httpMetadata?.contentType ?? fallbackTypes[extension],
				"Content-Length": String(object.size),
				"Cache-Control": "private, no-store",
				"Content-Disposition": disposition,
			},
		});
	});
}
