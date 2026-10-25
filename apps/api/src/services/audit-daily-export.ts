/**
 * Daily audit export to each organization's storage (decision 5c5512a5).
 *
 * Audit events stay 90 days in D1. Before they age out, the nightly
 * retention-cleanup tick writes every organization's events of each finished
 * UTC day to R2 as gzip JSON Lines, one object per hour so no day has to fit
 * in Worker memory:
 *
 *   audit-exports/v1/<organizationId>/<YYYY-MM-DD>/<HH>.jsonl.gz
 *
 * Each line is the event exactly as `GET /audit/export?format=jsonl` returns
 * it. Objects are kept 13 months, then deleted by the same tick.
 *
 * Every step is idempotent: an hour whose object exists is skipped, so a tick
 * that ran out of time resumes the next night, and the last
 * `AUDIT_DAILY_EXPORT_BACKFILL_DAYS` days are retried each run.
 */

import { searchAuditEvents } from "@tedix/db/queries/audit";
import { listOrganizations } from "@tedix/db/queries/organizations";
import type { DbClient } from "@tedix/db/client";
import { toAuditEventOutput } from "../lib/audit-event-output";

export const AUDIT_DAILY_EXPORT_PREFIX = "audit-exports/v1/";
/** Finished days retried each run, so a missed night is filled in. */
export const AUDIT_DAILY_EXPORT_BACKFILL_DAYS = 7;
export const AUDIT_DAILY_EXPORT_KEEP_MONTHS = 13;
/** Rows per search page within one hour. */
export const AUDIT_DAILY_EXPORT_PAGE_ROWS = 1000;
/** Organizations read per listing page. */
const ORGANIZATION_PAGE = 50;
/** Expired objects deleted per organization per run. */
const SWEEP_LIMIT = 1000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface AuditDailyExportResult {
	organizations: number;
	objectsWritten: number;
	eventsWritten: number;
	objectsDeleted: number;
	stoppedBy: "done" | "time_budget";
	errors: number;
}

function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function auditDailyExportKey(
	organizationId: string,
	hourStartMs: number,
): string {
	const iso = new Date(hourStartMs).toISOString();
	return `${AUDIT_DAILY_EXPORT_PREFIX}${organizationId}/${iso.slice(0, 10)}/${iso.slice(11, 13)}.jsonl.gz`;
}

/** The first day (YYYY-MM-DD) still kept: anything before it is deleted. */
export function auditDailyExportKeepFrom(now: Date): string {
	return new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth() - AUDIT_DAILY_EXPORT_KEEP_MONTHS,
			now.getUTCDate(),
		),
	)
		.toISOString()
		.slice(0, 10);
}

async function gzipLines(lines: string[]): Promise<Uint8Array> {
	const stream = new Blob(lines)
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** All events of one organization-hour, newest first, as JSON Lines. */
async function readHour(
	db: DbClient,
	organizationId: string,
	hourStartMs: number,
): Promise<string[]> {
	const startDate = new Date(hourStartMs).toISOString();
	// The search bound is inclusive and timestamps are whole seconds.
	const endDate = new Date(hourStartMs + HOUR_MS - 1000).toISOString();
	const lines: string[] = [];
	const seen = new Set<string>();
	for (let offset = 0; ;) {
		const { data } = await searchAuditEvents(db, {
			organizationId,
			startDate,
			endDate,
			limit: AUDIT_DAILY_EXPORT_PAGE_ROWS,
			offset,
		});
		for (const row of data) {
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			lines.push(`${JSON.stringify(toAuditEventOutput(row))}\n`);
		}
		offset += data.length;
		if (data.length < AUDIT_DAILY_EXPORT_PAGE_ROWS) return lines;
	}
}

/** Whether the organization has any event in the day window at all. */
async function hasEvents(
	db: DbClient,
	organizationId: string,
	dayStartMs: number,
): Promise<boolean> {
	const { data } = await searchAuditEvents(db, {
		organizationId,
		startDate: new Date(dayStartMs).toISOString(),
		endDate: new Date(dayStartMs + DAY_MS - 1000).toISOString(),
		limit: 1,
	});
	return data.length > 0;
}

async function exportOrganizationDay(params: {
	db: DbClient;
	bucket: R2Bucket;
	organizationId: string;
	dayStartMs: number;
	result: AuditDailyExportResult;
	outOfTime: () => boolean;
}): Promise<void> {
	const { db, bucket, organizationId, dayStartMs, result } = params;
	if (!(await hasEvents(db, organizationId, dayStartMs))) return;
	for (let hour = 0; hour < 24; hour += 1) {
		if (params.outOfTime()) return;
		const hourStartMs = dayStartMs + hour * HOUR_MS;
		const key = auditDailyExportKey(organizationId, hourStartMs);
		if (await bucket.head(key)) continue;
		const lines = await readHour(db, organizationId, hourStartMs);
		if (lines.length === 0) continue;
		const body = await gzipLines(lines);
		const stored = await bucket.put(key, body, {
			httpMetadata: {
				contentType: "application/x-ndjson",
				contentEncoding: "gzip",
			},
			customMetadata: {
				organizationId,
				events: String(lines.length),
				exportedAt: new Date().toISOString(),
			},
		});
		if (!stored || stored.size !== body.byteLength)
			throw new Error(`audit export object not confirmed: ${key}`);
		result.objectsWritten += 1;
		result.eventsWritten += lines.length;
	}
}

/** Delete this organization's export objects older than the keep window. */
async function sweepOrganization(
	bucket: R2Bucket,
	organizationId: string,
	keepFrom: string,
): Promise<number> {
	const prefix = `${AUDIT_DAILY_EXPORT_PREFIX}${organizationId}/`;
	const expired: string[] = [];
	let cursor: string | undefined;
	// Keys sort by day, so the listing stops at the first kept day.
	listing: do {
		const page = await bucket.list({ prefix, cursor, limit: 500 });
		for (const object of page.objects) {
			if (object.key.slice(prefix.length, prefix.length + 10) >= keepFrom)
				break listing;
			expired.push(object.key);
			if (expired.length >= SWEEP_LIMIT) break listing;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	for (let index = 0; index < expired.length; index += 1000) {
		await bucket.delete(expired.slice(index, index + 1000));
	}
	return expired.length;
}

/**
 * Export every organization's finished days not yet exported (newest last
 * `AUDIT_DAILY_EXPORT_BACKFILL_DAYS`), then delete objects past 13 months.
 * Stops cleanly at `budgetMs`; the next run resumes from what exists.
 */
export async function runAuditDailyExport(params: {
	db: DbClient;
	bucket: R2Bucket;
	now: Date;
	budgetMs: number;
	clock?: () => number;
}): Promise<AuditDailyExportResult> {
	const clock = params.clock ?? Date.now;
	const deadline = clock() + params.budgetMs;
	const outOfTime = () => clock() >= deadline;
	const todayStartMs = Date.parse(`${utcDay(params.now.getTime())}T00:00:00Z`);
	const keepFrom = auditDailyExportKeepFrom(params.now);
	const result: AuditDailyExportResult = {
		organizations: 0,
		objectsWritten: 0,
		eventsWritten: 0,
		objectsDeleted: 0,
		stoppedBy: "done",
		errors: 0,
	};
	for (let offset = 0; ; offset += ORGANIZATION_PAGE) {
		const organizations = await listOrganizations(params.db, {
			limit: ORGANIZATION_PAGE,
			offset,
		});
		for (const organization of organizations) {
			if (outOfTime()) {
				result.stoppedBy = "time_budget";
				return result;
			}
			result.organizations += 1;
			try {
				// Oldest first, so a day nearing the 90-day D1 floor is never last.
				for (let back = AUDIT_DAILY_EXPORT_BACKFILL_DAYS; back >= 1; back -= 1)
					await exportOrganizationDay({
						db: params.db,
						bucket: params.bucket,
						organizationId: organization.id,
						dayStartMs: todayStartMs - back * DAY_MS,
						result,
						outOfTime,
					});
				result.objectsDeleted += await sweepOrganization(
					params.bucket,
					organization.id,
					keepFrom,
				);
			} catch (error) {
				result.errors += 1;
				console.warn(
					JSON.stringify({
						event: "audit.daily_export.organization_failed",
						organizationId: organization.id,
						error: error instanceof Error ? error.name : "unknown",
					}),
				);
			}
		}
		if (organizations.length < ORGANIZATION_PAGE) break;
	}
	if (outOfTime()) result.stoppedBy = "time_budget";
	return result;
}
