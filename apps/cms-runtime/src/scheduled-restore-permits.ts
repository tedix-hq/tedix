import type { DbQueryClient } from "@tedix/db/query-client";
import {
	enterCmsRestorePermit,
	leaveCompletedCmsScheduledPermit,
	leaveCmsRestorePermit,
	cmsRestoreLeasePermit,
	renewCmsRestorePermitLease,
	type CmsRestorePermitParams,
	type CmsRestoreSiteParams,
} from "@tedix/db/queries/cms-restore-fences";
import type { CmsRestoreFenceIdentity } from "./tenant-restore-fence";
import { runtimePermitId } from "./runtime-permit-owner";
import {
	startRestorePermitLease,
	type RestoreLeaseContext,
} from "./restore-permit-lease";

interface ScheduledPermitCompletion extends CmsRestorePermitParams {
	version: 1;
	kind: "scheduled";
	state: "completed";
}

function prefix(siteId: string): string {
	return `scheduled-permits/${siteId}/`;
}

function key(permit: CmsRestorePermitParams): string {
	return `${prefix(permit.siteId)}${permit.permitId}.json`;
}

/** An owner completion callback or successful RPC return proves that the handler
 * and its tracked waitUntil callbacks ended. Without either, rejection stays
 * unknown; duration, permit age and missing receipts are not completion proof.
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 */
export async function withScheduledCmsRestorePermit<T>(
	db: DbQueryClient,
	storage: R2Bucket,
	identity: CmsRestoreFenceIdentity,
	run: (completed: () => Promise<void>) => Promise<T>,
	// Retention's bundle-retention: prefix also fences bundle activation in D1.
	permitId: string = runtimePermitId(),
	context?: RestoreLeaseContext,
): Promise<{ admitted: false } | { admitted: true; value: T }> {
	if (!context && !permitId.startsWith("bundle-retention:"))
		throw new Error("CMS scheduled lease requires its execution context");
	const identityPermit: CmsRestorePermitParams = {
		...identity,
		permitId,
		kind: "scheduled",
	};
	const permit = context
		? cmsRestoreLeasePermit(identityPermit)
		: identityPermit;
	const startedAt = Date.now();
	try {
		if (!(await enterCmsRestorePermit(db, permit))) return { admitted: false };
	} catch (error) {
		// Admission never reached the handler; an unknown INSERT can be released.
		await leaveCmsRestorePermit(db, permit).catch(() => false);
		throw error;
	}
	const lease = context
		? startRestorePermitLease(
				context,
				() => renewCmsRestorePermitLease(db, permit),
				startedAt,
			)
		: undefined;
	let ownerCompleted = false;
	const receipt: ScheduledPermitCompletion = {
		...permit,
		kind: "scheduled",
		version: 1,
		state: "completed",
	};
	let completion: Promise<void> | undefined;
	const completed = () =>
		(completion ??= (async () => {
			lease?.assertActive();
			ownerCompleted = true;
			lease?.stop();
			// The tenant calls back after its handler and waitUntil work drain, so
			// losing the final RPC response does not lose the completion proof.
			await storage.put(key(permit), JSON.stringify(receipt));
			if (!(await leaveCompletedCmsScheduledPermit(db, permit)))
				throw new Error("CMS scheduled restore permit release failed");
			await storage.delete(key(permit));
		})());
	try {
		lease?.assertActive();
		const value = await run(completed);
		await completed();
		return { admitted: true, value };
	} catch (error) {
		// An uncertain remote handler must stop before its lease can expire.
		if (context && !ownerCompleted)
			context.abort(error instanceof Error ? error : new Error(String(error)));
		throw error;
	} finally {
		lease?.stop();
	}
}

/** Deriving the tenant env, building the loader stub and starting the isolate
 * through `ready` run no tenant handler: module scope cannot perform I/O. A
 * failure there (bundle load, module evaluation, loader factory) therefore
 * proves no scheduled write began and must not leave a permit behind. Only
 * the handler RPC itself runs under the permit. Its rejection stays unknown
 * unless the owner already acknowledged completion. */
export async function runScheduledTenantWithPermit<T>(
	db: DbQueryClient,
	storage: R2Bucket,
	identity: CmsRestoreFenceIdentity,
	tenant: {
		ready: () => Promise<unknown>;
		scheduled: (completed: () => Promise<void>) => Promise<T>;
	},
	context: RestoreLeaseContext,
): Promise<{ admitted: false } | { admitted: true; value: T }> {
	await tenant.ready();
	return withScheduledCmsRestorePermit(
		db,
		storage,
		identity,
		tenant.scheduled,
		undefined,
		context,
	);
}

function isCompletion(value: unknown): value is ScheduledPermitCompletion {
	if (typeof value !== "object" || value === null) return false;
	const receipt = value as Record<string, unknown>;
	return (
		receipt.version === 1 &&
		receipt.state === "completed" &&
		receipt.kind === "scheduled" &&
		typeof receipt.siteId === "string" &&
		typeof receipt.slug === "string" &&
		typeof receipt.permitId === "string" &&
		Number.isSafeInteger(receipt.restoreEpoch) &&
		(receipt.restoreEpoch as number) >= 0
	);
}

/** A bounded page of exact owner receipts; unknown and active permits stay in
 * D1 and still block capture. Replaying cleanup after a lost delete response is
 * safe because leave matches the full site, slug, epoch, kind and permit ID. */
export async function reconcileScheduledCmsRestorePermits(
	db: DbQueryClient,
	storage: R2Bucket,
	site: CmsRestoreSiteParams,
): Promise<number> {
	const page = await storage.list({ prefix: prefix(site.siteId), limit: 100 });
	let reclaimed = 0;
	for (const object of page.objects) {
		const stored = await storage.get(object.key);
		if (!stored) continue;
		const receipt: unknown = await stored.json();
		if (
			!isCompletion(receipt) ||
			receipt.siteId !== site.siteId ||
			receipt.slug !== site.slug ||
			key(receipt) !== object.key
		)
			throw new Error("CMS scheduled restore permit completion invalid");
		if (await leaveCmsRestorePermit(db, receipt)) reclaimed++;
		await storage.delete(object.key);
	}
	return reclaimed;
}
