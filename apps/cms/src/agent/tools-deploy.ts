import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import {
	cancelCmsSandboxBuild,
	readCmsSandboxBuildStatus,
	resolveCmsPrivacyBannerEnabled,
	startCmsSandboxBuild,
} from "./build-runner";
import { getActiveCmsSiteForPermit } from "./cms-restore-permit";
import {
	buildCmsPublishReceipt,
	parseCmsPublishJobId,
} from "./publish-receipt";
import {
	type PublicCmsRouteExpectation,
	verifyPublicCmsRoutes,
} from "./public-route-verification";
import { getCmsPublicBuildRoute } from "./storage";
import {
	schema,
	readThemeDeployHumanAuthority,
	defaultCmsRouteExpectations,
	requirePlatformAdminForOrg,
	buildStatusOutput,
	type BuildStatusOutput,
	cmsBuildStatusKey,
	updateStoredJobReceipt,
	type SiteBuilderToolContext,
} from "./tools-shared";

export function registerDeployTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"theme_build",
		{
			title: "Build Theme",
			description:
				"Start a build-only check for the current theme without holding a long Sandbox control request open. " +
				"Returns a jobId immediately; poll theme_build_status until complete or failed.",
			inputSchema: schema(
				z.object({
					waitMs: z
						.number()
						.int()
						.min(0)
						.max(45_000)
						.optional()
						.describe(
							"Optional initial wait before returning status. Default 5000ms, max 45000ms.",
						),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					message: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					successMarkerDetected: z.boolean(),
					logTail: z.string(),
					launchLog: z.string().optional(),
				}),
			),
		},
		async (args: { waitMs?: number }) => {
			const privacyBannerEnabled = await resolveCmsPrivacyBannerEnabled(
				ctx.db,
				ctx.orgSlug,
			);
			const publicBuildRoute = await getCmsPublicBuildRoute(
				ctx.db,
				ctx.orgSlug,
			);
			if (!publicBuildRoute)
				throw new Error(
					`CMS site ${ctx.orgSlug} has no active public build route`,
				);
			const build = await startCmsSandboxBuild(ctx.sandbox, {
				orgSlug: ctx.orgSlug,
				privacyBannerEnabled,
				...publicBuildRoute,
			});
			let snapshot = await readCmsSandboxBuildStatus(ctx.sandbox, build.jobId);
			const waitMs = args.waitMs ?? 5000;
			const deadline = Date.now() + waitMs;
			while (snapshot.status === "running" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				snapshot = await readCmsSandboxBuildStatus(ctx.sandbox, build.jobId);
			}
			const output = await updateStoredJobReceipt(
				ctx.storage,
				cmsBuildStatusKey(ctx.orgSlug, snapshot.jobId),
				async () => buildStatusOutput(snapshot),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_build_status",
		{
			title: "Check Theme Build Status",
			description:
				"Check a build-only job started by theme_build. Uses short Sandbox control probes and returns the current log tail.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,128}$/)
						.describe("Build job ID returned by theme_build."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					message: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					successMarkerDetected: z.boolean(),
					logTail: z.string(),
					launchLog: z.string().optional(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { jobId: string }) => {
			const output = await updateStoredJobReceipt<BuildStatusOutput>(
				ctx.storage,
				cmsBuildStatusKey(ctx.orgSlug, args.jobId),
				async () =>
					buildStatusOutput(
						await readCmsSandboxBuildStatus(ctx.sandbox, args.jobId),
					),
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_build_cancel",
		{
			title: "Cancel Theme Build",
			description:
				"Cancel a running build-only job started by theme_build. Uses the Sandbox SDK process API for the build process instead of a shell fallback.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,128}$/)
						.describe("Build job ID returned by theme_build."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					message: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					successMarkerDetected: z.boolean(),
					logTail: z.string(),
					launchLog: z.string().optional(),
					cancelled: z.boolean(),
					previousStatus: z.string().nullable(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { jobId: string }) => {
			let cancellation:
				| { cancelled: boolean; previousStatus: string | null }
				| undefined;
			const receipt = await updateStoredJobReceipt<BuildStatusOutput>(
				ctx.storage,
				cmsBuildStatusKey(ctx.orgSlug, args.jobId),
				async () => {
					const snapshot = await cancelCmsSandboxBuild(ctx.sandbox, args.jobId);
					cancellation = snapshot;
					return buildStatusOutput(snapshot);
				},
			);
			const output = {
				...receipt,
				cancelled:
					receipt.status === "cancelled" && (cancellation?.cancelled ?? false),
				previousStatus: cancellation?.previousStatus ?? receipt.status,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_deploy",
		{
			title: "Deploy Theme to Live CMS",
			description:
				"Kick off an async deploy of the current theme to {slug}.cms.tedix.dev. " +
				"Returns immediately with a jobId. The deploy runs in a Cloudflare Workflow: " +
				"build → snapshot → dispatch upload → version finalize, with per-step retries. " +
				"Poll theme_deploy_status with the jobId to see progress and the final URL. " +
				"Pass sourceCommit to build the editable theme from that commit of the tenant's Artifacts theme repo " +
				"(the builder workspace is overwritten with it and the bundle records the commit); " +
				"without it the builder's current workspace is built only when no prior Artifacts-backed bundle exists.",
			inputSchema: schema(
				z.object({
					summary: z
						.string()
						.optional()
						.describe("Brief description of the changes (for version history)"),
					sourceCommit: z
						.string()
						.regex(/^[a-f0-9]{40}$/)
						.optional()
						.describe(
							"Full 40-character commit in the tenant's cms-theme-{slug} Artifacts repo to build and record as the bundle source.",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => {
			const guard = requirePlatformAdminForOrg(ctx, ctx.orgSlug, "deploy");
			if (guard) return guard;
			const { jobId } = await ctx.startDeploy(
				ctx.orgSlug,
				args.summary,
				args.sourceCommit,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								status: "queued",
								jobId,
								summary: args.summary,
								hint: "Call theme_deploy_status with this jobId to check progress. Builds typically finish within 60-120s.",
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.registerTool(
		"theme_deploy_status",
		{
			title: "Get Theme Deploy Status",
			description:
				"Check the status of a deploy started with theme_deploy. " +
				"Returns one of: queued, running, complete, failed. Includes the latest " +
				"workflow phase plus recent phase history (preflight, build-and-snapshot, " +
				"publish-bundle, health-check). On 'complete' the response includes the deployed version and live URL. " +
				"Every response carries a read-only humanAuthority object ({ state: active | stale | none, markerEtag, activeEtag, hint }) " +
				"describing whether the site's human assertion marker matches the currently active bundle; a deploy activates a new bundle, " +
				"so 'stale' means human cms_* OAuth calls fail until an admin runs get_human_auth_activation then set_human_auth_activation. " +
				"While the job is still running it reports the currently active bundle.",
			inputSchema: schema(
				z.object({
					jobId: z.string().describe("Job ID returned from theme_deploy"),
				}),
			),
			outputSchema: schema(
				z
					.object({
						status: z.enum([
							"queued",
							"running",
							"complete",
							"failed",
							"errored",
							"terminated",
							"paused",
							"unknown",
						]),
						jobId: z.string(),
						output: z
							.object({
								version: z.number().int(),
								url: z.string(),
							})
							.optional(),
						error: z.string().optional(),
						phase: z.string().optional(),
						message: z.string().optional(),
						updatedAt: z.string().optional(),
						history: z
							.array(
								z.object({
									phase: z.string(),
									status: z.string(),
									message: z.string().optional(),
									timestamp: z.string(),
									details: z.record(z.string(), z.unknown()).optional(),
								}),
							)
							.optional(),
						details: z.record(z.string(), z.unknown()).optional(),
						humanAuthority: z.object({
							state: z.enum(["active", "stale", "none"]),
							markerEtag: z.string().nullable(),
							activeEtag: z.string().nullable(),
							hint: z.string().optional(),
						}),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => {
			const [status, humanAuthority] = await Promise.all([
				ctx.getDeployStatus(args.jobId),
				readThemeDeployHumanAuthority(ctx.db, ctx.orgSlug),
			]);
			const output = { ...status, humanAuthority };
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					status.status === "failed" || status.status === "errored"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_verify_public_routes",
		{
			title: "Verify Public CMS Routes",
			description:
				"Check public HTML routes at this tenant's configured canonical site URL without a browser. " +
				"Reports status, title, H1, language, and canonical URL for each bounded relative route. " +
				"Tedix landing defaults to its home, localized pages, blog, and a published article; other sites default to home. " +
				"Pass routes to check additional pages or stronger title expectations. This is read-only and does not publish content.",
			inputSchema: schema(
				z.object({
					routes: z
						.array(
							z.object({
								path: z.string(),
								expectedLang: z.string().optional(),
								expectedTitle: z.string().optional(),
								expectedTitleContains: z.string().optional(),
								forbiddenTitle: z.string().optional(),
							}),
						)
						.min(1)
						.max(8)
						.optional(),
				}),
			),
			outputSchema: schema(
				z.object({
					ok: z.boolean(),
					checkedAt: z.string(),
					origin: z.string(),
					routes: z.array(
						z.object({
							path: z.string(),
							url: z.string(),
							status: z.number().int().nullable(),
							ok: z.boolean(),
							title: z.string().nullable(),
							h1: z.string().nullable(),
							canonical: z.string().nullable(),
							lang: z.string().nullable(),
							error: z.string().optional(),
						}),
					),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { routes?: PublicCmsRouteExpectation[] }) => {
			const guard = requirePlatformAdminForOrg(
				ctx,
				ctx.orgSlug,
				"verify public routes for",
			);
			if (guard) return guard;
			const configured = await getCmsPublicBuildRoute(ctx.db, ctx.orgSlug);
			if (!configured?.publicSiteUrl) {
				throw new Error(
					`No active canonical public site URL for CMS tenant ${ctx.orgSlug}`,
				);
			}
			const output = await verifyPublicCmsRoutes({
				canonicalUrl: configured.publicSiteUrl,
				routes: args.routes ?? defaultCmsRouteExpectations(ctx.orgSlug),
			});
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_publish_receipt",
		{
			title: "Read Verified Theme Publish Receipt",
			description:
				"For a theme_deploy job, combine its terminal outcome, the currently active bundle and source, and fresh canonical public-page checks. " +
				"ready is true only when the same deployed version is still active and the public routes match. " +
				"A completed job alone is not publication proof.",
			inputSchema: schema(
				z.object({
					jobId: z.string().max(150),
					expectedSourceCommit: z
						.string()
						.regex(/^[a-f0-9]{40}$/)
						.optional(),
					routes: z
						.array(
							z.object({
								path: z.string(),
								expectedLang: z.string().optional(),
								expectedTitle: z.string().optional(),
								expectedTitleContains: z.string().optional(),
								forbiddenTitle: z.string().optional(),
							}),
						)
						.min(1)
						.max(8)
						.optional(),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.string(),
					deployedVersion: z.number().int().nullable(),
					activeVersion: z.number().int().nullable(),
					sourceRevision: z
						.discriminatedUnion("kind", [
							z.object({
								kind: z.literal("artifacts_commit"),
								value: z.string(),
							}),
							z.object({
								kind: z.literal("editable_source_digest"),
								value: z.string(),
							}),
						])
						.nullable(),
					liveUrl: z.string().nullable(),
					routeHealth: z
						.object({
							ok: z.boolean(),
							checkedAt: z.string(),
							origin: z.string().optional(),
							routes: z.array(
								z.object({
									path: z.string(),
									url: z.string(),
									status: z.number().int().nullable(),
									ok: z.boolean(),
									title: z.string().nullable(),
									h1: z.string().nullable(),
									canonical: z.string().nullable(),
									lang: z.string().nullable(),
									error: z.string().optional(),
								}),
							),
						})
						.nullable(),
					ready: z.boolean(),
					issues: z.array(z.string()),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: {
			jobId: string;
			expectedSourceCommit?: string;
			routes?: PublicCmsRouteExpectation[];
		}) => {
			const guard = requirePlatformAdminForOrg(
				ctx,
				ctx.orgSlug,
				"read publish receipt for",
			);
			if (guard) return guard;
			const site = await getActiveCmsSiteForPermit(ctx.db, ctx.orgSlug);
			parseCmsPublishJobId(args.jobId, site.siteId, site.restoreEpoch);
			const deploy = await ctx.getDeployStatus(args.jobId);
			let routeHealth:
				| Awaited<ReturnType<typeof verifyPublicCmsRoutes>>
				| undefined;
			if (deploy.status === "complete") {
				try {
					const configured = await getCmsPublicBuildRoute(ctx.db, ctx.orgSlug);
					if (configured?.publicSiteUrl) {
						routeHealth = await verifyPublicCmsRoutes({
							canonicalUrl: configured.publicSiteUrl,
							routes: args.routes ?? defaultCmsRouteExpectations(ctx.orgSlug),
						});
					}
				} catch {
					// Missing/unsafe public route configuration fails the receipt closed.
				}
			}
			const versions = await ctx.listVersions(ctx.orgSlug);
			const output = buildCmsPublishReceipt({
				orgSlug: ctx.orgSlug,
				siteId: site.siteId,
				restoreEpoch: site.restoreEpoch,
				jobId: args.jobId,
				deploy,
				versions,
				expectedSourceCommit: args.expectedSourceCommit,
				routeHealth,
			});
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_list_versions",
		{
			title: "List Theme Versions",
			description:
				"List all deployed theme versions with active status, source identity, timestamps, and summaries. " +
				"Use a version number with theme_rollback to restore a previous theme.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z
					.object({
						versions: z.array(
							z.object({
								version: z.number().int(),
								active: z.boolean(),
								deployedAt: z.string().nullable(),
								promptSummary: z.string().nullable(),
								sourceRevision: z
									.discriminatedUnion("kind", [
										z.object({
											kind: z.literal("artifacts_commit"),
											value: z.string().regex(/^[a-f0-9]{40}$/),
										}),
										z.object({
											kind: z.literal("editable_source_digest"),
											value: z.string().regex(/^[a-f0-9]{64}$/),
										}),
									])
									.nullable(),
							}),
						),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const guard = requirePlatformAdminForOrg(
				ctx,
				ctx.orgSlug,
				"list versions for",
			);
			if (guard) return guard;
			const versions = await ctx.listVersions(ctx.orgSlug);
			const output = { versions };
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_rollback",
		{
			title: "Rollback Theme",
			description:
				"Restore a previous theme version to the live CMS. " +
				"Use theme_list_versions to see available versions.",
			inputSchema: schema(
				z.object({
					version: z
						.number()
						.int()
						.positive()
						.describe("Version number to restore"),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => {
			const guard = requirePlatformAdminForOrg(ctx, ctx.orgSlug, "rollback");
			if (guard) return guard;
			const { url } = await ctx.rollback(ctx.orgSlug, args.version);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{ status: "rolled_back", version: args.version, url },
							null,
							2,
						),
					},
				],
			};
		},
	);
}
