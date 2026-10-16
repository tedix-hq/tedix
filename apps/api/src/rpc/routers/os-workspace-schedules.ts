import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	isWorkspaceSkillResource,
	type OsWorkspaceSchedule,
} from "@tedix/api-contract/schemas/os-workspace-schedules";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import { getLatestReportedSkillRun } from "@tedix/db/queries/skill-runs";
import { getSkillSchedule } from "@tedix/db/queries/skill-schedules";
import { createDbQueryClient } from "@tedix/db/query-client";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	readRunsAt,
	reportedLastRun,
	SKIPPED_RUN_RESULT_STATUSES,
	schedulePurpose,
	scheduleRunTimes,
} from "../../services/workspace-schedules";
import { requireWorkspace } from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const readOs = os
	.use(withAuth)
	.use(osAudit(OS_WORKSPACES_AUDIT))
	.use(AUTHZ.osRead);

/** A Workspace links at most this many scheduled skills in its Resources. */
const MAX_SCHEDULES = 20;

function parseMetadata(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

const list = readOs.schedules.list.handler(async ({ input, context }) => {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const organizationId = workspace.organizationId;
	const resources = (
		await listOsWorkspaceResources(createDbQueryClient(context.env.DB), {
			organizationId,
			workspaceId: workspace.id,
			status: "active",
			limit: 200,
		})
	)
		.filter(isWorkspaceSkillResource)
		.slice(0, MAX_SCHEDULES);
	const now = new Date();
	const items = await Promise.all(
		resources.map(async (resource): Promise<OsWorkspaceSchedule | null> => {
			const skillId = resource.providerResourceId;
			const [skill, schedule, run] = await Promise.all([
				getSkillEntry(context.db, skillId, organizationId),
				getSkillSchedule(context.db, skillId),
				getLatestReportedSkillRun(context.db, {
					organizationId,
					skillId,
					runtimeEnvironment: context.env.ENVIRONMENT,
					skippedResultStatuses: SKIPPED_RUN_RESULT_STATUSES,
				}),
			]);
			if (!skill) return null;
			const metadata = parseMetadata(resource.metadata);
			const active =
				schedule?.organizationId === organizationId && schedule.enabled
					? schedule
					: null;
			const times = active
				? scheduleRunTimes(active.cron, readRunsAt(metadata), now)
				: { dailyTimes: [], nextRunAt: null };
			return {
				resourceId: resource.id,
				skillId,
				name: resource.name,
				purpose: schedulePurpose(metadata, skill),
				enabled: active !== null,
				cron: active?.cron ?? null,
				...times,
				lastRun: reportedLastRun(run),
			};
		}),
	);
	return {
		items: items.filter((item): item is OsWorkspaceSchedule => item !== null),
	};
});

export const osWorkspaceScheduleProcedures = { list };
