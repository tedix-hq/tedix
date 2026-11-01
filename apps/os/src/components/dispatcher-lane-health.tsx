import { useQuery } from "@tanstack/react-query";
import type { DispatcherHealthReport } from "@tedix/api-contract/schemas/dispatcher-health";
import { useEffect, useState } from "react";
import { Badge } from "@/components/kumo/badge";
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
				<h2 className="type-tedix-section">Local lanes</h2>
				<Text tone="secondary">
					Checks for new reports every 30 seconds. A running runner does not
					prove a task is progressing. Runner and Lead states reflect their
					latest reports; older reports leave their current state unknown.
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
								<h3 className="type-tedix-section break-all">{machine}</h3>
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
					<details key="historical" className="min-w-0">
						<summary className="min-h-11 cursor-pointer py-2">
							Historical machines ({machines.length})
						</summary>
						{tables}
					</details>
				) : (
					<div key="current" className="min-w-0">
						{tables}
					</div>
				);
			})}
		</section>
	);
}

function DutyRow({ lane, now }: { lane: DispatcherHealthReport; now: number }) {
	const stale = isStaleReport(lane, now);
	const lead = lane.lane === "supervisor-lead";
	const duty = lane.duty;
	const observedAt = duty?.observedAt ?? lane.observedAt;
	const state = stale
		? "Unknown · stale"
		: duty
			? {
					running: lead ? "Lead running" : "Running",
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
					{lead ? `Lead · ${lane.executor}` : lane.executor}
				</span>
				<Text tone="secondary" className="break-all">
					{lead ? "Periodic Lead check" : `Runner: ${lane.lane}`}
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
			<TableCell label="Last observed" className="whitespace-normal align-top">
				<time dateTime={observedAt} title={absoluteTime(observedAt)}>
					{relativeTime(observedAt, new Date(now))}
				</time>
				{stale ? <Text tone="secondary">Historical report</Text> : null}
			</TableCell>
			<TableCell
				label="Problem"
				className="whitespace-normal break-words align-top"
			>
				<Text>
					{stale
						? "Current problem unknown"
						: (duty?.lastProblem ?? "Not reported")}
				</Text>
				<details className="min-w-0 break-words">
					<summary className="min-h-11 cursor-pointer py-2">
						History and details
					</summary>
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
									{lead ? "Last pass result" : "Most reported problem (30 min)"}
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
				</details>
			</TableCell>
		</TableRow>
	);
}
