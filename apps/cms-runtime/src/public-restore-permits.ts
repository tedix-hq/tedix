import type { DbQueryClient } from "@tedix/db/query-client";
import {
	enterCmsRestorePermit,
	leaveCmsRestorePermit,
	type CmsRestorePermitParams,
} from "@tedix/db/queries/cms-restore-fences";
/** Share admission only; authentication and response creation still run per request. */
export function publicRestorePermitEligible(request: Request): boolean {
	return request.method === "GET" || request.method === "HEAD";
}

/** A restore close drains until this reservation expires and its borrowers
 * leave (cms-site-restore-workflow drain-site-permits polls for 30 seconds). */
const REUSE_MS = 10_000;
const MAX_RESERVATIONS = 128;

interface Reservation {
	permit: CmsRestorePermitParams;
	expiresAt: number;
	borrowers: number;
	retired: boolean;
}

/** The TTL limits reuse, never the lifetime of an active operation. D1 retains the
 * claim through every borrower; nested claims remain protected from outer reclaim.
 * The durable row is the admission check: a borrow inside the TTL performs no
 * D1 I/O, and a close, pause or deprovision waits for the row to drain. */
export class PublicRestorePermits {
	private reservations = new Map<string, Reservation>();

	constructor(
		private queries = {
			enter: enterCmsRestorePermit,
			leave: leaveCmsRestorePermit,
		},
		private clock = {
			now: () => Date.now(),
			schedule: (task: () => Promise<void>, delayMs: number) =>
				new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(task),
		},
	) {}

	forRequest(waitUntil: (task: Promise<unknown>) => void) {
		let borrowed: Reservation | undefined;
		const release = async (db: DbQueryClient): Promise<boolean> => {
			if (!borrowed) return true;
			const reservation = borrowed;
			borrowed = undefined;
			reservation.borrowers--;
			if (reservation.borrowers !== 0 || !reservation.retired) return true;
			return this.queries.leave(db, reservation.permit);
		};
		return {
			enter: async (db: DbQueryClient, permit: CmsRestorePermitParams) => {
				const key = JSON.stringify([
					permit.siteId,
					permit.slug,
					permit.restoreEpoch,
					permit.kind,
				]);
				const reservation = this.reservations.get(key);
				if (reservation && this.clock.now() < reservation.expiresAt) {
					borrowed = reservation;
					reservation.borrowers++;
					return true;
				}
				// Do not share another request's pending D1 I/O. Concurrent cold
				// requests can each reserve a row, then share the last completed one.
				// A pooled outer claim must not be reclaimed as an abandoned response;
				// the nested kind makes fence closure wait for pool expiry and borrowers.
				const durablePermit =
					permit.kind === "outer"
						? { ...permit, kind: "nested" as const }
						: permit;
				if (!(await this.queries.enter(db, durablePermit))) return false;
				borrowed = {
					permit: durablePermit,
					expiresAt: this.clock.now() + REUSE_MS,
					borrowers: 1,
					retired: false,
				};
				const created = borrowed;
				if (this.reservations.size < MAX_RESERVATIONS || reservation)
					this.reservations.set(key, created);
				else created.retired = true;
				if (!created.retired)
					waitUntil(
						this.clock.schedule(async () => {
							created.retired = true;
							if (this.reservations.get(key) === created)
								this.reservations.delete(key);
							if (
								created.borrowers === 0 &&
								!(await this.queries.leave(db, created.permit))
							)
								throw new Error(
									"CMS public restore reservation release failed",
								);
						}, REUSE_MS),
					);
				return true;
			},
			leave: async (db: DbQueryClient, _permit: CmsRestorePermitParams) =>
				release(db),
		};
	}
}

const pool = new PublicRestorePermits();

export function publicRestorePermitQueries(
	waitUntil: (task: Promise<unknown>) => void,
) {
	return pool.forRequest(waitUntil);
}
