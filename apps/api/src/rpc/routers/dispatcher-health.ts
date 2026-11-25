import { getRunnerRules } from "@tedix/db/queries/runner-rules";
import { implement } from "@orpc/server";
import { dispatcherHealthContract } from "@tedix/api-contract/contracts/dispatcher-health";
import { SupervisorActivitySchema } from "@tedix/api-contract/schemas/dispatcher-health";
import type { DispatcherHealthReportRow } from "@tedix/db/schema/dispatcher-health";
import {
	getDispatcherHealthSettings,
	listDispatcherHealthReports,
	listDispatcherWorkReferences,
	upsertDispatcherHealthReport,
} from "@tedix/db/queries/work-items/dispatcher-health";
import { requireOrgId } from "../org-scope";
import { machineReporterAccount } from "./machines-principal";
import { type BaseContext, withAuth, withAuthorization } from "../orpc";

const os = implement(dispatcherHealthContract)
	.$context<BaseContext>()
	.use(withAuth);

function toReport(
	row: DispatcherHealthReportRow,
	now: Date,
	staleAfterSeconds: number,
) {
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
		machineName: row.machineName ?? null,
		cliVersion: row.cliVersion,
		topReason:
			row.topReason === null || row.topReasonCount === null
				? null
				: { reason: row.topReason, count: row.topReasonCount },
		ageSeconds,
		staleAfterSeconds,
		stale: ageSeconds > staleAfterSeconds,
	};
}

const reportProcedure = os.report
	.use(withAuthorization("tedis:update", "work:write"))
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const now = new Date();
		// A report that names its machine also records the account that sent it:
		// only that account may later claim the machine's tool calls.
		// A caller whose account cannot be resolved still reports its health.
		const reportedBy = input.machineName
			? await machineReporterAccount(context, orgId).catch(() => null)
			: null;
		const row = await upsertDispatcherHealthReport(context.db, {
			orgId,
			reporterId: input.reporterId,
			executor: input.executor,
			lane: input.lane,
			running: input.running,
			observedAt: input.observedAt,
			reportedAt: now.toISOString(),
			lastAdmissionAt: input.lastAdmissionAt,
			topReason: input.topReason?.reason ?? null,
			topReasonCount: input.topReason?.count ?? null,
			duty: input.duty ?? null,
			machineName: input.machineName ?? null,
			cliVersion: input.cliVersion ?? null,
			machineTools: input.machineTools ?? null,
			reportedBy,
			rulesSkillId: input.rulesSkillId ?? null,
		});
		const settings = await getDispatcherHealthSettings(context.db, orgId);
		return toReport(row, now, settings.reportStaleAfterSeconds);
	});

const rulesProcedure = os.getRunnerRules
	.use(withAuthorization("tedis:read", "work:read"))
	.handler(async ({ context }) => {
		requireOrgId(context);
		return { rules: await getRunnerRules(context.db) };
	});

const listProcedure = os.list
	.use(withAuthorization("tedis:read", "work:read"))
	.handler(async ({ context }) => {
		const now = new Date();
		const rows = await listDispatcherHealthReports(
			context.db,
			requireOrgId(context),
		);
		const { reportStaleAfterSeconds: staleAfterSeconds } =
			await getDispatcherHealthSettings(context.db, requireOrgId(context));
		const reports = rows.map((row) => toReport(row, now, staleAfterSeconds));
		const fresh = reports.filter(
			(row) =>
				!row.stale &&
				now.getTime() - Date.parse(row.observedAt) <= staleAfterSeconds * 1000,
		);
		const ids = fresh.flatMap(({ duty }) => [
			...(duty?.activity?.current.map(({ id }) => id) ?? []),
			...(duty?.activity?.waiting.map(({ id }) => id) ?? []),
			...(duty?.activity?.lastCompleted
				? [duty.activity.lastCompleted.id]
				: []),
			...(duty?.skips?.entries.map(({ workItemId }) => workItemId) ?? []),
		]);
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
			const duty = report.duty;
			if (!duty) continue;
			if (duty.skips) {
				const observedAt = Date.parse(duty.skips.observedAt);
				duty.skips =
					report.running &&
					fresh.includes(report) &&
					observedAt <= now.getTime() &&
					now.getTime() - observedAt <= staleAfterSeconds * 1000
						? {
								...duty.skips,
								entries: duty.skips.entries.filter(
									({ workItemId }) =>
										work.get(workItemId)?.disposition === "accepted",
								),
							}
						: undefined;
			}
			const activity = duty.activity;
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
				...duty,
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
	getRunnerRules: rulesProcedure,
});
