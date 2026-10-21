import { AUTHORING_TOOLS } from "./authoring-workspace";
import type { McpServer } from "@tedix/mcp-shared/server";
import { createMcpServer } from "@tedix/mcp-shared/server";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import * as z from "zod";
import { storeServiceKey } from "../service-key-storage";
import { registerBlogGenerationTool } from "./blog-generation";
import type { CmsProxyContext } from "./cms-proxy-runtime";
import { registerCmsProxyTools } from "./cms-proxy-tools";
import {
	type CmsSandboxForceRecoveryPins,
	type CmsSandboxRecoveryPins,
	destroyPinnedCmsBuilderSandbox,
	stopPinnedCmsBuilderSandbox,
} from "./sandbox-recovery";
import {
	type CmsTemplateSlug,
	EDITABLE_DIRS,
	EDITABLE_FILES,
	lockedDirsForTemplate,
	lockedFilesForTemplate,
} from "../template-policy";
import {
	type ImageGenerationToolContext,
	registerImageGenerationTools,
} from "./image-generation";
import { buildServiceKeyProvisionAuthCandidates } from "./service-key-auth";
import { schema, forbidden, type SiteBuilderToolContext } from "./tools-shared";
import { registerThemeTools } from "./tools-theme";
import { registerHotThemeTools } from "./tools-hot-theme";
import { registerTemplateSyncTools } from "./tools-template-sync";
import { registerPreviewTools } from "./tools-preview";
import { registerDeployTools } from "./tools-deploy";
import { registerPropagateTools } from "./tools-propagate";

export function buildSiteBuilderMcpServer(
	ctx: SiteBuilderToolContext,
): McpServer {
	const server = createMcpServer(
		{ name: "cms", version: "0.1.0" },
		{
			// No `logging` capability: server-initiated notifications/message never
			// fire on the stateless transport, and logging is deprecated in MCP
			// 2026-07-28 (SEP-2577), so declaring it would be an empty promise.
			capabilities: {},
			instructions: buildInstructions(ctx.templateSlug),
		},
	);
	installCmsToolAudit(server, ctx.recordMcpAuditEvent);
	if (ctx.prepareAuthoringWorkspace) {
		const register = server.registerTool.bind(server);
		server.registerTool = ((
			name: string,
			options: unknown,
			handler: (...args: unknown[]) => unknown,
		) =>
			register(
				name,
				options as never,
				(async (...args: unknown[]) => {
					if (AUTHORING_TOOLS.has(name)) await ctx.prepareAuthoringWorkspace!();
					return handler(...args);
				}) as never,
			)) as typeof server.registerTool;
	}

	registerThemeTools(server, ctx);
	registerBuilderRecoveryTool(server, ctx);
	registerHotThemeTools(server, ctx);
	registerTemplateSyncTools(server, ctx);
	registerPreviewTools(server, ctx);
	registerDeployTools(server, ctx);
	registerPropagateTools(server, ctx);
	registerImageGenerationTools(server, ctx as ImageGenerationToolContext);

	const cmsCtx: CmsProxyContext = {
		orgSlug: ctx.orgSlug,
		isPlatformAdmin: ctx.isPlatformAdmin,
		mediaMaintenanceAuthorized: ctx.mediaMaintenanceAuthorized,
		forwardedAuth: ctx.forwardedAuth,
		humanAuthRequired: ctx.humanAuthRequired,
		humanIdentity: ctx.humanIdentity,
		humanAuthDenial: ctx.humanAuthDenial,
		serviceApiKey: ctx.serviceApiKey,
		loadTransferServiceKey: ctx.loadTransferServiceKey,
		loadTransferHumanIdentity: ctx.loadTransferHumanIdentity,
		internalAuthToken: ctx.internalAuthToken,
		environment: ctx.environment,
		cmsDispatch: ctx.cmsDispatch,
		db: ctx.db,
		bundlesBucket: ctx.bundlesBucket,
	};
	try {
		registerCmsProxyTools(server, cmsCtx);
		registerBlogGenerationTool(server, {
			cms: cmsCtx,
			geminiApiKey: ctx.geminiApiKey,
			geminiGateway: ctx.geminiGateway,
		});
		const toolCount = Object.keys(
			(server as any)._registeredTools ?? {},
		).length;
		console.log(
			`[buildSiteBuilderMcpServer] Registered ${toolCount} total tools`,
		);
	} catch (err) {
		console.error(
			"[buildSiteBuilderMcpServer] registerCmsProxyTools failed:",
			err,
		);
	}

	registerServiceKeyTool(server, ctx);

	return server;
}

function registerBuilderRecoveryTool(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	const recoveryInput = z.object({
		orgSlug: z.string().regex(/^[a-z][a-z0-9-]*$/),
		expectedSiteId: z.string().uuid(),
		expectedVersion: z.number().int().positive(),
		expectedBundleEtag: z.string().regex(/^[a-f0-9]{64}$/),
		expectedSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
		expectedFailedSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
		proofJobId: z
			.string()
			.regex(/^cms-[0-9a-f-]+-e\d+-v[1-9]\d*-s[a-f0-9]{40}$/),
		confirmMayInterruptInFlightBuild: z.literal(true),
		reason: z.string().trim().min(20).max(1000),
	});
	const recoveryOutput = (status: z.ZodType) =>
		z.object({
			status,
			orgSlug: z.string(),
			siteId: z.string(),
			activeVersion: z.number().int(),
			sourceCommit: z.string(),
			message: z.string(),
		});
	server.registerTool(
		"stop_builder_sandbox",
		{
			title: "Stop Pinned CMS Builder Sandbox",
			description:
				"Platform-admin recovery only. Pin the active bundle's Artifacts source with expectedSourceCommit and the failed deploy's source with expectedFailedSourceCommit. Invoke stop for this exact tenant's Builder container after checking its active site ID, bundle version and etag, and a failed deploy receipt whose completed preflight fetched the failed source. The receipt proves a prior fetch, not current Git availability. The SDK stop RPC does not confirm signal delivery or container exit, so success means stop_requested. Does not destroy the Sandbox or modify the live site; local Builder drafts may be lost. A concurrently restarted same-tenant build can be interrupted after the final checks. A lost stop response is reported as uncertain.",
			inputSchema: schema(recoveryInput),
			outputSchema: schema(
				recoveryOutput(z.enum(["stop_requested", "uncertain"])),
			),
			annotations: { destructiveHint: true, readOnlyHint: false },
		},
		async (pins: CmsSandboxRecoveryPins) => {
			if (!ctx.isPlatformAdmin)
				return forbidden(
					"Platform admin authority required to stop a CMS Builder Sandbox",
				);
			try {
				const output = await stopPinnedCmsBuilderSandbox({
					pins,
					currentOrgSlug: ctx.orgSlug,
					isPlatformAdmin: ctx.isPlatformAdmin,
					db: ctx.db,
					bundlesBucket: ctx.bundlesBucket,
					storage: ctx.storage,
					artifacts: ctx.artifacts,
					getDeployStatus: ctx.getDeployStatus,
					getSandboxForOrg: ctx.getSandboxForOrg,
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(output, null, 2) },
					],
					structuredContent: output,
					isError: output.status === "uncertain" ? (true as const) : undefined,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CONFLICT] ${error instanceof Error ? error.message : "CMS Builder stop refused"}`,
						},
					],
					isError: true as const,
				};
			}
		},
	);
	server.registerTool(
		"force_destroy_builder_sandbox",
		{
			title: "Force Destroy Pinned CMS Builder Sandbox",
			description:
				"Platform-admin recovery after ordinary stop failed. Request force-destroy for only this exact tenant's Builder Sandbox after the same active-site, separately pinned active and failed Artifacts sources, failed preflight receipt, and terminal Workflow checks. This can lose container-local drafts and preview state and interrupt a concurrent build. The SDK may queue destroy behind an unfinished stop, so a timeout does not prove SIGKILL was attempted. No CMS site, bundle, R2, or Artifacts deletion is requested. SDK completion does not replace independent provider instance-exit verification; a lost response is uncertain.",
			inputSchema: schema(
				recoveryInput.extend({ confirmLoseBuilderDrafts: z.literal(true) }),
			),
			outputSchema: schema(
				recoveryOutput(z.enum(["destroy_rpc_completed", "uncertain"])),
			),
			annotations: { destructiveHint: true, readOnlyHint: false },
		},
		async (pins: CmsSandboxForceRecoveryPins) => {
			if (!ctx.isPlatformAdmin)
				return forbidden(
					"Platform admin authority required to force-destroy a CMS Builder Sandbox",
				);
			try {
				const output = await destroyPinnedCmsBuilderSandbox({
					pins,
					currentOrgSlug: ctx.orgSlug,
					isPlatformAdmin: ctx.isPlatformAdmin,
					db: ctx.db,
					bundlesBucket: ctx.bundlesBucket,
					storage: ctx.storage,
					artifacts: ctx.artifacts,
					getDeployStatus: ctx.getDeployStatus,
					getSandboxForOrg: ctx.getSandboxForOrg,
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(output, null, 2) },
					],
					structuredContent: output,
					isError: output.status === "uncertain" ? (true as const) : undefined,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CONFLICT] ${error instanceof Error ? error.message : "CMS Builder force-destroy refused"}`,
						},
					],
					isError: true as const,
				};
			}
		},
	);
}

export function installCmsToolAudit(
	server: McpServer,
	record: SiteBuilderToolContext["recordMcpAuditEvent"],
): void {
	if (!record) return;
	const target = server as unknown as {
		registerTool: (...args: unknown[]) => unknown;
	};
	const registerTool = target.registerTool.bind(server);
	target.registerTool = (...args: unknown[]) => {
		const [name, options, handler] = args;
		if (typeof name !== "string" || typeof handler !== "function") {
			return registerTool(...args);
		}
		return registerTool(name, options, async (...handlerArgs: unknown[]) => {
			const startedAt = Date.now();
			let outcome: "error" | "success" = "error";
			let resultDigest: string | null = null;
			try {
				const result = await (handler as (...values: unknown[]) => unknown)(
					...handlerArgs,
				);
				try {
					const bytes = new TextEncoder().encode(
						(JSON.stringify(result) ?? "null").slice(0, 65_536),
					);
					const digest = await crypto.subtle.digest("SHA-256", bytes);
					resultDigest = Array.from(new Uint8Array(digest), (byte) =>
						byte.toString(16).padStart(2, "0"),
					).join("");
				} catch {
					resultDigest = null;
				}
				outcome = "success";
				return result;
			} finally {
				try {
					await record({
						durationMs: Date.now() - startedAt,
						outcome,
						resultDigest,
						toolName: name,
					});
				} catch (error) {
					console.error("[cms-mcp] audit write failed", error);
				}
			}
		});
	};
}

function registerServiceKeyTool(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"cms_provision_service_key",
		{
			title: "Provision CMS Service Key",
			description:
				"Store an Emdash PAT (ec_pat_...) for this org so service/tedi contexts can call CMS tools autonomously. " +
				"Two modes: (1) pass `pat` directly to store a PAT you already have; " +
				"(2) omit `pat` to auto-create one via the Emdash API using a live Descope user session or the Site Builder internal service credential. " +
				"Run once per org to enable autonomous CMS access.",
			inputSchema: schema(
				z.object({
					pat: z
						.string()
						.optional()
						.describe(
							"Existing Emdash PAT (ec_pat_...) to store directly. Omit to auto-create via user session.",
						),
					name: z
						.string()
						.optional()
						.describe(
							"Token name when auto-creating through user or internal service auth (default: 'tedix-site-builder-service')",
						),
				}),
			),
			// Provisions a credential: mutating and authority-granting.
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async (args: { pat?: string; name?: string }) => {
			// Direct PAT bootstrap — no user session required
			if (args.pat) {
				if (!args.pat.startsWith("ec_pat_")) {
					return {
						content: [
							{
								type: "text" as const,
								text: "[ERROR] pat must be an Emdash Personal Access Token starting with ec_pat_. OAuth tokens (ec_oat_) are time-limited and not suitable as service keys.",
							},
						],
						isError: true,
					};
				}
				await storeServiceKey(ctx.storage, ctx.orgSlug, args.pat);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								ok: true,
								org: ctx.orgSlug,
								mode: "stored",
								message:
									"PAT stored. CMS tools are now available for this org.",
							}),
						},
					],
				};
			}

			const authCandidates = buildServiceKeyProvisionAuthCandidates(ctx);
			if (authCandidates.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "[ERROR] No pat provided and no CMS bootstrap credential is available. Pass pat=<ec_pat_...>, call from a user session, or configure CMS_INTERNAL_AUTH_TOKEN.",
						},
					],
					isError: true,
				};
			}

			const origin = buildSurfaceUrl("cms", ctx.orgSlug, {
				platformDomain: platformDomainForEnvironment(ctx.environment),
			});
			if (!origin) throw new Error("CMS organization slug is required");
			const baseUrl = `${origin}/_emdash/api`;
			const tokenName = args.name ?? "tedix-site-builder-service";

			const doFetch = ctx.cmsDispatch
				? (url: string, init: RequestInit) =>
						ctx.cmsDispatch!.fetch(new Request(url, init))
				: (url: string, init: RequestInit) => fetch(url, init);
			let resp: Response | undefined;
			let text = "";
			for (const [index, headers] of authCandidates.entries()) {
				resp = await doFetch(`${baseUrl}/admin/api-tokens`, {
					method: "POST",
					headers: {
						...headers,
						"Content-Type": "application/json",
						"X-EmDash-Request": "1",
					},
					body: JSON.stringify({
						name: tokenName,
						scopes: ["admin"],
					}),
				});
				text = await resp.text();
				if (resp.ok) break;
				const canRetryAuth =
					(resp.status === 401 || resp.status === 403) &&
					index < authCandidates.length - 1;
				if (!canRetryAuth) break;
			}

			if (!resp) throw new Error("CMS service-key bootstrap made no request");
			if (!resp.ok) {
				const detail =
					resp.status === 403
						? "Admin privileges required — the Descope user must have an admin role in this Emdash org."
						: text.slice(0, 400);
				return {
					content: [
						{
							type: "text" as const,
							text: `[CMS_ERROR] POST /admin/api-tokens failed (${resp.status}): ${detail}`,
						},
					],
					isError: true,
				};
			}

			let pat: string;
			try {
				const body = JSON.parse(text) as {
					success?: boolean;
					data?: { token?: string };
				};
				pat = body.data?.token ?? "";
			} catch {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CMS_ERROR] Unexpected response: ${text.slice(0, 200)}`,
						},
					],
					isError: true,
				};
			}

			if (!pat) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CMS_ERROR] No token in response: ${text.slice(0, 200)}`,
						},
					],
					isError: true,
				};
			}

			await storeServiceKey(ctx.storage, ctx.orgSlug, pat);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							ok: true,
							org: ctx.orgSlug,
							tokenName,
							mode: "created",
							message:
								"PAT created and stored. Service contexts can now call CMS tools for this org.",
						}),
					},
				],
			};
		},
	);
}

export function buildInstructions(templateSlug: CmsTemplateSlug): string {
	return `You are connected to the CMS theme builder for an Emdash tenant using the installed Astro and Tailwind CSS versions.

## What You Can Do

Use the theme_* tools inside this cms_* namespace to customize the tenant frontend:
- Read and modify Astro pages, layouts, components, and CSS
- Preview changes with a live dev server
- Build and deploy themes to the live CMS
- Rollback to previous versions

## File Boundaries

LOCKED (cannot modify — CMS infrastructure):
${lockedFilesForTemplate(templateSlug)
	.map((f) => `  - ${f}`)
	.join("\n")}
${lockedDirsForTemplate(templateSlug)
	.map((dir) => `  - ${dir}**`)
	.join("\n")}

EDITABLE (theme customization):
${EDITABLE_FILES.map((f) => `  - ${f}`).join("\n")}

You may also create NEW files in: ${EDITABLE_DIRS.join(", ")}

## Emdash Content API (available in theme files)

\`\`\`typescript
// Content queries (import from "emdash")
getEmDashCollection(name, { orderBy, limit, offset }) → { entries, cacheHint }
getEntriesByByline(collection, byline, options) → entries credited to a byline in any position
getEmDashEntry(name, slug) → { entry, cacheHint }
getSiteSettings() → { title, tagline, url, ... }
getSiteSettingsWithCacheHint() → { data, cacheHint }
getEntryTerms(collection, id, taxonomy) → terms[]
getSeoMeta(entry, opts) → { title, description, ogTitle, ogDescription, ogImage, canonical, robots } // reads entry.data.seo
decodeSlug(slug) → decoded string
search(query, opts) → { items, nextCursor? }

// UI components (import from "emdash/ui")
<Image image={...} class="..." />
<PortableText value={content} />
<EmDashHead page={pageCtx} />
<EmDashBodyStart page={pageCtx} />
<EmDashBodyEnd page={pageCtx} />

// Page context (import from "emdash/page")
createPublicPageContext({ Astro, kind, pageType, title, ... })
\`\`\`

## Important Rules

1. Always keep EmDashHead/EmDashBodyStart/EmDashBodyEnd in the layout — they power the CMS toolbar and SEO
2. Pass returned cacheHint values to Astro.cache.set(cacheHint) for route invalidation; use getSiteSettingsWithCacheHint() when settings should invalidate the page
3. Use the installed Tailwind CSS utilities and tenant font variable \`var(--font-sans)\`
4. Content is Portable Text (structured JSON), not markdown — render with <PortableText value={...} />
5. Author metadata belongs in native Emdash byline customFields; read from entry.data.bylines[i].byline.customFields rather than hardcoded tenant data
6. Org context available via Astro.locals.org (slug, siteTitle)
`;
}
