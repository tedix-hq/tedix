import { PencilSimple, Pulse, SlidersHorizontal } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { ActivityRunningNow } from "./activity-running-now";
import { Card, CardContent, CardHeader, CardTitle } from "./kumo/card";
import { Link } from "./kumo/link";
import { Text } from "./kumo/text";
import { WorkListSkeleton, WorkReadFailure } from "./work-surface-primitives";
import {
	osQuery,
	projectListQueryOptions,
	workItemPagesQueryOptions,
} from "@/lib/os-query-options";
import { useOsPreferences } from "@/lib/use-os-preferences";
import { EMPTY_FEED_PREFERENCES } from "@tedix/api-contract/utils/activity-feed";
import { WorkItemCommentComposer } from "./work-item-comment-composer";
import { Button } from "./kumo/button";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "./kumo/collapsible";
import { workRefreshOptions } from "@/lib/work-refresh";
import { absoluteDate } from "@/lib/time";
import { workHomeMattersThrough } from "@/lib/work-home-overview";
import { useState, type ReactNode } from "react";

const ORGANIZATION_ACTIVITY_CONFIG = ActivityFeedConfigSchema.parse({
	version: 1,
	scope: "organization",
	projects: [],
});

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Card aria-label={title} className="min-w-0">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent className="grid min-w-0 gap-3">{children}</CardContent>
		</Card>
	);
}

function Rows({ children, label }: { children: ReactNode; label: string }) {
	return (
		<ul aria-label={label} className="grid min-w-0 gap-3">
			{children}
		</ul>
	);
}

function Row({
	href,
	label,
	detail,
}: {
	href: string;
	label: string;
	detail: ReactNode;
}) {
	return (
		<li className="grid min-w-0 gap-1 border-t border-kumo-line pt-3">
			<Link variant="record" href={href}>
				{label}
			</Link>
			<Text tone="secondary">{detail}</Text>
		</li>
	);
}

/** Each section stays a glance; its link opens the full list. */
const SECTION_ROWS = 5;

const recoveryReason: Record<string, string> = {
	dependencies_blocked: "A dependency is not finished",
	latest_attempt_failed: "The last run failed",
	latest_attempt_expired: "The last run timed out",
	attempt_lease_elapsed: "The run stopped reporting",
};

function ShareUpdate({ onPosted }: { onPosted: () => void }) {
	const [itemId, setItemId] = useState("");
	const list = useInfiniteQuery(workItemPagesQueryOptions({}));
	return (
		<section
			aria-label="Share an update"
			className="grid gap-3 rounded-lg border border-kumo-line p-4"
		>
			{list.isError && (
				<WorkReadFailure
					title="Could not load tasks"
					error={list.error}
					onRetry={() => list.refetch()}
				/>
			)}
			<label className="grid gap-1">
				Task
				<select
					className="min-w-0 rounded-md border border-kumo-line bg-kumo-base p-2"
					value={itemId}
					onChange={(event) => setItemId(event.target.value)}
				>
					<option value="">
						{list.isPending ? "Loading tasks…" : "Choose a task"}
					</option>
					{list.data?.pages
						.flatMap((page) => page.data)
						.map((task) => (
							<option key={task.id} value={task.id}>
								{task.title}
							</option>
						))}
				</select>
			</label>
			{list.hasNextPage && (
				<Button
					variant="ghost"
					disabled={list.isFetchingNextPage}
					onClick={() => list.fetchNextPage()}
				>
					More tasks
				</Button>
			)}
			{itemId && (
				<WorkItemCommentComposer
					key={itemId}
					itemId={itemId}
					onPosted={onPosted}
				/>
			)}
		</section>
	);
}

export function WorkHomeOverview({ children }: { children?: ReactNode }) {
	const { query, save } = useOsPreferences();
	const preferences = query.data?.preferences;
	const projects = preferences?.activityFeed?.projectIds ?? [];
	const following =
		projects.length > 0 && preferences?.activityOverviewScope !== "all";
	const [sharing, setSharing] = useState(false);
	const [posted, setPosted] = useState(false);
	const [pick, setPick] = useState(false);
	const [running, setRunning] = useState(false);
	const [details, setDetails] = useState(false);
	const [offset, setOffset] = useState(0);
	const available = useQuery({
		...projectListQueryOptions(50, { offset }),
		enabled: pick,
	});
	function choose(scope: "all" | "following", ids = projects) {
		if (!preferences || save.isPending) return;
		save.mutate({
			...preferences,
			activityOverviewScope: scope,
			activityFeed: {
				...(preferences.activityFeed ?? EMPTY_FEED_PREFERENCES),
				projectIds: ids,
			},
		});
	}
	return (
		<section
			aria-label="Work overview"
			className="mx-auto grid w-full max-w-3xl gap-3 pb-6"
		>
			<div
				role="group"
				aria-label="Activity scope"
				className="activity-toolbar flex flex-wrap items-center gap-1 border-b border-kumo-line"
			>
				<Button
					size="sm"
					variant="ghost"
					aria-pressed={following}
					disabled={!preferences || save.isPending}
					onClick={() =>
						projects.length ? choose("following") : setPick(true)
					}
				>
					Following
				</Button>
				<Button
					size="sm"
					variant="ghost"
					aria-pressed={!following}
					disabled={!preferences || save.isPending}
					onClick={() => choose("all")}
				>
					All work
				</Button>
				<Button
					size="sm"
					variant="ghost"
					className="ms-auto"
					aria-label="Running now"
					title="Running now"
					aria-expanded={running}
					onClick={() => setRunning(!running)}
				>
					<Pulse aria-hidden className="size-5" />
					<span className="max-sm:sr-only">Running now</span>
				</Button>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Choose projects"
					title="Choose projects"
					aria-expanded={pick}
					onClick={() => setPick(!pick)}
				>
					<SlidersHorizontal aria-hidden className="size-5" />
					<span className="sr-only">Choose projects</span>
				</Button>
				<Button
					size="sm"
					aria-label="Share an update"
					title="Share an update"
					aria-expanded={sharing}
					onClick={() => {
						setPosted(false);
						setSharing(!sharing);
					}}
				>
					<PencilSimple aria-hidden className="size-5" />
					<span className="max-sm:sr-only">Share an update</span>
				</Button>
			</div>
			{sharing && (
				<ShareUpdate
					onPosted={() => {
						setPosted(true);
						setSharing(false);
					}}
				/>
			)}
			{posted && <p role="status">Update posted.</p>}
			{pick && (
				<fieldset className="grid max-h-64 gap-2 overflow-auto">
					<legend>Projects to follow</legend>
					{available.isPending && <Text>Loading projects…</Text>}
					{available.isError && (
						<WorkReadFailure
							title="Could not load projects"
							error={available.error}
							onRetry={() => available.refetch()}
						/>
					)}
					{available.data?.data.map((project) => (
						<label key={project.id} className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={projects.includes(project.id)}
								disabled={!preferences || save.isPending}
								onChange={(event) =>
									choose(
										"following",
										event.target.checked
											? [...projects, project.id]
											: projects.filter((id) => id !== project.id),
									)
								}
							/>
							{project.name}
						</label>
					))}
					{(offset > 0 || available.data?.pagination.hasMore) && (
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="ghost"
								disabled={!offset}
								onClick={() => setOffset((n) => Math.max(0, n - 50))}
							>
								Previous projects
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={!available.data?.pagination.hasMore}
								onClick={() => setOffset((n) => n + 50)}
							>
								More projects
							</Button>
						</div>
					)}
				</fieldset>
			)}
			{save.isError && (
				<Text role="body">
					Could not save your Activity preference. Try again.
				</Text>
			)}
			{running && (
				<div>
					<ActivityRunningNow
						config={ORGANIZATION_ACTIVITY_CONFIG}
						followedProjects={following ? projects : undefined}
					/>
					<Collapsible open={details} onOpenChange={setDetails}>
						<CollapsibleDefaultTrigger>
							Stuck and upcoming work
						</CollapsibleDefaultTrigger>
						<CollapsibleDefaultContent>
							{details && <OverviewSections />}
						</CollapsibleDefaultContent>
					</Collapsible>
				</div>
			)}
			<div aria-label="Recent activity" className="activity-posts min-w-0">
				{children}
			</div>
		</section>
	);
}

export function OverviewSections() {
	const [now] = useState(() => new Date());
	const mattersThrough = workHomeMattersThrough(now);
	const readiness = useQuery({
		...osQuery.workItems.listReadinessProjection.queryOptions({
			input: { limit: 50 },
		}),
		...workRefreshOptions,
	});
	const recovery = useQuery({
		...osQuery.workItems.listRecoveryProjection.queryOptions({
			input: { limit: 100 },
		}),
		...workRefreshOptions,
	});
	const matters = useQuery({
		...osQuery.workItems.list.queryOptions({
			input: {
				disposition: "accepted",
				mattersThrough,
				limit: 50,
			},
		}),
		...workRefreshOptions,
	});

	const stuck = new Map<
		string,
		{ id: string; title: string; reason: string }
	>();
	for (const row of readiness.data?.data ?? []) {
		// Running work and work waiting for its start date are not stuck.
		if (
			row.readiness.ready ||
			row.readiness.state === "already_running" ||
			row.readiness.state === "not_before"
		)
			continue;
		stuck.set(row.workItem.id, {
			id: row.workItem.id,
			title: row.workItem.title,
			reason:
				row.readiness.reasons[0]?.detail ??
				"Readiness could not be established",
		});
	}
	for (const row of recovery.data?.data ?? []) {
		if (stuck.has(row.id)) continue;
		stuck.set(row.id, {
			id: row.id,
			title: row.title,
			reason: row.signals
				.map((signal) =>
					signal === "dispatch_held"
						? `The runner stopped: ${row.dispatchHoldReason}`
						: recoveryReason[signal],
				)
				.join(" · "),
		});
	}
	const stuckFailed = readiness.isError || recovery.isError;

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<Section title="Stuck">
				{stuckFailed && (
					<WorkReadFailure
						title="Stuck Work unavailable"
						error={readiness.error ?? recovery.error}
					/>
				)}
				{stuck.size ? (
					<Rows label="Stuck Work">
						{[...stuck.values()].slice(0, SECTION_ROWS).map((row) => (
							<Row
								key={row.id}
								href={`/work/items/${encodeURIComponent(row.id)}`}
								label={row.title}
								detail={row.reason}
							/>
						))}
					</Rows>
				) : readiness.isPending || recovery.isPending ? (
					<WorkListSkeleton label="Checking stuck Work" />
				) : stuckFailed ? null : (
					<Text tone="secondary">Nothing is blocked.</Text>
				)}
				{(stuck.size > SECTION_ROWS ||
					readiness.data?.hasMore ||
					recovery.data?.hasMore) && (
					<Link href="/work?view=feed&filter=stalled">More stuck Work</Link>
				)}
			</Section>

			<Section title="This week">
				<Text tone="secondary">Due soon or high priority.</Text>
				{matters.isError && (
					<WorkReadFailure
						title="This week's Work unavailable"
						error={matters.error}
					/>
				)}
				{matters.data?.data.length ? (
					<Rows label="This week's Work">
						{matters.data.data.slice(0, SECTION_ROWS).map((row) => {
							const dueAt = row.deadline ?? row.dueDate;
							const reason = [
								row.priority === "critical"
									? "Critical priority"
									: row.priority === "high"
										? "High priority"
										: null,
								dueAt ? `Due ${absoluteDate(dueAt)}` : null,
							]
								.filter(Boolean)
								.join(" · ");
							return (
								<Row
									key={row.id}
									href={`/work/items/${encodeURIComponent(row.id)}`}
									label={row.title}
									detail={reason}
								/>
							);
						})}
					</Rows>
				) : matters.isPending ? (
					<WorkListSkeleton label="Checking this week's Work" />
				) : matters.isError ? null : (
					<Text tone="secondary">
						Nothing is due within seven days or marked high or critical
						priority.
					</Text>
				)}
				{((matters.data?.data.length ?? 0) > SECTION_ROWS ||
					matters.data?.pagination.hasMore) && (
					<Link href="/work?view=items&status=accepted">All accepted Work</Link>
				)}
			</Section>
		</div>
	);
}
