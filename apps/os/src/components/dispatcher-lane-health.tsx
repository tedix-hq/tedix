import { SectionTitle } from "@/components/kumo/page";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/components/kumo/link";
import type {
	DispatcherHealthReport,
	SupervisorActivity,
} from "@tedix/api-contract/schemas/dispatcher-health";
import { useEffect, useState } from "react";
import { Badge } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import {
	WorkEmpty,
	WorkListSkeleton,
	WorkReadFailure,
} from "./work-surface-primitives";
import { dispatcherHealthQueryOptions } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { OS_COPY } from "@/shared/os-copy";

function skipReasonSummary(reason: string): string {
	if (
		reason.startsWith(
			"Possible human-reserved action; no accountable user owner can authorize a delegation comment.",
		)
	)
		return "Owner authorization required";
	if (
		/requires (?:its owner or steward|a current active organization owner or admin membership)/i.test(
			reason,
		)
	)
		return "Owner permission required";
	if (
		/waiting for (?:owner )?approval|approval_blocked|Missing approval risk:/i.test(
			reason,
		)
	)
		return "Approval required";
	if (
		/tool policy could not be verified|access could not be verified|mcp_access_revalidation_required/i.test(
			reason,
		)
	)
		return "Access could not be verified";
	if (
		reason.startsWith(
			"This Work revision has a retained receipt or retry deadline",
		)
	)
		return "Earlier run or retry recorded";
	return "See the reported details";
}

function isStaleReport(lane: DispatcherHealthReport, now: number): boolean {
	const observed = Date.parse(lane.duty?.observedAt ?? lane.observedAt);
	return (
		lane.stale ||
		!Number.isFinite(observed) ||
		now - observed > lane.staleAfterSeconds * 1000
	);
}

export function DispatcherLaneHealth() {
	const health = useQuery({
		...dispatcherHealthQueryOptions(),
		refetchInterval: 30_000,
	});
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(timer);
	}, []);
	return (
		<section aria-label="Local lanes" className="grid gap-3">
			<div>
				<SectionTitle>Local lanes</SectionTitle>
				<Text tone="secondary">
					Checks for new reports every 30 seconds. Shows reported tasks and
					confirmed completions. Older reports leave current activity unknown.
				</Text>
			</div>
			{health.isError ? (
				<WorkReadFailure
					title="Lane observations unavailable"
					error={health.error}
					onRetry={() => health.refetch()}
					retrying={health.isFetching}
				/>
			) : null}
			{health.isPending ? (
				<WorkListSkeleton label="Loading local lanes" />
			) : null}
			{health.data?.data.length === 0 ? (
				<WorkEmpty
					title="No lane observations"
					description="No supervisor has reported local lanes to this organization. Their state is unknown."
				/>
			) : null}
			{health.data &&
			health.data.data.length > 0 &&
			health.data.data.every((lane) => isStaleReport(lane, now)) ? (
				<Text tone="secondary">
					No recent lane reports. Current lane status is unknown.
				</Text>
			) : null}
			{[false, true].map((historical) => {
				const machines = [
					...new Set(health.data?.data.map((lane) => lane.reporterId)),
				].filter(
					(machine) =>
						health.data?.data
							.filter((lane) => lane.reporterId === machine)
							.every((lane) => isStaleReport(lane, now)) === historical,
				);
				if (!machines.length) return null;
				const tables = (
					<div className="grid min-w-0 gap-4">
						{machines.map((machine) => (
							<section
								key={machine}
								aria-label={`Machine ${machine}`}
								className="grid min-w-0 gap-2"
							>
								<Text
									as="h3"
									role="section"
									weight="semibold"
									tone="strong"
									className="break-all"
								>
									{machine}
								</Text>
								<Table
									aria-label={`Duties on ${machine}`}
									mobileLayout="stacked"
									className="w-full table-fixed"
								>
									<TableHeader>
										<TableRow>
											{OS_COPY.supervisorDutyColumns.map((label) => (
												<TableHead key={label} scope="col">
													{label}
												</TableHead>
											))}
										</TableRow>
									</TableHeader>
									<TableBody>
										{health.data?.data
											.filter((lane) => lane.reporterId === machine)
											.map((lane) => (
												<DutyRow key={lane.lane} lane={lane} now={now} />
											))}
									</TableBody>
								</Table>
							</section>
						))}
					</div>
				);
				return historical ? (
					<Collapsible key="historical" className="min-w-0">
						<CollapsibleDefaultTrigger>
							Historical machines ({machines.length})
						</CollapsibleDefaultTrigger>
						<CollapsibleDefaultContent keepMounted>
							{tables}
						</CollapsibleDefaultContent>
					</Collapsible>
				) : (
					<div key="current" className="min-w-0">
						{tables}
					</div>
				);
			})}
		</section>
	);
}

function WorkLink({ work }: { work: { id: string; title?: string } }) {
	return (
		<Link
			href={`/work/items/${work.id}`}
			variant="record"
			title={work.title ?? "Open task"}
			className="min-w-0 max-w-full"
		>
			<Text as="span" truncate>
				{work.title ?? "Open task"}
			</Text>
		</Link>
	);
}

function WorkActivity({
	activity,
	stale,
	now,
}: {
	activity?: SupervisorActivity;
	stale: boolean;
	now: number;
}) {
	if (stale) return <Text>Task activity unknown</Text>;
	if (!activity) return <Text>Task activity not reported</Text>;
	return (
		<div className="grid min-w-0 grid-cols-1 gap-2">
			{activity.current.length ? (
				activity.current.map((work) => (
					<div key={work.id}>
						<WorkLink work={work} />
					</div>
				))
			) : (
				<Text>
					{activity.currentCount
						? "Task details unavailable"
						: "No active task reported"}
				</Text>
			)}
			{activity.currentCount > activity.current.length ? (
				<Text tone="secondary">
					{activity.currentCount - activity.current.length} more tasks reported
				</Text>
			) : null}
			<div>
				<Text tone="secondary">Last completed</Text>
				{activity.lastCompleted ? (
					<>
						<WorkLink work={activity.lastCompleted} />
						<Text>
							<time
								dateTime={activity.lastCompleted.completedAt}
								title={absoluteTime(activity.lastCompleted.completedAt)}
							>
								{relativeTime(
									activity.lastCompleted.completedAt,
									new Date(now),
								)}
							</time>
						</Text>
					</>
				) : (
					<Text>Not reported</Text>
				)}
			</div>
		</div>
	);
}

const WAIT_LABELS = {
	retry: "Retry scheduled",
	confirmation: "Checking admission",
	reply: "Waiting for a reply",
	completion: "Confirming completion",
	held: "Held for review",
};

function DutyRow({ lane, now }: { lane: DispatcherHealthReport; now: number }) {
	const stale = isStaleReport(lane, now);
	const duty = lane.duty;
	const lead =
		duty?.kind === "task" || (!duty && lane.lane === "supervisor-lead");
	const activity = duty?.activity;
	const taskState = activity?.current.some((work) => work.phase === "working")
		? "Working"
		: activity?.current.some((work) => work.phase === "finishing")
			? "Finishing"
			: activity?.current.length
				? "Starting"
				: activity?.currentCount
					? "Activity unknown"
					: "Ready";
	const nextAt = duty?.retryAt ?? (lane.running ? activity?.nextCheckAt : null);
	const observedAt = duty?.observedAt ?? lane.observedAt;
	const state = stale
		? "Unknown · stale"
		: duty?.kind === "service" && duty.state === "running" && !lane.running
			? "Stopped"
			: duty
				? {
						running: lead ? "Check running" : activity ? taskState : "Running",
						waiting: lead ? "Waiting for next check" : "Restart scheduled",
						stopped: "Stopped",
						failed: "Needs attention",
						unknown: "Unknown",
					}[duty.state]
				: lead
					? "Last pass reported"
					: !lane.running
						? "Stopped"
						: lane.slotsInUse > 0
							? "Slots in use"
							: "Idle";
	return (
		<TableRow data-lane-state={state}>
			<TableCell
				label="Duty"
				className="whitespace-normal break-words align-top"
			>
				<span className="font-medium">
					{lead ? `Scheduled check · ${lane.executor}` : lane.executor}
				</span>
				<Text
					role="caption"
					tone="secondary"
					truncate
					title={lead ? "Scheduled task" : `Runner: ${lane.lane}`}
				>
					{lead ? "Scheduled task" : `Runner: ${lane.lane}`}
				</Text>
			</TableCell>
			<TableCell label="State" className="whitespace-normal align-top">
				<Badge
					variant={
						stale ||
						(duty
							? ["failed", "stopped", "unknown"].includes(duty.state)
							: !lane.running)
							? "warning"
							: "secondary"
					}
				>
					{state}
				</Badge>
			</TableCell>
			<TableCell
				label="Work"
				className="whitespace-normal break-words align-top"
			>
				<WorkActivity activity={activity} stale={stale} now={now} />
			</TableCell>
			<TableCell label="Last observed" className="whitespace-normal align-top">
				<time dateTime={observedAt} title={absoluteTime(observedAt)}>
					{relativeTime(observedAt, new Date(now))}
				</time>
				{stale ? <Text tone="secondary">Historical report</Text> : null}
			</TableCell>
			<TableCell
				label="Next step"
				className="whitespace-normal break-words align-top"
			>
				{stale || duty?.lastProblem ? (
					<Text>{stale ? "Current problem unknown" : duty?.lastProblem}</Text>
				) : null}
				{!stale ? (
					<div className="grid gap-2">
						{activity?.waiting.map((work) => (
							<div key={work.id}>
								<WorkLink work={work} />
								<Text>{WAIT_LABELS[work.reason]}</Text>
								{work.retryAt ? (
									<Text>
										{Date.parse(work.retryAt) <= now
											? "Retry or check due"
											: "Scheduled"}
										:{" "}
										<time dateTime={work.retryAt}>
											{absoluteTime(work.retryAt)}
										</time>
									</Text>
								) : null}
							</div>
						))}
						<Text>
							{nextAt ? (
								<>
									{Date.parse(nextAt) <= now ? "Check due" : "Next check"}:{" "}
									<time dateTime={nextAt}>{absoluteTime(nextAt)}</time>
								</>
							) : (
								"Next check not reported"
							)}
						</Text>
					</div>
				) : null}
				<Collapsible className="min-w-0 break-words" data-lane-details>
					<CollapsibleDefaultTrigger>
						History and details
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent keepMounted>
						<div className="grid gap-2">
							{stale ? (
								<Text>
									Historical lane observation. Current state is unknown.
								</Text>
							) : null}
							{lead ? (
								<Text>Current pass: {duty ? state : "Not reported"}</Text>
							) : (
								<Text>
									{lane.slotsInUse} / {lane.slotsTotal} slots in use
									{stale ? " at last observation" : ""}
								</Text>
							)}
							<Text tone="secondary">
								Received {absoluteTime(lane.reportedAt)}
							</Text>
							<Text>
								Last task picked up:{" "}
								{lane.lastAdmissionAt
									? absoluteTime(lane.lastAdmissionAt)
									: "Not observed"}
							</Text>
							{lane.topReason ? (
								<div>
									<Text>
										{lead
											? "Last pass result"
											: "Most reported problem (30 min)"}
										:{" "}
										{lead
											? lane.topReason.reason
											: skipReasonSummary(lane.topReason.reason)}
										{!lead && ` · ${lane.topReason.count} observations`}
									</Text>
									{!lead ? <Text>{lane.topReason.reason}</Text> : null}
								</div>
							) : (
								<Text>
									{lead
										? "Last pass result: Not reported"
										: "No repeated problem reported in the last 30 minutes."}
								</Text>
							)}
							{duty ? (
								<>
									<Text>
										Last started:{" "}
										{duty.lastRunAt
											? absoluteTime(duty.lastRunAt)
											: "Not observed"}
									</Text>
									<Text>
										Last exit:{" "}
										{duty.lastExitAt
											? `${absoluteTime(duty.lastExitAt)} · code ${duty.lastExitCode ?? "unavailable"}`
											: "Not observed"}
									</Text>
									<Text>
										Recorded restarts (last hour): {duty.restartsLastHour}
									</Text>
									<Text>
										Next {lead ? "check" : "retry"}:{" "}
										{duty.retryAt ? absoluteTime(duty.retryAt) : "Not reported"}
									</Text>
									{duty.lastProblem ? (
										<Text>Last problem: {duty.lastProblem}</Text>
									) : null}
								</>
							) : (
								<Text tone="secondary">Restart history: Not reported</Text>
							)}
						</div>
					</CollapsibleDefaultContent>
				</Collapsible>
			</TableCell>
		</TableRow>
	);
}
