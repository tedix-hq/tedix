import {
	getActiveCmsSiteForPermit,
	withExactCmsSiteRestorePermit,
} from "./cms-restore-permit";
import { getCmsBundleDeployGeneration } from "./storage";

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
	// This prefix also cannot collide with the legacy slug-only ID. The full
	// source commit prevents restart from retaining a different original input.
	// The epoch gives a post-restore deploy a fresh instance and payload.
	return `cms-${siteId}-e${restoreEpoch}-v${nextBundleVersion}${sourceCommit ? `-s${sourceCommit}` : ""}`;
}

/**
 * Admit one deploy per tenant bundle generation. Concurrent callers resolve
 * the same next version and therefore the same Workflow instance id. The
 * loser of Workflow.create's provider-side uniqueness race reuses the winning
 * receipt instead of starting a second workflow against the shared sandbox.
 */
export async function startCmsDeployWorkflow(input: {
	workflow: CmsDeployWorkflowBinding;
	db: D1Database;
	orgSlug: string;
	summary?: string;
	sourceCommit?: string;
}): Promise<{ jobId: string; reused: boolean }> {
	const site = await getActiveCmsSiteForPermit(input.db, input.orgSlug);
	return withExactCmsSiteRestorePermit(input.db, site, async () => {
		const generation = await getCmsBundleDeployGeneration(
			input.db,
			input.orgSlug,
		);
		if (generation.hasArtifactsHistory && !input.sourceCommit) {
			throw new Error(
				`CMS theme deploy for ${input.orgSlug} requires sourceCommit because an Artifacts-backed bundle exists. Commit the complete editable theme to its cms-theme-${input.orgSlug} Artifacts repository, then retry theme_deploy with the full 40-character sourceCommit.`,
			);
		}
		const jobId = cmsDeployWorkflowInstanceId(
			site.siteId,
			input.orgSlug,
			generation.nextVersion,
			site.restoreEpoch,
			input.sourceCommit,
		);
		const params: CmsDeployWorkflowParams = {
			siteId: site.siteId,
			restoreEpoch: site.restoreEpoch,
			orgSlug: input.orgSlug,
			summary: input.summary,
			sourceCommit: input.sourceCommit,
			nextBundleVersion: generation.nextVersion,
			expectedActiveVersion: generation.activeVersion,
		};
		try {
			const instance = await input.workflow.create({ id: jobId, params });
			return { jobId: instance.id, reused: false };
		} catch (createError) {
			try {
				const existing = await input.workflow.get(jobId);
				const status = await existing.status();
				if (status.status === "errored" || status.status === "terminated") {
					await existing.restart();
				}
				return { jobId: existing.id, reused: true };
			} catch {
				throw createError;
			}
		}
	});
}
