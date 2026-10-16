import { Clock } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	OsWorkspaceSchedule,
	OsWorkspaceSchedulePersonalRead,
} from "@tedix/api-contract/schemas/os-workspace-schedules";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { ListSkeleton } from "@/components/list-skeleton";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	osQuery,
	workspaceResourcesQueryOptions,
	workspaceSchedulesQueryOptions,
} from "@/lib/os-query-options";
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
							<WorkspaceScheduleRow
								schedule={schedule}
								workspaceId={workspaceId}
							/>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function WorkspaceScheduleRow({
	schedule,
	workspaceId,
}: {
	schedule: OsWorkspaceSchedule;
	workspaceId: string;
}) {
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
				{schedule.personalRead?.canAllow && (
					<PersonalReadControl
						access={schedule.personalRead}
						resourceId={schedule.resourceId}
						workspaceId={workspaceId}
					/>
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

/**
 * The owner's own consent for a skill that reads their personal account:
 * one button grants read-only access with the tools the skill declares, and
 * Stop revokes it. Shown only to the Workspace's owner.
 */
function PersonalReadControl({
	access,
	resourceId,
	workspaceId,
}: {
	access: OsWorkspaceSchedulePersonalRead;
	resourceId: string;
	workspaceId: string;
}) {
	const queryClient = useQueryClient();
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({
				queryKey: workspaceSchedulesQueryOptions(workspaceId).queryKey,
			}),
			queryClient.invalidateQueries({
				queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
			}),
			queryClient.invalidateQueries({
				queryKey: osQuery.personalResourceDelegations.list.key(),
			}),
		]);
	const allow = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.schedules.allowPersonalRead({
				workspaceId,
				resourceId,
			}),
		onSuccess: refresh,
	});
	const stop = useMutation({
		mutationFn: (id: string) =>
			osApi.personalResourceDelegations.revoke({ id }),
		onSuccess: refresh,
	});
	const error = allow.error ?? stop.error;
	if (access.grantId) {
		const grantId = access.grantId;
		return (
			<Text as="p" role="label" className="m-0" data-schedule-personal-read>
				Reads your {access.providerName} (read-only) ·{" "}
				<Button
					size="xs"
					variant="ghost"
					disabled={stop.isPending}
					onClick={() => stop.mutate(grantId)}
				>
					Stop
				</Button>
				{error && <span role="alert"> {error.message}</span>}
			</Text>
		);
	}
	if (allow.data?.status === "not_connected") {
		return (
			<Text as="p" role="label" className="m-0" data-schedule-personal-read>
				Connect your {access.providerName} first in{" "}
				<a href="/account/connections">Settings → Connections</a>, then come
				back here.
			</Text>
		);
	}
	return (
		<div className="grid justify-items-start gap-1" data-schedule-personal-read>
			<Button
				size="sm"
				variant="secondary"
				disabled={allow.isPending}
				onClick={() => allow.mutate()}
			>
				Let this read my {access.providerName} (read-only)
			</Button>
			{error && (
				<Text
					as="p"
					role="label"
					tone="error"
					className="m-0"
					aria-live="polite"
				>
					{error.message}
				</Text>
			)}
		</div>
	);
}
