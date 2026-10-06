import { createDbQueryClient } from "@tedix/db/query-client";
import {
	enterCmsRestorePermit,
	leaveCmsRestorePermit,
} from "@tedix/db/queries/cms-restore-fences";
import { getCmsDeprovisionOperation } from "@tedix/db/queries/cms-deprovision-operations";
import { getCmsSiteBySlug } from "@tedix/db/queries/cms-sites";

export interface ExactCmsSite {
	siteId: string;
	slug: string;
}

export interface ExactCmsActiveSite extends ExactCmsSite {
	restoreEpoch: number;
}

/** Only the paused canonical site with its running teardown receipt may be deleted. */
export async function hasExactCmsDeprovisionAuthority(
	platformDb: D1Database,
	site: ExactCmsSite,
): Promise<boolean> {
	const db = createDbQueryClient(platformDb);
	const canonical = await getCmsSiteBySlug(db, site.slug);
	if (
		!canonical ||
		canonical.id !== site.siteId ||
		canonical.slug !== site.slug ||
		canonical.status !== "paused"
	)
		return false;
	const receipt = await getCmsDeprovisionOperation(db, site.siteId);
	return (
		!!receipt &&
		receipt.id === site.siteId &&
		receipt.slug === site.slug &&
		receipt.organizationId === canonical.organizationId &&
		receipt.authoringAppId === canonical.authoringAppId &&
		receipt.status === "running"
	);
}

/** Resolve the canonical active identity before deploy admission. */
export async function getActiveCmsSiteForPermit(
	platformDb: D1Database,
	slug: string,
): Promise<ExactCmsActiveSite> {
	const site = await getCmsSiteBySlug(createDbQueryClient(platformDb), slug);
	if (!site || site.status !== "active") {
		throw new Error(`CMS restore permit denied for site ${slug}`);
	}
	return { siteId: site.id, slug: site.slug, restoreEpoch: site.restoreEpoch };
}

/** The caller lost observation of a process that may still mutate site state. */
export class CmsUnknownProcessOutcomeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CmsUnknownProcessOutcomeError";
	}
}

export interface ExactCmsSiteRestorePermitOptions {
	/** Leave a durable drain blocker only for an unknown process outcome. */
	retainPermitOnUnknownProcessOutcome?: boolean;
}

/** Admit only the captured immutable site, and hold its permit through the callback. */
export async function withExactCmsSiteRestorePermit<T>(
	platformDb: D1Database,
	site: ExactCmsActiveSite,
	operation: () => Promise<T>,
	options?: ExactCmsSiteRestorePermitOptions,
): Promise<T> {
	if (
		!site?.siteId ||
		!site?.slug ||
		!Number.isSafeInteger(site.restoreEpoch) ||
		site.restoreEpoch < 0
	) {
		throw new Error("CMS restore permit denied: exact site identity required");
	}
	const db = createDbQueryClient(platformDb);
	const permit = {
		siteId: site.siteId,
		slug: site.slug,
		permitId: crypto.randomUUID(),
		restoreEpoch: site.restoreEpoch,
		kind: "nested" as const,
	};
	// The INSERT checks the active site ID, slug, fence, and deprovision receipt
	// in one D1 write. A read before this point alone would race teardown.
	if (!(await enterCmsRestorePermit(db, permit))) {
		throw new Error(`CMS restore permit denied for site ${site.slug}`);
	}
	const outcome = await Promise.resolve()
		.then(operation)
		.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	const retainPermit =
		!outcome.ok &&
		options?.retainPermitOnUnknownProcessOutcome === true &&
		outcome.error instanceof CmsUnknownProcessOutcomeError;
	if (!retainPermit && !(await leaveCmsRestorePermit(db, permit))) {
		throw new Error(`CMS restore permit release failed for site ${site.slug}`);
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}

/** Keep the exact site's restore permit until the complete mutation and readback finish. */
export async function withCmsSiteRestorePermit<T>(
	platformDb: D1Database,
	orgSlug: string,
	operation: () => Promise<T>,
): Promise<T> {
	return withExactCmsSiteRestorePermit(
		platformDb,
		await getActiveCmsSiteForPermit(platformDb, orgSlug),
		operation,
	);
}
