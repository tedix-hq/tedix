import { CMS_TEMPLATE_SLUGS } from "../schemas/cms-template";
import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";

import {
	CmsEditorProposalInputSchema,
	CmsEditorProposalOutputSchema,
} from "../schemas/cms-editor-proposals";

const SiteIdParamSchema = z.object({ siteId: z.uuid() });
const CmsDomainClaimInputSchema = SiteIdParamSchema.extend({
	claimId: z.uuid(),
});
const CmsDomainStatusSchema = z.object({
	claimId: z.uuid(),
	hostname: z.string(),
	status: z.enum(["pending", "provisioning", "active", "removing"]),
	isZoneApex: z.boolean(),
	txtName: z.string(),
	txtValue: z.string(),
	cnameTarget: z.string(),
	providerStatus: z.string().nullable(),
	sslStatus: z.string().nullable(),
	validationRecords: z.array(
		z.object({
			type: z.enum(["TXT", "CNAME"]),
			name: z.string(),
			value: z.string(),
		}),
	),
});

const SiteResourceSchema = z.object({
	kind: z.enum([
		"site_record",
		"durable_object",
		"media",
		"release",
		"authoring_proxy",
		"mcp_app",
		"domain",
		"source",
	]),
	state: z.enum(["ready", "missing", "optional", "unknown"]),
	identifier: z.string(),
	requiredForRecovery: z.boolean(),
});

const RecoveryPointSchema = z.object({
	id: z.string(),
	label: z.string(),
	createdAt: z
		.string()
		.nullable()
		.describe(
			"Null only when a legacy recovery point predates deployment timestamps",
		),
	active: z.boolean(),
});

const SiteRecoveryManifestSchema = z.object({
	siteId: z.uuid(),
	type: z.enum(["cms", "docs"]),
	slug: z.string(),
	status: z.enum(["active", "paused", "provisioning"]),
	capturedAt: z.string(),
	recoverable: z.boolean(),
	blockers: z.array(z.string()),
	resources: z.array(SiteResourceSchema),
	recoveryPoints: z.array(RecoveryPointSchema),
});

const CmsRecoveryCaptureSchema = z.object({
	siteId: z.uuid(),
	captureId: z.uuid(),
	status: z.string(),
	capturedAt: z.string().optional(),
	retainUntil: z.string().optional(),
	bundle: z.object({ version: z.number().int(), etag: z.string() }).optional(),
	media: z
		.object({ count: z.number().int(), bytes: z.number().int() })
		.optional(),
});

const CmsSiteRestoreSchema = z.object({
	siteId: z.uuid(),
	captureId: z.uuid(),
	generation: z.uuid(),
	phase: z.enum([
		"claimed",
		"fenced",
		"drained",
		"undo-captured",
		"target-schedule-intent",
		"target-scheduled",
		"target-sql-verified",
		"target-media-verified",
		"undo-schedule-intent",
		"undo-scheduled",
		"undo-sql-verified",
		"undo-media-verified",
		"release-intent",
		"released",
		"held",
	]),
	createdAt: z.string(),
	updatedAt: z.string(),
	errorCode: z.string().optional(),
});

export const SiteSummarySchema = z.object({
	id: z.uuid(),
	type: z.enum(["cms", "docs"]),
	slug: z.string(),
	name: z.string(),
	description: z
		.string()
		.nullable()
		.describe("Null when the owner has not supplied a description"),
	status: z.enum(["active", "paused", "provisioning"]),
	url: z.string().url(),
	accessMode: z
		.enum(["public", "organization"])
		.nullable()
		.describe("Documentation site access policy; null for CMS sites"),
	customDomain: z
		.string()
		.nullable()
		.describe("Null when the platform hostname is canonical"),
	activeRevisionId: z
		.string()
		.nullable()
		.describe(
			"Active documentation build; null for CMS sites or an unpublished Docs site",
		),
	mcpAppId: z
		.uuid()
		.nullable()
		.describe("Optional independently managed branded MCP app"),
	authoringAppId: z
		.uuid()
		.nullable()
		.describe("Optional CMS authoring proxy managed with the site lifecycle"),
});

const DependencySchema = z.object({
	kind: z.enum([
		"site",
		"mcp_app",
		"authoring_app",
		"gateway",
		"durable_object",
		"media",
		"bundles",
		"theme",
		"sandbox",
		"hostname",
	]),
	status: z.enum(["present", "absent", "unknown"]),
	detail: z.string(),
	destructive: z.boolean(),
});

const SiteDeprovisionStatusSchema = z.object({
	operationId: z.uuid(),
	siteId: z.uuid(),
	slug: z.string(),
	status: z.enum(["queued", "running", "succeeded", "failed"]),
	stage: z.string(),
	deleted: z.array(z.string()),
	errors: z.array(z.string()),
});

export const sitesContract = oc.router({
	proposeCmsEditorDraft: oc
		.route({
			method: "POST",
			path: "/{siteId}/editor-proposals",
			tags: ["internal"],
			summary: "Propose edits to an unsaved CMS draft",
		})
		.input(CmsEditorProposalInputSchema)
		.output(CmsEditorProposalOutputSchema),

	createCms: oc
		.route({
			method: "POST",
			path: "/cms/create",
			tags: ["internal"],
			summary: "Create a CMS site ready for authoring",
		})
		.input(
			z
				.object({
					slug: z
						.string()
						.min(1)
						.max(63)
						.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
					name: z.string().min(1).max(100),
					templateSlug: z.enum(CMS_TEMPLATE_SLUGS).default("native-marketing"),
				})
				.strict(),
		)
		.output(
			z.object({
				siteId: z.uuid(),
				slug: z.string(),
				url: z.url(),
				readyForAuthoring: z.boolean(),
				published: z.boolean(),
			}),
		),
	registerCms: oc
		.route({
			method: "POST",
			path: "/cms",
			tags: ["internal"],
			summary: "Register a provisioned CMS site",
		})
		.input(
			z
				.object({
					slug: z
						.string()
						.min(1)
						.max(63)
						.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
					name: z.string().min(1).max(100),
					authoringAppId: z.uuid(),
					templateSlug: z.enum(CMS_TEMPLATE_SLUGS).default("native-marketing"),
					customDomain: z
						.string()
						.max(253)
						.regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)
						.optional()
						.describe(
							"Omit to use the platform CMS hostname; DNS must be provisioned separately",
						),
				})
				.strict(),
		)
		.output(z.object({ siteId: z.uuid(), slug: z.string(), url: z.url() })),
	updateCmsDomain: oc
		.route({
			method: "POST",
			path: "/cms/{siteId}/domain",
			tags: ["internal"],
			summary: "Update a provisioned CMS site's canonical hostname",
		})
		.input(
			SiteIdParamSchema.extend({
				customDomain: z
					.string()
					.max(253)
					.regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)
					.nullable()
					.describe(
						"Provision DNS separately; null restores the platform CMS hostname",
					),
			}).strict(),
		)
		.output(z.object({ siteId: z.uuid(), slug: z.string(), url: z.url() })),
	beginCmsDomain: oc
		.route({
			method: "POST",
			path: "/cms/{siteId}/domain-claims",
			tags: ["internal"],
			summary: "Begin a verified CMS custom-domain claim",
		})
		.input(
			SiteIdParamSchema.extend({
				hostname: z.string().min(4).max(253),
				redirectToApex: z.boolean().optional(),
			}).strict(),
		)
		.output(CmsDomainStatusSchema),
	getCmsDomain: oc
		.route({
			method: "GET",
			path: "/cms/{siteId}/domain-claims",
			tags: ["internal"],
			summary: "Inspect a CMS custom-domain claim",
		})
		.input(SiteIdParamSchema.extend({ redirectToApex: z.boolean().optional() }))
		.output(CmsDomainStatusSchema.nullable()),
	verifyCmsDomain: oc
		.route({
			method: "POST",
			path: "/cms/{siteId}/domain-claims/{claimId}/verify",
			tags: ["internal"],
			summary: "Verify and activate a CMS custom domain",
		})
		.input(CmsDomainClaimInputSchema)
		.output(CmsDomainStatusSchema),
	removeCmsDomain: oc
		.route({
			method: "DELETE",
			path: "/cms/{siteId}/domain-claims/{claimId}",
			tags: ["internal"],
			summary: "Remove a CMS custom domain",
		})
		.input(CmsDomainClaimInputSchema)
		.output(z.object({ removed: z.boolean() })),
	list: oc
		.route({
			method: "GET",
			path: "/sites",
			tags: ["internal"],
			summary: "List owned sites",
		})
		.input(z.object({}).strict().optional())
		.output(
			z.object({
				sites: z.array(SiteSummarySchema),
				cmsCustomDomainsEnabled: z.boolean(),
				cmsSiteQuota: z.object({
					used: z.number().int().nonnegative(),
					limit: z.number().int().min(-1),
				}),
			}),
		),
	getRecoveryManifest: oc
		.route({
			method: "GET",
			path: "/{siteId}/recovery-manifest",
			tags: ["internal"],
			summary: "Inspect a site recovery manifest",
		})
		.input(SiteIdParamSchema)
		.output(SiteRecoveryManifestSchema),
	startCmsRecoveryCapture: oc
		.route({
			method: "POST",
			path: "/cms/{siteId}/recovery-captures",
			tags: ["internal"],
			summary: "Capture a private CMS recovery point",
		})
		.input(SiteIdParamSchema)
		.output(CmsRecoveryCaptureSchema),
	getCmsRecoveryCapture: oc
		.route({
			method: "GET",
			path: "/cms/{siteId}/recovery-captures/{captureId}",
			tags: ["internal"],
			summary: "Inspect a CMS recovery capture",
		})
		.input(SiteIdParamSchema.extend({ captureId: z.uuid() }))
		.output(CmsRecoveryCaptureSchema),
	purgeCmsRecoveryCapture: oc
		.route({
			method: "DELETE",
			path: "/cms/{siteId}/recovery-captures/{captureId}",
			tags: ["internal"],
			summary: "Purge a private CMS recovery capture",
		})
		.input(
			SiteIdParamSchema.extend({
				captureId: z.uuid(),
				confirmation: z.string().min(1),
			}),
		)
		.output(CmsRecoveryCaptureSchema),
	startCmsSiteRestore: oc
		.route({
			method: "POST",
			path: "/cms/{siteId}/site-restores",
			tags: ["internal"],
			summary: "Start an exact-capture CMS site restore",
		})
		.input(
			SiteIdParamSchema.extend({
				captureId: z.uuid(),
				confirmation: z.string().min(1),
				mode: z.enum(["restore", "roundtrip"]).default("restore"),
			}),
		)
		.output(CmsSiteRestoreSchema),
	getCmsSiteRestore: oc
		.route({
			method: "GET",
			path: "/cms/{siteId}/site-restores/{generation}",
			tags: ["internal"],
			summary: "Inspect a CMS site restore operation",
		})
		.input(SiteIdParamSchema.extend({ generation: z.uuid() }))
		.output(CmsSiteRestoreSchema),
	setLifecycle: oc
		.route({
			method: "POST",
			path: "/{siteId}/lifecycle",
			tags: ["internal"],
			summary: "Archive or restore a site",
		})
		.input(
			SiteIdParamSchema.extend({
				action: z.enum(["archive", "restore"]),
				confirmation: z.string().min(1),
			}),
		)
		.output(
			z.object({
				siteId: z.uuid(),
				slug: z.string(),
				type: z.enum(["cms", "docs"]),
				status: z.enum(["active", "paused"]),
			}),
		),
	getReconciliation: oc
		.route({
			method: "GET",
			path: "/reconciliation",
			tags: ["internal"],
			summary: "Get the latest owned-site reconciliation",
		})
		.input(z.object({}).strict().optional())
		.output(
			z
				.object({
					runId: z.uuid(),
					source: z.enum(["manual", "scheduled"]),
					checkedAt: z.string(),
					sitesChecked: z.number().int().nonnegative(),
					issues: z.array(
						z.object({
							siteId: z.uuid(),
							slug: z.string(),
							type: z.enum(["cms", "docs"]),
							code: z.string(),
							severity: z.enum(["warning", "error"]),
							detail: z.string(),
						}),
					),
				})
				.nullable(),
		),
	runReconciliation: oc
		.route({
			method: "POST",
			path: "/reconciliation",
			tags: ["internal"],
			summary: "Run a read-only owned-site reconciliation",
		})
		.input(z.object({}).strict())
		.output(
			z.object({
				runId: z.uuid(),
				source: z.literal("manual"),
				checkedAt: z.string(),
				sitesChecked: z.number().int().nonnegative(),
				issues: z.array(
					z.object({
						siteId: z.uuid(),
						slug: z.string(),
						type: z.enum(["cms", "docs"]),
						code: z.string(),
						severity: z.enum(["warning", "error"]),
						detail: z.string(),
					}),
				),
			}),
		),
	repairCmsMedia: oc
		.route({
			method: "POST",
			path: "/cms/{slug}/resources/media/repair",
			tags: ["internal"],
			summary: "Ensure a CMS site's media bucket exists",
		})
		.input(
			z.object({
				slug: z
					.string()
					.min(1)
					.max(63)
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			}),
		)
		.output(
			z.object({
				siteId: z.uuid(),
				slug: z.string(),
				bucketName: z.string(),
				created: z.boolean(),
				state: z.literal("ready"),
			}),
		),
	getDeprovisionPlan: oc
		.route({
			method: "GET",
			path: "/{siteId}/deprovision-plan",
			tags: ["internal"],
			summary: "Inspect a CMS site deprovision plan",
		})
		.input(SiteIdParamSchema)
		.output(
			z.object({
				slug: z.string(),
				confirmation: z.string(),
				dependencies: z.array(DependencySchema),
			}),
		),
	deprovision: oc
		.route({
			method: "DELETE",
			path: "/{siteId}",
			tags: ["internal"],
			summary: "Deprovision a CMS site",
		})
		.input(SiteIdParamSchema.extend({ confirmation: z.string().min(1) }))
		.output(SiteDeprovisionStatusSchema),
	getDeprovisionStatus: oc
		.route({
			method: "GET",
			path: "/{siteId}/deprovision-status",
			tags: ["internal"],
			summary: "Read a CMS deprovision operation receipt",
		})
		.input(SiteIdParamSchema)
		.output(SiteDeprovisionStatusSchema),
});

export type SitesContract = typeof sitesContract;
