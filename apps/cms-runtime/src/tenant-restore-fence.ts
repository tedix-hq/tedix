import type { DbQueryClient } from "@tedix/db/query-client";
import {
	enterCmsRestorePermit,
	leaveCmsRestorePermit,
	type CmsRestorePermitParams,
} from "@tedix/db/queries/cms-restore-fences";

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

const defaultQueries: CmsRestorePermitQueries = {
	enter: enterCmsRestorePermit,
	leave: leaveCmsRestorePermit,
};

async function enterPermit(
	db: DbQueryClient,
	permit: CmsRestorePermitParams,
	queries: CmsRestorePermitQueries,
): Promise<boolean> {
	try {
		return await queries.enter(db, permit);
	} catch {
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
	queries: CmsRestorePermitQueries = defaultQueries,
	kind: CmsRestorePermitParams["kind"] = "nested",
): Promise<{ admitted: false } | { admitted: true; value: T }> {
	const permit = {
		...identity,
		permitId: crypto.randomUUID(),
		kind,
	};
	if (!(await enterPermit(db, permit, queries))) return { admitted: false };

	try {
		return { admitted: true, value: await run() };
	} finally {
		await leavePermit(db, permit, queries);
	}
}

/** Response creation and each body pull have separate outer permits pinned to
 * one epoch. An abandoned, unread body leaves no permit row; a later pull after
 * a restore close or epoch rotation fails admission. */
export async function withCmsRestoreResponsePermit(
	db: DbQueryClient,
	identity: CmsRestoreFenceIdentity,
	run: () => Promise<Response>,
	queries: CmsRestorePermitQueries = defaultQueries,
): Promise<{ admitted: false } | { admitted: true; value: Response }> {
	const pinnedIdentity = { ...identity };
	const initialPermit: CmsRestorePermitParams = {
		...pinnedIdentity,
		permitId: crypto.randomUUID(),
		kind: "outer",
	};
	if (!(await enterPermit(db, initialPermit, queries)))
		return { admitted: false };

	let response: Response;
	try {
		response = await run();
		if (response.body) {
			const reader = response.body.getReader();
			let pendingPull: Promise<void> | undefined;
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						const pull = (async () => {
							const permit: CmsRestorePermitParams = {
								...pinnedIdentity,
								permitId: crypto.randomUUID(),
								kind: "outer",
							};
							try {
								if (!(await enterPermit(db, permit, queries)))
									throw new CmsRestoreFenceUnavailableError();
								let next: ReadableStreamReadResult<Uint8Array>;
								try {
									next = await reader.read();
								} finally {
									await leavePermit(db, permit, queries);
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
		await leavePermit(db, initialPermit, queries);
	}
	return { admitted: true, value: response };
}

export function cmsRestoreFenceResponse(): Response {
	return new Response("CMS site temporarily unavailable during restore", {
		status: 503,
		headers: { "Cache-Control": "no-store", "Retry-After": "30" },
	});
}
