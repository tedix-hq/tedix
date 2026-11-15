import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
	WorkExecutorSchema,
	WorkItemDispositionSchema,
	type WorkExecutor,
	type WorkItem,
} from "@tedix/api-contract/schemas/work-items";
import { useId, useMemo } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
import { Label } from "@/components/kumo/label";
import { Link } from "@/components/kumo/link";
import { Page } from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import { WORK_EXECUTOR_LABELS } from "@/components/work-dispatch-app";
import {
	dispositionVariant,
	workOwnerName,
} from "@/components/work-factory-pages";
import { useWorkPrincipalNames } from "@/components/work-operations-shared";
import {
	WorkListSkeleton,
	WorkPageHeader,
	WorkReadFailure,
} from "@/components/work-surface-primitives";
import {
	projectListQueryOptions,
	workItemPagesQueryOptions,
} from "@/lib/os-query-options";
import { plainWorkText, workDate } from "@/lib/work-detail";
import type { WorkHomeSearch } from "@/lib/work-home-search";
import { OS_COPY } from "@/shared/os-copy";

type WorkItemsFilters = Pick<WorkHomeSearch, "status" | "project" | "executor">;
type WorkItemRow = Pick<
	WorkItem,
	| "id"
	| "title"
	| "disposition"
	| "priority"
	| "projectId"
	| "parentWorkItemId"
	| "accountableOwnerType"
	| "accountableOwnerId"
	| "dueDate"
	| "deadline"
	| "metadata"
	| "createdAt"
>;

const PRIORITY_LABELS: Record<WorkItem["priority"], string> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
};
const PRIORITY_ORDER = Object.keys(PRIORITY_LABELS);
const ALL = "all";

const due = (item: WorkItemRow) => item.deadline || item.dueDate;

/** Critical first; within one priority the nearest due date, undated last. */
export function sortWorkItems<T extends WorkItemRow>(items: readonly T[]): T[] {
	return [...items].sort(
		(a, b) =>
			PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
			Number(!due(a)) - Number(!due(b)) ||
			(due(a) ?? "").localeCompare(due(b) ?? "") ||
			b.createdAt.localeCompare(a.createdAt),
	);
}

function executorLabel(item: WorkItemRow): string {
	const executor = WorkExecutorSchema.safeParse(item.metadata?.executor);
	return executor.success ? WORK_EXECUTOR_LABELS[executor.data] : "Not set";
}

function Filter<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T | undefined;
	options: Record<T, string>;
	onChange: (value: T | undefined) => void;
}) {
	const id = useId();
	const items = { [ALL]: `Any ${label.toLowerCase()}`, ...options };
	return (
		<div className="grid min-w-0 gap-1">
			<Label htmlFor={id}>{label}</Label>
			<Select
				value={value ?? ALL}
				items={items}
				onValueChange={(next) =>
					onChange(!next || next === ALL ? undefined : (next as T))
				}
			>
				<SelectTrigger id={id} className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries<string>(items).map(([key, text]) => (
						<SelectItem key={key} value={key}>
							{text}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/** The epic is the parent Work Item; its title and date come from the loaded rows. */
function epicOf(item: WorkItemRow, items: readonly WorkItemRow[]) {
	if (!item.parentWorkItemId) return null;
	const parent = items.find((row) => row.id === item.parentWorkItemId);
	return {
		id: item.parentWorkItemId,
		title: parent?.title,
		due: parent && due(parent),
	};
}

export function AllWorkTable({
	items,
	projectNames,
	principalNames,
}: {
	items: readonly WorkItemRow[];
	projectNames: ReadonlyMap<string, string>;
	principalNames?: Map<string, string>;
}) {
	return (
		<Table
			scrollLabel="All work"
			mobileLayout="stacked"
			className="table-fixed sm:min-w-[72rem]"
		>
			<TableHeader>
				<TableRow>
					<TableHead className="w-[22%]">Title</TableHead>
					<TableHead className="w-[11%]">{OS_COPY.work.status}</TableHead>
					<TableHead className="w-[13%]">{OS_COPY.work.project}</TableHead>
					<TableHead className="w-[12%]">{OS_COPY.work.owner}</TableHead>
					<TableHead className="w-[11%]">Executor</TableHead>
					<TableHead className="w-[8%]">Priority</TableHead>
					<TableHead className="w-[13%]">Epic</TableHead>
					<TableHead className="w-[10%]">{OS_COPY.work.due}</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{items.map((item) => {
					const project = item.projectId
						? projectNames.get(item.projectId)
						: undefined;
					const owner = workOwnerName(
						item.accountableOwnerType,
						item.accountableOwnerId,
						principalNames,
					);
					const dueOn = due(item);
					const epic = epicOf(item, items);
					return (
						<TableRow key={item.id}>
							<TableCell className="py-2! whitespace-normal">
								<Link
									variant="record"
									href={`/work/items/${item.id}`}
									className="font-medium"
								>
									<span className="line-clamp-2">
										{plainWorkText(item.title)}
									</span>
								</Link>
							</TableCell>
							<TableCell className="py-2!" label={OS_COPY.work.status}>
								<Badge variant={dispositionVariant(item.disposition)}>
									{OS_COPY.work.dispositions[item.disposition]}
								</Badge>
							</TableCell>
							<TableCell
								className="py-2! sm:truncate"
								label={OS_COPY.work.project}
								title={project}
							>
								{item.projectId ? (
									<Link href={`/work/projects/${item.projectId}`}>
										{project ?? "Open project"}
									</Link>
								) : (
									<Text as="span" tone="secondary">
										No project
									</Text>
								)}
							</TableCell>
							<TableCell
								className="py-2! sm:truncate"
								label={OS_COPY.work.owner}
								title={owner}
							>
								{owner}
							</TableCell>
							<TableCell className="py-2! sm:truncate" label="Executor">
								{executorLabel(item)}
							</TableCell>
							<TableCell className="py-2!" label="Priority">
								{PRIORITY_LABELS[item.priority]}
							</TableCell>
							<TableCell
								className="py-2! sm:truncate"
								label="Epic"
								title={epic?.title}
							>
								{epic ? (
									<>
										<Link href={`/work/items/${epic.id}`}>
											{epic.title ? plainWorkText(epic.title) : "Open epic"}
										</Link>
										{epic.due ? (
											<Text as="span" tone="secondary">
												{" "}
												· target{" "}
												<time dateTime={epic.due}>{workDate(epic.due)}</time>
											</Text>
										) : null}
									</>
								) : (
									<Text as="span" tone="secondary">
										No epic
									</Text>
								)}
							</TableCell>
							<TableCell className="py-2!" label={OS_COPY.work.due}>
								{dueOn ? (
									<time dateTime={dueOn}>{workDate(dueOn)}</time>
								) : (
									<Text as="span" tone="secondary">
										{OS_COPY.work.noDue}
									</Text>
								)}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

/** Work → All work: every Work Item in one list, filtered in the URL. */
export function WorkItemsView({
	filters,
	onFiltersChange,
}: {
	filters: WorkItemsFilters;
	onFiltersChange: (filters: WorkItemsFilters) => void;
}) {
	const pages = useInfiniteQuery(
		workItemPagesQueryOptions({
			disposition: filters.status,
			projectId: filters.project,
			executor: filters.executor,
		}),
	);
	const projects = useQuery(projectListQueryOptions(100));
	const projectNames = useMemo(
		() =>
			new Map(
				(projects.data?.data ?? []).map((project) => [
					project.id,
					project.name,
				]),
			),
		[projects.data],
	);
	const loaded = useMemo(
		() => (pages.data?.pages ?? []).flatMap((page) => page.data),
		[pages.data],
	);
	const items = useMemo(() => sortWorkItems(loaded), [loaded]);
	const principalNames = useWorkPrincipalNames(loaded[0]?.orgId);
	const total = pages.data?.pages[0]?.pagination.total ?? 0;
	const change = (next: Partial<WorkItemsFilters>) =>
		onFiltersChange({
			status: filters.status,
			project: filters.project,
			executor: filters.executor,
			...next,
		});
	return (
		<Page width="full">
			<WorkPageHeader
				title="All work"
				description="Every Work Item, most important first."
			/>
			<div className="grid gap-3 sm:grid-cols-3 lg:max-w-3xl">
				<Filter
					label={OS_COPY.work.status}
					value={filters.status}
					options={
						Object.fromEntries(
							WorkItemDispositionSchema.options.map((status) => [
								status,
								OS_COPY.work.dispositions[status],
							]),
						) as Record<WorkItem["disposition"], string>
					}
					onChange={(status) => change({ status })}
				/>
				<Filter
					label={OS_COPY.work.project}
					value={filters.project}
					options={Object.fromEntries(projectNames)}
					onChange={(project) => change({ project })}
				/>
				<Filter<WorkExecutor>
					label="Executor"
					value={filters.executor}
					options={WORK_EXECUTOR_LABELS}
					onChange={(executor) => change({ executor })}
				/>
			</div>
			{pages.isPending ? (
				<WorkListSkeleton rows={8} label="Loading Work Items" />
			) : pages.isError && !items.length ? (
				<WorkReadFailure
					title="Work Items unavailable"
					error={pages.error}
					onRetry={() => pages.refetch()}
					retrying={pages.isRefetching}
				/>
			) : items.length ? (
				<>
					<AllWorkTable
						items={items}
						projectNames={projectNames}
						principalNames={principalNames}
					/>
					<div className="flex flex-wrap items-center gap-3">
						<Text tone="secondary" aria-live="polite">
							{pages.hasNextPage
								? `Showing the ${items.length} newest of ${total}. Priority order covers what is shown.`
								: `${total} ${total === 1 ? "Work Item" : "Work Items"}`}
						</Text>
						{pages.hasNextPage ? (
							<Button
								variant="outline"
								onClick={() => void pages.fetchNextPage()}
								disabled={pages.isFetchingNextPage}
								loading={pages.isFetchingNextPage}
							>
								Show more
							</Button>
						) : null}
					</div>
				</>
			) : (
				<Empty
					title={
						filters.status || filters.project || filters.executor
							? "No Work Items match these filters"
							: "No Work Items yet"
					}
				/>
			)}
		</Page>
	);
}
