import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { Alert } from "@/components/kumo/alert";
import { ConfirmDialog } from "./confirm-dialog";
import { Empty } from "@/components/kumo/empty";
import { WorkspaceListRow } from "./workspace-list-row";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card, CardContent } from "@/components/kumo/card";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/kumo/dialog";
import { Label } from "@/components/kumo/label";
import { Collection, SectionTitle } from "@/components/kumo/page";
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
			<DialogContent size="sm">
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
					<div className="grid gap-1">
						<Label htmlFor="work-start-date">Start date</Label>
						<Input
							id="work-start-date"
							type="date"
							value={start}
							onChange={(event) => setStart(event.target.value)}
						/>
					</div>
					<div className="grid gap-1">
						<Label htmlFor="work-duration-days">Duration in days</Label>
						<Input
							id="work-duration-days"
							type="number"
							min={1}
							max={3650}
							step={1}
							value={duration}
							onChange={(event) => setDuration(event.target.value)}
						/>
					</div>
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
					<DialogFooter>
						<Button type="submit" disabled={save.isPending || save.isError}>
							{save.isPending ? "Saving…" : "Save dates"}
						</Button>
					</DialogFooter>
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
	const [removing, setRemoving] = useState<{ id: string; name: string } | null>(
		null,
	);
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
		onSuccess: async () => {
			setRemoving(null);
			await refreshLinks();
		},
	});
	const removingTotal = removing
		? itemQueries[visibleIds.indexOf(removing.id)]?.data?.pagination.total
		: undefined;
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
		<WorkspaceListRow key={item.id} className="flex-wrap gap-y-1">
			<div className="min-w-0 flex-1 basis-48">
				<ItemLink item={item} />
				{effectiveProjectId === "all" && visibleIds.length > 1 ? (
					<Text role="label" tone="secondary" className="mt-0.5">
						{projectName(item.projectId)}
					</Text>
				) : null}
			</div>
			<Text role="label" tone="secondary" className="w-16">
				{label(item.priority)}
			</Text>
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
		</WorkspaceListRow>
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
					<div className="w-full sm:ml-auto sm:w-44">
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
					<Alert
						variant="destructive"
						description="Some workspace work could not be loaded. Refresh to try again."
					/>
				) : null}
				{links.isError ? null : links.isPending ||
				  itemQueries.some((query) => query.isPending) ? (
					<Text tone="secondary">Loading work…</Text>
				) : !linked.length ? (
					<Empty
						appearance="inline"
						title="No linked projects"
						description="Bring your project work into this workspace."
					>
						<Button size="sm" onClick={() => setManage(true)}>
							Link a project
						</Button>
					</Empty>
				) : !work.length ? (
					<Empty
						appearance="inline"
						title="No work to show"
						description={
							allItems.length
								? "No work matches these filters."
								: "No work in the linked projects yet."
						}
					/>
				) : view === "list" ? (
					groups
						.filter((group) => group.items.length)
						.map((group) => (
							<section
								key={group.disposition}
								aria-label={label(group.disposition)}
							>
								<SectionTitle className="mb-2">
									{label(group.disposition)}{" "}
									<Text
										as="span"
										role="label"
										tone="secondary"
										className="ml-1"
									>
										{group.items.length}
									</Text>
								</SectionTitle>
								<Collection aria-label={label(group.disposition)}>
									{group.items.map(row)}
								</Collection>
							</section>
						))
				) : view === "board" ? (
					<div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:overflow-x-auto sm:pb-3">
						{groups
							.filter((group) => !hideEmpty || group.items.length)
							.map((group) => (
								<section
									key={group.disposition}
									className="min-w-0 w-full sm:w-72 sm:shrink-0"
									aria-label={label(group.disposition)}
								>
									<SectionTitle className="mb-3">
										{label(group.disposition)}{" "}
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="ml-1"
										>
											{group.items.length}
										</Text>
									</SectionTitle>
									<div className="grid gap-2">
										{group.items.map((item) => (
											<Card key={item.id} size="sm">
												<CardContent className="grid gap-3">
													<ItemLink item={item} />
													<div className="flex items-center justify-between gap-2">
														<Text role="label" tone="secondary">
															{label(item.priority)}
														</Text>
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
				) : (
					<>
						{scheduled.length ? (
							<section
								aria-label="Scheduled work"
								className="min-w-0 rounded-lg border border-kumo-line"
							>
								<div className="hidden grid-cols-[16rem_minmax(0,1fr)] border-b border-kumo-line sm:grid">
									<Text role="label" tone="secondary" className="p-3">
										Scheduled work
									</Text>
									<div className="grid grid-cols-7 border-l border-kumo-line">
										{Array.from({ length: 7 }, (_, index) => (
											<Text
												role="label"
												tone="secondary"
												key={index}
												className="border-l border-kumo-line px-2 py-3 first:border-l-0"
											>
												{dateLabel(rangeStart + (span * index) / 7)}
											</Text>
										))}
									</div>
								</div>
								{scheduled.map((item) => {
									const duration = item.durationDays ?? 1;
									const dates = `${dateLabel(item.startAt!)} · ${duration} ${duration === 1 ? "day" : "days"}`;
									const barClassName =
										"min-w-0 sm:absolute sm:top-2 sm:left-[var(--timeline-start)] sm:w-[var(--timeline-width)] sm:overflow-hidden";
									return (
										<div
											key={item.id}
											className="grid min-w-0 gap-2 border-b border-kumo-line p-3 last:border-b-0 sm:grid-cols-[16rem_minmax(0,1fr)] sm:gap-0 sm:p-0"
											style={
												{
													"--timeline-start": `${((Date.parse(item.startAt!) - rangeStart) / span) * 100}%`,
													"--timeline-width": `${((duration * DAY) / span) * 100}%`,
												} as CSSProperties
											}
										>
											<div className="min-w-0 sm:p-3">
												<ItemLink item={item} />
											</div>
											<div className="relative min-w-0 sm:min-h-12 sm:border-l sm:border-kumo-line sm:bg-[linear-gradient(to_right,var(--color-kumo-line)_1px,transparent_1px)] sm:bg-[size:14.285714%_100%]">
												<Text
													role="label"
													tone="secondary"
													className="mb-2 sm:hidden"
												>
													{dates}
												</Text>
												{canSchedule(item) ? (
													<Button
														variant="default"
														size="sm"
														className={barClassName}
														aria-label={`Schedule ${item.title}`}
														title={`${item.title}: ${dates}`}
														onClick={() => setScheduledItem(item)}
													>
														<span className="sm:hidden">Edit dates</span>
														<span className="hidden sm:inline">
															{duration}d
														</span>
													</Button>
												) : (
													<Badge
														variant="secondary"
														className={`${barClassName} hidden sm:inline-flex`}
														title={`${item.title}: ${dates}`}
													>
														{duration}d
													</Badge>
												)}
											</div>
										</div>
									);
								})}
							</section>
						) : (
							<Text tone="secondary">
								Schedule a work item to start your timeline.
							</Text>
						)}
						{unscheduled.length ? (
							<section aria-label="Unscheduled work">
								<SectionTitle className="mb-2">
									Unscheduled{" "}
									<Text
										as="span"
										role="label"
										tone="secondary"
										className="ml-1"
									>
										{unscheduled.length}
									</Text>
								</SectionTitle>
								<Collection aria-label="Unscheduled work">
									{unscheduled.map(row)}
								</Collection>
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
						<Link href="/work/queue">Open Work for the full list</Link>.
					</Text>
				) : null}
			</div>
			<Dialog open={manage} onOpenChange={setManage}>
				<DialogContent>
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
					{attach.isError ? (
						<Text tone="error">{attach.error?.message}</Text>
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
					<Collection appearance="inline" className="max-h-80 overflow-y-auto">
						{managerProjects.map((project) => {
							const isLinked = linked.some(
								(link) => link.projectId === project.id,
							);
							return (
								<WorkspaceListRow key={project.id}>
									<div className="min-w-0 flex-1">
										<Text weight="medium">{project.name}</Text>
										<Text role="label" tone="secondary">
											{project.key}
										</Text>
									</div>
									<Button
										size="sm"
										variant={isLinked ? "ghost" : "secondary"}
										disabled={attach.isPending || remove.isPending}
										aria-label={`${isLinked ? "Remove" : "Link"} ${project.name}`}
										onClick={() => {
											if (!isLinked) return attach.mutate(project.id);
											remove.reset();
											setRemoving({ id: project.id, name: project.name });
										}}
									>
										{isLinked ? "Remove" : "Link"}
									</Button>
								</WorkspaceListRow>
							);
						})}
					</Collection>
				</DialogContent>
			</Dialog>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title={`Remove ${removing?.name ?? "this project"} from this workspace?`}
				description={
					removingTotal === undefined
						? "Its Work items will stop showing in this workspace. The project and its Work items are not changed, and you can link it again."
						: `${removingTotal} Work ${removingTotal === 1 ? "item" : "items"} will stop showing in this workspace. The project and its Work items are not changed, and you can link it again.`
				}
				confirmLabel="Remove from workspace"
				pendingLabel="Removing…"
				retryLabel="Try again"
				cancelLabel="Keep linked"
				destructive
				isPending={remove.isPending}
				error={remove.error}
				onConfirm={() => removing && remove.mutate(removing.id)}
			/>
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
