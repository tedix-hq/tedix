import { useQuery } from "@tanstack/react-query";
import type { DispatcherHealthReport } from "@tedix/api-contract/schemas/dispatcher-health";
import { useEffect, useState } from "react";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Text } from "@/components/kumo/text";
import {
	WorkEmpty,
	WorkListSkeleton,
	WorkReadFailure,
} from "./work-surface-primitives";
import { dispatcherHealthQueryOptions } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

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
	const observed = Date.parse(lane.observedAt);
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
					prove a task is progressing. Lead reports describe the last pass, not
					whether another pass is running now.
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
				const lanes =
					health.data?.data.filter(
						(lane) => isStaleReport(lane, now) === historical,
					) ?? [];
				if (!lanes.length) return null;
				const cards = (
					<div className="grid gap-4">
						{[...new Set(lanes.map((lane) => lane.reporterId))].map(
							(machine) => (
								<section
									key={machine}
									aria-label={`Machine ${machine}`}
									className="grid min-w-0 gap-3"
								>
									<h3 className="type-tedix-section break-all">{machine}</h3>
									<div className="grid gap-3 lg:grid-cols-3">
										{lanes
											.filter((lane) => lane.reporterId === machine)
											.map((lane) => {
												const stale = historical;
												const lead = lane.lane === "supervisor-lead";
												const state = stale
													? "Unknown · stale"
													: lead
														? "Last pass reported"
														: !lane.running
															? "Stopped"
															: lane.slotsInUse > 0
																? "Slots in use"
																: "Idle";
												return (
													<Card
														key={`${lane.reporterId}:${lane.lane}`}
														data-lane-state={state}
													>
														<CardHeader>
															<CardTitle className="flex flex-wrap items-center justify-between gap-2">
																{lead
																	? `Lead · ${lane.executor}`
																	: lane.executor}
																<Badge
																	variant={
																		stale || !lane.running
																			? "warning"
																			: "secondary"
																	}
																>
																	{state}
																</Badge>
															</CardTitle>
															<CardDescription className="break-all">
																{lead
																	? "Periodic Lead check"
																	: `Runner: ${lane.lane}`}
															</CardDescription>
														</CardHeader>
														<CardContent className="grid gap-2">
															{lead ? (
																<Text>Current pass: Not reported</Text>
															) : (
																<Text>
																	{lane.slotsInUse} / {lane.slotsTotal} slots in
																	use
																	{stale ? " at last observation" : ""}
																</Text>
															)}
															<Text tone="secondary">
																Observed{" "}
																<time
																	dateTime={lane.observedAt}
																	title={absoluteTime(lane.observedAt)}
																>
																	{relativeTime(lane.observedAt, new Date(now))}
																</time>
															</Text>
															<Text tone="secondary">
																Received {absoluteTime(lane.reportedAt)}
															</Text>
															<Text tone="secondary">
																Last task picked up:{" "}
																{lane.lastAdmissionAt
																	? absoluteTime(lane.lastAdmissionAt)
																	: "Not observed"}
															</Text>
															{lane.topReason ? (
																<details className="min-w-0 break-words">
																	<summary className="min-h-11 cursor-pointer py-2">
																		{lead
																			? "Last pass result"
																			: "Most reported problem (30 min)"}
																		:{" "}
																		{lead
																			? lane.topReason.reason
																			: skipReasonSummary(
																					lane.topReason.reason,
																				)}
																		{!lead &&
																			` · ${lane.topReason.count} observations`}
																	</summary>
																	<Text className="break-words">
																		{lane.topReason.reason}
																	</Text>
																</details>
															) : (
																<Text>
																	{lead
																		? "Last pass result: Not reported"
																		: "No repeated problem reported in the last 30 minutes."}
																</Text>
															)}
															<Text tone="secondary">
																Restart history: Not reported
															</Text>
														</CardContent>
													</Card>
												);
											})}
									</div>
								</section>
							),
						)}
					</div>
				);
				return historical ? (
					<details key="historical" className="grid gap-3">
						<summary className="min-h-11 cursor-pointer py-2">
							Historical lane observations ({lanes.length})
						</summary>
						{cards}
					</details>
				) : (
					<div key="current">{cards}</div>
				);
			})}
		</section>
	);
}
