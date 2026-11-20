/**
 * Moves organizations' gateway change ledgers into their log stores, one
 * organization at a time, on the two-minute tick after the sealer
 * (`docs/engineering/organization-log-store.md`, "Cutover").
 *
 * Every organization moves once the workspace runtime has the store. For
 * the first organization (fewest checkpoints first) whose store is not live
 * yet:
 * - `passthrough`: copy whole sealed checkpoints that already have an
 *   evidence bundle, in sequence order, while writes still go to main. When
 *   every checkpoint is copied, begin the cutover.
 * - `cutover`: the store now holds new appends. Keep copying what main seals
 *   (late writes are sealed into main's chain and copied like any other
 *   checkpoint). Finish once the cutover is at least two ticks old and main
 *   has, checked twice, no unsealed row, no uncopied checkpoint and no
 *   checkpoint without a bundle for the organization.
 *
 * Nothing is deleted from main here. Rows leave main in a later step, after
 * the archive check.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { OrganizationLogRuntime } from "@tedix/db/queries/durable-sqlite/organization-log-rpc";
import {
	countUnsealedGatewayChangeRecords,
	hasGatewayChangeRecordsAfter,
	listGatewayChangeRecordCheckpoints,
	listGatewayChangeRecordsForCheckpoint,
	listOrganizationsWithGatewayChangeRecordCheckpoints,
} from "@tedix/db/queries/gateway-change-records";
import type { DbQueryClient } from "@tedix/db/query-client";
import { withOverloadBackoff } from "../services/d1-retention-archive";
import {
	callOrganizationLog,
	organizationLogRuntime,
} from "../services/organization-log";

/**
 * Records copied per import call: one page, read from main with one indexed
 * range query. Same page size as the retention move engine.
 */
export const RECORDS_PER_IMPORT = 500;
/** Records copied per run, at most; the rest waits for the next tick. */
export const MAX_RECORDS_PER_RUN = 5_000;
/** Pause after each copied page, so live reads of main keep working. */
export const PAGE_PAUSE_MS = 1_000;
/** Time a run may spend copying. */
export const COPY_BUDGET_MS = 30_000;
/** A cutover finishes no earlier than this after it began. */
export const MIN_CUTOVER_MS = 2 * 60_000;
/** A cutover or a held append older than this is reported as an error. */
export const SLOW_CUTOVER_MS = 15 * 60_000;

export interface CutoverResult extends Record<string, number> {
	recordsCopied: number;
	checkpointsCopied: number;
	cutoversBegun: number;
	cutoversFinished: number;
	organizationsLive: number;
	orphansInMain: number;
}

/** Copy pages after the store's tail until caught up or out of time. */
async function copy(
	db: DbQueryClient,
	log: OrganizationLogRuntime,
	organizationId: string,
	after: number,
	deadline: number,
	result: CutoverResult,
	pagePauseMs: number,
): Promise<{ caughtUp: boolean; tail: number }> {
	let tail = after;
	while (Date.now() < deadline && result.recordsCopied < MAX_RECORDS_PER_RUN) {
		const next = await withOverloadBackoff(
			() =>
				listGatewayChangeRecordCheckpoints(db, organizationId, {
					afterLastSequence: tail,
					limit: 50,
				}),
			deadline,
		);
		const ready: typeof next = [];
		let records = 0;
		for (const checkpoint of next) {
			if (!checkpoint.evidenceBundleKey) break;
			if (
				ready.length > 0 &&
				records + checkpoint.recordCount > RECORDS_PER_IMPORT
			)
				break;
			ready.push(checkpoint);
			records += checkpoint.recordCount;
		}
		if (ready.length === 0) return { caughtUp: next.length === 0, tail };
		const rows = await withOverloadBackoff(
			() =>
				listGatewayChangeRecordsForCheckpoint(db, {
					organizationId,
					firstSequence: ready[0]!.firstSequence,
					lastSequence: ready.at(-1)!.lastSequence,
					recordCount: records,
				}),
			deadline,
		);
		const copied = await log.organizationLogImport(organizationId, {
			records: rows,
			checkpoints: ready,
		});
		tail = copied.sequence;
		result.recordsCopied += rows.length;
		result.checkpointsCopied += ready.length;
		if (pagePauseMs > 0)
			await new Promise((resolve) => setTimeout(resolve, pagePauseMs));
	}
	return { caughtUp: false, tail };
}

/** Main holds nothing for the organization beyond what the store copied. */
async function mainIsSettled(
	db: DbQueryClient,
	organizationId: string,
	tail: number,
): Promise<boolean> {
	const [unsealed, later] = await Promise.all([
		countUnsealedGatewayChangeRecords(db, organizationId),
		listGatewayChangeRecordCheckpoints(db, organizationId, {
			afterLastSequence: tail,
			limit: 1,
		}),
	]);
	return unsealed === 0 && later.length === 0;
}

export async function runOrganizationLogCutover(
	db: DbQueryClient,
	log: OrganizationLogRuntime,
	now: number,
	pagePauseMs = PAGE_PAUSE_MS,
): Promise<CutoverResult> {
	const result: CutoverResult = {
		recordsCopied: 0,
		checkpointsCopied: 0,
		cutoversBegun: 0,
		cutoversFinished: 0,
		organizationsLive: 0,
		orphansInMain: 0,
	};
	const deadline = Date.now() + COPY_BUDGET_MS;
	for (const {
		organizationId,
	} of await listOrganizationsWithGatewayChangeRecordCheckpoints(db)) {
		const status = await log.organizationLogStatus(organizationId);
		if (!status.available) return result;
		if (status.state === "live") {
			result.organizationsLive++;
			// A write that reached main after the move would be outside the
			// store's chain. It must never happen; report it if it does.
			if (
				status.mainTailSequence !== null &&
				(await hasGatewayChangeRecordsAfter(
					db,
					organizationId,
					status.mainTailSequence,
				))
			) {
				result.orphansInMain++;
				console.error(
					JSON.stringify({
						event: "organization_log.orphan_in_main",
						organizationId,
						mainTailSequence: status.mainTailSequence,
					}),
				);
			}
			continue;
		}
		try {
			const copied = await copy(
				db,
				log,
				organizationId,
				status.tail?.sequence ?? 0,
				deadline,
				result,
				pagePauseMs,
			);
			if (status.state === "passthrough") {
				if (copied.caughtUp) {
					await log.organizationLogBeginCutover(organizationId);
					result.cutoversBegun++;
				}
				break;
			}
			const startedAt = Date.parse(status.cutoverStartedAt ?? "");
			const age = now - startedAt;
			const oldestHeld = status.oldestPendingAt
				? now - Date.parse(status.oldestPendingAt)
				: 0;
			if (age > SLOW_CUTOVER_MS || oldestHeld > SLOW_CUTOVER_MS)
				console.error(
					JSON.stringify({
						event: "organization_log.cutover_slow",
						organizationId,
						cutoverAgeSeconds: Math.round(age / 1000),
						pending: status.pending,
						oldestPendingAgeSeconds: Math.round(oldestHeld / 1000),
					}),
				);
			if (
				copied.caughtUp &&
				age >= MIN_CUTOVER_MS &&
				(await mainIsSettled(db, organizationId, copied.tail)) &&
				(await mainIsSettled(db, organizationId, copied.tail))
			) {
				const [head] = await listGatewayChangeRecordCheckpoints(
					db,
					organizationId,
					{ fromSequence: copied.tail, untilSequence: copied.tail, limit: 1 },
				);
				const finished = await log.organizationLogFinishCutover(
					organizationId,
					{
						sequence: copied.tail,
						chainHash: head?.headChainHash ?? null,
					},
				);
				result.cutoversFinished++;
				console.log(
					JSON.stringify({
						event: "organization_log.live",
						organizationId,
						...finished,
					}),
				);
			}
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "organization_log.cutover_failed",
					organizationId,
					exception: safeExceptionTopology(error),
				}),
			);
		}
		// One organization at a time.
		break;
	}
	return result;
}

/** The cron path. Does nothing until the workspace runtime has the store. */
export async function runOrganizationLogCutoverCron(
	env: Pick<CloudflareEnv, "DB">,
	scheduledTime: number,
): Promise<Record<string, number>> {
	const log = organizationLogRuntime(env);
	const available = await callOrganizationLog(
		(runtime) => runtime.organizationLogAvailable(),
		env,
	);
	if (!log || !available) return {};
	const { createDbQueryClient } = await import("@tedix/db/query-client");
	const result = await runOrganizationLogCutover(
		createDbQueryClient(env.DB),
		log,
		scheduledTime,
	);
	console.log(
		JSON.stringify({ event: "organization_log.cutover.run", ...result }),
	);
	return result;
}
