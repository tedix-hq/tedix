import { listTenantBundleVersions } from "@tedix/provisioning/cms";
import type { CmsSandbox } from "../sandbox";
import type { ArtifactsBinding } from "../types";
import { getActiveCmsSiteForPermit } from "./cms-restore-permit";
import { themeArtifactRepoName } from "./hot-theme";
import { parseCmsPublishJobId } from "./publish-receipt";

const STOP_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 90_000;

// Matches the durable key written by deploy-workflow.ts. Keep this pure: that
// module imports cloudflare:workers and cannot load in plain tool tests.
function deployProofStatusKey(jobId: string): string {
	return `themes/deploy-status/${jobId}.json`;
}

export interface CmsSandboxRecoveryPins {
	orgSlug: string;
	expectedSiteId: string;
	expectedVersion: number;
	expectedBundleEtag: string;
	expectedSourceCommit: string;
	expectedFailedSourceCommit: string;
	proofJobId: string;
	confirmMayInterruptInFlightBuild: true;
	reason: string;
}

export interface CmsSandboxForceRecoveryPins extends CmsSandboxRecoveryPins {
	confirmLoseBuilderDrafts: true;
}

export type CmsSandboxRecoveryResult = {
	status: "stop_requested" | "destroy_rpc_completed" | "uncertain";
	orgSlug: string;
	siteId: string;
	activeVersion: number;
	sourceCommit: string;
	message: string;
};

type RecoveryPreflightInput = {
	pins: CmsSandboxRecoveryPins;
	currentOrgSlug: string;
	isPlatformAdmin: boolean;
	db: D1Database;
	bundlesBucket: R2Bucket;
	storage: R2Bucket;
	getDeployStatus: (
		jobId: string,
	) => Promise<{ status: string; jobId: string }>;
	artifacts?: ArtifactsBinding;
};

async function verifyPinnedCmsBuilderRecovery(
	input: RecoveryPreflightInput,
): Promise<{ siteId: string; restoreEpoch: number }> {
	const { pins } = input;
	if (!input.isPlatformAdmin)
		throw new Error("Platform admin authority required");
	if (pins.orgSlug !== input.currentOrgSlug)
		throw new Error("Recovery slug must match the authenticated CMS tenant");
	if (!/^[a-z][a-z0-9-]*$/.test(pins.orgSlug))
		throw new Error("Invalid CMS tenant slug");
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			pins.expectedSiteId,
		)
	)
		throw new Error("Exact CMS site ID required");
	if (!Number.isSafeInteger(pins.expectedVersion) || pins.expectedVersion < 1)
		throw new Error("Exact active bundle version required");
	if (!/^[a-f0-9]{64}$/.test(pins.expectedBundleEtag))
		throw new Error("Exact active bundle etag required");
	if (!/^[a-f0-9]{40}$/.test(pins.expectedSourceCommit))
		throw new Error("Exact active Artifacts source commit required");
	if (!/^[a-f0-9]{40}$/.test(pins.expectedFailedSourceCommit))
		throw new Error("Exact failed-deploy Artifacts source commit required");
	if (pins.reason.trim().length < 20)
		throw new Error("A specific recovery reason is required");
	if (pins.confirmMayInterruptInFlightBuild !== true)
		throw new Error(
			"Explicit acknowledgment of possible in-flight build interruption is required",
		);
	if (!/^cms-[0-9a-f-]+-e\d+-v[1-9]\d*-s[a-f0-9]{40}$/.test(pins.proofJobId))
		throw new Error("Exact source-backed deploy proof job ID required");
	if (!input.artifacts)
		throw new Error(
			"CMS Artifacts binding is required to preserve the active source",
		);

	const site = await getActiveCmsSiteForPermit(input.db, pins.orgSlug);
	if (site.siteId !== pins.expectedSiteId || site.slug !== pins.orgSlug)
		throw new Error("CMS site identity changed; Builder stop refused");
	const admitted = parseCmsPublishJobId(
		pins.proofJobId,
		site.siteId,
		site.restoreEpoch,
	);
	if (
		admitted.sourceCommit !== pins.expectedFailedSourceCommit ||
		admitted.version !== pins.expectedVersion + 1
	)
		throw new Error(
			"Deploy proof job does not match the pinned site generation and source",
		);
	const versions = await listTenantBundleVersions(
		{ platformDb: input.db, bundlesBucket: input.bundlesBucket },
		pins.orgSlug,
	);
	const active = versions.filter((version) => version.isActive);
	if (
		active.length !== 1 ||
		active[0]?.version !== pins.expectedVersion ||
		active[0].etag !== pins.expectedBundleEtag ||
		active[0].sourceRevision?.kind !== "artifacts_commit" ||
		active[0].sourceRevision.value !== pins.expectedSourceCommit
	)
		throw new Error(
			"CMS active bundle or Artifacts source changed; Builder stop refused",
		);

	const manifestObject = await input.bundlesBucket.get(
		`${pins.orgSlug}/v${pins.expectedVersion}/manifest.json`,
	);
	if (!manifestObject || manifestObject.size > 1024 * 1024)
		throw new Error("Pinned CMS bundle manifest is unavailable");
	let manifest: unknown;
	try {
		manifest = JSON.parse(await manifestObject.text());
	} catch {
		throw new Error("Pinned CMS bundle manifest is invalid");
	}
	if (
		!manifest ||
		typeof manifest !== "object" ||
		(manifest as Record<string, unknown>).version !== pins.expectedVersion ||
		(manifest as Record<string, unknown>).etag !== pins.expectedBundleEtag ||
		JSON.stringify((manifest as Record<string, unknown>).sourceRevision) !==
			JSON.stringify({
				kind: "artifacts_commit",
				value: pins.expectedSourceCommit,
			})
	)
		throw new Error("Pinned CMS bundle manifest does not match active source");

	// The repository must still exist before any container action. The active
	// bundle and manifest carry the exact commit; no Sandbox read is involved.
	await input.artifacts.get(themeArtifactRepoName(pins.orgSlug));
	const receiptObject = await input.storage.get(
		deployProofStatusKey(pins.proofJobId),
	);
	if (!receiptObject || receiptObject.size > 1024 * 1024)
		throw new Error("Exact deploy proof receipt is unavailable");
	let receipt: unknown;
	try {
		receipt = JSON.parse(await receiptObject.text());
	} catch {
		throw new Error("Exact deploy proof receipt is invalid");
	}
	if (
		!receipt ||
		typeof receipt !== "object" ||
		(receipt as Record<string, unknown>).jobId !== pins.proofJobId ||
		(receipt as Record<string, unknown>).orgSlug !== pins.orgSlug ||
		(receipt as Record<string, unknown>).status !== "failed" ||
		(receipt as Record<string, unknown>).phase !== "failed" ||
		!Array.isArray((receipt as Record<string, unknown>).history) ||
		!(receipt as { history: unknown[] }).history.some(
			(event) =>
				!!event &&
				typeof event === "object" &&
				(event as Record<string, unknown>).phase === "preflight" &&
				(event as Record<string, unknown>).status === "complete" &&
				Number.isSafeInteger(
					(event as { details?: { sourceFileCount?: number } }).details
						?.sourceFileCount,
				) &&
				(event as { details: { sourceFileCount: number } }).details
					.sourceFileCount > 0,
		)
	)
		throw new Error(
			"Deploy proof does not show completed exact-source preflight and terminal failure",
		);
	const liveWorkflow = await input.getDeployStatus(pins.proofJobId);
	if (
		liveWorkflow.jobId !== pins.proofJobId ||
		(liveWorkflow.status !== "errored" && liveWorkflow.status !== "terminated")
	)
		throw new Error(
			"Deploy proof Workflow is active or its terminal state is unavailable",
		);
	// Recheck the current pointer immediately before the RPC. These reads do
	// not create a restore permit or contact the unresponsive Builder Sandbox.
	// A same-tenant deploy can still start after this check and before teardown.
	const currentSite = await getActiveCmsSiteForPermit(input.db, pins.orgSlug);
	const currentActive = (
		await listTenantBundleVersions(
			{ platformDb: input.db, bundlesBucket: input.bundlesBucket },
			pins.orgSlug,
		)
	).filter((version) => version.isActive);
	if (
		currentSite.siteId !== site.siteId ||
		currentSite.restoreEpoch !== site.restoreEpoch ||
		currentActive.length !== 1 ||
		currentActive[0]?.version !== pins.expectedVersion ||
		currentActive[0].etag !== pins.expectedBundleEtag ||
		currentActive[0].sourceRevision?.kind !== "artifacts_commit" ||
		currentActive[0].sourceRevision.value !== pins.expectedSourceCommit
	)
		throw new Error(
			"CMS site or active source changed before Builder recovery",
		);
	return { siteId: site.siteId, restoreEpoch: site.restoreEpoch };
}

/** Stop only the pinned tenant Builder container. Never delete its durable state. */
export async function stopPinnedCmsBuilderSandbox(
	input: RecoveryPreflightInput & {
		getSandboxForOrg: (slug: string) => Pick<CmsSandbox, "destroy">;
		stopTimeoutMs?: number;
	},
): Promise<CmsSandboxRecoveryResult> {
	const { pins } = input;
	const site = await verifyPinnedCmsBuilderRecovery(input);

	console.info("[cms-builder-recovery] stop requested", {
		orgSlug: pins.orgSlug,
		siteId: site.siteId,
		version: pins.expectedVersion,
		reasonLength: pins.reason.trim().length,
	});

	const timeoutMs = input.stopTimeoutMs ?? STOP_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			input.getSandboxForOrg(pins.orgSlug).destroy(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("stop RPC deadline exceeded")),
					timeoutMs,
				);
			}),
		]);
		return {
			status: "stop_requested",
			orgSlug: pins.orgSlug,
			siteId: site.siteId,
			activeVersion: pins.expectedVersion,
			sourceCommit: pins.expectedSourceCommit,
			message:
				"Builder Sandbox stop RPC completed; container exit was not observed and signal delivery is unverified. The failed deploy receipt proves a prior exact-source fetch; current Git availability was not checked. No D1, R2, or Artifacts write was requested. A concurrently restarted same-tenant build may have been interrupted after the final checks.",
		};
	} catch {
		return {
			status: "uncertain",
			orgSlug: pins.orgSlug,
			siteId: site.siteId,
			activeVersion: pins.expectedVersion,
			sourceCommit: pins.expectedSourceCommit,
			message:
				"Builder Sandbox stop outcome is unknown. A concurrently restarted same-tenant build may have been interrupted after the final checks. Do not repeat or claim recovery until independently observed.",
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Force-tear down one pinned Builder Sandbox after an ordinary stop failed. */
export async function destroyPinnedCmsBuilderSandbox(
	input: Omit<RecoveryPreflightInput, "pins"> & {
		pins: CmsSandboxForceRecoveryPins;
		getSandboxForOrg: (slug: string) => Pick<CmsSandbox, "destroy">;
		destroyTimeoutMs?: number;
	},
): Promise<CmsSandboxRecoveryResult> {
	const { pins } = input;
	if (!input.isPlatformAdmin)
		throw new Error("Platform admin authority required");
	if (pins.confirmLoseBuilderDrafts !== true)
		throw new Error(
			"Explicit acknowledgment of Builder draft loss is required",
		);
	const site = await verifyPinnedCmsBuilderRecovery(input);
	console.info("[cms-builder-recovery] force destroy requested", {
		orgSlug: pins.orgSlug,
		siteId: site.siteId,
		version: pins.expectedVersion,
		reasonLength: pins.reason.trim().length,
	});
	const timeoutMs = input.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			input.getSandboxForOrg(pins.orgSlug).destroy(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("destroy RPC deadline exceeded")),
					timeoutMs,
				);
			}),
		]);
		return {
			status: "destroy_rpc_completed",
			orgSlug: pins.orgSlug,
			siteId: site.siteId,
			activeVersion: pins.expectedVersion,
			sourceCommit: pins.expectedSourceCommit,
			message:
				"Builder Sandbox SDK destroy RPC completed; verify the exact provider instance exited before retrying. Container-local drafts and preview state may be lost. No CMS site, bundle, R2, or Artifacts deletion was requested. A concurrent same-tenant build may have been interrupted.",
		};
	} catch {
		return {
			status: "uncertain",
			orgSlug: pins.orgSlug,
			siteId: site.siteId,
			activeVersion: pins.expectedVersion,
			sourceCommit: pins.expectedSourceCommit,
			message:
				"Builder Sandbox force-destroy outcome is unknown. The SDK call may be queued behind an unfinished stop, so SIGKILL may not have been attempted. Do not repeat or retry the build until the exact provider instance is independently observed. Container-local drafts may already be lost.",
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}
