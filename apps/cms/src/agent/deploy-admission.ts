import {
	getActiveCmsSiteForPermit,
	withExactCmsSiteRestorePermit,
} from "./cms-restore-permit";
import {
	getCmsBundleDeployGeneration,
	getCmsDeployAdmission,
	reserveCmsDeployAdmission,
} from "./storage";

/** Mirrors the platform `InstanceStatus` union; keep it in step with workerd. */
interface CmsDeployWorkflowStatus {
	status:
		| "queued"
		| "running"
		| "paused"
		| "errored"
		| "rollingBack"
		| "terminated"
		| "complete"
		| "waiting"
		| "waitingForPause"
		| "unknown";
}

export interface CmsDeployWorkflowParams {
	siteId: string;
	restoreEpoch: number;
	orgSlug: string;
	summary?: string;
	/**
	 * Full commit in the tenant's Artifacts theme repo to build. When set, the
	 * deploy materializes that commit's editable files into the builder
	 * instead of trusting the disposable container's current contents.
	 */
	sourceCommit?: string;
	nextBundleVersion: number;
	expectedActiveVersion: number | null;
}

export interface CmsDeployWorkflowBinding {
	create(options: {
		id: string;
		params: CmsDeployWorkflowParams;
	}): Promise<{ id: string }>;
	get(id: string): Promise<{
		id: string;
		status(): Promise<CmsDeployWorkflowStatus>;
		restart(): Promise<void>;
	}>;
}

/**
 * Exact shape of {@link cmsDeployWorkflowInstanceId}. Tools declare it as the
 * jobId schema pattern; the MCP gateway's secret egress scan lets a long job
 * ID through only under this identical pattern
 * (apps/mcp/src/mcp/utils/secret-egress-scan.ts EXEMPT_IDENTIFIER_PATTERNS).
 */
export const CMS_DEPLOY_JOB_ID_RE =
	/^cms-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-e[0-9]{1,16}-v[1-9][0-9]{0,15}(?:-s[a-f0-9]{40})?$/;

export function cmsDeployWorkflowInstanceId(
	siteId: string,
	orgSlug: string,
	nextBundleVersion: number,
	restoreEpoch: number,
	sourceCommit?: string,
): string {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(orgSlug)) {
		throw new Error(`Invalid CMS organization slug: ${orgSlug}`);
	}
	if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(siteId)) {
		throw new Error(`Invalid CMS site ID: ${siteId}`);
	}
	if (!Number.isSafeInteger(nextBundleVersion) || nextBundleVersion < 1) {
		throw new Error(`Invalid CMS bundle version: ${nextBundleVersion}`);
	}
	if (!Number.isSafeInteger(restoreEpoch) || restoreEpoch < 0) {
		throw new Error(`Invalid CMS restore epoch: ${restoreEpoch}`);
	}
	if (sourceCommit && !/^[a-f0-9]{40}$/.test(sourceCommit)) {
		throw new Error(`Invalid CMS theme source commit: ${sourceCommit}`);
	}
	// A site UUID distinguishes a newly provisioned site after slug reuse.
	// The full source commit prevents restart from retaining a different original input.
	// The epoch gives a post-restore deploy a fresh instance and payload.
	return `cms-${siteId}-e${restoreEpoch}-v${nextBundleVersion}${sourceCommit ? `-s${sourceCommit}` : ""}`;
}

/** Reserve a site before creating a Workflow; only terminal receipts free it. */
export async function startCmsDeployWorkflow(input: {
	workflow: CmsDeployWorkflowBinding;
	db: D1Database;
	orgSlug: string;
	summary?: string;
	sourceCommit?: string;
}): Promise<{ jobId: string; reused: boolean }> {
	const site = await getActiveCmsSiteForPermit(input.db, input.orgSlug);
	return withExactCmsSiteRestorePermit(input.db, site, async () => {
		const previous = await getCmsDeployAdmission(input.db, site);

		const generation = await getCmsBundleDeployGeneration(
			input.db,
			input.orgSlug,
		);
		if (generation.hasArtifactsHistory && !input.sourceCommit) {
			throw new Error(
				`CMS theme deploy for ${input.orgSlug} requires sourceCommit because an Artifacts-backed bundle exists. Commit the complete editable theme to its cms-theme-${input.orgSlug} Artifacts repository, then retry theme_deploy with the full 40-character sourceCommit.`,
			);
		}
		const previousJobId = previous?.split(":", 1)[0];
		let nextVersion = generation.nextVersion;
		if (
			previousJobId?.startsWith(`cms-${site.siteId}-e${site.restoreEpoch}-`)
		) {
			const previousVersion = Number(previousJobId.match(/-v([0-9]+)/)?.[1]);
			const sameSource = input.sourceCommit
				? previousJobId.endsWith(`-s${input.sourceCommit}`)
				: !/-s[a-f0-9]{40}$/.test(previousJobId);
			let status: CmsDeployWorkflowStatus;
			let recoverCreation = false;
			try {
				status = await (await input.workflow.get(previousJobId)).status();
			} catch (error) {
				// Recover only the exact reserved generation before any bundle write.
				if (!sameSource || previousVersion < generation.nextVersion)
					throw error;
				status = { status: "unknown" };
				recoverCreation = true;
				nextVersion = previousVersion;
			}
			if (["complete", "errored", "terminated"].includes(status.status)) {
				// Never restart an old instance: its terminal status could race a
				// second caller before restart becomes visible at the provider.
				nextVersion = Math.max(nextVersion, previousVersion + 1);
			} else if (!recoverCreation) {
				if (!sameSource)
					throw new Error(`CMS deploy already in progress: ${previousJobId}`);
				return { jobId: previousJobId, reused: true };
			}
		}
		const jobId = cmsDeployWorkflowInstanceId(
			site.siteId,
			input.orgSlug,
			nextVersion,
			site.restoreEpoch,
			input.sourceCommit,
		);

		const params: CmsDeployWorkflowParams = {
			siteId: site.siteId,
			restoreEpoch: site.restoreEpoch,
			orgSlug: input.orgSlug,
			summary: input.summary,
			sourceCommit: input.sourceCommit,
			nextBundleVersion: nextVersion,
			expectedActiveVersion: generation.activeVersion,
		};
		const reservation = `${jobId}:${crypto.randomUUID()}`;
		if (
			!(await reserveCmsDeployAdmission(input.db, site, previous, reservation))
		) {
			const winner = await getCmsDeployAdmission(input.db, site);
			if (winner?.split(":", 1)[0] !== jobId)
				throw new Error(`CMS deploy already in progress: ${winner}`);
			// The winner may still be creating the provider instance. Creating the
			// identical ID below coalesces safely without releasing its reservation.
		}
		try {
			const instance = await input.workflow.create({ id: jobId, params });
			return { jobId: instance.id, reused: false };
		} catch (createError) {
			try {
				const existing = await input.workflow.get(jobId);
				await existing.status();
				return { jobId: existing.id, reused: true };
			} catch {
				throw createError;
			}
		}
	});
}
