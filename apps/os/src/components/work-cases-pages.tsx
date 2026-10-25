import {
	WorkPageHeader,
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

/** Plain names for a work stream's stage; the stored values stay as they are. */
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
	title: z.string().trim().min(1, "Give the work stream a name."),
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
				title="Work streams"
				description="Bigger pieces of work inside a project, such as a sprint, an incident or an investigation. Each one groups several tasks and has one owner."
				action={
					<Button
						variant={caseFormOpen ? "outline" : "default"}
						onClick={() => setCaseFormOpen((open) => !open)}
						aria-expanded={caseFormOpen}
						aria-controls="open-case-form"
					>
						{caseFormOpen ? "Cancel" : "New work stream"}
					</Button>
				}
			/>
			{caseFormOpen ? (
				<PageSection id="open-case-form" aria-label="New work stream">
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
			<PageSection aria-label="Work streams">
				{query.isPending ? (
					<WorkListSkeleton />
				) : query.isError ? (
					<WorkReadFailure
						title="Work streams unavailable"
						error={query.error}
					/>
				) : records.length === 0 ? (
					<WorkEmpty
						title="No work streams yet"
						description="Start one when a piece of work will need several tasks, and more will turn up as you go."
					/>
				) : (
					<>
						<Collection
							appearance="inline"
							aria-label="Work streams"
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
						<Table
							scrollLabel="Work streams"
							containerClassName="hidden sm:block"
						>
							<TableHeader>
								<TableRow>
									<TableHead>Work stream</TableHead>
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
			if (!query.data) throw new Error("Work stream is not loaded");
			return osApi.workItems.updateCase({
				caseId,
				expectedVersion: query.data.workCase.version,
				stage,
			});
		},
		onSuccess: refresh,
	});
	const attach = useMutation({
		mutationFn: (value: z.output<typeof caseAttachmentSchema>) =>
			osApi.workItems.attachCaseWorkItem({
				caseId,
				workItemId: value.workItemId,
				...(value.rationale ? { rationale: value.rationale } : {}),
			}),
		onSuccess: async () => {
			attachmentForm.reset();
			itemPaging.reset();
			await refresh();
		},
	});
	const attachmentForm = useZodForm({
		schema: caseAttachmentSchema,
		defaultValues: { workItemId: "", rationale: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => attach.mutate(value),
	});
	const dependency = useMutation({
		mutationFn: (value: z.output<typeof caseDependencySchema>) =>
			osApi.workItems.addCaseDependency({
				fromCaseId: caseId,
				toCaseId: value.dependentCaseId,
			}),
		onSuccess: async () => {
			dependencyForm.reset();
			dependencyPaging.reset();
			await refresh();
		},
	});
	const dependencyForm = useZodForm({
		schema: caseDependencySchema,
		defaultValues: { dependentCaseId: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => dependency.mutate(value),
	});
	if (query.isPending)
		return (
			<Page width="lg">
				<PageBack render={<Link href="/work/cases" />}>
					All work streams
				</PageBack>
				<WorkListSkeleton />
			</Page>
		);
	if (query.isError || !query.data)
		return (
			<Page width="lg">
				<PageBack render={<Link href="/work/cases" />}>
					All work streams
				</PageBack>
				<WorkReadFailure title="Work stream unavailable" error={query.error} />
			</Page>
		);
	const record = query.data.workCase;
	return (
		<Page width="lg">
			<PageBack render={<Link href="/work/cases" />}>All work streams</PageBack>
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
							Closing a work stream does not finish its tasks.
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
						<CardTitle>Attach discovered work</CardTitle>
					</CardHeader>
					<CardContent>
						<form
							className="grid gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								void attachmentForm.handleSubmit();
							}}
						>
							<FormField
								form={attachmentForm}
								name="workItemId"
								label="Work Item id"
							>
								{(field, meta) => (
									<FormInput
										field={field}
										{...meta}
										placeholder="Work Item UUID"
									/>
								)}
							</FormField>
							<FormField
								form={attachmentForm}
								name="rationale"
								label="Rationale"
								optional
							>
								{(field, meta) => (
									<FormInput
										field={field}
										{...meta}
										placeholder="Why this work belongs here"
									/>
								)}
							</FormField>
							<Button type="submit" disabled={attach.isPending}>
								{attach.isPending ? "Attaching…" : "Attach Work Item"}
							</Button>
							<MutationError error={attach.error} />
						</form>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Add dependency</CardTitle>
						<CardDescription>
							This work stream must finish before the one that depends on it.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<form
							className="grid gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								void dependencyForm.handleSubmit();
							}}
						>
							<FormField
								form={dependencyForm}
								name="dependentCaseId"
								label="Dependent work stream id"
							>
								{(field, meta) => (
									<FormInput
										field={field}
										{...meta}
										placeholder="Work stream id"
									/>
								)}
							</FormField>
							<Button type="submit" disabled={dependency.isPending}>
								{dependency.isPending ? "Adding…" : "Add dependency"}
							</Button>
							<MutationError error={dependency.error} />
						</form>
					</CardContent>
				</Card>
			</div>
			<SectionCollection
				title={`Tasks (${query.data.items.data.length})`}
				description="Tasks in this work stream and why each belongs here."
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
							<Text as="li" role="body" key={item.id}>
								<Link href={`/work/items/${item.workItemId}`}>
									{item.workItemId}
								</Link>
								{item.rationale ? ` — ${item.rationale}` : ""}
							</Text>
						))
					: undefined}
			</SectionCollection>
			<SectionCollection
				title={`Dependencies (${query.data.dependencies.data.length})`}
				description="Work streams that must finish before others can go ahead."
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
					? query.data.dependencies.data.map((edge) => (
							<Text
								as="li"
								role="label"
								tone="mono"
								key={edge.id}
								className="tabular-nums"
							>
								{edge.fromCaseId} → {edge.toCaseId}
							</Text>
						))
					: undefined}
			</SectionCollection>
		</Page>
	);
}

const caseAttachmentSchema = z.object({
	workItemId: z.string().trim().uuid("Enter a canonical Work Item UUID."),
	rationale: z.string().trim(),
});

const caseDependencySchema = z.object({
	dependentCaseId: z.string().trim().uuid("Enter a work stream id."),
});
