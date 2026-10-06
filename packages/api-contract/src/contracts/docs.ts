import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";

export const DocsActorSchema = z.object({
	type: z.enum(["user", "service", "tedi", "m2m", "external_agent", "kernel"]),
	id: z.string(),
	sessionId: z.string().nullable(),
});

export const DocsSiteSchema = z.object({
	id: z.string().uuid(),
	orgSlug: z.string(),
	slug: z.string(),
	title: z.string(),
	description: z.string(),
	locale: z.string(),
	canonicalUrl: z.string().url(),
	sourceProvider: z.enum(["artifacts", "github", "gitlab", "generic"]),
	sourceAuthMode: z.enum(["public", "connection"]),
	repositoryUrl: z.string().nullable(),
	artifactsRepository: z.string().nullable(),
	branch: z.string(),
	contentRoot: z.string(),
	accessMode: z.enum(["public", "organization"]),
	status: z.enum(["active", "paused"]),
	activeBuildId: z.string().uuid().nullable(),
	latestBuildId: z.string().uuid().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const DocsBuildSchema = z.object({
	id: z.string().uuid(),
	siteId: z.string().uuid(),
	status: z.enum(["queued", "running", "complete", "failed"]),
	phase: z.string(),
	sourceBranch: z.string().nullable(),
	sourceRevision: z.string().nullable(),
	proposalId: z.string().uuid().nullable(),
	manifestKey: z.string().nullable(),
	error: z.string().nullable(),
	requestedBy: DocsActorSchema.nullable(),
	createdAt: z.string(),
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
});

export const DocsChangeSchema = z.object({
	id: z.string().uuid(),
	siteId: z.string().uuid(),
	status: z.enum([
		"proposed",
		"validating",
		"validated",
		"committed",
		"rejected",
	]),
	path: z.string(),
	message: z.string(),
	baseRevision: z.string(),
	proposalBranch: z.string(),
	proposalRevision: z.string(),
	contentSha256: z.string(),
	previewBuildId: z.string().uuid().nullable(),
	committedRevision: z.string().nullable(),
	proposedBy: DocsActorSchema,
	committedBy: DocsActorSchema.nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	committedAt: z.string().nullable(),
});

export const DocsReleaseSchema = z.object({
	id: z.string().uuid(),
	siteId: z.string().uuid(),
	buildId: z.string().uuid(),
	previousBuildId: z.string().uuid().nullable(),
	action: z.enum(["publish", "rollback"]),
	actor: DocsActorSchema,
	createdAt: z.string(),
});

export const DocsPolicyPresetSchema = z.object({
	id: z.enum(["viewer", "editor", "publisher"]),
	label: z.string(),
	description: z.string(),
	scopes: z.array(z.string()),
});

export const DocsSearchProjectionSchema = z.union([
	z.object({
		accepted: z.number().int().nonnegative(),
		buildId: z.string().uuid(),
		sourceRevision: z.string(),
	}),
	z.object({ accepted: z.literal(false), error: z.string() }),
	z.null(),
]);

export const DocsReleaseResultSchema = z.object({
	site: DocsSiteSchema,
	release: DocsReleaseSchema,
	searchProjection: DocsSearchProjectionSchema,
});

export const DocsValidationResultSchema = z.union([
	z.object({
		change: DocsChangeSchema,
		build: DocsBuildSchema.nullable().describe(
			"Nullable only when a validating change retains its preview build reference after the immutable build record became unavailable.",
		),
		idempotent: z.literal(true),
	}),
	z.object({
		build: DocsBuildSchema,
		previewPath: z.string(),
		workflowId: z.string(),
		change: DocsChangeSchema,
	}),
]);

const siteIdInput = z.object({ siteId: z.string().uuid() });
const changeIdInput = z.object({ changeId: z.string().uuid() });

export const docsContract = oc
	.route({ tags: ["docs"], prefix: "/docs" })
	.errors(baseErrors)
	.router({
		listSites: oc
			.route({ method: "GET", path: "/sites", summary: "List Docs sites" })
			.input(z.object({}))
			.output(
				z.object({
					sites: z.array(DocsSiteSchema),
					policyPresets: z.array(DocsPolicyPresetSchema),
				}),
			),
		getWorkspace: oc
			.route({
				method: "GET",
				path: "/sites/{siteId}/workspace",
				summary: "Get Docs review workspace",
			})
			.input(siteIdInput)
			.output(
				z.object({
					site: DocsSiteSchema,
					builds: z.array(DocsBuildSchema),
					changes: z.array(DocsChangeSchema),
					releases: z.array(DocsReleaseSchema),
				}),
			),
		upsertSite: oc
			.route({
				method: "POST",
				path: "/sites",
				summary: "Create or update a Docs site",
			})
			.input(
				z.object({
					siteId: z.string().uuid().optional(),
					slug: z.string().min(1),
					title: z.string().min(1).max(120),
					description: z.string().min(1).max(300),
					locale: z.string().default("en"),
					canonicalUrl: z.string().url().optional(),
					sourceProvider: z.enum(["artifacts", "github", "gitlab", "generic"]),
					sourceAuthMode: z.enum(["public", "connection"]).default("public"),
					repositoryUrl: z.string().url().nullable().optional(),
					artifactsRepository: z.string().nullable().optional(),
					branch: z.string().default("main"),
					contentRoot: z.string().default("docs/public"),
					accessMode: z.enum(["public", "organization"]).default("public"),
				}),
			)
			.output(z.object({ site: DocsSiteSchema })),
		importRepository: oc
			.route({
				method: "POST",
				path: "/sites/{siteId}/import",
				summary: "Mirror a public repository into Artifacts",
			})
			.input(
				siteIdInput.extend({
					repositoryUrl: z.string().url(),
					branch: z.string().default("main"),
				}),
			)
			.output(z.object({ site: DocsSiteSchema, imported: z.boolean() })),
		startBuild: oc
			.route({
				method: "POST",
				path: "/sites/{siteId}/builds",
				summary: "Build a private Docs preview",
			})
			.input(siteIdInput)
			.output(
				z.object({
					build: DocsBuildSchema,
					previewPath: z.string(),
					workflowId: z.string(),
				}),
			),
		getPreviewLink: oc
			.route({
				method: "POST",
				path: "/builds/{buildId}/preview-link",
				summary: "Create a short-lived Docs preview link",
			})
			.input(z.object({ buildId: z.string().uuid() }))
			.output(
				z.object({
					expiresAt: z.number().int(),
					previewUrl: z.string().url(),
				}),
			),
		publishBuild: oc
			.route({
				method: "POST",
				path: "/sites/{siteId}/publish",
				summary: "Publish a validated Docs build",
			})
			.input(siteIdInput.extend({ buildId: z.string().uuid() }))
			.output(DocsReleaseResultSchema),
		rollbackBuild: oc
			.route({
				method: "POST",
				path: "/sites/{siteId}/rollback",
				summary: "Roll back to an immutable Docs build",
			})
			.input(siteIdInput.extend({ buildId: z.string().uuid() }))
			.output(DocsReleaseResultSchema),
		getDiff: oc
			.route({
				method: "GET",
				path: "/changes/{changeId}/diff",
				summary: "Get a Docs proposal diff",
			})
			.input(changeIdInput)
			.output(z.object({ change: DocsChangeSchema, diff: z.string() })),
		validateChange: oc
			.route({
				method: "POST",
				path: "/changes/{changeId}/validate",
				summary: "Build a Docs proposal preview",
			})
			.input(changeIdInput)
			.output(DocsValidationResultSchema),
		commitChange: oc
			.route({
				method: "POST",
				path: "/changes/{changeId}/commit",
				summary: "Commit a validated Docs proposal",
			})
			.input(changeIdInput)
			.output(z.object({ change: DocsChangeSchema })),
	});

export type DocsSite = z.infer<typeof DocsSiteSchema>;
export type DocsBuild = z.infer<typeof DocsBuildSchema>;
export type DocsChange = z.infer<typeof DocsChangeSchema>;
export type DocsRelease = z.infer<typeof DocsReleaseSchema>;
