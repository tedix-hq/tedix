import { useQuery } from "@tanstack/react-query";
import type {
	WorkMap,
	WorkMapActor,
	WorkMapEpic,
	WorkMapItem,
	WorkMapLane,
	WorkMapSignalKind,
} from "@tedix/api-contract/schemas/work-map";
import type { WorkMapConfig } from "@tedix/api-contract/schemas/os-work-map";
import { useEffect, useMemo, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import { Link } from "@/components/kumo/link";
import { Meter } from "@/components/kumo/meter";
import { SectionTitle } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { useWorkPrincipalNames } from "./work-operations-shared";
import {
	WorkEmpty,
	WorkListSkeleton,
	WorkPageHeader,
	WorkReadFailure,
} from "./work-surface-primitives";
import { workMapQueryOptions } from "@/lib/os-query-options";
import { absoluteTime, formatDurationMs } from "@/lib/time";

/** Lanes must show a stop within a minute: poll at least every 10 s while open. */
const REFRESH_MS = 10_000;
const NOT_MOVING_PREVIEW = 15;

const SIGNAL_LABEL: Record<WorkMapSignalKind, string> = {
	stalled: "Stalled",
	held: "Held",
	waiting_on_person: "Waiting on a person",
	waiting_for_approval: "Needs approval",
	blocked: "Blocked",
	overlap: "Overlap",
	conflict: "Duplicate",
	orphan: "No purpose",
};
const SIGNAL_VARIANT: Record<WorkMapSignalKind, BadgeVariant> = {
	stalled: "warning",
	held: "error",
	waiting_on_person: "info",
	waiting_for_approval: "info",
	blocked: "warning",
	overlap: "warning",
	conflict: "warning",
	orphan: "secondary",
};
const LANE_VARIANT: Record<WorkMapLane["state"], BadgeVariant> = {
	up: "success",
	late: "warning",
	down: "error",
	stopped: "error",
	unknown: "warning",
};
const LANE_LABEL: Record<WorkMapLane["state"], string> = {
	up: "Up",
	late: "Late",
	down: "Down",
	stopped: "Stopped",
	unknown: "Unknown",
};

const since = (iso: string | null, now: number) =>
	iso ? formatDurationMs(Math.max(0, now - Date.parse(iso))) : null;

function useActorName(organizationId: string | undefined) {
	const names = useWorkPrincipalNames(organizationId);
	return (actor: WorkMapActor) =>
		actor.type === "unassigned"
			? "Nobody yet: assign an owner"
			: (names.get(`${actor.type}:${actor.id}`) ??
				(actor.type === "user"
					? "A team member"
					: actor.type === "tedi"
						? "A tedi"
						: actor.type === "external_agent"
							? "An agent"
							: actor.type === "team"
								? "A team"
								: "Tedix"));
}

/** Keys seen on an earlier visit: report what changed, not the whole state. */
function useSeen(organizationId: string | undefined, keys: string[]) {
	const storageKey = organizationId
		? `tedix.work-map.seen.${organizationId}`
		: null;
	const [seen] = useState<Set<string> | null>(() => {
		if (!storageKey || typeof localStorage === "undefined") return null;
		try {
			const raw = localStorage.getItem(storageKey);
			return raw ? new Set(JSON.parse(raw) as string[]) : null;
		} catch {
			return null;
		}
	});
	const joined = keys.join("\n");
	useEffect(() => {
		if (!storageKey || !joined) return;
		const timer = setTimeout(() => {
			try {
				localStorage.setItem(storageKey, JSON.stringify(joined.split("\n")));
			} catch {}
		}, 5_000);
		return () => clearTimeout(timer);
	}, [storageKey, joined]);
	return (key: string) => Boolean(seen && !seen.has(key));
}

export function WorkMapApp({ config }: { config: WorkMapConfig }) {
	const query = useQuery({
		...workMapQueryOptions(config.stalledAfterHours),
		refetchInterval: REFRESH_MS,
		refetchIntervalInBackground: false,
	});
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 5_000);
		return () => clearInterval(timer);
	}, []);
	const map = query.data;
	const actorName = useActorName(map?.organizationId);
	const isNew = useSeen(map?.organizationId, [
		...(map?.notMoving.map((row) => `item:${row.workItemId}:${row.kind}`) ??
			[]),
		...(map?.lanes
			.filter((lane) => lane.state !== "up")
			.map((lane) => `lane:${lane.id}:${lane.state}`) ?? []),
	]);

	return (
		<div className="grid gap-6">
			<WorkPageHeader
				title="Map"
				description="What is running, which purpose it serves, and what is not moving and who must act."
			/>
			{query.isPending ? (
				<WorkListSkeleton />
			) : !map ? (
				<WorkReadFailure
					fallback="The map could not be read. Nothing below is known until it loads."
					title="Map unavailable"
				/>
			) : (
				<>
					<Freshness
						map={map}
						failed={query.isError}
						updatedAt={query.dataUpdatedAt}
						now={now}
					/>
					<Lanes lanes={map.lanes} now={now} isNew={isNew} />
					<NotMoving map={map} now={now} actorName={actorName} isNew={isNew} />
					<PurposeTree map={map} now={now} />
				</>
			)}
		</div>
	);
}

function Freshness({
	map,
	failed,
	updatedAt,
	now,
}: {
	map: WorkMap;
	failed: boolean;
	updatedAt: number;
	now: number;
}) {
	const age = Math.max(0, now - updatedAt);
	const stale = failed || age > REFRESH_MS * 3;
	return (
		<div className="flex flex-wrap items-center gap-2" aria-live="polite">
			{stale ? (
				<Badge variant="warning">Stale</Badge>
			) : (
				<Badge variant="success">Live</Badge>
			)}
			<Text tone="secondary">
				{stale
					? `The last refresh failed. Showing what was true ${formatDurationMs(age)} ago; do not read silence as quiet.`
					: `Updated ${absoluteTime(map.readAt)}. Refreshes every ${REFRESH_MS / 1000} seconds.`}
				{map.truncated ? " Only the newest 500 open items are shown." : ""}
			</Text>
		</div>
	);
}

function Lanes({
	lanes,
	now,
	isNew,
}: {
	lanes: WorkMapLane[];
	now: number;
	isNew: (key: string) => boolean;
}) {
	return (
		<section aria-labelledby="work-map-lanes" className="grid gap-2">
			<SectionTitle id="work-map-lanes">Runners and supervisor</SectionTitle>
			{lanes.length === 0 ? (
				<Text tone="secondary">
					No supervisor has ever reported for this organization, so runner state
					is unknown.
				</Text>
			) : (
				<ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3">
					{lanes.map((lane) => (
						<li
							key={lane.id}
							className="grid gap-1 rounded-md border border-kumo-hairline p-3"
						>
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant={LANE_VARIANT[lane.state]}>
									{lane.kind === "supervisor" ? "Supervisor" : "Runner"}{" "}
									{LANE_LABEL[lane.state].toLowerCase()}
								</Badge>
								<Text weight="medium">
									{lane.kind === "supervisor"
										? lane.reporterId
										: `${lane.executor}${lane.kind === "duty" ? " task" : ""}`}
								</Text>
								{lane.state !== "up" &&
								isNew(`lane:${lane.id}:${lane.state}`) ? (
									<Badge variant="outline">New</Badge>
								) : null}
							</div>
							<Text role="label" tone="secondary">
								{lane.reportedAt
									? `Last heartbeat ${since(lane.reportedAt, now)} ago. `
									: ""}
								{lane.reason}
							</Text>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function NotMoving({
	map,
	now,
	actorName,
	isNew,
}: {
	map: WorkMap;
	now: number;
	actorName: (actor: WorkMapActor) => string;
	isNew: (key: string) => boolean;
}) {
	const [all, setAll] = useState(false);
	const rows = all ? map.notMoving : map.notMoving.slice(0, NOT_MOVING_PREVIEW);
	return (
		<section aria-labelledby="work-map-not-moving" className="grid gap-2">
			<SectionTitle id="work-map-not-moving">
				Not moving ({map.notMoving.length})
			</SectionTitle>
			<Text role="label" tone="secondary">
				Longest first. Accepted work counts as stalled after{" "}
				{map.stalledAfterHours} hours without an event.
			</Text>
			{map.notMoving.length === 0 ? (
				<WorkEmpty
					title="Everything open is moving"
					description="No open item is held, blocked, waiting on a person or quiet past the threshold."
				/>
			) : (
				<ol className="m-0 grid list-none gap-0 divide-y divide-kumo-hairline border-y border-kumo-hairline p-0">
					{rows.map((row) => (
						<li key={row.workItemId} className="grid gap-1 py-3">
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant={SIGNAL_VARIANT[row.kind]}>
									{SIGNAL_LABEL[row.kind]}
								</Badge>
								{row.since ? (
									<Text role="label" tone="secondary">
										for {since(row.since, now)}
									</Text>
								) : null}
								{isNew(`item:${row.workItemId}:${row.kind}`) ? (
									<Badge variant="outline">New</Badge>
								) : null}
								<Link href={`/work/items/${row.workItemId}`} variant="record">
									{row.title}
								</Link>
							</div>
							<Text role="label">
								<span className="font-medium">Why: </span>
								{row.blocker}
							</Text>
							<Text role="label">
								<span className="font-medium">Who must act: </span>
								{actorName(row.actor)}
								{row.interactionId ? (
									<>
										{" · "}
										<Link href={`/work/interactions/${row.interactionId}`}>
											Open the request
										</Link>
									</>
								) : null}
							</Text>
						</li>
					))}
				</ol>
			)}
			{map.notMoving.length > NOT_MOVING_PREVIEW ? (
				<div>
					<Button
						variant="secondary"
						className="min-h-11"
						onClick={() => setAll(!all)}
					>
						{all ? "Show fewer" : `Show all ${map.notMoving.length}`}
					</Button>
				</div>
			) : null}
		</section>
	);
}

function SignalBadges({ item }: { item: WorkMapItem }) {
	const kinds = [...new Set(item.signals.map((signal) => signal.kind))];
	return (
		<>
			{kinds.map((kind) => (
				<Badge key={kind} variant={SIGNAL_VARIANT[kind]}>
					{SIGNAL_LABEL[kind]}
				</Badge>
			))}
		</>
	);
}

function EpicNode({
	epic,
	tree,
	now,
	depth,
}: {
	epic: WorkMapEpic;
	tree: Tree;
	now: number;
	depth: number;
}) {
	const children = tree.itemsByParent.get(epic.id) ?? [];
	const subEpics = tree.epicsByParent.get(epic.id) ?? [];
	const stuck = children.filter((item) =>
		item.signals.some((signal) => signal.kind !== "orphan"),
	).length;
	const { progress } = epic;
	return (
		<li className="grid gap-1">
			<Collapsible defaultOpen={depth === 0 && tree.epicCount <= 8}>
				<CollapsibleDefaultTrigger>
					<span className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{epic.title}</span>
						<Text role="label" tone="secondary">
							{progress.completed} of {progress.total - progress.cancelled} done
							{progress.open ? ` · ${progress.open} open` : ""}
							{stuck ? ` · ${stuck} need attention` : ""}
						</Text>
					</span>
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<div className="grid gap-2 border-l border-kumo-hairline pl-4">
						<Meter
							label={`${epic.title} progress`}
							hideLabel
							value={Math.round(progress.percentDone * 100)}
						/>
						<Link href={`/work/items/${epic.id}`} variant="record">
							Open epic
						</Link>
						{subEpics.length ? (
							<ul className="m-0 grid list-none gap-2 p-0">
								{subEpics.map((child) => (
									<EpicNode
										key={child.id}
										epic={child}
										tree={tree}
										now={now}
										depth={depth + 1}
									/>
								))}
							</ul>
						) : null}
						{children.length ? (
							<ul className="m-0 grid list-none gap-1 p-0">
								{children
									.filter((item) => !tree.epicIds.has(item.id))
									.map((item) => (
										<li
											key={item.id}
											className="flex flex-wrap items-center gap-2"
										>
											<Link href={`/work/items/${item.id}`} variant="record">
												{item.title}
											</Link>
											<Badge variant="outline">
												{item.disposition === "proposed"
													? "Proposed"
													: item.attemptState === "running"
														? "Running"
														: "Open"}
											</Badge>
											<SignalBadges item={item} />
											{item.lastEventAt ? (
												<Text role="label" tone="secondary">
													last activity {since(item.lastEventAt, now)} ago
												</Text>
											) : null}
										</li>
									))}
							</ul>
						) : null}
					</div>
				</CollapsibleDefaultContent>
			</Collapsible>
		</li>
	);
}

type Tree = {
	epicIds: Set<string>;
	epicCount: number;
	itemsByParent: Map<string, WorkMapItem[]>;
	epicsByParent: Map<string, WorkMapEpic[]>;
};

function group<T>(rows: T[], key: (row: T) => string | null) {
	const map = new Map<string, T[]>();
	for (const row of rows) {
		const k = key(row);
		if (k) map.set(k, [...(map.get(k) ?? []), row]);
	}
	return map;
}

function PurposeTree({ map, now }: { map: WorkMap; now: number }) {
	const tree = useMemo<Tree>(() => {
		const epicIds = new Set(map.epics.map((epic) => epic.id));
		return {
			epicIds,
			epicCount: map.epics.filter(
				(epic) => !epic.parentId || !epicIds.has(epic.parentId),
			).length,
			itemsByParent: group(map.items, (item) => item.parentId),
			epicsByParent: group(map.epics, (epic) =>
				epic.parentId && epicIds.has(epic.parentId) ? epic.parentId : null,
			),
		};
	}, [map]);
	const projectName = new Map(
		map.projects.map((project) => [project.id, project]),
	);
	const objectiveTitle = new Map(map.objectives.map((o) => [o.id, o.title]));
	const roots = map.epics.filter(
		(epic) => !epic.parentId || !tree.epicIds.has(epic.parentId),
	);
	const byPurpose = group(roots, (epic) => {
		const objective =
			epic.objectiveId ??
			(epic.projectId ? projectName.get(epic.projectId)?.objectiveId : null);
		return objective
			? `objective:${objective}`
			: epic.projectId
				? `project:${epic.projectId}`
				: "none";
	});
	const loose = map.items.filter(
		(item) => !item.parentId && !tree.epicIds.has(item.id),
	);
	const orphans = loose.filter((item) =>
		item.signals.some((signal) => signal.kind === "orphan"),
	);
	return (
		<section aria-labelledby="work-map-purpose" className="grid gap-3">
			<SectionTitle id="work-map-purpose">Purpose and progress</SectionTitle>
			{roots.length === 0 ? (
				<Text tone="secondary">No epics yet: no open item has child Work.</Text>
			) : (
				[...byPurpose].map(([key, epics]) => {
					const [kind, id] = key.split(":");
					const label =
						kind === "objective"
							? `Objective: ${objectiveTitle.get(id!) ?? "Unknown objective"}`
							: kind === "project"
								? `Project: ${projectName.get(id!)?.name ?? "Unknown project"}`
								: "No objective or project";
					return (
						<div key={key} className="grid gap-2">
							<Text weight="semibold">{label}</Text>
							<ul className="m-0 grid list-none gap-2 p-0">
								{epics.map((epic) => (
									<EpicNode
										key={epic.id}
										epic={epic}
										tree={tree}
										now={now}
										depth={0}
									/>
								))}
							</ul>
						</div>
					);
				})
			)}
			<Text role="label" tone="secondary">
				{loose.length} open items are not part of an epic
				{orphans.length ? `; ${orphans.length} have no purpose at all` : ""}.
			</Text>
			{orphans.length ? (
				<Collapsible>
					<CollapsibleDefaultTrigger>
						Show items with no purpose
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent>
						<ul className="m-0 grid list-none gap-1 p-0">
							{orphans.map((item) => (
								<li key={item.id} className="flex flex-wrap items-center gap-2">
									<Link href={`/work/items/${item.id}`} variant="record">
										{item.title}
									</Link>
									<SignalBadges item={item} />
								</li>
							))}
						</ul>
					</CollapsibleDefaultContent>
				</Collapsible>
			) : null}
		</section>
	);
}
