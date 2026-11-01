import { implement } from "@orpc/server";
import { dispatcherHealthContract } from "@tedix/api-contract/contracts/dispatcher-health";
import { SupervisorActivitySchema } from "@tedix/api-contract/schemas/dispatcher-health";
import type { DispatcherHealthReportRow } from "@tedix/db/schema/dispatcher-health";
import {
	listDispatcherHealthReports,
	listDispatcherWorkReferences,
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
		duty: row.duty ?? null,
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
			duty: input.duty ?? null,
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
		const reports = rows.map((row) => toReport(row, now));
		const activities = reports
			.filter(
				(row) =>
					!row.stale &&
					now.getTime() - Date.parse(row.observedAt) <=
						DISPATCHER_HEALTH_STALE_AFTER_SECONDS * 1000,
			)
			.map((row) => row.duty?.activity)
			.filter((value) => value !== undefined);
		const ids = activities.flatMap((activity) =>
			[
				...activity.current,
				...activity.waiting,
				...(activity.lastCompleted ? [activity.lastCompleted] : []),
			].map((work) => work.id),
		);
		const work = new Map(
			(
				await listDispatcherWorkReferences(
					context.db,
					requireOrgId(context),
					ids,
				)
			).map((row) => [row.id, row]),
		);
		for (const report of reports) {
			const activity = report.duty?.activity;
			if (!activity) continue;
			const current = activity.current.flatMap((ref) => {
				const row = work.get(ref.id);
				return row?.disposition === "accepted"
					? [{ ...ref, title: row.title.slice(0, 200) || undefined }]
					: [];
			});
			const waiting = activity.waiting.flatMap((ref) => {
				const row = work.get(ref.id);
				return row?.disposition === "accepted"
					? [{ ...ref, title: row.title.slice(0, 200) || undefined }]
					: [];
			});
			const completed =
				activity.lastCompleted && work.get(activity.lastCompleted.id);
			const last = SupervisorActivitySchema.shape.lastCompleted.safeParse(
				completed?.disposition === "completed"
					? {
							id: completed.id,
							title: completed.title.slice(0, 200) || undefined,
							completedAt: completed.completedAt,
						}
					: null,
			);
			report.duty = {
				...report.duty!,
				activity: {
					...activity,
					current,
					waiting,
					lastCompleted: last.success ? last.data : null,
				},
			};
		}
		return {
			reportedAt: now.toISOString(),
			data: reports,
		};
	});

export const dispatcherHealthContractRouter = os.router({
	report: reportProcedure,
	list: listProcedure,
});
