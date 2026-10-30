import { useQuery } from "@tanstack/react-query";
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
					This view checks for new observations every 30 seconds. Use the
					observation time to check freshness. A running dispatcher does not
					prove work is progressing.
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
			<div className="grid gap-3 lg:grid-cols-3">
				{health.data?.data.map((lane) => {
					const stale =
						lane.stale ||
						now - Date.parse(lane.observedAt) > lane.staleAfterSeconds * 1000;
					const state = stale
						? "Unknown · stale"
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
									{lane.executor}
									<Badge
										variant={stale || !lane.running ? "warning" : "secondary"}
									>
										{state}
									</Badge>
								</CardTitle>
								<CardDescription className="break-all">
									Lane {lane.lane} · Reporter {lane.reporterId}
								</CardDescription>
							</CardHeader>
							<CardContent className="grid gap-2">
								<Text>
									{lane.slotsInUse} / {lane.slotsTotal} slots in use
									{stale ? " at last observation" : ""}
								</Text>
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
									Last admission:{" "}
									{lane.lastAdmissionAt
										? absoluteTime(lane.lastAdmissionAt)
										: "Not observed"}
								</Text>
								<Text className="break-words">
									{lane.topReason
										? `Recent skipped work: ${lane.topReason.reason} (${lane.topReason.count} occurrences)`
										: "No repeated skip or failure reported."}
								</Text>
							</CardContent>
						</Card>
					);
				})}
			</div>
		</section>
	);
}
