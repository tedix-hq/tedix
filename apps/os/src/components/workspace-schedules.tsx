import { Clock, LinkBreak, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	OsWorkspaceSchedule,
	OsWorkspaceSchedulePersonalRead,
} from "@tedix/api-contract/schemas/os-workspace-schedules";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { ListSkeleton } from "@/components/list-skeleton";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { WorkspaceSkillLinkDialog } from "@/components/workspace-skill-link-dialog";
import { useOsFormattingPreferences } from "@/lib/format";
import { osApi } from "@/lib/api";
import {
	osQuery,
	workspaceResourcesQueryOptions,
	workspaceSchedulesQueryOptions,
} from "@/lib/os-query-options";
import {
	lastRunFailure,
	lastRunLine,
	nextRunLine,
	scheduleWhen,
} from "@/lib/workspace-schedules";

/**
 * "Skills and schedules" in a workspace's Resources: every skill linked to
 * this workspace, the tedi that runs it, when it runs, how the last run went
 * and when the next one is. People link and unlink skills here; a link never
 * changes the skill or its schedule.
 */
export function WorkspaceSchedules({ workspaceId }: { workspaceId: string }) {
	const query = useQuery(workspaceSchedulesQueryOptions(workspaceId));
	const [linking, setLinking] = useState(false);
	const items = query.data?.items ?? [];
	if (query.isError) return null;
	return (
		<section
			aria-label="Skills and schedules"
			className="canvas-resource-section canvas-resource-schedules"
		>
			<SectionEyebrow
				title="Skills and schedules"
				count={query.data ? items.length : undefined}
				variant="console"
				actions={
					<Button
						size="sm"
						variant="secondary"
						icon={<Plus aria-hidden size={14} />}
						onClick={() => setLinking(true)}
					>
						Link skill
					</Button>
				}
			/>
			{query.isPending && <ListSkeleton rows={1} rowClassName="h-20" />}
			{query.data && items.length === 0 && (
				<Empty
					appearance="quiet"
					title="No skills run this workspace yet"
					description="Link the skills that fill it, and they show here with their schedule and last run."
				/>
			)}
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
			{linking && (
				<WorkspaceSkillLinkDialog
					open
					onOpenChange={setLinking}
					workspaceId={workspaceId}
					linkedSkillIds={items.map((item) => item.skillId)}
				/>
			)}
		</section>
	);
}

/** "Run by Research Tedi · Automation": who runs the skill and how. */
function runsByLine(schedule: OsWorkspaceSchedule): string {
	return [
		schedule.tediName ? `Run by ${schedule.tediName}` : "No tedi runs it yet",
		schedule.hasWorkflow ? "Automation" : "Instructions",
	].join(" · ");
}

function WorkspaceScheduleRow({
	schedule,
	workspaceId,
}: {
	schedule: OsWorkspaceSchedule;
	workspaceId: string;
}) {
	useOsFormattingPreferences();
	const next = schedule.enabled ? nextRunLine(schedule.nextRunAt) : null;
	const failure =
		schedule.lastRun?.status === "failed"
			? lastRunFailure(schedule.lastRun, schedule)
			: null;
	const titleId = `workspace-schedule-${schedule.resourceId}`;
	return (
		<Surface
			as="article"
			tier="panel"
			aria-labelledby={titleId}
			className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 p-4 sm:flex sm:p-6"
			data-workspace-schedule={schedule.skillId}
		>
			<Clock
				aria-hidden
				size={20}
				className="mt-0.5 shrink-0 text-kumo-subtle"
			/>
			<div className="grid min-w-0 flex-1 gap-2">
				<Text
					as="h3"
					id={titleId}
					role="section"
					tone="strong"
					weight="semibold"
					className="m-0 wrap-anywhere"
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
					tone="secondary"
					className="m-0"
					data-schedule-runs-by
				>
					{runsByLine(schedule)}
				</Text>
				<Text
					as="p"
					role="label"
					tone={failure ? "error" : "secondary"}
					className="m-0"
					data-schedule-last-run
				>
					{failure
						? `Last run failed: ${failure.reason}`
						: lastRunLine(schedule.lastRun)}
				</Text>
				{failure?.details && (
					<Collapsible
						className="text-kumo-subtle type-tedix-control"
						data-schedule-last-run-details
					>
						<CollapsibleDefaultTrigger className="group/disclosure -mx-2">
							Technical details
						</CollapsibleDefaultTrigger>
						<CollapsibleDefaultContent keepMounted>
							<p className="m-0 whitespace-pre-wrap wrap-anywhere">
								{failure.details}
							</p>
						</CollapsibleDefaultContent>
					</Collapsible>
				)}
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
			<div className="col-start-2 flex shrink-0 flex-wrap items-center gap-3 sm:flex-col sm:items-end">
				<Link
					className="w-fit"
					variant="navigation"
					href={`/skills/${encodeURIComponent(schedule.skillId)}/runs`}
				>
					See runs
				</Link>
				<UnlinkSkillButton
					skillId={schedule.skillId}
					name={schedule.name}
					workspaceId={workspaceId}
				/>
			</div>
		</Surface>
	);
}

/** Unlink one skill from the workspace; the skill and its schedule stay. */
function UnlinkSkillButton({
	skillId,
	name,
	workspaceId,
}: {
	skillId: string;
	name: string;
	workspaceId: string;
}) {
	const queryClient = useQueryClient();
	const unlink = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.schedules.unlink({ workspaceId, skillId }),
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: workspaceSchedulesQueryOptions(workspaceId).queryKey,
				}),
				queryClient.invalidateQueries({
					queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
				}),
			]),
	});
	return (
		<>
			<Button
				size="xs"
				variant="ghost"
				icon={<LinkBreak aria-hidden size={14} />}
				aria-label={`Unlink ${name} from this workspace`}
				disabled={unlink.isPending}
				onClick={() => unlink.mutate()}
			>
				Unlink
			</Button>
			{unlink.isError && (
				<Text as="p" role="label" tone="error" className="m-0">
					{unlink.error.message}
				</Text>
			)}
		</>
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
			<Text
				as="p"
				role="label"
				className="m-0 flex flex-wrap items-center gap-1"
				data-schedule-personal-read
			>
				{access.level === "organise"
					? `Reads and organises your ${access.providerName} (never sends or deletes)`
					: `Reads your ${access.providerName} (read-only)`}{" "}
				·{" "}
				<Button
					size="xs"
					variant="ghost"
					disabled={stop.isPending}
					onClick={() => stop.mutate(grantId)}
				>
					Stop
				</Button>
				{error && (
					<span role="alert">
						<Text as="span" role="label" tone="error">
							{" "}
							{error.message}
						</Text>
					</span>
				)}
			</Text>
		);
	}
	if (allow.data?.status === "not_connected") {
		return (
			<Text as="p" role="label" className="m-0" data-schedule-personal-read>
				Connect your {access.providerName} first in{" "}
				<Link href="/account/connections">Settings → Connections</Link>, then
				come back here.
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
				{access.providerId === "tedix-session-activity"
					? `Let the ${access.workerName ?? "scheduled"} tedi read my session activity (read-only)`
					: `Let this read my ${access.providerName} (read-only)`}
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
