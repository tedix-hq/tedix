import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDbClient } from "@tedix/db/client";
import {
	deleteApp,
	getAppMetadataJson,
	updateApp,
} from "@tedix/db/queries/app-records";
import {
	aggregateAppEntryMatches,
	aggregateAppLink,
} from "@tedix/db/queries/aggregate-app-links";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import {
	beginRemovingCmsDomainClaim,
	listCmsDomainClaimsForSite,
	removeCmsDomainClaim,
} from "@tedix/db/queries/cms-domain-claims";
import {
	getCmsSiteByIdForOrganization,
	setCmsSiteStatus,
} from "@tedix/db/queries/cms-sites";
import {
	completeCmsDeprovisionOperation,
	getCmsDeprovisionOperation,
	updateCmsDeprovisionOperation,
} from "@tedix/db/queries/cms-deprovision-operations";
import { countCmsRestorePermitsForSite } from "@tedix/db/queries/cms-restore-fences";
import { mergeAppMetadataPatch } from "../rpc/routers/app-metadata";
import {
	deleteCmsCustomHostname,
	findCmsCustomHostname,
	type CmsCustomHostnameEnv,
} from "../services/cms-custom-hostnames";

export interface CmsDeprovisionParams {
	siteId: string;
	organizationId: string;
}

function aggregateEntries(app: { metadata: unknown }) {
	const entries = getAppMetadataJson(app as never)?.mcpConfig?.aggregateApps;
	return Array.isArray(entries)
		? (entries as Array<{ slug: string; [key: string]: unknown }>)
		: [];
}

interface CmsCleanupResult {
	success?: boolean;
	errors?: string[];
	deletedDurableObjectData?: boolean;
	deletedMediaBucket?: boolean;
	deletedBundles?: boolean;
	deletedSiteBuilderObjects?: number;
	deletedSandbox?: boolean;
}

function removedProviderResources(result: CmsCleanupResult): string[] {
	const removed: string[] = [];
	if (result.deletedDurableObjectData === true) removed.push("durable_object");
	if (result.deletedMediaBucket === true) removed.push("media");
	if (result.deletedBundles === true) removed.push("bundles");
	// The provider reports a count for this prefix. Zero is a completed purge
	// when the whole cleanup succeeded, but is ambiguous on a partial failure.
	if (
		result.success === true &&
		Number.isInteger(result.deletedSiteBuilderObjects) &&
		(result.deletedSiteBuilderObjects ?? -1) >= 0
	)
		removed.push("theme");
	if (result.deletedSandbox === true) removed.push("sandbox");
	return removed;
}

function isPlatformHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return ["tedix.dev", "tedix.tech"].some(
		(domain) => normalized === domain || normalized.endsWith(`.${domain}`),
	);
}

/** An admitted provider call can outlive its Workflow step timeout. Its durable
 * permit, rather than the Workflow status, determines when deletion is safe. */
async function waitForCmsMutationDrain(
	db: Parameters<typeof countCmsRestorePermitsForSite>[0],
	siteId: string,
): Promise<void> {
	for (let poll = 0; poll < 270; poll++) {
		if ((await countCmsRestorePermitsForSite(db, siteId)) === 0) return;
		if (poll < 269)
			await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
	}
	throw new Error(
		"CMS mutations are still in progress; cleanup needs attention",
	);
}

export class CmsDeprovisionWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	CmsDeprovisionParams
> {
	async run(event: WorkflowEvent<CmsDeprovisionParams>, step: WorkflowStep) {
		const { siteId, organizationId } = event.payload;
		const db = createDbClient(this.env.DB);
		const operation = await step.do(
			"verify deprovision receipt",
			{
				retries: { limit: 3, delay: "2 seconds" },
				timeout: "30 seconds",
			},
			async () => {
				const receipt = await getCmsDeprovisionOperation(db, siteId);
				if (
					!receipt ||
					receipt.organizationId !== organizationId ||
					event.instanceId !== siteId
				)
					throw new NonRetryableError(
						"CMS deprovision operation ownership mismatch",
					);
				if (receipt.status === "succeeded") return receipt;
				const site = await getCmsSiteByIdForOrganization(db, {
					id: siteId,
					organizationId,
				});
				if (
					!site ||
					site.slug !== receipt.slug ||
					site.authoringAppId !== receipt.authoringAppId
				)
					throw new NonRetryableError("CMS deprovision site identity mismatch");
				return receipt;
			},
		);
		if (operation.status === "succeeded") return operation;

		try {
			await step.do(
				"drain CMS mutations",
				{ retries: { limit: 0, delay: "1 second" }, timeout: "10 minutes" },
				() => waitForCmsMutationDrain(db, siteId),
			);
			await step.do(
				"pause site and disable authoring",
				{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
				async () => {
					const site = await getCmsSiteByIdForOrganization(db, {
						id: siteId,
						organizationId,
					});
					if (
						!site ||
						site.slug !== operation.slug ||
						site.authoringAppId !== operation.authoringAppId
					)
						throw new NonRetryableError(
							"CMS deprovision site identity mismatch",
						);
					await setCmsSiteStatus(db, siteId, "paused");
					const apps = await getAppsByOrganization(db, organizationId);
					const authoring = apps.find(
						(app) => app.id === operation.authoringAppId,
					);
					if (authoring)
						await updateApp(db, authoring.id, { visibility: "disabled" });
					await updateCmsDeprovisionOperation(db, {
						siteId,
						organizationId,
						status: "running",
						stage: "Removing CMS resources",
					});
				},
			);
			const hostnameRemoved = await step.do(
				"remove CMS custom hostnames",
				{
					// An in-flight Cloudflare create can outlive the first cleanup
					// attempt. Wait for its five-minute lease to become stale.
					retries: { limit: 6, delay: "1 minute" },
					timeout: "2 minutes",
				},
				async () => {
					const site = await getCmsSiteByIdForOrganization(db, {
						id: siteId,
						organizationId,
					});
					if (!site) return [];
					const claims = await listCmsDomainClaimsForSite(db, {
						organizationId,
						siteId,
					});
					const hostnameEnv = this.env as unknown as CmsCustomHostnameEnv;
					for (const claim of claims) {
						const key = { id: claim.id, organizationId, siteId };
						const removing = await beginRemovingCmsDomainClaim(db, key);
						if (!removing)
							throw new Error(
								claim.status === "provisioning"
									? "CMS domain provisioning is still in progress"
									: "CMS domain claim changed during deprovision",
							);
						let providerId = removing.providerHostnameId;
						if (
							!providerId &&
							(removing.status === "removing_provisioning" ||
								removing.status === "removing_legacy")
						) {
							// These states prove the provider may hold a hostname whose
							// ID was never recorded: creation started before the lease
							// went stale, or the hostname was already routed by this
							// site. An ordinary pending claim has neither provenance.
							const provider = await findCmsCustomHostname(
								hostnameEnv,
								removing.hostname,
							);
							providerId = provider?.id ?? null;
						}
						if (!providerId && claim.status === "active")
							throw new Error("Active CMS domain claim has no provider ID");
						if (providerId)
							await deleteCmsCustomHostname(
								hostnameEnv,
								providerId,
								removing.hostname,
							);
						if (!(await removeCmsDomainClaim(db, key)))
							throw new Error("CMS domain claim was not removed");
					}
					if (
						site.customDomain &&
						!claims.some((claim) => claim.hostname === site.customDomain) &&
						!isPlatformHostname(site.customDomain)
					) {
						// Pre-claim external sites may have a SaaS hostname. Tedix-owned
						// hosts use platform DNS/routes and cannot have SaaS records.
						const legacy = await findCmsCustomHostname(
							hostnameEnv,
							site.customDomain,
						);
						if (legacy)
							await deleteCmsCustomHostname(
								hostnameEnv,
								legacy.id,
								site.customDomain,
							);
					}
					const removed =
						claims.length > 0 ||
						(site.customDomain && !isPlatformHostname(site.customDomain))
							? ["hostname"]
							: [];
					await updateCmsDeprovisionOperation(db, {
						siteId,
						organizationId,
						status: "running",
						stage: "Removing CMS resources",
						deleted: removed,
					});
					return removed;
				},
			);
			const providerRemoved = await step.do(
				"remove CMS resources",
				{
					retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
					timeout: "10 minutes",
				},
				async () => {
					const response = await this.env.CMS.fetch(
						new Request(
							`https://cms.internal/api/internal/deployments/${operation.slug}`,
							{
								method: "DELETE",
								headers: {
									Authorization: `Bearer ${this.env.PLATFORM_SERVICE_TOKEN}`,
									"X-Tedix-Connection-Label": operation.slug,
									"X-Tedix-CMS-Site-Id": siteId,
								},
							},
						),
					);
					const result = (await response
						.json()
						.catch(() => ({}))) as CmsCleanupResult;
					const removed = removedProviderResources(result);
					const complete =
						response.ok && result.success === true && removed.length === 5;
					await updateCmsDeprovisionOperation(db, {
						siteId,
						organizationId,
						status: "running",
						stage: complete
							? "Removing site records"
							: "Removing CMS resources",
						deleted: [...hostnameRemoved, ...removed],
					});
					if (!response.ok || !result.success)
						throw new Error(
							result.errors?.join("; ") ||
								`CMS lifecycle returned ${response.status}`,
						);
					if (!complete)
						throw new Error("CMS lifecycle omitted a resource cleanup outcome");
					return removed;
				},
			);

			const deleted = await step.do(
				"remove site records",
				{
					retries: { limit: 3, delay: "2 seconds" },
					timeout: "1 minute",
				},
				async () => {
					const removed = [...hostnameRemoved, ...providerRemoved];
					const apps = await getAppsByOrganization(db, organizationId);
					const authoring = apps.find(
						(app) => app.id === operation.authoringAppId,
					);
					if (authoring) {
						const link = aggregateAppLink(authoring);
						// deleteApp also scrubs these links; this pass records which
						// gateways referenced the authoring app.
						for (const gateway of apps) {
							const entries = aggregateEntries(gateway);
							if (
								!entries.some((entry) => aggregateAppEntryMatches(entry, link))
							)
								continue;
							await updateApp(db, gateway.id, {
								metadata: mergeAppMetadataPatch(getAppMetadataJson(gateway), {
									mcpConfig: {
										aggregateApps: entries.filter(
											(entry) => !aggregateAppEntryMatches(entry, link),
										),
									},
								}),
							});
							removed.push(`gateway:${gateway.slug}`);
						}
						await deleteApp(db, authoring.id);
					}
					if (operation.authoringAppId) removed.push("authoring_app");
					removed.push("site");
					await completeCmsDeprovisionOperation(db, {
						siteId,
						organizationId,
						deleted: removed,
					});
					return removed;
				},
			);
			return { siteId, slug: operation.slug, deleted };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await step.do(
				"record deprovision failure",
				{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
				async () => {
					await updateCmsDeprovisionOperation(db, {
						siteId,
						organizationId,
						status: "failed",
						stage: "Cleanup needs attention",
						errors: [message],
					});
				},
			);
			throw new NonRetryableError(message);
		}
	}
}
