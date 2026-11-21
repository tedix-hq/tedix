import type { DbQueryClient } from "@tedix/db/query-client";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import {
	enterCmsRestorePermit,
	leaveCmsRestorePermit,
	cmsRestoreLeasePermit,
	renewCmsRestorePermitLease,
	type CmsRestorePermitParams,
} from "@tedix/db/queries/cms-restore-fences";
import type { EmDashDBStub } from "./emdash-db";
import { runtimePermitId } from "./runtime-permit-owner";
import {
	startRestorePermitLease,
	type RestoreLeaseContext,
} from "./restore-permit-lease";

export class CmsRestoreFenceUnavailableError extends Error {
	constructor() {
		super("CMS restore fence unavailable");
		this.name = "CmsRestoreFenceUnavailableError";
	}
}

export interface CmsRestoreFenceIdentity {
	siteId: string;
	slug: string;
	restoreEpoch: number;
}

interface CmsRestorePermitQueries {
	enter: typeof enterCmsRestorePermit;
	leave: typeof leaveCmsRestorePermit;
}

/** Exact holders must stop executing before the durable lease can be swept. */
export function leasedCmsRestorePermitQueries(
	context: RestoreLeaseContext,
): CmsRestorePermitQueries {
	const leases = new Map<string, ReturnType<typeof startRestorePermitLease>>();
	return {
		async enter(db, input) {
			const permit = cmsRestoreLeasePermit(input);
			const startedAt = Date.now();
			if (!(await enterCmsRestorePermit(db, permit))) return false;
			const lease = startRestorePermitLease(
				context,
				() => renewCmsRestorePermitLease(db, permit),
				startedAt,
			);
			leases.set(input.permitId, lease);
			lease.assertActive();
			return true;
		},
		async leave(db, input) {
			const lease = leases.get(input.permitId);
			leases.delete(input.permitId);
			lease?.stop();
			const removed = await leaveCmsRestorePermit(
				db,
				cmsRestoreLeasePermit(input),
			);
			lease?.assertActive();
			return removed;
		},
	};
}

async function enterPermit(
	db: DbQueryClient,
	permit: CmsRestorePermitParams,
	queries: CmsRestorePermitQueries,
): Promise<boolean> {
	try {
		return await queries.enter(db, permit);
	} catch {
		// No tenant work began, even if D1 committed before losing its response.
		await queries.leave(db, permit).catch(() => false);
		throw new CmsRestoreFenceUnavailableError();
	}
}

async function leavePermit(
	db: DbQueryClient,
	permit: CmsRestorePermitParams,
	queries: CmsRestorePermitQueries,
): Promise<void> {
	try {
		if (await queries.leave(db, permit)) return;
	} catch {
		// A failed or missing ledger release cannot be treated as success.
	}
	throw new CmsRestoreFenceUnavailableError();
}

/** A nested permit covers the entire tenant operation, including retries. */
export async function withCmsRestorePermit<T>(
	db: DbQueryClient,
	identity: CmsRestoreFenceIdentity,
	run: () => Promise<T>,
	queries: CmsRestorePermitQueries,
	kind: CmsRestorePermitParams["kind"] = "nested",
): Promise<{ admitted: false } | { admitted: true; value: T }> {
	const permit = {
		...identity,
		permitId: runtimePermitId(),
		kind,
	};
	if (!(await enterPermit(db, permit, queries))) return { admitted: false };

	try {
		return { admitted: true, value: await run() };
	} finally {
		await leavePermit(db, permit, queries);
	}
}

/** Storage, session and egress operations borrow the shared nested reservation
 * held by the site's database object instead of writing their own D1 row. The
 * object keeps the row until the reservation expires and every callback
 * settles, so a restore, pause or deprovision drains it exactly as it drains
 * an exact permit. Any coordinator failure is a closed fence. */
export async function withSharedCmsRestorePermit<T>(
	env: { DB_DO: DurableObjectNamespace },
	identity: CmsRestoreFenceIdentity,
	run: () => Promise<T>,
): Promise<T> {
	const coordinator = durableObjectStubByName(
		env.DB_DO,
		env,
		identity.slug,
	) as unknown as Pick<EmDashDBStub, "runWithRestorePermit">;
	let outcome: { value: T } | { error: unknown } | undefined;
	try {
		await coordinator.runWithRestorePermit(
			{
				siteId: identity.siteId,
				slug: identity.slug,
				restoreEpoch: identity.restoreEpoch,
			},
			async () => {
				try {
					outcome = { value: await run() };
				} catch (error) {
					outcome = { error };
				}
			},
		);
	} catch {
		throw new CmsRestoreFenceUnavailableError();
	}
	if (!outcome) throw new CmsRestoreFenceUnavailableError();
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}

/** Response creation and each body pull use outer permits pinned to one epoch.
 * Public reads may borrow a short-lived reservation; unread bodies never retain
 * a borrower. Every later pull still checks admission in the pinned epoch. */
export async function withCmsRestoreResponsePermit(
	db: DbQueryClient,
	identity: CmsRestoreFenceIdentity,
	run: () => Promise<Response>,
	queries: CmsRestorePermitQueries,
	initialQueries: CmsRestorePermitQueries = queries,
	createPullQueries?: () => CmsRestorePermitQueries,
): Promise<{ admitted: false } | { admitted: true; value: Response }> {
	const pinnedIdentity = { ...identity };
	const initialPermit: CmsRestorePermitParams = {
		...pinnedIdentity,
		permitId: runtimePermitId(),
		kind: "outer",
	};
	if (!(await enterPermit(db, initialPermit, initialQueries)))
		return { admitted: false };

	let response: Response;
	try {
		response = await run();
		if (response.body && isBufferableResponse(response)) {
			// A finite body usually arrives in many small chunks. Admitting each
			// chunk separately costs one ledger round trip per chunk (about
			// 90 ms), which made a 190 KB page take six seconds and a 1.4 MB
			// image more than a minute. Reading the whole body under the initial
			// permit is stricter, not looser: a restore close cannot interleave
			// with the read.
			const bytes = await response.arrayBuffer();
			response = new Response(bytes, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} else if (response.body) {
			const reader = response.body.getReader();
			let pendingPull: Promise<void> | undefined;
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						const pull = (async () => {
							const permit: CmsRestorePermitParams = {
								...pinnedIdentity,
								permitId: runtimePermitId(),
								kind: "outer",
							};
							const pullQueries = createPullQueries?.() ?? queries;
							try {
								if (!(await enterPermit(db, permit, pullQueries)))
									throw new CmsRestoreFenceUnavailableError();
								let next: ReadableStreamReadResult<Uint8Array>;
								try {
									next = await reader.read();
								} finally {
									await leavePermit(db, permit, pullQueries);
								}
								if (cancelled) return;
								if (next.done) controller.close();
								else controller.enqueue(next.value);
							} catch (error) {
								controller.error(error);
								try {
									await reader.cancel(error);
								} catch {
									// Keep the fence error as the public stream failure.
								}
							}
						})();
						pendingPull = pull;
						void pull.then(
							() => {
								if (pendingPull === pull) pendingPull = undefined;
							},
							() => {
								if (pendingPull === pull) pendingPull = undefined;
							},
						);
						return pull;
					},
					async cancel(reason) {
						cancelled = true;
						try {
							await reader.cancel(reason);
						} finally {
							await pendingPull;
						}
					},
				},
				{ highWaterMark: 0 },
			);
			response = new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}
	} finally {
		await leavePermit(db, initialPermit, initialQueries);
	}
	return { admitted: true, value: response };
}

/** Largest known-length body read under the initial permit. */
const BUFFERED_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;

/** Rendered HTML, and any other body with a known length under the limit
 * (stylesheets, scripts, images). Event streams and unbounded or very large
 * bodies keep per-pull admission. */
function isBufferableResponse(response: Response): boolean {
	const type = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (type.startsWith("text/html")) return true;
	if (type.startsWith("text/event-stream")) return false;
	const length = Number(response.headers.get("content-length"));
	return (
		Number.isInteger(length) &&
		length > 0 &&
		length <= BUFFERED_RESPONSE_LIMIT_BYTES
	);
}

/** Why a public request got 503: a closed restore fence, or a passing failure. */
const UNAVAILABLE_REASON_HEADER = "X-Tedix-Cms-Unavailable";

/** The site is closed by a restore, pause or deprovision. */
export function cmsRestoreFenceResponse(): Response {
	return new Response("CMS site temporarily unavailable during restore", {
		status: 503,
		headers: {
			"Cache-Control": "no-store",
			"Retry-After": "30",
			[UNAVAILABLE_REASON_HEADER]: "restore",
		},
	});
}

/** A lookup or permit check failed for a moment; no restore is closing the site. */
export function cmsTemporarilyUnavailableResponse(): Response {
	return new Response(
		"This page is briefly unavailable. Please reload in a few seconds.",
		{
			status: 503,
			headers: {
				"Cache-Control": "no-store",
				"Retry-After": "5",
				[UNAVAILABLE_REASON_HEADER]: "transient",
			},
		},
	);
}
