import {
	DOCS_TOOL_SCOPES,
	type DocsToolName,
} from "@tedix/api-contract/contracts/docs-tool-scopes";
import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import {
	READ_OBSERVATION_META_KEY,
	type DocsFileObservationReceipt,
} from "@tedix/mcp-shared/read-observation-receipt";
import { createMcpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import { searchPublicDocs } from "./ai-search";
import {
	commitDocsChange,
	getDocsDiff,
	getDocsFile,
	listDocsFiles,
	proposeDocsChange,
} from "./authoring";
import { createPreviewAccess } from "./preview-access";
import { logDocsFailure } from "./log";
import { docsSourceAuthPath, getDocsSandbox } from "./sandbox";
import {
	activateBuild,
	createBuild,
	createChange,
	getBuild,
	getChange,
	getSiteById,
	listBuilds,
	listChanges,
	listReleases,
	listSites,
	markChangeCommitted,
	setChangePreview,
	syncChangeValidation,
	upsertSite,
	updateBuildProgress,
} from "./registry";
import {
	assertArtifactsRepository,
	assertArtifactsRepositoryUrl,
	assertBranch,
	assertContentRoot,
	assertRepositoryUrl,
	assertSlug,
	gitProviderAuthorization,
	shellQuote,
} from "./source";
import type {
	AppBindings,
	DocsActor,
	DocsChange,
	DocsSite,
	SourceAuthMode,
	SourceProvider,
} from "./types";

// MCP SDK's overload union still cannot infer Zod v4 schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = (value: z.ZodType): any => value;

export interface DocsToolContext {
	env: AppBindings;
	orgSlug: string;
	platformAdmin: boolean;
	scopes: string[];
	actor: DocsActor;
	providerAuthorization: string | null;
}

async function publicationReceipt(
	ctx: DocsToolContext,
	activated: Awaited<ReturnType<typeof activateBuild>>,
) {
	let searchProjection: unknown = null;
	if (activated.site.accessMode === "public") {
		try {
			const workflow = await ctx.env.DOCS_BUILD_WORKFLOW.create({
				id: `search-${activated.release.id}`,
				params: {
					operation: "index",
					siteId: activated.site.id,
					buildId: activated.release.buildId,
				},
			});
			searchProjection = { status: "queued", workflowId: workflow.id };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logDocsFailure("docs.search_index_queue_failed", error);
			searchProjection = { status: "failed", error: message };
		}
	}
	return { ...activated, searchProjection };
}

const providerSchema = z.enum(["artifacts", "github", "gitlab", "generic"]);

function result(value: unknown, meta?: Record<string, unknown>) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(value, null, 2),
			},
		],
		structuredContent: value as Record<string, unknown>,
		...(meta ? { _meta: meta } : {}),
	};
}

function errorResult(error: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: error instanceof Error ? error.message : String(error),
			},
		],
		isError: true as const,
	};
}

function requireToolScope(ctx: DocsToolContext, tool: DocsToolName): void {
	const required = DOCS_TOOL_SCOPES[tool];
	if (!hasScope(ctx.scopes, required)) {
		throw new Error(`insufficient_scope: "${tool}" requires ${required}`);
	}
}

async function runTool(
	ctx: DocsToolContext,
	tool: DocsToolName,
	operation: () => Promise<unknown>,
) {
	try {
		requireToolScope(ctx, tool);
		return result(await operation());
	} catch (error) {
		return errorResult(error);
	}
}

function sourceFields(input: {
	sourceProvider: SourceProvider;
	repositoryUrl?: string | null;
	artifactsRepository?: string | null;
}): { repositoryUrl: string | null; artifactsRepository: string | null } {
	if (input.sourceProvider === "artifacts") {
		if (!input.artifactsRepository) {
			throw new Error(
				"artifactsRepository is required for Cloudflare Artifacts sources",
			);
		}
		const artifactsRepository = assertArtifactsRepository(
			input.artifactsRepository,
		);
		return {
			repositoryUrl: input.repositoryUrl
				? assertArtifactsRepositoryUrl(input.repositoryUrl, artifactsRepository)
				: null,
			artifactsRepository,
		};
	}
	if (!input.repositoryUrl) {
		throw new Error("repositoryUrl is required for external Git sources");
	}
	return {
		repositoryUrl: assertRepositoryUrl(
			input.sourceProvider,
			input.repositoryUrl,
		),
		artifactsRepository: null,
	};
}

function assertOwned(site: DocsSite | null, orgSlug: string): DocsSite {
	if (!site || site.orgSlug !== orgSlug) {
		throw new Error("Documentation site not found");
	}
	return site;
}

async function ownedSite(
	ctx: DocsToolContext,
	siteId: string,
): Promise<DocsSite> {
	return assertOwned(await getSiteById(ctx.env.DB, siteId), ctx.orgSlug);
}

async function ownedChange(
	ctx: DocsToolContext,
	changeId: string,
): Promise<{ change: DocsChange; site: DocsSite }> {
	const change = await getChange(ctx.env.DB, changeId);
	if (!change) throw new Error("Documentation change not found");
	const site = await ownedSite(ctx, change.siteId);
	return {
		change: await syncChangeValidation(ctx.env.DB, change),
		site,
	};
}

async function queueBuild(
	ctx: DocsToolContext,
	input: {
		site: DocsSite;
		sourceBranch: string;
		proposalId?: string | null;
	},
) {
	let authorization: string | null = null;
	if (input.site.sourceAuthMode === "connection") {
		authorization = ctx.providerAuthorization
			? gitProviderAuthorization(
					input.site.sourceProvider,
					ctx.providerAuthorization,
				)
			: null;
		if (
			!authorization ||
			authorization.length > 4096 ||
			!/^[A-Za-z][A-Za-z0-9_-]* [^\r\n]+$/.test(authorization)
		) {
			throw new Error(
				"Private source build requires a governed tenant connection",
			);
		}
	}
	const build = await createBuild(ctx.env.DB, {
		siteId: input.site.id,
		sourceBranch: input.sourceBranch,
		proposalId: input.proposalId,
		requestedBy: ctx.actor,
	});
	const tokenPath = docsSourceAuthPath(build.id);
	const sandbox = getDocsSandbox(ctx.env, build.id);
	let workflow: { id: string };
	try {
		if (authorization) {
			await sandbox.writeFile(tokenPath, authorization);
			const protectedFile = await (
				await sandbox.exec([
					"bash",
					"-lc",
					`chmod 600 ${shellQuote(tokenPath)}`,
				])
			).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
			if (
				protectedFile.exitCode !== 0 ||
				protectedFile.timedOut ||
				protectedFile.signal !== undefined ||
				protectedFile.truncated
			) {
				throw new Error("Unable to protect private source credential");
			}
		}
		workflow = await ctx.env.DOCS_BUILD_WORKFLOW.create({
			id: build.id,
			params: { siteId: input.site.id, buildId: build.id },
		});
	} catch (error) {
		if (authorization) {
			await (
				await sandbox.exec(["bash", "-lc", `rm -f ${shellQuote(tokenPath)}`])
			)
				.output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 })
				.catch(() => undefined);
		}
		await updateBuildProgress(ctx.env.DB, build.id, {
			status: "failed",
			phase: "failed",
			error: (error instanceof Error ? error.message : String(error)).slice(
				0,
				4000,
			),
		}).catch(() => undefined);
		throw error;
	}
	return {
		build,
		previewPath: `/preview/${build.id}/?org=${encodeURIComponent(ctx.orgSlug)}`,
		workflowId: workflow.id,
	};
}

export function buildDocsMcpServer(ctx: DocsToolContext) {
	const server = createMcpServer(
		{ name: "Tedix Docs MCP", version: "0.2.0" },
		{
			instructions:
				"Manage tenant Git-backed documentation. Builds create private immutable previews; publishing and rollback are separate admin-scoped release actions.",
		},
	);

	server.registerTool(
		"list_docs_sites",
		{
			title: "List Documentation Sites",
			description: "List documentation sites owned by the selected tenant.",
			inputSchema: schema(z.object({})),
			annotations: { readOnlyHint: true },
		},
		async () =>
			runTool(ctx, "list_docs_sites", async () => ({
				sites: await listSites(ctx.env.DB, ctx.orgSlug),
			})),
	);

	server.registerTool(
		"get_docs_site",
		{
			title: "Get Documentation Site",
			description: "Get one tenant documentation site.",
			inputSchema: schema(z.object({ siteId: z.string().uuid() })),
			annotations: { readOnlyHint: true },
		},
		async ({ siteId }: { siteId: string }) =>
			runTool(ctx, "get_docs_site", async () => ({
				site: await ownedSite(ctx, siteId),
			})),
	);

	server.registerTool(
		"upsert_docs_site",
		{
			title: "Create or Update Documentation Site",
			description:
				"Create or update a documentation site. Set sourceAuthMode to connection for a private external Git source available through this tenant's governed connection.",
			inputSchema: schema(
				z.object({
					siteId: z.string().uuid().optional(),
					slug: z.string(),
					title: z.string().min(1).max(120),
					description: z.string().min(1).max(300),
					locale: z
						.string()
						.regex(/^[a-z]{2}(?:-[A-Z]{2})?$/)
						.default("en"),
					canonicalUrl: z.string().url().optional(),
					sourceProvider: providerSchema,
					sourceAuthMode: z.enum(["public", "connection"]).default("public"),
					repositoryUrl: z.string().url().nullable().optional(),
					artifactsRepository: z.string().nullable().optional(),
					branch: z.string().default("main"),
					contentRoot: z.string().default("docs/public"),
					accessMode: z.enum(["public", "organization"]).default("public"),
				}),
			),
			annotations: { openWorldHint: true },
		},
		async (input: {
			siteId?: string;
			slug: string;
			title: string;
			description: string;
			locale: string;
			canonicalUrl?: string;
			sourceProvider: SourceProvider;
			sourceAuthMode: SourceAuthMode;
			repositoryUrl?: string | null;
			artifactsRepository?: string | null;
			branch: string;
			contentRoot: string;
			accessMode: DocsSite["accessMode"];
		}) =>
			runTool(ctx, "upsert_docs_site", async () => {
				const slug = assertSlug(input.slug);
				const source = sourceFields(input);
				const canonicalUrl =
					input.canonicalUrl ?? `https://${slug}.${ctx.env.DOCS_BASE_DOMAIN}`;
				const parsedCanonical = new URL(canonicalUrl);
				if (parsedCanonical.protocol !== "https:") {
					throw new Error("Canonical URL must use HTTPS");
				}
				return {
					site: await upsertSite(ctx.env.DB, {
						id: input.siteId,
						orgSlug: ctx.orgSlug,
						slug,
						title: input.title.trim(),
						description: input.description.trim(),
						locale: input.locale,
						canonicalUrl: parsedCanonical.origin,
						sourceProvider: input.sourceProvider,
						sourceAuthMode:
							input.sourceProvider === "artifacts"
								? "public"
								: input.sourceAuthMode,
						repositoryUrl: source.repositoryUrl,
						artifactsRepository: source.artifactsRepository,
						branch: assertBranch(input.branch),
						contentRoot: assertContentRoot(input.contentRoot),
						accessMode: input.accessMode,
					}),
				};
			}),
	);

	server.registerTool(
		"import_docs_repository",
		{
			title: "Import Documentation Repository",
			description:
				"Import a public HTTPS Git repository into Cloudflare Artifacts and make the imported repository the site's source.",
			inputSchema: schema(
				z.object({
					siteId: z.string().uuid(),
					repositoryUrl: z.string().url(),
					branch: z.string().default("main"),
				}),
			),
			annotations: { openWorldHint: true },
		},
		async (input: { siteId: string; repositoryUrl: string; branch: string }) =>
			runTool(ctx, "import_docs_repository", async () => {
				if (!ctx.env.ARTIFACTS) {
					throw new Error("Cloudflare Artifacts binding is unavailable");
				}
				const site = await ownedSite(ctx, input.siteId);
				const repositoryUrl = assertRepositoryUrl(
					"generic",
					input.repositoryUrl,
				);
				const branch = assertBranch(input.branch);
				const artifactsRepository = assertArtifactsRepository(
					`docs-${ctx.orgSlug}-${site.slug}`,
				);
				const imported = await ctx.env.ARTIFACTS.import({
					source: { url: repositoryUrl, branch, depth: 1 },
					target: {
						name: artifactsRepository,
						description: `Source mirror for ${site.title}`,
						setDefaultBranch: branch,
					},
				});
				const importedRemote = await imported.remote;
				return {
					site: await upsertSite(ctx.env.DB, {
						...site,
						id: site.id,
						repositoryUrl: assertArtifactsRepositoryUrl(
							importedRemote,
							artifactsRepository,
						),
						artifactsRepository,
						sourceProvider: "artifacts",
						branch,
					}),
					imported: true,
				};
			}),
	);

	server.registerTool(
		"search_docs",
		{
			title: "Search Public Documentation",
			description:
				"Semantically search only the active immutable revision of a public Docs site and return source citations.",
			inputSchema: schema(
				z.object({
					siteId: z.string().uuid(),
					query: z.string().min(1).max(500),
					limit: z.number().int().min(1).max(20).default(8),
				}),
			),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({
			siteId,
			query,
			limit,
		}: {
			siteId: string;
			query: string;
			limit: number;
		}) =>
			runTool(ctx, "search_docs", async () => {
				const site = await ownedSite(ctx, siteId);
				if (!site.activeBuildId)
					throw new Error("Docs site has no active build");
				const build = await getBuild(ctx.env.DB, site.activeBuildId);
				if (!build) throw new Error("Active Docs build not found");
				return searchPublicDocs(ctx.env, site, build, query, limit);
			}),
	);

	server.registerTool(
		"start_docs_build",
		{
			title: "Build Documentation Preview",
			description:
				"Start a durable documentation build from the site's configured branch. Private Git sources require this tenant's governed connection. Success creates an immutable private preview and never changes the live site.",
			inputSchema: schema(z.object({ siteId: z.string().uuid() })),
			annotations: { openWorldHint: true },
		},
		async ({ siteId }: { siteId: string }) =>
			runTool(ctx, "start_docs_build", async () => {
				const site = await ownedSite(ctx, siteId);
				return queueBuild(ctx, { site, sourceBranch: site.branch });
			}),
	);

	server.registerTool(
		"publish_docs_build",
		{
			title: "Publish Documentation Build",
			description:
				"Atomically make a completed build from the configured branch live. The site's access mode continues to enforce either public or organization-only delivery.",
			inputSchema: schema(
				z.object({
					siteId: z.string().uuid(),
					buildId: z.string().uuid(),
				}),
			),
			annotations: { destructiveHint: true, openWorldHint: true },
		},
		async ({ siteId, buildId }: { siteId: string; buildId: string }) =>
			runTool(ctx, "publish_docs_build", async () => {
				const site = await ownedSite(ctx, siteId);
				const build = await getBuild(ctx.env.DB, buildId);
				if (
					!build ||
					build.siteId !== site.id ||
					build.sourceBranch !== site.branch ||
					build.proposalId
				) {
					throw new Error(
						"Only a completed preview from the configured branch can be published",
					);
				}
				const activated = await activateBuild(ctx.env.DB, {
					buildId,
					orgSlug: ctx.orgSlug,
					siteId,
					action: "publish",
					actor: ctx.actor,
				});
				return publicationReceipt(ctx, activated);
			}),
	);

	server.registerTool(
		"rollback_docs_build",
		{
			title: "Roll Back Documentation Build",
			description:
				"Atomically restore a previous successful immutable build without rebuilding it.",
			inputSchema: schema(
				z.object({
					siteId: z.string().uuid(),
					buildId: z.string().uuid(),
				}),
			),
			annotations: { destructiveHint: true, openWorldHint: true },
		},
		async ({ siteId, buildId }: { siteId: string; buildId: string }) =>
			runTool(ctx, "rollback_docs_build", async () => {
				const site = await ownedSite(ctx, siteId);
				const build = await getBuild(ctx.env.DB, buildId);
				if (!build || build.siteId !== site.id) {
					throw new Error("Documentation build not found");
				}
				const activated = await activateBuild(ctx.env.DB, {
					buildId,
					orgSlug: ctx.orgSlug,
					siteId,
					action: "rollback",
					actor: ctx.actor,
				});
				return publicationReceipt(ctx, activated);
			}),
	);

	server.registerTool(
		"list_docs_builds",
		{
			title: "List Documentation Builds",
			description: "List recent previews and builds for a site.",
			inputSchema: schema(z.object({ siteId: z.string().uuid() })),
			annotations: { readOnlyHint: true },
		},
		async ({ siteId }: { siteId: string }) =>
			runTool(ctx, "list_docs_builds", async () => {
				await ownedSite(ctx, siteId);
				return { builds: await listBuilds(ctx.env.DB, siteId) };
			}),
	);

	server.registerTool(
		"get_docs_build",
		{
			title: "Get Documentation Build",
			description: "Get preview phase, source revision, and failure details.",
			inputSchema: schema(z.object({ buildId: z.string().uuid() })),
			annotations: { readOnlyHint: true },
		},
		async ({ buildId }: { buildId: string }) =>
			runTool(ctx, "get_docs_build", async () => {
				const build = await getBuild(ctx.env.DB, buildId);
				if (!build) throw new Error("Documentation build not found");
				await ownedSite(ctx, build.siteId);
				return { build };
			}),
	);

	server.registerTool(
		"get_docs_preview_link",
		{
			title: "Create Documentation Preview Link",
			description:
				"Create a short-lived browser link for one completed private preview build.",
			inputSchema: schema(z.object({ buildId: z.string().uuid() })),
			annotations: { readOnlyHint: true },
		},
		async ({ buildId }: { buildId: string }) =>
			runTool(ctx, "get_docs_preview_link", async () => {
				const build = await getBuild(ctx.env.DB, buildId);
				if (build?.status !== "complete") {
					throw new Error("Documentation preview is not ready");
				}
				await ownedSite(ctx, build.siteId);
				return createPreviewAccess({
					buildId,
					env: ctx.env,
					orgSlug: ctx.orgSlug,
				});
			}),
	);

	server.registerTool(
		"list_docs_releases",
		{
			title: "List Documentation Releases",
			description: "List the immutable publish and rollback ledger for a site.",
			inputSchema: schema(z.object({ siteId: z.string().uuid() })),
			annotations: { readOnlyHint: true },
		},
		async ({ siteId }: { siteId: string }) =>
			runTool(ctx, "list_docs_releases", async () => {
				await ownedSite(ctx, siteId);
				return { releases: await listReleases(ctx.env.DB, siteId) };
			}),
	);

	server.registerTool(
		"list_docs_files",
		{
			title: "List Documentation Files",
			description:
				"List Markdown and MDX files in the site's configured public content root.",
			inputSchema: schema(z.object({ siteId: z.string().uuid() })),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ siteId }: { siteId: string }) =>
			runTool(ctx, "list_docs_files", async () =>
				listDocsFiles(ctx.env, await ownedSite(ctx, siteId)),
			),
	);

	server.registerTool(
		"get_docs_file",
		{
			title: "Get Documentation File",
			description:
				"Read a Markdown or MDX file from the configured public content root.",
			inputSchema: schema(
				z.object({ siteId: z.string().uuid(), path: z.string().min(1) }),
			),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ siteId, path }: { siteId: string; path: string }) => {
			try {
				requireToolScope(ctx, "get_docs_file");
				const site = await ownedSite(ctx, siteId);
				const file = await getDocsFile(ctx.env, site, path);
				const receipt: DocsFileObservationReceipt = {
					version: 1,
					kind: "docs_file_observation",
					receiptId: crypto.randomUUID(),
					provider: { appSlug: "docs", toolName: "get_docs_file" },
					resource: {
						organizationSlug: ctx.orgSlug,
						siteId: site.id,
						path: file.path,
					},
					evidence: {
						contentSha256: file.contentSha256,
						byteLength: file.byteLength,
						observedGitRevision: file.revision,
					},
					observedAt: new Date().toISOString(),
				};
				return result(file, { [READ_OBSERVATION_META_KEY]: receipt });
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"propose_docs_change",
		{
			title: "Propose Documentation Change",
			description:
				"Create a reviewable Git branch containing one Markdown or MDX change. The public branch and live site are not modified.",
			inputSchema: schema(
				z.object({
					siteId: z.string().uuid(),
					proposalId: z.string().uuid().optional(),
					path: z.string().min(1),
					content: z.string(),
					message: z.string().min(1).max(200),
					expectedRevision: z
						.string()
						.regex(/^[a-f0-9]{40,64}$/i)
						.optional(),
				}),
			),
			annotations: { openWorldHint: true },
		},
		async (input: {
			siteId: string;
			proposalId?: string;
			path: string;
			content: string;
			message: string;
			expectedRevision?: string;
		}) =>
			runTool(ctx, "propose_docs_change", async () => {
				const site = await ownedSite(ctx, input.siteId);
				const changeId = input.proposalId ?? crypto.randomUUID();
				const existing = await getChange(ctx.env.DB, changeId);
				if (existing) {
					if (existing.siteId !== site.id) {
						throw new Error("Proposal ID belongs to another site");
					}
					return { change: existing, idempotent: true };
				}
				const proposed = await proposeDocsChange(ctx.env, site, {
					changeId,
					content: input.content,
					expectedRevision: input.expectedRevision,
					message: input.message,
					path: input.path,
				});
				const change = await createChange(ctx.env.DB, {
					id: changeId,
					siteId: site.id,
					path: input.path,
					message: input.message.trim(),
					baseRevision: proposed.baseRevision,
					proposalBranch: proposed.proposalBranch,
					proposalRevision: proposed.proposalRevision,
					contentSha256: proposed.contentSha256,
					proposedBy: ctx.actor,
				});
				return { change, diff: proposed.diff };
			}),
	);

	server.registerTool(
		"validate_docs_change",
		{
			title: "Validate Documentation Change",
			description:
				"Build a private documentation preview from a proposal branch. This never changes the public branch or live site.",
			inputSchema: schema(z.object({ changeId: z.string().uuid() })),
			annotations: { openWorldHint: true },
		},
		async ({ changeId }: { changeId: string }) =>
			runTool(ctx, "validate_docs_change", async () => {
				const { change, site } = await ownedChange(ctx, changeId);
				if (change.status === "committed" || change.status === "rejected") {
					throw new Error(`Documentation change is ${change.status}`);
				}
				if (change.status === "validating" && change.previewBuildId) {
					return {
						change,
						build: await getBuild(ctx.env.DB, change.previewBuildId),
						idempotent: true,
					};
				}
				const queued = await queueBuild(ctx, {
					site,
					sourceBranch: change.proposalBranch,
					proposalId: change.id,
				});
				const updated = await setChangePreview(ctx.env.DB, {
					changeId: change.id,
					buildId: queued.build.id,
				});
				return { ...queued, change: updated };
			}),
	);

	server.registerTool(
		"list_docs_changes",
		{
			title: "List Documentation Changes",
			description: "List recent Git-backed documentation proposals for a site.",
			inputSchema: schema(z.object({ siteId: z.string().uuid() })),
			annotations: { readOnlyHint: true },
		},
		async ({ siteId }: { siteId: string }) =>
			runTool(ctx, "list_docs_changes", async () => {
				await ownedSite(ctx, siteId);
				const changes = await listChanges(ctx.env.DB, siteId);
				return {
					changes: await Promise.all(
						changes.map((change) => syncChangeValidation(ctx.env.DB, change)),
					),
				};
			}),
	);

	server.registerTool(
		"get_docs_change",
		{
			title: "Get Documentation Change",
			description:
				"Get one Git-backed documentation proposal and validation state.",
			inputSchema: schema(z.object({ changeId: z.string().uuid() })),
			annotations: { readOnlyHint: true },
		},
		async ({ changeId }: { changeId: string }) =>
			runTool(ctx, "get_docs_change", async () => ({
				change: (await ownedChange(ctx, changeId)).change,
			})),
	);

	server.registerTool(
		"get_docs_diff",
		{
			title: "Get Documentation Diff",
			description: "Read the bounded Git diff for a documentation proposal.",
			inputSchema: schema(z.object({ changeId: z.string().uuid() })),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ changeId }: { changeId: string }) =>
			runTool(ctx, "get_docs_diff", async () => {
				const { change, site } = await ownedChange(ctx, changeId);
				return { change, ...(await getDocsDiff(ctx.env, site, change)) };
			}),
	);

	server.registerTool(
		"commit_docs_change",
		{
			title: "Commit Documentation Change",
			description:
				"Fast-forward a successfully validated proposal onto the configured public branch. A separate preview build and publish action are still required.",
			inputSchema: schema(z.object({ changeId: z.string().uuid() })),
			annotations: { destructiveHint: true, openWorldHint: true },
		},
		async ({ changeId }: { changeId: string }) =>
			runTool(ctx, "commit_docs_change", async () => {
				const { change, site } = await ownedChange(ctx, changeId);
				const committed = await commitDocsChange(ctx.env, site, change);
				return {
					change: await markChangeCommitted(ctx.env.DB, {
						changeId,
						revision: committed.revision,
						actor: ctx.actor,
					}),
				};
			}),
	);

	return server;
}
