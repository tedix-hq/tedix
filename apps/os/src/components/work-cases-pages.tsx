import {
	WorkPageHeader,
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
	workCaseDetailQueryOptions,
	workCaseListQueryOptions,
	workFleetQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import {
	OperationActor,
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

const caseFormSchema = z.object({
	title: z.string().trim().min(1, "Enter a case title."),
	ownerId: z.string().trim().min(1, "Enter an accountable owner id."),
	projectId: z.string().trim(),
});

export function WorkCasesPage() {
	useOsFormattingPreferences();
	const client = useQueryClient();
	const paging = useCursorPaging<{ at: string; id: string }>();
	const caseListOptions = workCaseListQueryOptions({
		limit: 50,
		...(paging.cursor ? { cursor: paging.cursor } : {}),
	});
	const query = useQuery(caseListOptions);
	const [caseFormOpen, setCaseFormOpen] = useState(false);
	const create = useMutation({
		mutationFn: (value: z.output<typeof caseFormSchema>) =>
			osApi.workItems.createCase({
				title: value.title,
				kind: "other",
				accountableOwnerType: "user",
				accountableOwnerId: value.ownerId,
				...(value.projectId ? { projectId: value.projectId } : {}),
			}),
		onSuccess: async () => {
			form.reset();
			setCaseFormOpen(false);
			paging.reset();
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.workCases() }),
				client.invalidateQueries({
					queryKey: workFleetQueryOptions().queryKey,
				}),
			]);
		},
	});
	const form = useZodForm({
		schema: caseFormSchema,
		defaultValues: { title: "", ownerId: "", projectId: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => create.mutate(value),
	});
	return (
		<Page width="xl">
			<WorkPageHeader
				title="Cases"
				description="Evolving investigations, incidents, customer matters, and other knowledge work. Case stage never substitutes for Work Item readiness."
				action={
					<Button
						variant={caseFormOpen ? "outline" : "default"}
						onClick={() => setCaseFormOpen((open) => !open)}
						aria-expanded={caseFormOpen}
						aria-controls="open-case-form"
					>
						{caseFormOpen ? "Close form" : "Open case"}
					</Button>
				}
			/>
			{caseFormOpen ? (
				<PageSection id="open-case-form" aria-labelledby="open-case-title">
					<SectionHeader>
						<SectionHeading>
							<SectionTitle id="open-case-title">Open a case</SectionTitle>
							<SectionDescription>
								The accountable owner is explicit; project linkage is optional.
							</SectionDescription>
						</SectionHeading>
					</SectionHeader>
					<Surface className="p-4">
						<form
							className="grid gap-3 md:grid-cols-3"
							onSubmit={(event) => {
								event.preventDefault();
								event.stopPropagation();
								void form.handleSubmit();
							}}
						>
							<FormField form={form} name="title" label="Case title">
								{(field, meta) => <FormInput field={field} {...meta} />}
							</FormField>
							<FormField
								form={form}
								name="ownerId"
								label="Accountable owner id"
							>
								{(field, meta) => <FormInput field={field} {...meta} />}
							</FormField>
							<FormField
								form={form}
								name="projectId"
								label="Project id"
								optional
							>
								{(field, meta) => <FormInput field={field} {...meta} />}
							</FormField>
							<Button type="submit" disabled={create.isPending}>
								{create.isPending ? "Opening…" : "Open case"}
							</Button>
						</form>
						<MutationError error={create.error} />
					</Surface>
				</PageSection>
			) : null}
			<PageSection aria-labelledby="case-register-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="case-register-title">Case register</SectionTitle>
						<SectionDescription>
							Current investigations and durable knowledge-work containers.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{query.isPending ? (
					<WorkListSkeleton />
				) : query.isError ? (
					<WorkReadFailure title="Cases unavailable" error={query.error} />
				) : query.data.data.length === 0 ? (
					<WorkEmpty
						title="No cases"
						description="Open a case when the next Work Items will emerge as facts arrive."
					/>
				) : (
					<>
						<Collection
							appearance="inline"
							aria-label="Cases"
							className="border-kumo-line border-y sm:hidden"
						>
							{query.data.data.map((record) => (
								<li
									key={record.id}
									className="min-w-0 space-y-1 px-3 py-2"
									data-mobile-case-row
								>
									<div className="flex min-w-0 items-start justify-between gap-3">
										<Link
											variant="record"
											href={`/work/cases/${record.id}`}
											className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center py-1 font-medium leading-snug coarse:min-h-11"
										>
											<span className="line-clamp-2">{record.title}</span>
											<Text as="span" role="label" tone="mono-secondary">
												{sentenceCase(record.kind)} · {record.id.slice(0, 8)}
											</Text>
										</Link>
										<Badge
											variant={
												record.stage === "closed" ? "outline" : "secondary"
											}
											className="mt-1 shrink-0"
										>
											{sentenceCase(record.stage)}
										</Badge>
									</div>
									<dl className="m-0 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-kumo-subtle type-tedix-label">
										<div className="min-w-0 max-w-full">
											<dt className="sr-only">Accountable owner</dt>
											<dd
												className="m-0 truncate"
												title={record.accountableOwnerId}
												data-mobile-case-owner
											>
												<OperationActor
													type={record.accountableOwnerType}
													id={record.accountableOwnerId}
												/>
											</dd>
										</div>
										<span aria-hidden="true">·</span>
										<div className="min-w-0">
											<dt className="sr-only">Horizon</dt>
											<dd className="m-0 whitespace-nowrap tabular-nums">
												{record.targetResolutionAt ? (
													<time
														dateTime={record.targetResolutionAt}
														title={absoluteTime(record.targetResolutionAt)}
													>
														{absoluteDate(record.targetResolutionAt)}
													</time>
												) : (
													"Not committed"
												)}
											</dd>
										</div>
									</dl>
								</li>
							))}
						</Collection>
						<Table scrollLabel="Cases" containerClassName="hidden sm:block">
							<TableHeader>
								<TableRow>
									<TableHead>Case</TableHead>
									<TableHead>Stage</TableHead>
									<TableHead>Owner</TableHead>
									<TableHead>Horizon</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{query.data.data.map((record) => (
									<TableRow key={record.id}>
										<TableCell className="whitespace-normal">
											<Link variant="record" href={`/work/cases/${record.id}`}>
												{record.title}
											</Link>
											<Text as="p" role="label" tone="secondary">
												{sentenceCase(record.kind)} · {record.id.slice(0, 8)}
											</Text>
										</TableCell>
										<TableCell>
											<Badge
												variant={
													record.stage === "closed" ? "outline" : "secondary"
												}
											>
												{sentenceCase(record.stage)}
											</Badge>
										</TableCell>
										<TableCell title={record.accountableOwnerId}>
											<OperationActor
												type={record.accountableOwnerType}
												id={record.accountableOwnerId}
											/>
										</TableCell>
										<TableCell>
											{record.targetResolutionAt ? (
												<time
													dateTime={record.targetResolutionAt}
													title={absoluteTime(record.targetResolutionAt)}
												>
													{absoluteDate(record.targetResolutionAt)}
												</time>
											) : (
												"Not committed"
											)}
										</TableCell>
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
			if (!query.data) throw new Error("Case is not loaded");
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
				<PageBack render={<Link href="/work/cases" />}>All cases</PageBack>
				<WorkListSkeleton />
			</Page>
		);
	if (query.isError || !query.data)
		return (
			<Page width="lg">
				<PageBack render={<Link href="/work/cases" />}>All cases</PageBack>
				<WorkReadFailure title="Case unavailable" error={query.error} />
			</Page>
		);
	const record = query.data.workCase;
	return (
		<Page width="lg">
			<PageBack render={<Link href="/work/cases" />}>All cases</PageBack>
			<WorkPageHeader
				title={record.title}
				description={`${sentenceCase(record.kind)} case · version ${record.version}`}
			/>
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Business stage</SectionTitle>
						<SectionDescription>
							Closing is a guarded CAS transition and never completes attached
							Work Items.
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
							{sentenceCase(stage)}
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
								Attach Work Item
							</Button>
							<MutationError error={attach.error} />
						</form>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Add dependency</CardTitle>
						<CardDescription>
							This case must resolve before the dependent case.
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
								label="Dependent case id"
							>
								{(field, meta) => (
									<FormInput
										field={field}
										{...meta}
										placeholder="Dependent case UUID"
									/>
								)}
							</FormField>
							<Button type="submit" disabled={dependency.isPending}>
								Add dependency
							</Button>
							<MutationError error={dependency.error} />
						</form>
					</CardContent>
				</Card>
			</div>
			<SectionCollection
				title={`Attached Work Items (${query.data.items.data.length})`}
				description="Work admitted into this case with its discovery rationale."
				empty="No Work Items attached."
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
				description="Case ordering that constrains when dependent work may proceed."
				empty="No case dependencies."
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
	dependentCaseId: z.string().trim().uuid("Enter a canonical case UUID."),
});
