import type { DbQueryClient } from "@tedix/db/query-client";
import {
	canReuseCmsRestorePermit,
	enterCmsRestorePermit,
	leaveCmsRestorePermit,
	type CmsRestorePermitParams,
} from "@tedix/db/queries/cms-restore-fences";
import { EDGE_CACHE_EXCLUDED_PREFIXES } from "./edge-cache-headers";
import { publicAssetCacheEligible } from "./tenant-public-cache";

export function publicRestorePermitEligible(request: Request): boolean {
	const pathname = new URL(request.url).pathname;
	return (
		publicAssetCacheEligible(request) &&
		!EDGE_CACHE_EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
	);
}

const REUSE_MS = 10_000;
const MAX_RESERVATIONS = 128;

interface Reservation {
	permit: CmsRestorePermitParams;
	expiresAt: number;
	borrowers: number;
	retired: boolean;
}

/** The TTL limits reuse, never the lifetime of an active render. D1 retains
 * the reservation through every borrower; isolate loss uses outer reconciliation. */
export class PublicRestorePermits {
	private reservations = new Map<string, Reservation>();

	constructor(
		private queries = {
			enter: enterCmsRestorePermit,
			leave: leaveCmsRestorePermit,
			reuse: canReuseCmsRestorePermit,
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
				]);
				const reservation = this.reservations.get(key);
				if (reservation && Date.now() < reservation.expiresAt) {
					borrowed = reservation;
					reservation.borrowers++;
					try {
						if (await this.queries.reuse(db, reservation.permit)) return true;
					} catch (error) {
						await release(db);
						throw error;
					}
					await release(db);
					return false;
				}
				// Do not share another request's pending D1 I/O. Concurrent cold
				// requests can each reserve a row, then share the last completed one.
				if (!(await this.queries.enter(db, permit))) return false;
				borrowed = {
					permit,
					expiresAt: Date.now() + REUSE_MS,
					borrowers: 1,
					retired: false,
				};
				const created = borrowed;
				if (this.reservations.size < MAX_RESERVATIONS || reservation)
					this.reservations.set(key, created);
				else created.retired = true;
				if (!created.retired)
					waitUntil(
						new Promise<void>((resolve) => setTimeout(resolve, REUSE_MS)).then(
							async () => {
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
							},
						),
					);
				return true;
			},
			leave: async (db: DbQueryClient, _permit: CmsRestorePermitParams) =>
				release(db),
		};
	}
}

const pools = new WeakMap<D1Database, PublicRestorePermits>();

export function publicRestorePermitQueries(
	database: D1Database,
	waitUntil: (task: Promise<unknown>) => void,
) {
	let pool = pools.get(database);
	if (!pool) {
		pool = new PublicRestorePermits();
		pools.set(database, pool);
	}
	return pool.forRequest(waitUntil);
}
