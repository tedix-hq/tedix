import { useEffect, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ActivityFeedConfig } from "@tedix/api-contract/schemas/os-activity-feed";
import { dispatcherHealthQueryOptions, osQuery } from "@/lib/os-query-options";
import { workRefreshOptions } from "@/lib/work-refresh";
import { absoluteTime, relativeTime } from "@/lib/time";
import {
	namedWorkPrincipal,
	useWorkPrincipalNames,
} from "./work-operations-shared";
import { WorkReadFailure } from "./work-surface-primitives";
import { Card, CardContent, CardHeader, CardTitle } from "./kumo/card";
import { Link } from "./kumo/link";
import { Text } from "./kumo/text";
import { ActivityHarnessScorecard } from "./activity-harness-scorecard";

/** Uses the same canonical attempt and dispatcher projections as Work. */
export function ActivityRunningNow({
	config,
	projectId,
}: {
	config: ActivityFeedConfig;
	projectId?: string;
}) {
	const scopes = projectId
		? [projectId]
		: config.scope === "organization"
			? [undefined]
			: [...new Set(config.projects.map((project) => project.id))];
	const queries = useQueries({
		queries: scopes.map((id) => ({
			...osQuery.workItems.listAttemptProjection.queryOptions({
				input: {
					projectId: id,
					runtimeStates: ["queued", "running", "waiting", "retrying"],
					limit: 100,
				},
			}),
			...workRefreshOptions,
			refetchInterval: 30_000,
		})),
	});
	const health = useQuery({
		...dispatcherHealthQueryOptions(),
		...workRefreshOptions,
		refetchInterval: 30_000,
	});
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 15_000);
		return () => clearInterval(timer);
	}, []);
	const rows = [
		...new Map(
			queries
				.flatMap((query) => query.data?.data ?? [])
				.map((row) => [row.attempt.id, row]),
		).values(),
	];
	const names = useWorkPrincipalNames(rows[0]?.attempt.orgId);
	const failed = queries.some(
		(query) => query.isError || query.failureCount > 0,
	);
	const pending = queries.some((query) => query.isPending);
	const reports = health.data?.data ?? [];
	const fresh = reports.filter(
		(lane) =>
			!lane.stale &&
			now.getTime() - Date.parse(lane.duty?.observedAt ?? lane.observedAt) <=
				lane.staleAfterSeconds * 1000,
	);
	const runners = fresh.filter(
		(lane) => lane.duty?.kind !== "task" && lane.lane !== "supervisor-lead",
	);
	const up = runners.filter(
		(lane) => lane.running && (!lane.duty || lane.duty.state === "running"),
	);
	const lastReport = reports
		.map((lane) => lane.observedAt)
		.sort()
		.at(-1);
	const healthFailed = health.isError || health.failureCount > 0;
	return (
		<Card aria-label="Running now" className="my-4 min-w-0">
			<CardHeader>
				<CardTitle>Running now</CardTitle>
			</CardHeader>
			<CardContent className="grid min-w-0 gap-3">
				<Text tone="secondary">
					Updates every 30 seconds while Activity is open.
				</Text>
				<Text role="caption" aria-label="Fleet health">
					{healthFailed || !runners.length
						? "Runners up: unknown"
						: `Runners up: ${up.length} / ${runners.length}`}
					{reports.length > fresh.length
						? ` · ${reports.length - fresh.length} stale reports`
						: ""}
					{!healthFailed &&
					fresh.some(
						(lane) =>
							lane.lane === "supervisor-lead" || lane.duty?.kind === "task",
					)
						? " · Supervisor reporting"
						: " · Supervisor: unknown"}
					{" · Last renewal: unknown · Sign-in: unknown"}
					{lastReport && (
						<>
							{" "}
							· Last report{" "}
							<time dateTime={lastReport} title={absoluteTime(lastReport)}>
								{relativeTime(lastReport, now)}
							</time>
						</>
					)}
				</Text>
				{healthFailed && (
					<WorkReadFailure
						title="Fleet health unavailable"
						error={health.error ?? health.failureReason}
						onRetry={() => health.refetch()}
						retrying={health.isFetching}
					/>
				)}
				{failed && (
					<WorkReadFailure
						title="Active attempts unavailable"
						error={
							queries.find((query) => query.error || query.failureReason)
								?.error ??
							queries.find((query) => query.failureReason)?.failureReason
						}
						onRetry={() => Promise.all(queries.map((query) => query.refetch()))}
						retrying={queries.some((query) => query.isFetching)}
					/>
				)}
				<ActivityHarnessScorecard
					scopes={scopes}
					reports={healthFailed ? [] : reports}
					now={now.getTime()}
				/>
				{rows.length > 0 ? (
					<ul aria-label="Active attempts" className="grid min-w-0 gap-3">
						{rows.map(({ attempt, workItem }) => {
							const expired =
								!!attempt.expiresAt &&
								Date.parse(attempt.expiresAt) <= now.getTime();
							const lane = fresh.find((report) =>
								report.duty?.activity?.current.some(
									(work) => work.id === workItem.id,
								),
							);
							return (
								<li
									key={attempt.id}
									className="grid min-w-0 gap-1 border-t border-kumo-line pt-3"
								>
									<Link variant="record" href={`/work/items/${workItem.id}`}>
										{workItem.title}
									</Link>
									<Text role="caption" className="break-all">
										Attempt {attempt.attemptNumber} · {attempt.id}
									</Text>
									<Text>
										{namedWorkPrincipal(
											attempt.executorType,
											attempt.executorId,
											names,
										)}{" "}
										·{" "}
										{expired
											? "Lease elapsed · current activity unknown"
											: attempt.runtimeState}
									</Text>
									<Text role="caption" tone="secondary">
										Started{" "}
										<time
											dateTime={attempt.startedAt}
											title={absoluteTime(attempt.startedAt)}
										>
											{absoluteTime(attempt.startedAt)}
										</time>
										{` · ${Math.max(0, Math.floor((now.getTime() - Date.parse(attempt.startedAt)) / 60_000))} min elapsed · Last heartbeat `}
										{attempt.heartbeatAt ? (
											<time
												dateTime={attempt.heartbeatAt}
												title={absoluteTime(attempt.heartbeatAt)}
											>
												{relativeTime(attempt.heartbeatAt, now)}
											</time>
										) : (
											"unknown"
										)}
										{` · Runner: ${lane ? `${lane.executor} / ${lane.lane}` : "not reported"}`}
									</Text>
								</li>
							);
						})}
					</ul>
				) : (
					<Text tone="secondary">
						{failed
							? "Current activity is unknown."
							: pending
								? "Checking active attempts…"
								: "No active attempts in this scope."}
					</Text>
				)}
				{failed && rows.length > 0 && (
					<Text tone="secondary">
						Showing saved attempts. Current activity may have changed.
					</Text>
				)}
				{queries.some((query) => query.data?.hasMore) && (
					<Link href="/work/attempts">More active attempts in Work</Link>
				)}
			</CardContent>
		</Card>
	);
}
