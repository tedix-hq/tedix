import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card, CardContent } from "@/components/kumo/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import { Link } from "@/components/kumo/link";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	projectListQueryOptions,
	projectActiveAttemptsQueryOptions,
	projectMilestonesQueryOptions,
	projectSprintsQueryOptions,
	workGraphItemsQueryOptions,
	workspaceWorkProjectsQueryOptions,
	osQuery,
} from "@/lib/os-query-options";

import { WORK_PROGRESS, workProgress } from "@/lib/workspace-work-progress";

const VIEWS = [
	{ value: "list", label: "List" },
	{ value: "board", label: "Board" },
	{ value: "timeline", label: "Timeline" },
] as const;
type WorkView = (typeof VIEWS)[number]["value"];
const STATUSES = WORK_PROGRESS;
const canSchedule = (item: WorkItem) =>
	item.disposition === "proposed" || item.disposition === "accepted";
const DAY = 86_400_000;
const label = (value: string) =>
	value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
const dateLabel = (value: string | number) =>
	new Date(value).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});

function Picker({
	value,
	onChange,
	name,
	options,
}: {
	value: string;
	onChange: (value: string) => void;
	name: string;
	options: { value: string; label: string }[];
}) {
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (next !== null) onChange(next);
			}}
		>
			<SelectTrigger
				aria-label={name}
				size="sm"
				className="w-auto min-w-32 max-w-64"
			>
				<SelectValue>
					{options.find((option) => option.value === value)?.label}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function ItemLink({ item }: { item: WorkItem }) {
	return (
		<Link
			href={`/work/items/${item.id}`}
			variant="record"
			className="min-w-0 font-medium [overflow-wrap:anywhere]"
		>
			{item.title}
		</Link>
	);
}

function ScheduleDialog({
	item,
	close,
}: {
	item: WorkItem;
	close: () => void;
}) {
	const queryClient = useQueryClient();
	const [start, setStart] = useState(item.startAt?.slice(0, 10) ?? "");
	const [duration, setDuration] = useState(
		item.durationDays?.toString() ?? "1",
	);
	const [sprintId, setSprintId] = useState("none");
	const sprints = useQuery({
		...projectSprintsQueryOptions(item.projectId!),
		enabled: Boolean(item.projectId),
	});
	const refresh = async () => {
		await queryClient.invalidateQueries({ queryKey: osQuery.workItems.key() });
		if (item.projectId)
			await queryClient.invalidateQueries({
				queryKey: projectSprintsQueryOptions(item.projectId).queryKey,
			});
	};
	const save = useMutation({
		mutationFn: () =>
			osApi.workItems.updateSpecification({
				id: item.id,
				expectedWorkItemVersion: item.version,
				startAt: start ? `${start}T00:00:00.000Z` : null,
				durationDays: duration ? Number(duration) : null,
			}),
		onSuccess: async () => {
			await refresh();
			close();
		},
		onError: refresh,
	});
	const assign = useMutation({
		mutationFn: () =>
			osApi.projects.assignSprintWorkItem({
				id: item.projectId!,
				sprintId,
				workItemId: item.id,
			}),
		onSuccess: refresh,
	});
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Schedule work</DialogTitle>
					<DialogDescription>{item.title}</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<label className="grid gap-1 text-sm">
						Start date
						<Input
							type="date"
							value={start}
							onChange={(event) => setStart(event.target.value)}
						/>
					</label>
					<label className="grid gap-1 text-sm">
						Duration in days
						<Input
							type="number"
							min={1}
							max={3650}
							step={1}
							value={duration}
							onChange={(event) => setDuration(event.target.value)}
						/>
					</label>
					{save.isError ? (
						<div className="grid gap-2">
							<Text tone="error">{save.error.message}</Text>
							<Button
								type="button"
								variant="secondary"
								onClick={async () => {
									await refresh();
									close();
								}}
							>
								Reload latest
							</Button>
						</div>
					) : null}
					<Button type="submit" disabled={save.isPending || save.isError}>
						{save.isPending ? "Saving…" : "Save dates"}
					</Button>
				</form>
				{(sprints.data?.data.length ?? 0) > 0 ? (
					<div className="grid gap-2 border-t border-kumo-line pt-4">
						<Text role="caption">Sprint</Text>
						<div className="flex flex-wrap gap-2">
							<Picker
								name="Add work to sprint"
								value={sprintId}
								onChange={setSprintId}
								options={[
									{ value: "none", label: "Choose sprint" },
									...sprints
										.data!.data.filter(
											(entry) => !entry.workItemIds.includes(item.id),
										)
										.map(({ sprint }) => ({
											value: sprint.id,
											label: sprint.name,
										})),
								]}
							/>
							<Button
								variant="secondary"
								size="sm"
								disabled={
									sprintId === "none" ||
									assign.isPending ||
									Boolean(
										sprints.data?.data
											.find((entry) => entry.sprint.id === sprintId)
											?.workItemIds.includes(item.id),
									)
								}
								onClick={() => assign.mutate()}
							>
								Add to sprint
							</Button>
						</div>
						{sprints
							.data!.data.filter((entry) => entry.workItemIds.includes(item.id))
							.map(({ sprint }) => (
								<Text key={sprint.id} role="caption" tone="secondary">
									In {sprint.name}
								</Text>
							))}
						{assign.isError ? (
							<Text tone="error">{assign.error.message}</Text>
						) : null}
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

export function WorkspaceWorkPanel({ workspaceId }: { workspaceId: string }) {
	const queryClient = useQueryClient();
	const links = useQuery(workspaceWorkProjectsQueryOptions(workspaceId));
	const projects = useQuery(projectListQueryOptions(100));
	const [projectId, setProjectId] = useState("all");
	const [view, setView] = useState<WorkView>("list");
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState("all");
	const [sprintId, setSprintId] = useState("all");
	const [hideEmpty, setHideEmpty] = useState(true);
	const [manage, setManage] = useState(false);
	const [projectSearch, setProjectSearch] = useState("");
	const [scheduledItem, setScheduledItem] = useState<WorkItem | null>(null);
	const linked = links.data?.items ?? [];
	const effectiveProjectId = linked.some((link) => link.projectId === projectId)
		? projectId
		: "all";
	const visibleIds = linked
		.filter(
			(link) =>
				effectiveProjectId === "all" || link.projectId === effectiveProjectId,
		)
		.map((link) => link.projectId);
	const itemQueries = useQueries({
		queries: visibleIds.map((id) =>
			workGraphItemsQueryOptions({ projectId: id }, 100),
		),
	});
	const sprintQueries = useQueries({
		queries: visibleIds.map(projectSprintsQueryOptions),
	});
	const milestoneQueries = useQueries({
		queries: visibleIds.map((id) => projectMilestonesQueryOptions(id)),
	});
	const attemptQueries = useQueries({
		queries: visibleIds.map(projectActiveAttemptsQueryOptions),
	});
	const attempts = attemptQueries.flatMap(
		(query) => query.data?.data.map((entry) => entry.attempt) ?? [],
	);
	const allItems = itemQueries.flatMap((query) => query.data?.data ?? []);
	const sprints = sprintQueries.flatMap((query) => query.data?.data ?? []);
	const selectedSprint = sprints.find((entry) => entry.sprint.id === sprintId);
	const work = allItems.filter(
		(item) =>
			(status === "all" || workProgress(item, attempts) === status) &&
			item.title
				.toLocaleLowerCase()
				.includes(search.trim().toLocaleLowerCase()) &&
			(!selectedSprint || selectedSprint.workItemIds.includes(item.id)),
	);
	const projectName = (id: string | null) =>
		projects.data?.data.find((project) => project.id === id)?.name ??
		"Linked project";
	const managerProjects = [
		...(projects.data?.data ?? []),
		...linked
			.filter(
				(link) =>
					!projects.data?.data.some((project) => project.id === link.projectId),
			)
			.map((link) => ({
				id: link.projectId,
				name: "Linked project",
				key: link.projectId,
			})),
	]
		.filter((project) =>
			`${project.name} ${project.key}`
				.toLocaleLowerCase()
				.includes(projectSearch.toLocaleLowerCase()),
		)
		.sort(
			(a, b) =>
				Number(linked.some((link) => link.projectId === b.id)) -
				Number(linked.some((link) => link.projectId === a.id)),
		);
	const refreshLinks = () =>
		queryClient.invalidateQueries({
			queryKey: workspaceWorkProjectsQueryOptions(workspaceId).queryKey,
		});
	const attach = useMutation({
		mutationFn: (id: string) =>
			osApi.osWorkspaces.work.attachProject({ workspaceId, projectId: id }),
		onSuccess: refreshLinks,
	});
	const remove = useMutation({
		mutationFn: (id: string) => {
			const link = linked.find((entry) => entry.projectId === id);
			if (!link) throw new Error("Project is no longer linked");
			return osApi.osWorkspaces.work.removeProject({
				workspaceId,
				projectId: id,
				expectedUpdatedAt: link.updatedAt,
			});
		},
		onSuccess: refreshLinks,
	});
	const groups = STATUSES.map((disposition) => ({
		disposition,
		items: work.filter((item) => workProgress(item, attempts) === disposition),
	}));
	const scheduled = work.filter(
		(item) => item.startAt && Number.isFinite(Date.parse(item.startAt)),
	);
	const unscheduled = work.filter((item) => !item.startAt);
	const starts = scheduled.map((item) => Date.parse(item.startAt!));
	const rangeStart = starts.length
		? Math.floor(Math.min(...starts) / DAY) * DAY
		: Math.floor(Date.now() / DAY) * DAY;
	const rangeEnd = Math.max(
		rangeStart + 7 * DAY,
		...scheduled.map(
			(item) => Date.parse(item.startAt!) + (item.durationDays ?? 1) * DAY,
		),
	);
	const span = rangeEnd - rangeStart;
	const row = (item: WorkItem) => (
		<li
			key={item.id}
			className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
		>
			<div className="min-w-0 flex-1 basis-48">
				<ItemLink item={item} />
				{effectiveProjectId === "all" && visibleIds.length > 1 ? (
					<p className="mt-0.5 text-xs text-kumo-subtle">
						{projectName(item.projectId)}
					</p>
				) : null}
			</div>
			<span className="w-16 text-xs text-kumo-subtle">
				{label(item.priority)}
			</span>
			{canSchedule(item) ? (
				<Button
					size="sm"
					variant="ghost"
					aria-label={`Schedule ${item.title}`}
					onClick={() => setScheduledItem(item)}
				>
					{item.startAt ? dateLabel(item.startAt) : "Schedule"}
				</Button>
			) : (
				<Text role="caption" tone="secondary">
					{item.startAt ? dateLabel(item.startAt) : "Unscheduled"}
				</Text>
			)}
		</li>
	);

	return (
		<section
			aria-label="Workspace Work"
			className="min-h-0 min-w-0 flex-1 overflow-auto"
		>
			<header className="sticky top-0 z-10 grid gap-3 border-b border-kumo-line bg-kumo-base px-4 py-3 md:px-6">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Picker
						name="Work project"
						value={effectiveProjectId}
						onChange={(id) => {
							setProjectId(id);
							setSprintId("all");
						}}
						options={[
							{ value: "all", label: "All projects" },
							...linked.map((link) => ({
								value: link.projectId,
								label: projectName(link.projectId),
							})),
						]}
					/>
					<Button variant="ghost" size="sm" onClick={() => setManage(true)}>
						Manage projects
					</Button>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<SegmentedControl
						ariaLabel="Work view"
						compact
						options={VIEWS}
						value={view}
						onValueChange={setView}
					/>
					<div className="ml-auto w-44">
						<Input
							size="sm"
							aria-label="Search work"
							placeholder="Search work…"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
					</div>
					<Picker
						name="Work status"
						value={status}
						onChange={setStatus}
						options={[
							{ value: "all", label: "All statuses" },
							...STATUSES.map((value) => ({ value, label: label(value) })),
						]}
					/>
					{sprints.length ? (
						<Picker
							name="Work sprint"
							value={selectedSprint ? sprintId : "all"}
							onChange={setSprintId}
							options={[
								{ value: "all", label: "All sprints" },
								...sprints.map(({ sprint }) => ({
									value: sprint.id,
									label: sprint.name,
								})),
							]}
						/>
					) : null}
					{view === "board" ? (
						<Button
							size="sm"
							variant="ghost"
							aria-pressed={hideEmpty}
							onClick={() => setHideEmpty(!hideEmpty)}
						>
							{hideEmpty ? "Show empty groups" : "Hide empty groups"}
						</Button>
					) : null}
				</div>
			</header>
			<div className="grid gap-5 p-4 md:p-6">
				{attemptQueries.some(
					(query) => query.isError || query.data?.hasMore,
				) ? (
					<Text role="caption" tone="secondary">
						Some live progress is unavailable; work without a current attempt
						shows its accepted status.
					</Text>
				) : null}
				{sprintQueries.some((query) => query.isError) ? (
					<Text role="caption" tone="secondary">
						Sprint filters could not be loaded.
					</Text>
				) : null}
				{links.isError || itemQueries.some((query) => query.isError) ? (
					<Text tone="error">
						Some workspace work could not be loaded. Refresh to try again.
					</Text>
				) : null}
				{links.isError ? null : links.isPending ||
				  itemQueries.some((query) => query.isPending) ? (
					<Text tone="secondary">Loading work…</Text>
				) : !linked.length ? (
					<div className="grid justify-items-start gap-2">
						<Text>Bring your project work into this workspace.</Text>
						<Button size="sm" onClick={() => setManage(true)}>
							Link a project
						</Button>
					</div>
				) : !work.length ? (
					<Text tone="secondary">
						{allItems.length
							? "No work matches these filters."
							: "No work in the linked projects yet."}
					</Text>
				) : view === "list" ? (
					groups
						.filter((group) => group.items.length)
						.map((group) => (
							<section
								key={group.disposition}
								aria-label={label(group.disposition)}
							>
								<h3 className="mb-2 text-sm font-medium">
									{label(group.disposition)}{" "}
									<span className="ml-1 text-kumo-subtle">
										{group.items.length}
									</span>
								</h3>
								<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
									{group.items.map(row)}
								</ul>
							</section>
						))
				) : view === "board" ? (
					<div className="min-w-0 overflow-x-auto pb-3">
						<div className="flex items-start gap-4">
							{groups
								.filter((group) => !hideEmpty || group.items.length)
								.map((group) => (
									<section
										key={group.disposition}
										className="w-72 shrink-0"
										aria-label={label(group.disposition)}
									>
										<h3 className="mb-3 text-sm font-medium">
											{label(group.disposition)}{" "}
											<span className="ml-1 text-kumo-subtle">
												{group.items.length}
											</span>
										</h3>
										<div className="grid gap-2">
											{group.items.map((item) => (
												<Card key={item.id}>
													<CardContent className="grid gap-3 p-3">
														<ItemLink item={item} />
														<div className="flex items-center justify-between gap-2">
															<span className="text-xs text-kumo-subtle">
																{label(item.priority)}
															</span>
															{canSchedule(item) ? (
																<Button
																	size="sm"
																	variant="ghost"
																	aria-label={`Schedule ${item.title}`}
																	onClick={() => setScheduledItem(item)}
																>
																	{item.startAt
																		? dateLabel(item.startAt)
																		: "Schedule"}
																</Button>
															) : (
																<Text role="caption" tone="secondary">
																	{item.startAt
																		? dateLabel(item.startAt)
																		: "Unscheduled"}
																</Text>
															)}
														</div>
													</CardContent>
												</Card>
											))}
											{!group.items.length ? (
												<Text role="caption" tone="secondary">
													No work
												</Text>
											) : null}
										</div>
									</section>
								))}
						</div>
					</div>
				) : (
					<>
						{scheduled.length ? (
							<div className="min-w-0 overflow-x-auto rounded-lg border border-kumo-line">
								<div className="min-w-[52rem]">
									<div className="grid grid-cols-[16rem_1fr] border-b border-kumo-line text-xs text-kumo-subtle">
										<div className="p-3">Scheduled work</div>
										<div className="grid grid-cols-7 border-l border-kumo-line">
											{Array.from({ length: 7 }, (_, index) => (
												<div
													key={index}
													className="border-l border-kumo-line px-2 py-3 first:border-l-0"
												>
													{dateLabel(rangeStart + (span * index) / 7)}
												</div>
											))}
										</div>
									</div>
									{scheduled.map((item) => (
										<div
											key={item.id}
											className="grid grid-cols-[16rem_1fr] border-b border-kumo-line last:border-b-0"
										>
											<div className="truncate p-3">
												<ItemLink item={item} />
											</div>
											<div className="relative min-h-12 border-l border-kumo-line bg-[linear-gradient(to_right,var(--color-kumo-line)_1px,transparent_1px)] bg-[size:14.285714%_100%]">
												{canSchedule(item) ? (
													<Button
														variant="default"
														size="sm"
														className="absolute top-2 overflow-hidden"
														style={{
															left: `${((Date.parse(item.startAt!) - rangeStart) / span) * 100}%`,
															width: `${(((item.durationDays ?? 1) * DAY) / span) * 100}%`,
															minWidth: 0,
														}}
														aria-label={`Schedule ${item.title}`}
														title={`${item.title}: ${dateLabel(item.startAt!)} · ${item.durationDays ?? 1} days`}
														onClick={() => setScheduledItem(item)}
													>
														{item.durationDays ?? 1}d
													</Button>
												) : (
													<span
														className="absolute top-2 overflow-hidden rounded-md bg-kumo-tint px-2 py-1 text-xs"
														style={{
															left: `${((Date.parse(item.startAt!) - rangeStart) / span) * 100}%`,
															width: `${(((item.durationDays ?? 1) * DAY) / span) * 100}%`,
															minWidth: 0,
														}}
														title={`${item.title}: ${dateLabel(item.startAt!)} · ${item.durationDays ?? 1} days`}
													>
														{item.durationDays ?? 1}d
													</span>
												)}
											</div>
										</div>
									))}
								</div>
							</div>
						) : (
							<Text tone="secondary">
								Schedule a work item to start your timeline.
							</Text>
						)}
						{unscheduled.length ? (
							<section aria-label="Unscheduled work">
								<h3 className="mb-2 text-sm font-medium">
									Unscheduled{" "}
									<span className="ml-1 text-kumo-subtle">
										{unscheduled.length}
									</span>
								</h3>
								<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
									{unscheduled.map(row)}
								</ul>
							</section>
						) : null}
						{milestoneQueries.flatMap((query) => query.data?.data ?? [])
							.length ? (
							<div className="flex flex-wrap gap-2">
								{milestoneQueries
									.flatMap((query) => query.data?.data ?? [])
									.map(({ milestone }) => (
										<Badge key={milestone.id} variant="outline">
											◆ {milestone.title}
											{milestone.targetAt
												? ` · ${dateLabel(milestone.targetAt)}`
												: ""}
										</Badge>
									))}
							</div>
						) : null}
					</>
				)}
				{itemQueries.some(
					(query) =>
						(query.data?.pagination.total ?? 0) >
						(query.data?.data.length ?? 0),
				) ? (
					<Text role="caption" tone="secondary">
						Showing the first 100 items per project.{" "}
						<Link href="/work">Open Work for the full list</Link>.
					</Text>
				) : null}
			</div>
			<Dialog open={manage} onOpenChange={setManage}>
				<DialogContent className="max-w-lg">
					<DialogHeader>
						<DialogTitle>Manage projects</DialogTitle>
						<DialogDescription>
							Link projects to see their work in this workspace.
						</DialogDescription>
					</DialogHeader>
					<Input
						aria-label="Search projects"
						placeholder="Search projects…"
						value={projectSearch}
						onChange={(event) => setProjectSearch(event.target.value)}
					/>
					{projects.isError ? (
						<Text tone="error">Projects could not be loaded.</Text>
					) : null}
					{attach.isError || remove.isError ? (
						<Text tone="error">
							{attach.error?.message ?? remove.error?.message}
						</Text>
					) : null}
					{projects.isPending ? (
						<Text tone="secondary">Loading projects…</Text>
					) : !managerProjects.length ? (
						<Text tone="secondary">No projects match your search.</Text>
					) : null}
					{(projects.data?.pagination?.total ?? 0) >
					(projects.data?.data.length ?? 0) ? (
						<Text role="caption" tone="secondary">
							Showing the first 100 projects.
						</Text>
					) : null}
					<ul className="max-h-80 divide-y divide-kumo-line overflow-y-auto">
						{managerProjects.map((project) => {
							const isLinked = linked.some(
								(link) => link.projectId === project.id,
							);
							return (
								<li key={project.id} className="flex items-center gap-3 py-3">
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium">{project.name}</p>
										<p className="text-xs text-kumo-subtle">{project.key}</p>
									</div>
									<Button
										size="sm"
										variant={isLinked ? "ghost" : "secondary"}
										disabled={attach.isPending || remove.isPending}
										aria-label={`${isLinked ? "Remove" : "Link"} ${project.name}`}
										onClick={() =>
											isLinked
												? remove.mutate(project.id)
												: attach.mutate(project.id)
										}
									>
										{isLinked ? "Remove" : "Link"}
									</Button>
								</li>
							);
						})}
					</ul>
				</DialogContent>
			</Dialog>
			{scheduledItem ? (
				<ScheduleDialog
					key={scheduledItem.id}
					item={scheduledItem}
					close={() => setScheduledItem(null)}
				/>
			) : null}
		</section>
	);
}
