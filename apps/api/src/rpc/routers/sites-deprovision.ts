import {
	aggregateAppEntryMatches,
	aggregateAppLink,
} from "@tedix/db/queries/aggregate-app-links";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import {
	CmsDeprovisionReservationConflictError,
	getCmsDeprovisionOperationForOrganization,
	reserveCmsDeprovisionOperation,
	updateCmsDeprovisionOperation,
} from "@tedix/db/queries/cms-deprovision-operations";
import { getTenantBundleSummary } from "@tedix/db/queries/tenant-bundles";
import { requireOrgId } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "../orpc";
import { inspectCmsMediaResource } from "../../services/cms-media-resources";
import { inspectCmsProviderResources } from "../../services/cms-provider-resources";
import {
	authedSitesOs,
	aggregateEntries,
	requireCmsSite,
} from "./sites-shared";

type DeprovisionReceipt = NonNullable<
	Awaited<ReturnType<typeof getCmsDeprovisionOperationForOrganization>>
>;

function deprovisionStatus(receipt: DeprovisionReceipt) {
	return {
		operationId: receipt.id,
		siteId: receipt.id,
		slug: receipt.slug,
		status: receipt.status,
		stage: receipt.stage,
		deleted: receipt.deleted,
		errors: receipt.errors,
	};
}

async function ensureCmsDeprovisionWorkflow(
	context: BaseContext,
	receipt: DeprovisionReceipt,
	allowRestart: boolean,
) {
	if (receipt.status === "succeeded") return receipt;
	let instance: Awaited<
		ReturnType<CloudflareEnv["CMS_DEPROVISION_WORKFLOW"]["get"]>
	> | null = null;
	try {
		instance = await context.env.CMS_DEPROVISION_WORKFLOW.get(receipt.id);
	} catch {
		// A receipt may be committed just before dispatch. Its deterministic
		// Workflow ID lets the next request safely complete that dispatch.
	}
	if (instance) {
		const native = await instance.status();
		if (native.status === "errored" || native.status === "terminated") {
			if (allowRestart) {
				await updateCmsDeprovisionOperation(context.db, {
					siteId: receipt.id,
					organizationId: receipt.organizationId,
					status: "queued",
					stage: "Retrying cleanup",
					errors: [],
				});
				await instance.restart();
			} else if (receipt.status !== "failed") {
				await updateCmsDeprovisionOperation(context.db, {
					siteId: receipt.id,
					organizationId: receipt.organizationId,
					status: "failed",
					stage: "Cleanup needs attention",
					errors: ["Cleanup stopped before a final receipt was recorded"],
				});
			}
		} else if (
			native.status === "complete" &&
			receipt.status === "failed" &&
			allowRestart
		) {
			await updateCmsDeprovisionOperation(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
				status: "queued",
				stage: "Retrying cleanup",
				errors: [],
			});
			await instance.restart();
		} else if (native.status === "complete") {
			await updateCmsDeprovisionOperation(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
				status: "failed",
				stage: "Cleanup needs attention",
				errors: ["Cleanup finished without a success receipt"],
			});
		}
		return (
			(await getCmsDeprovisionOperationForOrganization(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
			})) ?? receipt
		);
	}
	if (
		receipt.status === "queued" ||
		(receipt.status === "failed" && allowRestart)
	) {
		if (receipt.status === "failed") {
			await updateCmsDeprovisionOperation(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
				status: "queued",
				stage: "Retrying cleanup",
				errors: [],
			});
		}
		try {
			await context.env.CMS_DEPROVISION_WORKFLOW.create({
				id: receipt.id,
				params: { siteId: receipt.id, organizationId: receipt.organizationId },
			});
		} catch (error) {
			// A competing request may have created the same deterministic instance.
			try {
				await context.env.CMS_DEPROVISION_WORKFLOW.get(receipt.id);
			} catch {
				throw error;
			}
		}
	} else if (receipt.status === "running") {
		return (
			(await updateCmsDeprovisionOperation(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
				status: "failed",
				stage: "Cleanup needs attention",
				errors: ["Cleanup workflow is no longer available"],
			})) ?? receipt
		);
	}
	return (
		(await getCmsDeprovisionOperationForOrganization(context.db, {
			siteId: receipt.id,
			organizationId: receipt.organizationId,
		})) ?? receipt
	);
}

export const getDeprovisionPlanProcedure = authedSitesOs.getDeprovisionPlan
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsSite(context, input.siteId);
		const apps = await getAppsByOrganization(context.db, site.organizationId);
		const authoringApp = apps.find((app) => app.id === site.authoringAppId);
		const mcpApp = apps.find((app) => app.id === site.mcpAppId);
		const gateway = authoringApp
			? apps.find((app) =>
					aggregateEntries(app).some((entry) =>
						aggregateAppEntryMatches(entry, aggregateAppLink(authoringApp)),
					),
				)
			: null;
		const [bundle, media, provider] = await Promise.all([
			getTenantBundleSummary(context.db, site.slug),
			inspectCmsMediaResource(context.env, site.slug),
			inspectCmsProviderResources(context.env, site.slug),
		]);
		return {
			slug: site.slug,
			confirmation: site.slug,
			dependencies: [
				{
					kind: "site" as const,
					status: "present" as const,
					detail: site.name,
					destructive: true,
				},
				{
					kind: "mcp_app" as const,
					status: mcpApp ? ("present" as const) : ("absent" as const),
					detail: mcpApp?.slug ?? "No branded MCP app",
					destructive: false,
				},
				{
					kind: "authoring_app" as const,
					status: authoringApp ? ("present" as const) : ("absent" as const),
					detail: authoringApp?.slug ?? "No authoring proxy",
					destructive: true,
				},
				{
					kind: "gateway" as const,
					status: gateway ? ("present" as const) : ("absent" as const),
					detail: gateway?.slug ?? "Not attached",
					destructive: false,
				},
				{
					kind: "durable_object" as const,
					status:
						provider.durableObject.state === "present"
							? ("present" as const)
							: provider.durableObject.state === "missing"
								? ("absent" as const)
								: ("unknown" as const),
					detail: `EmDashDB storage ${site.slug}`,
					destructive: true,
				},
				{
					kind: "media" as const,
					status:
						media.state === "ready"
							? ("present" as const)
							: media.state === "missing"
								? ("absent" as const)
								: ("unknown" as const),
					detail: media.bucketName,
					destructive: true,
				},
				{
					kind: "bundles" as const,
					status:
						bundle.activeVersion === null
							? ("absent" as const)
							: ("present" as const),
					detail:
						bundle.activeVersion === null
							? "No active bundle"
							: `Active version ${bundle.activeVersion}`,
					destructive: true,
				},
				{
					kind: "theme" as const,
					status: "unknown" as const,
					detail: `hot-themes/${site.slug}/`,
					destructive: true,
				},
				{
					kind: "sandbox" as const,
					status: "unknown" as const,
					detail: `Site Builder sandbox ${site.slug}`,
					destructive: true,
				},
				{
					kind: "hostname" as const,
					status: "present" as const,
					detail: site.customDomain ?? `${site.slug}.cms.tedix.dev`,
					destructive: false,
				},
			],
		};
	});

export const deprovisionSiteProcedure = authedSitesOs.deprovision
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		let receipt = await getCmsDeprovisionOperationForOrganization(context.db, {
			siteId: input.siteId,
			organizationId,
		});
		if (!receipt) {
			const site = await requireCmsSite(context, input.siteId);
			if (input.confirmation !== site.slug)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Type ${site.slug} to confirm`,
				);
			try {
				receipt = await reserveCmsDeprovisionOperation(context.db, {
					siteId: site.id,
					organizationId,
					slug: site.slug,
					authoringAppId: site.authoringAppId,
				});
			} catch (error) {
				if (error instanceof CmsDeprovisionReservationConflictError)
					throw createError(
						ErrorCodes.CONFLICT,
						"CMS site is being restored or changed concurrently",
					);
				throw error;
			}
		}
		if (input.confirmation !== receipt.slug)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Type ${receipt.slug} to confirm`,
			);
		try {
			receipt = await ensureCmsDeprovisionWorkflow(context, receipt, true);
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				`Could not start durable CMS cleanup: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
		return deprovisionStatus(receipt);
	});

export const getDeprovisionStatusProcedure = authedSitesOs.getDeprovisionStatus
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const receipt = await getCmsDeprovisionOperationForOrganization(
			context.db,
			{
				siteId: input.siteId,
				organizationId,
			},
		);
		if (!receipt)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"CMS cleanup operation not found",
			);
		return deprovisionStatus(
			await ensureCmsDeprovisionWorkflow(context, receipt, false),
		);
	});
