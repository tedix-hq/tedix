import { implement } from "@orpc/server";
import { dispatcherHealthContract } from "@tedix/api-contract/contracts/dispatcher-health";
import type { DispatcherHealthReportRow } from "@tedix/db/schema/dispatcher-health";
import {
	listDispatcherHealthReports,
	upsertDispatcherHealthReport,
} from "@tedix/db/queries/work-items/dispatcher-health";
import { requireOrgId } from "../org-scope";
import { type BaseContext, withAuth, withAuthorization } from "../orpc";

const DISPATCHER_HEALTH_STALE_AFTER_SECONDS = 300;

const os = implement(dispatcherHealthContract)
	.$context<BaseContext>()
	.use(withAuth);

function toReport(row: DispatcherHealthReportRow, now: Date) {
	const ageSeconds = Math.max(
		0,
		Math.floor((now.getTime() - Date.parse(row.reportedAt)) / 1_000),
	);
	return {
		reporterId: row.reporterId,
		executor: row.executor,
		lane: row.lane,
		running: row.running,
		observedAt: row.observedAt,
		reportedAt: row.reportedAt,
		lastAdmissionAt: row.lastAdmissionAt,
		slotsInUse: row.slotsInUse,
		slotsTotal: row.slotsTotal,
		topReason:
			row.topReason === null || row.topReasonCount === null
				? null
				: { reason: row.topReason, count: row.topReasonCount },
		ageSeconds,
		staleAfterSeconds: DISPATCHER_HEALTH_STALE_AFTER_SECONDS,
		stale: ageSeconds > DISPATCHER_HEALTH_STALE_AFTER_SECONDS,
	};
}

const reportProcedure = os.report
	.use(withAuthorization("tedis:update", "work:write"))
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const now = new Date();
		const row = await upsertDispatcherHealthReport(context.db, {
			orgId,
			reporterId: input.reporterId,
			executor: input.executor,
			lane: input.lane,
			running: input.running,
			observedAt: input.observedAt,
			reportedAt: now.toISOString(),
			lastAdmissionAt: input.lastAdmissionAt,
			slotsInUse: input.slotsInUse,
			slotsTotal: input.slotsTotal,
			topReason: input.topReason?.reason ?? null,
			topReasonCount: input.topReason?.count ?? null,
		});
		return toReport(row, now);
	});

const listProcedure = os.list
	.use(withAuthorization("tedis:read", "work:read"))
	.handler(async ({ context }) => {
		const now = new Date();
		const rows = await listDispatcherHealthReports(
			context.db,
			requireOrgId(context),
		);
		return {
			reportedAt: now.toISOString(),
			data: rows.map((row) => toReport(row, now)),
		};
	});

export const dispatcherHealthContractRouter = os.router({
	report: reportProcedure,
	list: listProcedure,
});
