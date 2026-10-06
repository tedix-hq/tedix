import type { TenantBundleSourceRevision } from "@tedix/provisioning/cms";

export interface CmsPublishRouteCheck {
	path: string;
	url: string;
	status: number | null;
	ok: boolean;
	title: string | null;
	h1: string | null;
	canonical: string | null;
	lang: string | null;
	error?: string;
}

export interface CmsPublishRouteHealth {
	ok: boolean;
	checkedAt: string;
	origin?: string;
	routes: CmsPublishRouteCheck[];
}

export interface CmsPublishReceiptInput {
	orgSlug: string;
	siteId: string;
	restoreEpoch: number;
	jobId: string;
	deploy: {
		jobId: string;
		status: string;
		output?: { version: number; url: string };
	};
	versions: Array<{
		version: number;
		active: boolean;
		sourceRevision: TenantBundleSourceRevision | null;
	}>;
	expectedSourceCommit?: string;
	routeHealth?: CmsPublishRouteHealth;
}

/** Match the admitted site and restore generation before reading a deploy receipt. */
export function parseCmsPublishJobId(
	jobId: string,
	siteId: string,
	restoreEpoch: number,
): { version: number; sourceCommit: string | null } {
	const prefix = `cms-${siteId}-e${restoreEpoch}-v`;
	const suffix = jobId.startsWith(prefix) ? jobId.slice(prefix.length) : "";
	const match = /^([1-9]\d*)(?:-s([a-f0-9]{40}))?$/.exec(suffix);
	const version = Number(match?.[1]);
	if (!match || !Number.isSafeInteger(version)) {
		throw new Error("Deploy job does not belong to this CMS tenant");
	}
	return { version, sourceCommit: match[2] ?? null };
}

export interface CmsPublishReceipt {
	jobId: string;
	status: string;
	deployedVersion: number | null;
	activeVersion: number | null;
	sourceRevision: TenantBundleSourceRevision | null;
	liveUrl: string | null;
	routeHealth: CmsPublishRouteHealth | null;
	ready: boolean;
	issues: string[];
}

/** Assemble a bounded, current-state receipt; a completed Workflow alone is not publication proof. */
export function buildCmsPublishReceipt(
	input: CmsPublishReceiptInput,
): CmsPublishReceipt {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(input.orgSlug)) {
		throw new Error("Invalid CMS organization slug");
	}
	const admitted = parseCmsPublishJobId(
		input.jobId,
		input.siteId,
		input.restoreEpoch,
	);
	if (input.deploy.jobId !== input.jobId) {
		throw new Error("Deploy status belongs to a different job");
	}
	if (
		input.expectedSourceCommit !== undefined &&
		!/^[a-f0-9]{40}$/.test(input.expectedSourceCommit)
	) {
		throw new Error("Expected source commit must be a full 40-character SHA");
	}

	const issues: string[] = [];
	const activeVersions = input.versions.filter((version) => version.active);
	const activeVersion =
		activeVersions.length === 1 ? activeVersions[0]!.version : null;
	if (activeVersions.length > 1) {
		issues.push("Multiple active CMS bundles were reported");
	}
	if (input.deploy.status !== "complete") {
		issues.push(`Deploy job is ${input.deploy.status}, not complete`);
	} else if (!input.deploy.output) {
		issues.push("Completed deploy has no version and live URL");
	}

	const deployedVersion = input.deploy.output?.version ?? null;
	if (deployedVersion !== null && deployedVersion !== admitted.version) {
		issues.push("Deploy result version does not match its job ID");
	}
	const deployed = input.versions.find(
		(version) => version.version === deployedVersion,
	);
	if (deployedVersion !== null && !deployed) {
		issues.push("Deployed bundle is absent from version history");
	} else if (deployed && !deployed.active) {
		issues.push("Deployed bundle is no longer active");
	}
	if (deployed && !deployed.sourceRevision) {
		issues.push("Deployed bundle has no recorded source identity");
	}
	if (deployed && admitted.sourceCommit) {
		if (
			deployed.sourceRevision?.kind !== "artifacts_commit" ||
			deployed.sourceRevision.value !== admitted.sourceCommit
		) {
			issues.push("Deployed source does not match the pinned job commit");
		}
	}
	if (
		deployed &&
		input.expectedSourceCommit &&
		(deployed.sourceRevision?.kind !== "artifacts_commit" ||
			deployed.sourceRevision.value !== input.expectedSourceCommit)
	) {
		issues.push("Deployed source does not match the expected commit");
	}
	if (
		!input.routeHealth ||
		input.routeHealth.routes.length === 0 ||
		!input.routeHealth.ok ||
		input.routeHealth.routes.some((route) => !route.ok)
	) {
		issues.push("Public route checks are missing or failed");
	}

	return {
		jobId: input.jobId,
		status: input.deploy.status,
		deployedVersion,
		activeVersion,
		sourceRevision: deployed?.sourceRevision ?? null,
		liveUrl: input.deploy.output?.url ?? null,
		routeHealth: input.routeHealth ?? null,
		ready: issues.length === 0,
		issues,
	};
}
