import {
	WorkPageHeader,
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useContext, useMemo, useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { WorkActorOwnerContext } from "@/components/work-actor-avatar";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { FormField } from "@/components/kumo/forms/form-field";
import { Input } from "@/components/kumo/input";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Link } from "@/components/kumo/link";
import {
	Collection,
	Page,
	PageBack,
	PageSection,
	SectionCollection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { useOsFormattingPreferences, sentenceCase } from "@/lib/format";
import { absoluteDate, absoluteTime } from "@/lib/time";
import {
	membersListQueryOptions,
	projectPortfolioQueryOptions,
	workCaseDetailQueryOptions,
	workCaseListQueryOptions,
	workFleetQueryOptions,
	workItemDetailQueryOptions,
	workItemListQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import {
	OperationActor,
	OperationPicker,
	MutationError,
	useCursorPaging,
	PageControls,
} from "./work-operations-shared";

const CASE_STAGES = [
	"investigating",
	"planning",
	"executing",
	"monitoring",
	"closed",
] as const;

/** Plain names for an epic's stage; the stored values stay as they are. */
export const WORK_STREAM_STAGE_LABELS = {
	investigating: "Looking into it",
	planning: "Planning",
	executing: "In progress",
	monitoring: "Watching",
	closed: "Closed",
} as const satisfies Record<(typeof CASE_STAGES)[number], string>;

function stageVariant(stage: (typeof CASE_STAGES)[number]) {
	if (stage === "closed") return "outline" as const;
	if (stage === "executing") return "success" as const;
	return "secondary" as const;
}

function StageBadge({
	stage,
	className,
}: {
	stage: (typeof CASE_STAGES)[number];
	className?: string;
}) {
	return (
		<Badge variant={stageVariant(stage)} className={className}>
			{WORK_STREAM_STAGE_LABELS[stage]}
		</Badge>
	);
}

function DueDate({ at }: { at: string }) {
	return (
		<time dateTime={at} title={absoluteTime(at)}>
			Due {absoluteDate(at)}
		</time>
	);
}

const caseFormSchema = z.object({
	title: z.string().trim().min(1, "Give the epic a name."),
});

/** Project names by id, from the shared Projects read. */
function useProjectNames() {
	const portfolio = useQuery(projectPortfolioQueryOptions());
	return useMemo(
		() =>
			new Map(
				(portfolio.data?.data ?? []).map((row) => [
					row.project.id,
					row.project.name,
				]),
			),
		[portfolio.data],
	);
}

export function WorkCasesRoute() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	return pathname.replace(/\/$/, "").endsWith("/work/cases") ? (
		<WorkCasesPage />
	) : (
		<Outlet />
	);
}

function NewWorkStreamForm({
	projects,
	onCreated,
}: {
	projects: ReadonlyMap<string, string>;
	onCreated: () => Promise<void>;
}) {
	const currentUserId = useContext(WorkActorOwnerContext);
	const context = useOsOperationalContext();
	const organizationId = context.data?.organization?.id ?? "";
	const members = useQuery({
		...membersListQueryOptions({ organizationId, limit: 100, offset: 0 }),
		enabled: Boolean(organizationId),
	});
	const [ownerId, setOwnerId] = useState(currentUserId ?? "");
	const [projectId, setProjectId] = useState("");
	const create = useMutation({
		mutationFn: (value: z.output<typeof caseFormSchema>) =>
			osApi.workItems.createCase({
				title: value.title,
				kind: "other",
				accountableOwnerType: "user",
				accountableOwnerId: ownerId || currentUserId || "",
				...(projectId ? { projectId } : {}),
			}),
		onSuccess: async () => {
			form.reset();
			setProjectId("");
			await onCreated();
		},
	});
	const form = useZodForm({
		schema: caseFormSchema,
		defaultValues: { title: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => create.mutate(value),
	});
	const ownerOptions = (members.data?.data ?? []).map((member) => ({
		value: member.descopeUserId,
		label: member.name || member.email,
	}));
	const projectOptions = [...projects]
		.map(([value, label]) => ({ value, label }))
		.sort((a, b) => a.label.localeCompare(b.label));
	return (
		<Surface className="p-4">
			<form
				className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					void form.handleSubmit();
				}}
			>
				<FormField form={form} name="title" label="Name">
					{(field, meta) => <FormInput field={field} {...meta} />}
				</FormField>
				<div className="grid min-w-0 gap-1">
					<Text as="span" role="label" tone="secondary">
						Owner
					</Text>
					<OperationPicker
						label="Choose owner"
						options={ownerOptions}
						value={ownerId}
						onSelect={setOwnerId}
					/>
				</div>
				<div className="grid min-w-0 gap-1">
					<Text as="span" role="label" tone="secondary">
						Project (optional)
					</Text>
					<OperationPicker
						label="Choose project"
						options={projectOptions}
						value={projectId}
						onSelect={setProjectId}
					/>
				</div>
				<Button
					type="submit"
					disabled={create.isPending || !(ownerId || currentUserId)}
				>
					{create.isPending ? "Creating…" : "Create"}
				</Button>
			</form>
			<MutationError error={create.error} />
		</Surface>
	);
}

export function WorkCasesPage() {
	useOsFormattingPreferences();
	const client = useQueryClient();
	const paging = useCursorPaging<{ at: string; id: string }>();
	const caseListOptions = workCaseListQueryOptions({
		limit: 50,
		...(paging.cursor ? { cursor: paging.cursor } : {}),
	});
	const query = useQuery(caseListOptions);
	const projects = useProjectNames();
	const [caseFormOpen, setCaseFormOpen] = useState(false);
	const records = query.data?.data ?? [];
	const anyDue = records.some((record) => record.targetResolutionAt);
	const context = (record: (typeof records)[number]) =>
		[
			record.projectId ? projects.get(record.projectId) : null,
			record.kind === "other" ? null : sentenceCase(record.kind),
		]
			.filter(Boolean)
			.join(" · ");
	return (
		<Page width="xl">
			<WorkPageHeader
				title="Epics"
				description="Bigger pieces of work inside a project, like an incident, an investigation or a feature. An epic groups several tasks and has one owner."
				action={
					<Button
						variant={caseFormOpen ? "outline" : "default"}
						onClick={() => setCaseFormOpen((open) => !open)}
						aria-expanded={caseFormOpen}
						aria-controls="open-case-form"
					>
						{caseFormOpen ? "Cancel" : "New epic"}
					</Button>
				}
			/>
			{caseFormOpen ? (
				<PageSection id="open-case-form" aria-label="New epic">
					<NewWorkStreamForm
						projects={projects}
						onCreated={async () => {
							setCaseFormOpen(false);
							paging.reset();
							await Promise.all([
								client.invalidateQueries({ queryKey: osQueryKeys.workCases() }),
								client.invalidateQueries({
									queryKey: workFleetQueryOptions().queryKey,
								}),
							]);
						}}
					/>
				</PageSection>
			) : null}
			<PageSection aria-label="Epics">
				{query.isPending ? (
					<WorkListSkeleton />
				) : query.isError ? (
					<WorkReadFailure title="Epics unavailable" error={query.error} />
				) : records.length === 0 ? (
					<WorkEmpty
						title="No epics yet"
						description="Start one when a piece of work will need several tasks, and more will turn up as you go."
					/>
				) : (
					<>
						<Collection
							appearance="inline"
							aria-label="Epics"
							className="border-kumo-line border-y sm:hidden"
						>
							{records.map((record) => (
								<li
									key={record.id}
									className="min-w-0 space-y-1 px-3 py-2"
									data-mobile-case-row
								>
									<div className="flex min-w-0 items-start justify-between gap-3">
										<Link
											variant="record"
											href={`/work/cases/${record.id}`}
											className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center py-1 font-medium leading-snug"
										>
											<span className="line-clamp-2">{record.title}</span>
											{context(record) ? (
												<Text as="span" role="label" tone="secondary">
													{context(record)}
												</Text>
											) : null}
										</Link>
										<StageBadge
											stage={record.stage}
											className="mt-1 shrink-0"
										/>
									</div>
									<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-kumo-subtle type-tedix-label">
										<span className="min-w-0 max-w-full" data-mobile-case-owner>
											<OperationActor
												type={record.accountableOwnerType}
												id={record.accountableOwnerId}
											/>
										</span>
										{record.targetResolutionAt ? (
											<span className="tabular-nums" data-mobile-case-due>
												<DueDate at={record.targetResolutionAt} />
											</span>
										) : null}
									</div>
								</li>
							))}
						</Collection>
						<Table scrollLabel="Epics" containerClassName="hidden sm:block">
							<TableHeader>
								<TableRow>
									<TableHead>Epic</TableHead>
									<TableHead>Stage</TableHead>
									<TableHead>Owner</TableHead>
									{anyDue ? <TableHead>Due</TableHead> : null}
								</TableRow>
							</TableHeader>
							<TableBody>
								{records.map((record) => (
									<TableRow key={record.id}>
										<TableCell className="whitespace-normal">
											<Link variant="record" href={`/work/cases/${record.id}`}>
												{record.title}
											</Link>
											{context(record) ? (
												<Text as="p" role="label" tone="secondary">
													{context(record)}
												</Text>
											) : null}
										</TableCell>
										<TableCell>
											<StageBadge stage={record.stage} />
										</TableCell>
										<TableCell>
											<OperationActor
												type={record.accountableOwnerType}
												id={record.accountableOwnerId}
											/>
										</TableCell>
										{anyDue ? (
											<TableCell className="tabular-nums">
												{record.targetResolutionAt ? (
													<DueDate at={record.targetResolutionAt} />
												) : null}
											</TableCell>
										) : null}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</>
				)}
				<PageControls
					hasPrevious={paging.hasPrevious}
					hasNext={Boolean(query.data?.nextCursor)}
					onPrevious={paging.reset}
					onBack={paging.previous}
					onNext={() => {
						if (query.data?.nextCursor) paging.next(query.data.nextCursor);
					}}
				/>
			</PageSection>
		</Page>
	);
}

/** Typed text shorter than this lists the project's tasks instead of searching. */
const TASK_SEARCH_MIN = 2;

/** Tasks to offer for attaching: the project's own, or a title search across the organization. */
function useTaskOptions(
	projectId: string | null,
	search: string,
	attached: ReadonlySet<string>,
) {
	const text = search.trim();
	const searching = text.length >= TASK_SEARCH_MIN;
	const tasks = useQuery(
		workItemListQueryOptions({
			limit: 20,
			...(searching ? { titleContains: text } : {}),
			...(!searching && projectId ? { projectId } : {}),
		}),
	);
	return (tasks.data?.data ?? [])
		.filter((item) => !attached.has(item.id))
		.map((item) => ({ value: item.id, label: item.title }));
}

/** Titles of the attached tasks on this page, read one by one (the page is bounded). */
function useTaskTitles(ids: readonly string[]) {
	const reads = useQueries({
		queries: ids.map((id) => workItemDetailQueryOptions(id)),
	});
	return new Map(
		ids.map(
			(id, index) => [id, reads[index]?.data?.workItem?.title ?? null] as const,
		),
	);
}

export function WorkCasePage({ caseId }: { caseId: string }) {
	const client = useQueryClient();
	const itemPaging = useCursorPaging<string>();
	const dependencyPaging = useCursorPaging<string>();
	const detailOptions = workCaseDetailQueryOptions(
		caseId,
		itemPaging.cursor,
		dependencyPaging.cursor,
	);
	const query = useQuery(detailOptions);
	const projects = useProjectNames();
	const streams = useQuery(workCaseListQueryOptions());
	const streamTitles = new Map(
		(streams.data?.data ?? []).map((row) => [row.id, row.title]),
	);
	const attachedIds = (query.data?.items.data ?? []).map(
		(item) => item.workItemId,
	);
	const taskTitles = useTaskTitles(attachedIds);
	const [taskSearch, setTaskSearch] = useState("");
	const [taskId, setTaskId] = useState("");
	const [taskLabel, setTaskLabel] = useState("");
	const [rationale, setRationale] = useState("");
	const [dependentId, setDependentId] = useState("");
	const taskOptions = useTaskOptions(
		query.data?.workCase.projectId ?? null,
		taskSearch,
		new Set(attachedIds),
	);
	const refresh = () =>
		Promise.all([
			client.invalidateQueries({
				queryKey: detailOptions.queryKey,
			}),
			client.invalidateQueries({
				queryKey: workCaseDetailQueryOptions(caseId).queryKey,
			}),
			client.invalidateQueries({ queryKey: osQueryKeys.workCases() }),
			client.invalidateQueries({ queryKey: workFleetQueryOptions().queryKey }),
		]);
	const update = useMutation({
		mutationFn: (stage: (typeof CASE_STAGES)[number]) => {
			if (!query.data) throw new Error("Epic is not loaded");
			return osApi.workItems.updateCase({
				caseId,
				expectedVersion: query.data.workCase.version,
				stage,
			});
		},
		onSuccess: refresh,
	});
	const attach = useMutation({
		mutationFn: () =>
			osApi.workItems.attachCaseWorkItem({
				caseId,
				workItemId: taskId,
				...(rationale.trim() ? { rationale: rationale.trim() } : {}),
			}),
		onSuccess: async () => {
			setTaskId("");
			setTaskLabel("");
			setRationale("");
			itemPaging.reset();
			await refresh();
		},
	});
	const dependency = useMutation({
		mutationFn: () =>
			osApi.workItems.addCaseDependency({
				fromCaseId: caseId,
				toCaseId: dependentId,
			}),
		onSuccess: async () => {
			setDependentId("");
			dependencyPaging.reset();
			await refresh();
		},
	});
	if (query.isPending)
		return (
			<Page width="lg">
				<PageBack render={<Link href="/work/cases" />}>All epics</PageBack>
				<WorkListSkeleton />
			</Page>
		);
	if (query.isError || !query.data)
		return (
			<Page width="lg">
				<PageBack render={<Link href="/work/cases" />}>All epics</PageBack>
				<WorkReadFailure title="Epic unavailable" error={query.error} />
			</Page>
		);
	const record = query.data.workCase;
	const streamOptions = (streams.data?.data ?? [])
		.filter((row) => row.id !== caseId)
		.map((row) => ({ value: row.id, label: row.title }));
	const streamName = (id: string) => streamTitles.get(id) ?? "Another epic";
	return (
		<Page width="lg">
			<PageBack render={<Link href="/work/cases" />}>All epics</PageBack>
			<WorkPageHeader
				title={record.title}
				description={[
					record.projectId ? projects.get(record.projectId) : null,
					record.kind === "other" ? null : sentenceCase(record.kind),
					WORK_STREAM_STAGE_LABELS[record.stage],
				]
					.filter(Boolean)
					.join(" · ")}
			/>
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Stage</SectionTitle>
						<SectionDescription>
							Closing an epic does not finish its tasks.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<div className="flex flex-wrap gap-2">
					{CASE_STAGES.map((stage) => (
						<Button
							key={stage}
							size="sm"
							variant={
								stage === record.stage
									? "secondary"
									: stage === "closed"
										? "destructive"
										: "outline"
							}
							disabled={update.isPending || stage === record.stage}
							onClick={() => update.mutate(stage)}
						>
							{update.isPending && update.variables === stage
								? `Moving to ${WORK_STREAM_STAGE_LABELS[stage]}…`
								: WORK_STREAM_STAGE_LABELS[stage]}
						</Button>
					))}
				</div>
			</PageSection>
			<MutationError error={update.error} />
			<div className="grid gap-3 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Add a task</CardTitle>
						<CardDescription>
							Search by title. Without a search you see this project&apos;s
							tasks.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<form
							className="grid gap-3"
							data-attach-task-form
							onSubmit={(event) => {
								event.preventDefault();
								if (taskId && !attach.isPending) attach.mutate();
							}}
						>
							<OperationPicker
								label="Choose a task"
								options={taskOptions}
								value={taskId}
								selectedLabel={taskLabel}
								onSearch={setTaskSearch}
								onSelect={(id) => {
									setTaskId(id);
									setTaskLabel(
										taskOptions.find((option) => option.value === id)?.label ??
											"",
									);
								}}
							/>
							<Input
								aria-label="Why it belongs here (optional)"
								placeholder="Why it belongs here (optional)"
								value={rationale}
								onChange={(event) => setRationale(event.target.value)}
							/>
							<Button type="submit" disabled={!taskId || attach.isPending}>
								{attach.isPending ? "Adding…" : "Add task"}
							</Button>
							<MutationError error={attach.error} />
						</form>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Add a dependency</CardTitle>
						<CardDescription>
							Pick the epic that has to wait until this one is done.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<form
							className="grid gap-3"
							data-add-dependency-form
							onSubmit={(event) => {
								event.preventDefault();
								if (dependentId && !dependency.isPending) dependency.mutate();
							}}
						>
							<OperationPicker
								label="Choose an epic"
								options={streamOptions}
								value={dependentId}
								onSelect={setDependentId}
							/>
							<Button
								type="submit"
								disabled={!dependentId || dependency.isPending}
							>
								{dependency.isPending ? "Adding…" : "Add dependency"}
							</Button>
							<MutationError error={dependency.error} />
						</form>
					</CardContent>
				</Card>
			</div>
			<SectionCollection
				title={`Tasks (${query.data.items.data.length})`}
				description="Tasks in this epic and why each belongs here."
				empty="No tasks yet."
				footer={
					<PageControls
						hasPrevious={itemPaging.hasPrevious}
						hasNext={Boolean(query.data.items.nextCursor)}
						onPrevious={itemPaging.reset}
						onBack={itemPaging.previous}
						onNext={() => {
							if (query.data.items.nextCursor)
								itemPaging.next(query.data.items.nextCursor);
						}}
					/>
				}
			>
				{query.data.items.data.length
					? query.data.items.data.map((item) => (
							<Text as="li" role="body" key={item.id} data-case-task>
								<Link href={`/work/items/${item.workItemId}`}>
									{taskTitles.get(item.workItemId) ?? "Task"}
								</Link>
								{item.rationale ? ` — ${item.rationale}` : ""}
							</Text>
						))
					: undefined}
			</SectionCollection>
			<SectionCollection
				title={`Dependencies (${query.data.dependencies.data.length})`}
				description="Epics that must finish before others can go ahead."
				empty="No dependencies."
				footer={
					<PageControls
						hasPrevious={dependencyPaging.hasPrevious}
						hasNext={Boolean(query.data.dependencies.nextCursor)}
						onPrevious={dependencyPaging.reset}
						onBack={dependencyPaging.previous}
						onNext={() => {
							if (query.data.dependencies.nextCursor)
								dependencyPaging.next(query.data.dependencies.nextCursor);
						}}
					/>
				}
			>
				{query.data.dependencies.data.length
					? query.data.dependencies.data.map((edge) => {
							const waiting = edge.fromCaseId === caseId;
							const other = waiting ? edge.toCaseId : edge.fromCaseId;
							const link = (
								<Link href={`/work/cases/${other}`}>{streamName(other)}</Link>
							);
							return (
								<Text as="li" role="body" key={edge.id} data-case-dependency>
									{waiting ? (
										<>{link} waits for this one</>
									) : (
										<>This one waits for {link}</>
									)}
								</Text>
							);
						})
					: undefined}
			</SectionCollection>
		</Page>
	);
}
