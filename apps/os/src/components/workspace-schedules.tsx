import { Clock } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { OsWorkspaceSchedule } from "@tedix/api-contract/schemas/os-workspace-schedules";
import { Link } from "@/components/kumo/link";
import { ListSkeleton } from "@/components/list-skeleton";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { Text } from "@/components/kumo/text";
import { workspaceSchedulesQueryOptions } from "@/lib/os-query-options";
import {
	lastRunLine,
	nextRunLine,
	scheduleWhen,
} from "@/lib/workspace-schedules";

/**
 * "Runs on a schedule" in a workspace's Resources: the skills that run for
 * this workspace by themselves, when they run, how the last run went and when
 * the next one is. Hidden when the workspace has none.
 */
export function WorkspaceSchedules({ workspaceId }: { workspaceId: string }) {
	const query = useQuery(workspaceSchedulesQueryOptions(workspaceId));
	const items = query.data?.items ?? [];
	if (query.isError || (query.data && items.length === 0)) return null;
	return (
		<section
			aria-label="Runs on a schedule"
			className="canvas-resource-section canvas-resource-schedules"
		>
			<SectionEyebrow
				title="Runs on a schedule"
				count={query.data ? items.length : undefined}
				variant="console"
			/>
			{query.isPending && <ListSkeleton rows={1} rowClassName="h-20" />}
			{items.length > 0 && (
				<ul className="m-0 grid list-none gap-3 p-0">
					{items.map((schedule) => (
						<li key={schedule.resourceId} className="min-w-0">
							<WorkspaceScheduleRow schedule={schedule} />
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function WorkspaceScheduleRow({ schedule }: { schedule: OsWorkspaceSchedule }) {
	const next = schedule.enabled ? nextRunLine(schedule.nextRunAt) : null;
	const titleId = `workspace-schedule-${schedule.resourceId}`;
	return (
		<article
			aria-labelledby={titleId}
			className="flex min-w-0 items-start gap-3 rounded-xl border border-kumo-line p-4"
			data-workspace-schedule={schedule.skillId}
		>
			<Clock
				aria-hidden
				size={20}
				className="mt-0.5 shrink-0 text-kumo-subtle"
			/>
			<div className="grid min-w-0 flex-1 gap-1">
				<Text
					as="h3"
					id={titleId}
					role="section"
					tone="strong"
					weight="semibold"
					className="m-0 truncate"
				>
					{schedule.name}
				</Text>
				{schedule.purpose && (
					<Text as="p" role="body" tone="secondary" className="m-0">
						{schedule.purpose}
					</Text>
				)}
				<Text as="p" role="body" className="m-0" data-schedule-when>
					{scheduleWhen(schedule)}
				</Text>
				<Text
					as="p"
					role="label"
					tone={schedule.lastRun?.status === "failed" ? "error" : "secondary"}
					className="m-0"
					data-schedule-last-run
				>
					{lastRunLine(schedule.lastRun)}
				</Text>
				{next && (
					<Text
						as="p"
						role="label"
						tone="secondary"
						className="m-0"
						data-schedule-next-run
					>
						{next}
					</Text>
				)}
			</div>
			<Link
				className="shrink-0 type-tedix-control"
				href={`/skills/${encodeURIComponent(schedule.skillId)}/runs`}
			>
				See runs
			</Link>
		</article>
	);
}
