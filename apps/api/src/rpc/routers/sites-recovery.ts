import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getCmsSiteByIdForOrganization } from "@tedix/db/queries/cms-sites";
import { getCmsDeprovisionOperationForOrganization } from "@tedix/db/queries/cms-deprovision-operations";
import { listDocsBuilds } from "@tedix/db/queries/docs-sites/builds";
import { listTenantBundleRecoveryPoints } from "@tedix/db/queries/tenant-bundles";
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
	startCmsRecoveryCapture,
	getCmsRecoveryCapture,
	purgeCmsRecoveryCapture,
	inspectLatestCmsRecoveryCapture,
	startCmsSiteRestore,
	getCmsSiteRestore,
} from "../../services/cms-recovery-resources";
import {
	authedSitesOs,
	requireCmsSite,
	requireOwnedSite,
} from "./sites-shared";

/** A completed deprovision receipt retains owner authority over private captures. */
async function requireCmsRecoveryOwnership(
	context: BaseContext,
	siteId: string,
) {
	const organizationId = requireOrgId(context);
	const site = await getCmsSiteByIdForOrganization(context.db, {
		id: siteId,
		organizationId,
	});
	if (site) return { id: site.id, slug: site.slug };
	const receipt = await getCmsDeprovisionOperationForOrganization(context.db, {
		siteId,
		organizationId,
	});
	if (receipt?.status === "succeeded")
		return { id: receipt.id, slug: receipt.slug };
	throw createError(ErrorCodes.NOT_FOUND, "CMS recovery capture not found");
}

export const getRecoveryManifestProcedure = authedSitesOs.getRecoveryManifest
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ input, context }) => {
		const owned = await requireOwnedSite(context, input.siteId);
		const capturedAt = new Date().toISOString();
		if (owned.type === "cms") {
			const [apps, points, media, provider, capture] = await Promise.all([
				getAppsByOrganization(context.db, owned.site.organizationId),
				listTenantBundleRecoveryPoints(context.db, owned.site.slug),
				inspectCmsMediaResource(context.env, owned.site.slug),
				inspectCmsProviderResources(context.env, owned.site.slug),
				inspectLatestCmsRecoveryCapture(
					context.env,
					owned.site.slug,
					owned.site.id,
				),
			]);
			const authoringApp = apps.find(
				(app) => app.id === owned.site.authoringAppId,
			);
			const activePoint = points.find((point) => point.active);
			const blockers = [
				...(!authoringApp ? ["Authoring proxy is missing"] : []),
				...(!activePoint ? ["No active CMS bundle is available"] : []),
				...(media.state === "missing" ? ["Media bucket is missing"] : []),
				...(media.state === "unknown"
					? ["Media bucket state could not be verified"]
					: []),
				...(provider.durableObject.state !== "present"
					? [
							`CMS Durable Object storage ${provider.durableObject.state === "missing" ? "is missing" : "state could not be verified"}`,
						]
					: []),
				...(!capture.verified
					? [
							"No restorable Durable Object database bookmark has been captured",
							"No independently verified media backup has been captured",
						]
					: ["No tested database and media restore procedure is available"]),
			];
			return {
				siteId: owned.site.id,
				type: "cms" as const,
				slug: owned.site.slug,
				status: owned.site.status,
				capturedAt,
				recoverable: blockers.length === 0,
				blockers,
				resources: [
					{
						kind: "site_record" as const,
						state: "ready" as const,
						identifier: owned.site.id,
						requiredForRecovery: true,
					},
					{
						kind: "durable_object" as const,
						state:
							provider.durableObject.state === "present"
								? ("ready" as const)
								: provider.durableObject.state === "missing"
									? ("missing" as const)
									: ("unknown" as const),
						identifier: `EmDashDB:${owned.site.slug}`,
						requiredForRecovery: true,
					},
					{
						kind: "media" as const,
						state: media.state,
						identifier: media.bucketName,
						requiredForRecovery: true,
					},
					{
						kind: "authoring_proxy" as const,
						state: authoringApp ? ("ready" as const) : ("missing" as const),
						identifier: authoringApp?.slug ?? `cms-${owned.site.slug}`,
						requiredForRecovery: true,
					},
					{
						kind: "mcp_app" as const,
						state: owned.site.mcpAppId
							? ("ready" as const)
							: ("optional" as const),
						identifier: owned.site.mcpAppId ?? "none",
						requiredForRecovery: false,
					},
					{
						kind: "domain" as const,
						state: "ready" as const,
						identifier:
							owned.site.customDomain ?? `${owned.site.slug}.cms.tedix.dev`,
						requiredForRecovery: false,
					},
					{
						kind: "release" as const,
						state: activePoint ? ("ready" as const) : ("missing" as const),
						identifier: activePoint ? String(activePoint.version) : "none",
						requiredForRecovery: true,
					},
				],
				recoveryPoints: points.map((point) => ({
					id: String(point.version),
					label: `Bundle rollback v${point.version} (content and media unchanged)`,
					createdAt: point.deployedAt,
					active: point.active,
				})),
			};
		}
		const builds = await listDocsBuilds(context.db, owned.site.id);
		const complete = builds.filter((build) => build.status === "complete");
		const activeExists = owned.site.activeBuildId
			? complete.some((build) => build.id === owned.site.activeBuildId)
			: false;
		const blockers = [
			...(!owned.site.activeBuildId ? ["No active documentation build"] : []),
			...(owned.site.activeBuildId && !activeExists
				? ["Active documentation build record is missing"]
				: []),
		];
		return {
			siteId: owned.site.id,
			type: "docs" as const,
			slug: owned.site.slug,
			status: owned.site.status,
			capturedAt,
			recoverable: blockers.length === 0,
			blockers,
			resources: [
				{
					kind: "site_record" as const,
					state: "ready" as const,
					identifier: owned.site.id,
					requiredForRecovery: true,
				},
				{
					kind: "source" as const,
					state:
						owned.site.repositoryUrl || owned.site.artifactsRepository
							? ("ready" as const)
							: ("missing" as const),
					identifier:
						owned.site.repositoryUrl ??
						owned.site.artifactsRepository ??
						"none",
					requiredForRecovery: true,
				},
				{
					kind: "domain" as const,
					state: "ready" as const,
					identifier: new URL(owned.site.canonicalUrl).hostname,
					requiredForRecovery: false,
				},
				{
					kind: "release" as const,
					state: activeExists ? ("ready" as const) : ("missing" as const),
					identifier: owned.site.activeBuildId ?? "none",
					requiredForRecovery: true,
				},
			],
			recoveryPoints: complete.map((build) => ({
				id: build.id,
				label: build.sourceRevision ?? build.id,
				createdAt: build.finishedAt ?? build.createdAt,
				active: build.id === owned.site.activeBuildId,
			})),
		};
	});

export const startCmsRecoveryCaptureProcedure =
	authedSitesOs.startCmsRecoveryCapture
		.use(withAuthorization("settings:manage", "mcp:content.admin"))
		.handler(async ({ input, context }) => {
			const site = await requireCmsSite(context, input.siteId);
			if (site.status !== "active")
				throw createError(
					ErrorCodes.CONFLICT,
					"CMS site must be active for recovery capture",
				);
			return startCmsRecoveryCapture(context.env, site.slug, site.id);
		});

export const getCmsRecoveryCaptureProcedure =
	authedSitesOs.getCmsRecoveryCapture
		.use(withAuthorization("apps:read", "mcp:content.read"))
		.handler(async ({ input, context }) => {
			const site = await requireCmsRecoveryOwnership(context, input.siteId);
			return getCmsRecoveryCapture(
				context.env,
				site.slug,
				site.id,
				input.captureId,
			);
		});

export const purgeCmsRecoveryCaptureProcedure =
	authedSitesOs.purgeCmsRecoveryCapture
		.use(withAuthorization("settings:manage", "mcp:content.admin"))
		.handler(async ({ input, context }) => {
			const site = await requireCmsRecoveryOwnership(context, input.siteId);
			if (input.confirmation !== site.slug)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Type ${site.slug} to confirm`,
				);
			return purgeCmsRecoveryCapture(
				context.env,
				site.slug,
				site.id,
				input.captureId,
			);
		});

export const startCmsSiteRestoreProcedure = authedSitesOs.startCmsSiteRestore
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsSite(context, input.siteId);
		if (site.status !== "active")
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS site must be active for restore",
			);
		if (input.confirmation !== site.slug)
			throw createError(ErrorCodes.BAD_REQUEST, `Type ${site.slug} to confirm`);
		return startCmsSiteRestore(context.env, {
			slug: site.slug,
			siteId: site.id,
			captureId: input.captureId,
			mode: input.mode,
		});
	});

export const getCmsSiteRestoreProcedure = authedSitesOs.getCmsSiteRestore
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsSite(context, input.siteId);
		return getCmsSiteRestore(context.env, {
			slug: site.slug,
			siteId: site.id,
			generation: input.generation,
		});
	});
