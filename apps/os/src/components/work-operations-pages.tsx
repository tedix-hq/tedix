import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import { useEffect, useState, type ReactNode } from "react";
import * as z from "zod";
import { markdownLineToPlainText } from "@tedix/api-contract/utils/markdown-plain-text";
import { ChatMarkdown } from "@/components/chat-markdown";
import { WorkAttentionSummary } from "@/components/work-attention-summary";
import { ApprovalManifestReview } from "@/components/approval-manifest";
import { ApprovalProvenanceHistory } from "@/components/approval-provenance";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import {
	InteractionDraftReply,
	latestDraftOf,
} from "@/components/work-interaction-draft";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { CodeBlock } from "@/components/kumo/code";
import { DateTimePicker } from "@/components/kumo/date-picker";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { ResponsiveFormSurface } from "@/components/kumo/responsive-form-surface";
import {
	Collection,
	Page,
	PageActions,
	PageBack,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionCollection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { SelectItem } from "@/components/kumo/select";
import { Skeleton } from "@/components/kumo/skeleton";
import { Switch } from "@/components/kumo/switch";
import { KumoTabs } from "@/components/kumo/tabs";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { sentenceCase } from "@/lib/format";
import {
	pendingApprovalsQueryOptions,
	membersListQueryOptions,
	tediRosterQueryOptions,
	workExternalPrincipalsQueryOptions,
	workAdmissionSpecificationQueryOptions,
	workApprovalsQueryOptions,
	workBudgetEnvelopesQueryOptions,
	workCaseDetailQueryOptions,
	workCaseListQueryOptions,
	workExecutionClustersQueryOptions,
	workFleetQueryOptions,
	workInteractionDetailQueryOptions,
	workInteractionsQueryOptions,
	workItemReadinessQueryOptions,
	workItemDetailQueryOptions,
	osQueryKeys,
	workResourcePoolsQueryOptions,
	workSchedulerQueryOptions,
	workUrgentInteractionsQueryOptions,
} from "@/lib/os-query-options";
import { useDocumentTitle } from "@/lib/use-document-title";
import { workPrincipalLabel } from "@/lib/work-display";

export function workCapacitySearch(search: Record<string, unknown>) {
	const resourceKey =
		typeof search.resourceKey === "string" &&
		search.resourceKey.length > 0 &&
		search.resourceKey.length <= 300
			? search.resourceKey
			: undefined;
	const explicit =
		search.saturated === true || search.saturated === "true"
			? true
			: search.saturated === false || search.saturated === "false"
				? false
				: undefined;
	return {
		resourceKey,
		saturated: explicit ?? !resourceKey,
		view:
			search.view === "budgets" ? ("budgets" as const) : ("resources" as const),
		exhausted: search.exhausted === true || search.exhausted === "true",
	};
}

export function ResourcePressureLinks({
	resourceKeys,
}: {
	resourceKeys: string[];
}) {
	return (
		<>
			{resourceKeys.slice(0, 8).map((resourceKey) => (
				<Text as="p" role="body" key={resourceKey}>
					<Link
						href={`/work/capacity?resourceKey=${encodeURIComponent(resourceKey)}`}
					>
						{resourceKey}
					</Link>
				</Text>
			))}
			{resourceKeys.length > 8 ? (
				<Link href="/work/capacity?saturated=true">
					See all {resourceKeys.length} saturated pools
				</Link>
			) : null}
		</>
	);
}

export function namedWorkPrincipal(
	type: string | undefined,
	id: string | null | undefined,
	names: ReadonlyMap<string, string>,
) {
	return (
		names.get(`${type}:${id}`) ??
		workPrincipalLabel(id ?? null, type ? sentenceCase(type) : "Recipient")
	);
}

function useWorkPrincipalNames(organizationId?: string) {
	const tedis = useQuery({
		...tediRosterQueryOptions(100),
		enabled: Boolean(organizationId),
		retry: false,
	});
	const members = useQuery({
		...membersListQueryOptions({
			organizationId: organizationId ?? "",
			limit: 100,
			offset: 0,
		}),
		enabled: Boolean(organizationId),
		retry: false,
	});
	const external = useQuery({
		...workExternalPrincipalsQueryOptions(organizationId ?? ""),
		enabled: Boolean(organizationId),
		retry: false,
	});
	const names = new Map<string, string>();
	for (const tedi of tedis.data?.data ?? [])
		names.set(`tedi:${tedi.id}`, tedi.displayName || tedi.name);
	for (const member of members.data?.data ?? [])
		names.set(`user:${member.descopeUserId}`, member.name || member.email);
	for (const principal of external.data ?? [])
		names.set(`external_agent:${principal.id}`, principal.displayName);
	return names;
}

function Header({
	title,
	description,
	action,
}: {
	title: string;
	description: ReactNode;
	action?: ReactNode;
}) {
	useDocumentTitle(`${title} · Work`);
	return (
		<PageHeader>
			<PageHeading>
				<PageTitle>{title}</PageTitle>
				<PageDescription>{description}</PageDescription>
			</PageHeading>
			{action ? <PageActions>{action}</PageActions> : null}
		</PageHeader>
	);
}

function Loading() {
	return (
		<div className="grid gap-2" aria-label="Loading">
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-10 w-full" />
		</div>
	);
}

function Failure({ title, error }: { title: string; error?: unknown }) {
	return (
		<Alert variant="destructive">
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>
				{error instanceof Error ? error.message : "The canonical read failed."}
			</AlertDescription>
		</Alert>
	);
}

function None({ title, description }: { title: string; description: string }) {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

function MutationError({ error }: { error: unknown }) {
	return error ? <Failure title="Write rejected" error={error} /> : null;
}

export function ApprovalRequestError({ error }: { error: unknown }) {
	if (
		error instanceof Error &&
		error.message === "Requester cannot approve its own proposal"
	) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Choose a different approver</AlertTitle>
				<AlertDescription>
					You cannot request approval from yourself. Choose another approver, or
					use the inbox above to approve an existing request assigned to you.
				</AlertDescription>
			</Alert>
		);
	}
	return <MutationError error={error} />;
}

export function useCursorPaging<T>() {
	const [cursor, setCursor] = useState<T | undefined>();
	const [history, setHistory] = useState<(T | undefined)[]>([]);
	return {
		cursor,
		hasPrevious: history.length > 0,
		next(nextCursor: T) {
			setHistory((current) => [...current, cursor]);
			setCursor(nextCursor);
		},
		previous() {
			setCursor(history.at(-1));
			setHistory(history.slice(0, -1));
		},
		reset() {
			setCursor(undefined);
			setHistory([]);
		},
	};
}

export function PageControls({
	hasPrevious,
	hasNext,
	onPrevious,
	onBack,
	onNext,
	label,
}: {
	label?: string;
	hasPrevious: boolean;
	hasNext: boolean;
	onPrevious: () => void;
	onBack?: () => void;
	onNext: () => void;
}) {
	if (!hasPrevious && !hasNext) return null;
	return (
		<div className="flex gap-2">
			<Button variant="outline" disabled={!hasPrevious} onClick={onPrevious}>
				{label ? `First ${label} page` : "First page"}
			</Button>
			{onBack ? (
				<Button variant="outline" disabled={!hasPrevious} onClick={onBack}>
					{label ? `Previous ${label} page` : "Back"}
				</Button>
			) : null}
			<Button variant="outline" disabled={!hasNext} onClick={onNext}>
				{label ? `Next ${label} page` : "Next page"}
			</Button>
		</div>
	);
}

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
			<Header
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
					<Loading />
				) : query.isError ? (
					<Failure title="Cases unavailable" error={query.error} />
				) : query.data.data.length === 0 ? (
					<None
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
												Owner: {workPrincipalLabel(record.accountableOwnerId)}
											</dd>
										</div>
										<span aria-hidden="true">·</span>
										<div className="min-w-0">
											<dt className="sr-only">Horizon</dt>
											<dd className="m-0 whitespace-nowrap tabular-nums">
												{record.targetResolutionAt
													? new Date(
															record.targetResolutionAt,
														).toLocaleDateString()
													: "Not committed"}
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
											{workPrincipalLabel(record.accountableOwnerId)}
										</TableCell>
										<TableCell>
											{record.targetResolutionAt
												? new Date(
														record.targetResolutionAt,
													).toLocaleDateString()
												: "Not committed"}
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
				<Loading />
			</Page>
		);
	if (query.isError || !query.data)
		return (
			<Page width="lg">
				<PageBack render={<Link href="/work/cases" />}>All cases</PageBack>
				<Failure title="Case unavailable" error={query.error} />
			</Page>
		);
	const record = query.data.workCase;
	return (
		<Page width="lg">
			<PageBack render={<Link href="/work/cases" />}>All cases</PageBack>
			<Header
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

const approvalProposalSchema = z.object({
	workItemId: z.string().trim().min(1, "Enter a Work Item id."),
	workItemVersion: z
		.string()
		.regex(/^\d+$/, "Enter a valid Work Item version.")
		.transform(Number)
		.refine((value) => value >= 1, "Version must be at least 1."),
	proposalJson: z.string().refine((value) => {
		try {
			JSON.parse(value);
			return true;
		} catch {
			return false;
		}
	}, "Enter valid proposal JSON."),
	authorityKey: z.string().trim().min(1, "Enter an authority key."),
	approverType: z.enum(["user", "tedi"]),
	approverId: z.string().trim().min(1, "Enter an approver id."),
	requestRationale: z
		.string()
		.trim()
		.min(1, "Explain why authority is needed."),
	expiresAt: z.date().nullable().refine(Boolean, "Choose an expiry."),
});

export function WorkApprovalsPage() {
	const client = useQueryClient();
	const paging = useCursorPaging<{ at: string; id: string }>();
	const approvalOptions = workApprovalsQueryOptions(paging.cursor);
	const query = useQuery(approvalOptions);
	const runtimeApprovals = useQuery(pendingApprovalsQueryOptions());
	const [selectedRuntimeIds, setSelectedRuntimeIds] = useState<string[]>([]);
	const [reviewRuntimeIds, setReviewRuntimeIds] = useState<string[]>([]);
	const [rationales, setRationales] = useState<Record<string, string>>({});
	const [mobileProposalOpen, setMobileProposalOpen] = useState(false);
	const propose = useMutation({
		mutationFn: (value: z.output<typeof approvalProposalSchema>) =>
			osApi.workApprovals.propose({
				workItemId: value.workItemId,
				workItemVersion: value.workItemVersion,
				proposal: JSON.parse(value.proposalJson) as never,
				authorityKey: value.authorityKey,
				approverType: value.approverType,
				approverId: value.approverId,
				requestRationale: value.requestRationale,
				expiresAt: value.expiresAt?.toISOString() ?? "",
			}),
		onSuccess: async (_result, value) => {
			form.setFieldValue("proposalJson", "{}");
			form.setFieldValue("requestRationale", "");
			paging.reset();
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.workApprovals() }),
				client.invalidateQueries({
					queryKey: workItemReadinessQueryOptions(value.workItemId).queryKey,
				}),
				client.invalidateQueries({
					queryKey: workSchedulerQueryOptions().queryKey,
				}),
				client.invalidateQueries({
					queryKey: workFleetQueryOptions().queryKey,
				}),
			]);
		},
	});
	const form = useZodForm({
		schema: approvalProposalSchema,
		defaultValues: {
			workItemId: "",
			workItemVersion: "1",
			proposalJson: "{}",
			authorityKey: "",
			approverType: "user",
			approverId: "",
			requestRationale: "",
			expiresAt: null,
		},
		validateOn: "submit",
		onSubmit: ({ value }) => propose.mutate(value),
	});
	const decide = useMutation({
		mutationFn: ({
			proposalId,
			version,
			decision,
		}: {
			proposalId: string;
			version: number;
			decision: "approved" | "rejected";
			workItemId: string;
		}) =>
			osApi.workApprovals.decide({
				proposalId,
				expectedProposalVersion: version,
				decision,
				rationale: rationales[proposalId]?.trim() ?? "",
			}),
		onSuccess: async (_value, variables) => {
			paging.reset();
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.workApprovals() }),
				client.invalidateQueries({
					queryKey: workItemReadinessQueryOptions(variables.workItemId)
						.queryKey,
				}),
				client.invalidateQueries({
					queryKey: workSchedulerQueryOptions().queryKey,
				}),
				client.invalidateQueries({
					queryKey: workFleetQueryOptions().queryKey,
				}),
			]);
		},
	});
	useEffect(() => {
		const currentIds = new Set(
			(runtimeApprovals.data?.data ?? []).map((approval) => approval.id),
		);
		setSelectedRuntimeIds((ids) => {
			const next = ids.filter((id) => currentIds.has(id));
			return next.length === ids.length ? ids : next;
		});
	}, [runtimeApprovals.data]);
	const approvalRows = query.data?.data ?? [];
	const pendingDecisions = approvalRows.filter(
		({ effectiveStatus, canDecide }) =>
			effectiveStatus === "pending" && canDecide,
	);
	const proposalHistory = approvalRows.filter(
		({ effectiveStatus, canDecide }) =>
			effectiveStatus !== "pending" || !canDecide,
	);
	return (
		<Page width="xl">
			<Header
				title="Approvals"
				description="Review runtime decisions and Work admission authority without crossing their separate governance boundaries."
			/>
			<PageSection aria-labelledby="runtime-approvals-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="runtime-approvals-title">
							Runtime approvals
						</SectionTitle>
						<SectionDescription>
							Actions paused by a tedi, Gadget, or automation. Resolve only
							after reviewing the request, evidence, expiry, and exact bound
							payload.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{selectedRuntimeIds.length > 0 ? (
					<div className="flex flex-wrap items-center gap-2">
						<Text as="span" role="label">
							{selectedRuntimeIds.length} of 25 selected
						</Text>
						<Button
							disabled={reviewRuntimeIds.length > 0}
							onClick={() => setReviewRuntimeIds([...selectedRuntimeIds])}
						>
							Review selected requests
						</Button>
						<Button
							variant="outline"
							disabled={reviewRuntimeIds.length > 0}
							onClick={() => setSelectedRuntimeIds([])}
						>
							Clear selection
						</Button>
					</div>
				) : null}
				{reviewRuntimeIds.length > 0 ? (
					<ApprovalManifestReview
						key={reviewRuntimeIds.join(":")}
						approvalRequestIds={reviewRuntimeIds}
						onClose={() => {
							setReviewRuntimeIds([]);
							setSelectedRuntimeIds([]);
						}}
					/>
				) : null}
				{runtimeApprovals.isPending ? (
					<Loading />
				) : runtimeApprovals.isError ? (
					<Failure
						title="Runtime approvals unavailable"
						error={runtimeApprovals.error}
					/>
				) : runtimeApprovals.data.data.length === 0 ? (
					<None
						title="No runtime decisions need attention"
						description="Tedi, Gadget, and automation approvals will appear here when they pause for a signed-in human."
					/>
				) : (
					<ul className="m-0 grid list-none gap-2 p-0">
						{runtimeApprovals.data.data.map((approval) => (
							<Surface
								key={approval.id}
								className="grid gap-3 px-3 py-3"
								render={<li />}
							>
								<div className="flex flex-wrap items-start justify-between gap-2">
									<div className="grid min-w-0 gap-1">
										<Text as="strong" role="body" tone="strong">
											{approval.description}
										</Text>
										<Text as="span" role="label" tone="secondary">
											{approval.review.operatorQuestion}
										</Text>
									</div>
									<div className="flex flex-wrap items-center gap-1.5">
										<Badge variant="warning">Awaiting approval</Badge>
										<Badge variant="outline">
											{sentenceCase(approval.review.intent)}
										</Badge>
									</div>
								</div>
								<Text as="p" role="body" className="m-0">
									{approval.review.summary}
								</Text>
								<div className="flex flex-wrap gap-x-4 gap-y-1">
									<Text as="span" role="label" tone="secondary">
										Expires {new Date(approval.expiresAt).toLocaleString()}
									</Text>
									<Text as="span" role="label" tone="mono-secondary">
										{approval.id}
									</Text>
								</div>
								<details className="text-kumo-subtle text-xs">
									<summary className="cursor-pointer text-kumo-default">
										Exact payload and evidence
									</summary>
									<CodeBlock
										className="mt-2 max-h-64 overflow-auto"
										code={JSON.stringify(
											{
												payload: approval.payload,
												evidenceRefs: approval.review.evidenceRefs,
												timeout: approval.review.timeout,
											},
											null,
											2,
										)}
										lang="json"
										showCopyButton
									/>
								</details>
								{approval.review.decisionMode === "approve_or_reject" ? (
									<div className="flex flex-wrap gap-2">
										<Button
											variant="outline"
											aria-pressed={selectedRuntimeIds.includes(approval.id)}
											disabled={
												reviewRuntimeIds.length > 0 ||
												(!selectedRuntimeIds.includes(approval.id) &&
													selectedRuntimeIds.length >= 25)
											}
											onClick={() =>
												setSelectedRuntimeIds((ids) =>
													ids.includes(approval.id)
														? ids.filter((id) => id !== approval.id)
														: [...ids, approval.id],
												)
											}
										>
											{selectedRuntimeIds.includes(approval.id)
												? "Remove from review"
												: "Add to ordered review"}
										</Button>
										<Button
											disabled={
												reviewRuntimeIds.length > 0 ||
												selectedRuntimeIds.length > 0
											}
											onClick={() => {
												setSelectedRuntimeIds([approval.id]);
												setReviewRuntimeIds([approval.id]);
											}}
										>
											Review exact request
										</Button>
									</div>
								) : null}
							</Surface>
						))}
					</ul>
				)}
			</PageSection>
			<PageSection aria-label="Runtime approval history">
				<ApprovalProvenanceHistory />
			</PageSection>
			<PageSection aria-labelledby="work-admission-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="work-admission-title">
							Work admission authority
						</SectionTitle>
						<SectionDescription>
							Immutable authority proposals that gate Work Item admission.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{query.isPending ? (
					<Loading />
				) : query.isError ? (
					<Failure title="Approvals unavailable" error={query.error} />
				) : approvalRows.length === 0 ? (
					<None
						title="No approval proposals"
						description="There are no Work-scoped proposals in this bounded inbox."
					/>
				) : (
					<>
						{pendingDecisions.length ? (
							<div className="grid gap-3" aria-label="Pending decisions">
								{pendingDecisions.map(
									({ proposal, effectiveStatus, canDecide, workItem }) => (
										<Card key={proposal.id}>
											<CardHeader>
												<CardTitle>
													{workItem ? (
														<Link
															variant="record"
															href={`/work/items/${workItem.id}`}
														>
															{workItem.title}
														</Link>
													) : (
														`Work Item ${proposal.workItemId}`
													)}
												</CardTitle>
												<CardDescription>
													{proposal.action} ·{" "}
													{JSON.stringify(proposal.proposal)}
												</CardDescription>
											</CardHeader>
											<CardContent className="grid gap-2">
												<div className="flex flex-wrap gap-2">
													<Badge
														variant={
															effectiveStatus === "approved"
																? "success"
																: effectiveStatus === "rejected"
																	? "error"
																	: "warning"
														}
													>
														{sentenceCase(effectiveStatus)}
													</Badge>
													<Badge variant="outline">
														{proposal.authorityKey}
													</Badge>
													<Text as="span" role="body" tone="secondary">
														Version {proposal.version} · expires{" "}
														{new Date(proposal.expiresAt).toLocaleString()}
													</Text>
												</div>
												<Text as="p" role="body" className="m-0">
													{proposal.requestRationale}
												</Text>
												{effectiveStatus === "pending" && canDecide ? (
													<>
														<Textarea
															aria-label={`Rationale for ${proposal.id}`}
															placeholder="Decision rationale"
															value={rationales[proposal.id] ?? ""}
															onChange={(event) =>
																setRationales((current) => ({
																	...current,
																	[proposal.id]: event.target.value,
																}))
															}
														/>
														<div className="flex gap-2">
															<Button
																disabled={
																	!rationales[proposal.id]?.trim() ||
																	decide.isPending
																}
																onClick={() =>
																	decide.mutate({
																		proposalId: proposal.id,
																		version: proposal.version,
																		decision: "approved",
																		workItemId: proposal.workItemId,
																	})
																}
															>
																Approve exact proposal
															</Button>
															<Button
																variant="destructive"
																disabled={
																	!rationales[proposal.id]?.trim() ||
																	decide.isPending
																}
																onClick={() =>
																	decide.mutate({
																		proposalId: proposal.id,
																		version: proposal.version,
																		decision: "rejected",
																		workItemId: proposal.workItemId,
																	})
																}
															>
																Reject
															</Button>
														</div>
													</>
												) : null}
											</CardContent>
										</Card>
									),
								)}
							</div>
						) : null}
						<Collapsible>
							<CollapsibleTrigger>
								Other decisions and history ({proposalHistory.length})
							</CollapsibleTrigger>
							<CollapsibleContent>
								<SectionCollection
									title="Other decisions and history"
									description="Past decisions and pending decisions assigned to other approvers."
									empty="No observational approval records."
								>
									{proposalHistory.length
										? proposalHistory.map(
												({ proposal, effectiveStatus, workItem }) => (
													<li
														key={proposal.id}
														className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
													>
														<div className="grid min-w-0 gap-1">
															<Text
																as="strong"
																role="body"
																tone="strong"
																className="truncate"
															>
																{workItem ? (
																	<Link
																		variant="record"
																		href={`/work/items/${workItem.id}`}
																	>
																		{workItem.title}
																	</Link>
																) : (
																	`Work Item ${proposal.workItemId}`
																)}
															</Text>
															<Text as="span" role="label" tone="secondary">
																{proposal.action} · {proposal.requestRationale}
															</Text>
														</div>
														<div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
															<Badge
																variant={
																	effectiveStatus === "approved"
																		? "success"
																		: effectiveStatus === "rejected"
																			? "error"
																			: "warning"
																}
															>
																{sentenceCase(effectiveStatus)}
															</Badge>
															<Badge variant="outline">
																{proposal.authorityKey}
															</Badge>
														</div>
													</li>
												),
											)
										: undefined}
								</SectionCollection>
							</CollapsibleContent>
						</Collapsible>
					</>
				)}
				<MutationError error={decide.error} />
				<PageControls
					hasPrevious={paging.hasPrevious}
					hasNext={Boolean(query.data?.hasMore && query.data.nextCursor)}
					onPrevious={paging.reset}
					onBack={paging.previous}
					onNext={() => {
						if (query.data?.nextCursor) paging.next(query.data.nextCursor);
					}}
				/>
				<ResponsiveFormSurface
					title="Request approval"
					description="Create a new request for a different approver. To approve an existing request, use its decision card in the inbox above."
					mobileDescription="Request approval from someone else. Existing requests are decided in the inbox."
					mobileOpen={mobileProposalOpen}
					onMobileOpenChange={setMobileProposalOpen}
				>
					<form
						className="grid gap-3 md:grid-cols-2"
						onSubmit={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void form.handleSubmit();
						}}
					>
						{(
							[
								["workItemId", "Work Item id"],
								["workItemVersion", "Work Item version"],
								["authorityKey", "Authority key"],
								["approverId", "Approver id"],
							] as const
						).map(([name, label]) => (
							<FormField key={name} form={form} name={name} label={label}>
								{(field, meta) => <FormInput field={field} {...meta} />}
							</FormField>
						))}
						<FormField form={form} name="approverType" label="Approver type">
							{(field, meta) => (
								<FormSelect field={field} {...meta}>
									<SelectItem value="user">User</SelectItem>
									<SelectItem value="tedi">Tedi</SelectItem>
								</FormSelect>
							)}
						</FormField>
						<FormField form={form} name="expiresAt" label="Expiry">
							{(field, meta) => (
								<DateTimePicker
									id={meta.id}
									aria-label="Approval expiry"
									aria-describedby={meta.errorId ?? meta.descriptionId}
									aria-invalid={meta.invalid}
									min={new Date()}
									onChange={field.handleChange}
									value={field.state.value}
								/>
							)}
						</FormField>
						<FormField
							form={form}
							name="requestRationale"
							label="Request rationale"
						>
							{(field, meta) => <FormTextarea field={field} {...meta} />}
						</FormField>
						<FormField form={form} name="proposalJson" label="Proposal JSON">
							{(field, meta) => (
								<FormTextarea
									field={field}
									{...meta}
									className="min-h-32 font-mono"
								/>
							)}
						</FormField>
						<Button
							className="md:col-span-2"
							disabled={propose.isPending}
							type="submit"
						>
							Send approval request
						</Button>
						<ApprovalRequestError error={propose.error} />
					</form>
				</ResponsiveFormSurface>
			</PageSection>
		</Page>
	);
}

const interactionRequestSchema = z.object({
	contextType: z.enum(["work_item", "case", "project"]),
	contextId: z.string().trim().min(1, "Enter a context id."),
	kind: z.enum(["question", "input", "handoff", "coordination"]),
	subject: z.string().trim().min(1, "Enter a subject."),
	prompt: z.string().trim().min(1, "Enter the requested input."),
	targetType: z.enum(["user", "tedi", "external_agent"]),
	targetId: z.string().trim().min(1, "Enter a target principal id."),
});

export function workInteractionsSearch(search: Record<string, unknown>): {
	view: "inbox" | "outbox" | "audit";
	state: "open" | "all";
} {
	return {
		view:
			search.view === "outbox" || search.view === "audit"
				? search.view
				: ("inbox" as const),
		state: search.state === "open" ? ("open" as const) : ("all" as const),
	};
}

const URGENT_LABEL_TEXT: Record<string, string> = {
	blocker_or_failure: "Blocked",
	human_only_action: "Needs you to act",
	risky_action: "Risky action",
};

const urgentInteractionMetadataSchema = z.object({
	host: z.string().optional(),
	sessionId: z.string().optional(),
	repository: z.string().optional(),
	triage: z.object({ urgentLabels: z.array(z.string()).optional() }).optional(),
});

/** Triage labels in plain words, deduplicated; unknown labels stay readable. */
function urgentReasons(labels: readonly string[] | undefined) {
	return [...new Set(labels ?? [])].map(
		(label) => URGENT_LABEL_TEXT[label] ?? sentenceCase(label),
	);
}

const DECISION_CAPTURE_SCHEMA = "tedix.decision-capture.v1";
const DECISION_CAPTURE_HOSTS: Record<string, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
};

const decisionCaptureMetadataSchema = z.object({
	schema: z.literal(DECISION_CAPTURE_SCHEMA),
	host: z.string().optional(),
	sessionId: z.string().optional(),
	repository: z.string().optional(),
	branch: z.string().nullish(),
	triage: z
		.object({
			urgency: z.string().optional(),
			urgentLabels: z.array(z.string()).optional(),
		})
		.optional()
		.catch(undefined),
	/** The server's verdict: `fyi` asks nothing of the user; `need` says what. */
	attention: z
		.object({
			kind: z.enum(["needs_you", "fyi"]),
			need: z.string().nullish(),
		})
		.optional()
		.catch(undefined),
});

/**
 * Where a decision-capture question came from and why it waits, or null for
 * any other Interaction. The question is the agent's own turn-end message in
 * the user's local session, not a message from another person. An `fyi` turn
 * (a status update) is never urgent; `need` is the one-line ask of a turn that
 * needs the user, when the server could write it.
 */
export function decisionCaptureSummary(metadata: unknown) {
	const parsed = decisionCaptureMetadataSchema.safeParse(metadata);
	if (!parsed.success) return null;
	const value = parsed.data;
	const host = value.host
		? (DECISION_CAPTURE_HOSTS[value.host] ?? value.host)
		: "agent";
	const attention = value.attention?.kind ?? null;
	const urgency =
		attention === "fyi"
			? "later"
			: value.triage?.urgency === "now" || value.triage?.urgency === "later"
				? value.triage.urgency
				: null;
	return {
		source: `your ${host} session`,
		origin: [`From your ${host} session`, value.repository, value.branch]
			.filter((part): part is string => Boolean(part))
			.join(" · "),
		sessionId: value.sessionId,
		shortSessionId: value.sessionId?.slice(0, 8),
		urgency,
		reasons: urgency === "now" ? urgentReasons(value.triage?.urgentLabels) : [],
		attention,
		need:
			attention === "needs_you" ? value.attention?.need?.trim() || null : null,
	};
}

/**
 * The subject as plain text. For a captured turn that needs the user, its
 * one-line need ("What's needed from you") replaces the agent's first line.
 * Decision-capture subjects come from the agent's Markdown; rows written
 * before the CLI stripped it still carry the markers.
 */
export function interactionSubject(request: {
	subject: string;
	metadata?: unknown;
}) {
	const summary = decisionCaptureSummary(request.metadata);
	if (!summary) return request.subject;
	return (
		summary.need || markdownLineToPlainText(request.subject) || request.subject
	);
}

/** Plain-language reasons and origin for one triaged agent-turn request. */
export function urgentInteractionSummary(metadata: unknown) {
	const parsed = urgentInteractionMetadataSchema.safeParse(metadata);
	const value = parsed.success ? parsed.data : {};
	return {
		reasons: urgentReasons(value.triage?.urgentLabels),
		origin: [
			value.repository,
			value.host,
			value.sessionId ? `session ${value.sessionId.slice(0, 8)}` : undefined,
		].filter((part): part is string => Boolean(part)),
		sessionId: value.sessionId,
	};
}

/**
 * Each turn end of a captured agent session opens a new question, so one busy
 * session floods the inbox. Within the loaded page, an open decision-capture
 * question shows only as the newest of its session, at that row's position;
 * the older open ones from the same session travel with it as `earlier`
 * (newest first). Every other row passes through unchanged and alone.
 */
export function groupSessionQuestions<
	T extends {
		request: { id: string; requestedAt: string; metadata?: unknown };
		effectiveState: string;
	},
>(rows: readonly T[]): Array<{ row: T; earlier: T[] }> {
	const sessionOf = (row: T) =>
		row.effectiveState === "open"
			? decisionCaptureSummary(row.request.metadata)?.sessionId
			: undefined;
	const sessions = new Map<string, T[]>();
	for (const row of rows) {
		const session = sessionOf(row);
		if (session) sessions.set(session, [...(sessions.get(session) ?? []), row]);
	}
	for (const members of sessions.values())
		members.sort((a, b) =>
			b.request.requestedAt.localeCompare(a.request.requestedAt),
		);
	return rows.flatMap((row) => {
		const session = sessionOf(row);
		if (!session) return [{ row, earlier: [] }];
		const [newest, ...earlier] = sessions.get(session) ?? [row];
		return newest === row ? [{ row, earlier }] : [];
	});
}

/** The quiet toggle under a session's newest question. */
function EarlierTurnsToggle({
	count,
	expanded,
	onToggle,
}: {
	count: number;
	expanded: boolean;
	onToggle: () => void;
}) {
	if (count === 0) return null;
	const label = `${count} earlier ${count === 1 ? "turn" : "turns"}`;
	return (
		<Button
			variant="ghost"
			size="xs"
			className="w-fit"
			aria-expanded={expanded}
			onClick={onToggle}
		>
			{expanded ? `Hide ${label}` : label}
		</Button>
	);
}

/** Which sessions' earlier turns are expanded, by request id of the newest. */
function useExpandedGroups() {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	return {
		isExpanded: (id: string) => expanded.has(id),
		toggle: (id: string) =>
			setExpanded((current) => {
				const next = new Set(current);
				if (!next.delete(id)) next.add(id);
				return next;
			}),
	};
}

function NeedsYouNowSection() {
	const query = useQuery(workUrgentInteractionsQueryOptions());
	const groups = useExpandedGroups();
	const rows = query.data?.data ?? [];
	if (rows.length === 0) return null;
	type UrgentRow = (typeof rows)[number];
	const renderRow = (
		{ request, workItem }: UrgentRow,
		earlier?: UrgentRow[],
	) => {
		const summary = urgentInteractionSummary(request.metadata);
		return (
			<TableRow key={request.id}>
				<TableCell className="whitespace-normal">
					<Link variant="record" href={`/work/interactions/${request.id}`}>
						{interactionSubject(request)}
					</Link>
					{workItem ? (
						<Text as="p" role="label" tone="secondary">
							{workItem.title}
						</Text>
					) : null}
					{earlier ? (
						<EarlierTurnsToggle
							count={earlier.length}
							expanded={groups.isExpanded(request.id)}
							onToggle={() => groups.toggle(request.id)}
						/>
					) : null}
				</TableCell>
				<TableCell className="whitespace-normal">
					<span className="flex flex-wrap gap-1">
						{summary.reasons.length > 0 ? (
							summary.reasons.map((reason) => (
								<Badge key={reason} variant="error">
									{reason}
								</Badge>
							))
						) : (
							<Badge variant="warning">Needs you</Badge>
						)}
					</span>
				</TableCell>
				<TableCell className="whitespace-normal">
					<span title={summary.sessionId}>
						{summary.origin.join(" · ") || "Origin not recorded"}
					</span>
				</TableCell>
			</TableRow>
		);
	};
	return (
		<PageSection aria-labelledby="interaction-urgent-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="interaction-urgent-title">
						Needs you now
					</SectionTitle>
					<SectionDescription>
						Open requests where an agent is blocked, needs you to act, or is
						about to take a risky action.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<Table scrollLabel="Requests that need you now">
				<TableHeader>
					<TableRow>
						<TableHead>Request</TableHead>
						<TableHead>Why</TableHead>
						<TableHead>From</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{groupSessionQuestions(rows).flatMap(({ row, earlier }) => [
						renderRow(row, earlier),
						...(groups.isExpanded(row.request.id)
							? earlier.map((older) => renderRow(older))
							: []),
					])}
				</TableBody>
			</Table>
		</PageSection>
	);
}

export function WorkInteractionsRoute() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	return pathname.replace(/\/$/, "").endsWith("/work/interactions") ? (
		<WorkInteractionsPage />
	) : (
		<Outlet />
	);
}

export function WorkInteractionsPage() {
	const client = useQueryClient();
	const paging = useCursorPaging<{ at: string; id: string }>();
	const navigate = useNavigate();
	const search = useRouterState({
		select: (state) => workInteractionsSearch(state.location.search),
	});
	const listView = search.view;
	useEffect(() => {
		paging.reset();
	}, [listView, search.state]);
	const setListView = (view: "inbox" | "outbox" | "audit") => {
		void navigate({
			to: "/work/interactions",
			search: { view, state: search.state },
		});
	};
	const [interactionFormOpen, setInteractionFormOpen] = useState(false);
	const groups = useExpandedGroups();
	const interactionOptions = workInteractionsQueryOptions(
		paging.cursor,
		listView,
		search.state === "open" ? ["open"] : undefined,
	);
	const query = useQuery(interactionOptions);
	const names = useWorkPrincipalNames(query.data?.data[0]?.request.orgId);
	const create = useMutation({
		mutationFn: (value: z.output<typeof interactionRequestSchema>) =>
			osApi.workInteractions.create({
				...(value.contextType === "work_item"
					? { workItemId: value.contextId }
					: value.contextType === "case"
						? { caseId: value.contextId }
						: { projectId: value.contextId }),
				kind: value.kind,
				subject: value.subject,
				prompt: value.prompt,
				requestedFrom: { type: value.targetType, id: value.targetId },
				metadata: {},
			}),
		onSuccess: async (_result, value) => {
			form.setFieldValue("subject", "");
			form.setFieldValue("prompt", "");
			paging.reset();
			setListView("outbox");
			setInteractionFormOpen(false);
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.workInteractions() }),
				client.invalidateQueries({
					queryKey: workSchedulerQueryOptions().queryKey,
				}),
				client.invalidateQueries({
					queryKey: workFleetQueryOptions().queryKey,
				}),
				...(value.contextType === "work_item"
					? [
							client.invalidateQueries({
								queryKey: workItemReadinessQueryOptions(value.contextId)
									.queryKey,
							}),
						]
					: []),
			]);
		},
	});
	const form = useZodForm({
		schema: interactionRequestSchema,
		defaultValues: {
			contextType: "work_item",
			contextId: "",
			kind: "question",
			subject: "",
			prompt: "",
			targetType: "user",
			targetId: "",
		},
		validateOn: "submit",
		onSubmit: ({ value }) => create.mutate(value),
	});
	const kind = useStore(form.store, (state) => state.values.kind);
	const visibleRows = query.data?.data ?? [];
	const renderInteractionRow = (
		{
			request,
			effectiveState,
			workItem,
			responseCount,
		}: (typeof visibleRows)[number],
		earlier?: (typeof visibleRows)[number][],
	) => (
		<TableRow key={request.id}>
			<TableCell className="whitespace-normal">
				<Link variant="record" href={`/work/interactions/${request.id}`}>
					{interactionSubject(request)}
				</Link>
				{earlier ? (
					<EarlierTurnsToggle
						count={earlier.length}
						expanded={groups.isExpanded(request.id)}
						onToggle={() => groups.toggle(request.id)}
					/>
				) : null}
				<Text as="p" role="label" tone="secondary">
					{workItem?.title ??
						request.workItemId ??
						request.caseId ??
						request.projectId ??
						"Context unavailable"}{" "}
					· {sentenceCase(request.kind)}
				</Text>
			</TableCell>
			<TableCell>
				<Badge variant={effectiveState === "open" ? "warning" : "outline"}>
					{sentenceCase(effectiveState)}
				</Badge>
			</TableCell>
			<TableCell>
				<span title={`${request.requestedFromType}:${request.requestedFromId}`}>
					{namedWorkPrincipal(
						request.requestedFromType,
						request.requestedFromId,
						names,
					)}
				</span>
			</TableCell>
			<TableCell>{responseCount}</TableCell>
		</TableRow>
	);
	const activeView =
		listView === "inbox"
			? {
					title: "Assigned to me",
					description:
						"Requests addressed to you. Open a record to review or respond.",
				}
			: listView === "outbox"
				? {
						title: "Requested by me",
						description:
							"Requests you sent. Open a record to see the recipient and any response.",
					}
				: {
						title: "Organization requests",
						description:
							search.state === "open"
								? "Open requests across your organization. Check the recipient to see who can respond."
								: "Requests across your organization, including past responses.",
					};
	return (
		<Page width="xl">
			<Header
				title="Requests"
				description="Assigned to me shows your requests. Organization requests shows who has been asked to respond."
				action={
					<Button
						variant={interactionFormOpen ? "outline" : "default"}
						onClick={() => setInteractionFormOpen((open) => !open)}
						aria-expanded={interactionFormOpen}
						aria-controls="ask-for-input-form"
					>
						{interactionFormOpen ? "Close form" : "Ask for input"}
					</Button>
				}
			/>
			<KumoTabs
				aria-label="Interaction view"
				value={listView}
				onValueChange={(value) => {
					paging.reset();
					setListView(value as "inbox" | "outbox" | "audit");
				}}
				tabs={[
					{ value: "inbox", label: "Assigned to me" },
					{ value: "outbox", label: "Requested by me" },
					{ value: "audit", label: "Organization" },
				]}
			/>
			<KumoTabs
				aria-label="Request state"
				value={search.state}
				onValueChange={(state) => {
					paging.reset();
					void navigate({
						to: "/work/interactions",
						search: {
							view: listView,
							state: state === "open" ? "open" : "all",
						},
					});
				}}
				tabs={[
					{ value: "open", label: "Open" },
					{ value: "all", label: "All" },
				]}
			/>
			{interactionFormOpen ? (
				<PageSection
					id="ask-for-input-form"
					aria-labelledby="ask-for-input-title"
				>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle id="ask-for-input-title">
								Ask for input
							</SectionTitle>
							<SectionDescription>
								Choose exactly one canonical context and one concrete target
								principal.
							</SectionDescription>
						</SectionHeading>
					</SectionHeader>
					<Surface className="p-4">
						<form
							className="grid gap-3 md:grid-cols-2"
							onSubmit={(event) => {
								event.preventDefault();
								event.stopPropagation();
								void form.handleSubmit();
							}}
						>
							<FormField form={form} name="contextType" label="Context type">
								{(field, meta) => (
									<FormSelect field={field} {...meta}>
										<SelectItem value="work_item">Work Item</SelectItem>
										<SelectItem value="case">Case</SelectItem>
										<SelectItem value="project">Project</SelectItem>
									</FormSelect>
								)}
							</FormField>
							<FormField form={form} name="kind" label="Request kind">
								{(field, meta) => (
									<FormSelect field={field} {...meta}>
										{["question", "input", "handoff", "coordination"].map(
											(value) => (
												<SelectItem key={value} value={value}>
													{sentenceCase(value)}
												</SelectItem>
											),
										)}
									</FormSelect>
								)}
							</FormField>
							<FormField form={form} name="targetType" label="Target type">
								{(field, meta) => (
									<FormSelect field={field} {...meta}>
										<SelectItem value="user">User</SelectItem>
										<SelectItem value="tedi">Tedi</SelectItem>
										<SelectItem value="external_agent">
											External agent
										</SelectItem>
									</FormSelect>
								)}
							</FormField>
							{(
								[
									["contextId", "Context id"],
									["targetId", "Target principal id"],
									["subject", "Subject"],
								] as const
							).map(([name, label]) => (
								<FormField key={name} form={form} name={name} label={label}>
									{(field, meta) => <FormInput field={field} {...meta} />}
								</FormField>
							))}
							<FormField form={form} name="prompt" label="Prompt">
								{(field, meta) => <FormTextarea field={field} {...meta} />}
							</FormField>
							<Button disabled={create.isPending} type="submit">
								Create {sentenceCase(kind)}
							</Button>
							<MutationError error={create.error} />
						</form>
					</Surface>
				</PageSection>
			) : null}
			{listView === "inbox" ? <NeedsYouNowSection /> : null}
			<PageSection aria-labelledby="interaction-queue-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="interaction-queue-title">
							{activeView.title}
						</SectionTitle>
						<SectionDescription>{activeView.description}</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{query.isPending ? (
					<Loading />
				) : query.isError ? (
					<Failure title="Interactions unavailable" error={query.error} />
				) : visibleRows.length === 0 ? (
					<None
						title={
							listView === "inbox"
								? "Nothing assigned to you"
								: listView === "outbox"
									? "No requests from you"
									: search.state === "open"
										? "No open organization requests"
										: "No organization requests"
						}
						description={
							listView === "inbox"
								? "No requests addressed to you match this view on this page."
								: listView === "outbox"
									? "Create a targeted request to populate your outbox."
									: "No requests match this view on this page."
						}
					/>
				) : (
					<Table scrollLabel="Interactions">
						<TableHeader>
							<TableRow>
								<TableHead>Request</TableHead>
								<TableHead>State</TableHead>
								<TableHead>Target</TableHead>
								<TableHead>Responses</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{(listView === "inbox"
								? groupSessionQuestions(visibleRows)
								: visibleRows.map((row) => ({ row, earlier: [] }))
							).flatMap(({ row, earlier }) => [
								renderInteractionRow(row, earlier),
								...(groups.isExpanded(row.request.id)
									? earlier.map((older) => renderInteractionRow(older))
									: []),
							])}
						</TableBody>
					</Table>
				)}
				{query.data?.hasMore ? (
					<PageControls
						label="interactions"
						hasPrevious={paging.hasPrevious}
						hasNext={Boolean(query.data.nextCursor)}
						onPrevious={paging.reset}
						onBack={paging.previous}
						onNext={() => {
							if (query.data?.nextCursor) paging.next(query.data.nextCursor);
						}}
					/>
				) : paging.hasPrevious ? (
					<PageControls
						label="interactions"
						hasPrevious
						hasNext={false}
						onPrevious={paging.reset}
						onBack={paging.previous}
						onNext={() => undefined}
					/>
				) : null}
			</PageSection>
		</Page>
	);
}

const interactionResponseSchema = z.object({
	responseKind: z.enum([
		"answer",
		"input_provided",
		"handoff_accepted",
		"handoff_declined",
		"coordination_update",
	]),
	body: z.string().trim().min(1, "Enter a response."),
	resolvesRequest: z.boolean(),
});

const externalActionSchema = z.object({
	label: z.string().trim().min(1).max(120),
	url: z
		.string()
		.trim()
		.max(2048)
		.url()
		.refine((value) => {
			const url = new URL(value);
			return url.protocol === "https:" && !url.username && !url.password;
		}),
});

export function WorkInteractionPage({ requestId }: { requestId: string }) {
	const client = useQueryClient();
	const [cursor, setCursor] = useState<
		{ at: string; id: string } | undefined
	>();
	const query = useQuery(workInteractionDetailQueryOptions(requestId, cursor));
	const names = useWorkPrincipalNames(query.data?.request.orgId);
	const refresh = () => {
		const workItemId = query.data?.request.workItemId;
		return Promise.all([
			client.invalidateQueries({
				queryKey: workInteractionDetailQueryOptions(requestId, cursor).queryKey,
			}),
			client.invalidateQueries({
				queryKey: workInteractionDetailQueryOptions(requestId).queryKey,
			}),
			client.invalidateQueries({ queryKey: osQueryKeys.workInteractions() }),
			client.invalidateQueries({
				queryKey: workSchedulerQueryOptions().queryKey,
			}),
			client.invalidateQueries({ queryKey: workFleetQueryOptions().queryKey }),
			...(workItemId
				? [
						client.invalidateQueries({
							queryKey: workItemReadinessQueryOptions(workItemId).queryKey,
						}),
					]
				: []),
		]);
	};
	const respond = useMutation({
		mutationFn: (
			value: z.output<typeof interactionResponseSchema> & {
				/** Cites the tedi draft an answer started from. */
				metadata?: Record<string, string | number>;
			},
		) => {
			if (!query.data) throw new Error("Interaction is not loaded");
			return osApi.workInteractions.respond({
				requestId,
				expectedRequestVersion: query.data.request.version,
				responseKind: value.responseKind,
				body: value.body,
				resolvesRequest: value.resolvesRequest,
				metadata: value.metadata ?? {},
			});
		},
		onSuccess: async () => {
			responseForm.reset();
			setCursor(undefined);
			await refresh();
		},
	});
	const responseForm = useZodForm({
		schema: interactionResponseSchema,
		defaultValues: {
			responseKind: "answer",
			body: "",
			resolvesRequest: true,
		},
		validateOn: "submit",
		onSubmit: ({ value }) => respond.mutate(value),
	});
	const cancel = useMutation({
		mutationFn: () => {
			if (!query.data) throw new Error("Interaction is not loaded");
			return osApi.workInteractions.cancel({
				requestId,
				expectedRequestVersion: query.data.request.version,
			});
		},
		onSuccess: refresh,
	});
	if (query.isPending)
		return (
			<Page width="lg">
				<PageBack render={<Link href="/work/interactions" />}>
					All interactions
				</PageBack>
				<Loading />
			</Page>
		);
	if (query.isError || !query.data)
		return (
			<Page width="lg">
				<PageBack render={<Link href="/work/interactions" />}>
					All interactions
				</PageBack>
				<Failure title="Interaction unavailable" error={query.error} />
			</Page>
		);
	const { request, effectiveState, responses } = query.data;
	const isQuestion = request.kind === "question";
	const draft =
		isQuestion && effectiveState === "open" && query.data.canRespond
			? latestDraftOf(query.data)
			: null;
	const parsedAction =
		request.kind === "input"
			? externalActionSchema.safeParse(request.metadata?.externalAction)
			: null;
	const externalAction = parsedAction?.success ? parsedAction.data : null;
	const originChatTitle =
		typeof request.metadata?.originChatTitle === "string"
			? request.metadata.originChatTitle.trim().slice(0, 120)
			: "";
	const decisionCapture = decisionCaptureSummary(request.metadata);
	// The tedi's recommended answer: shown first for a captured agent turn.
	const draftReply = draft ? (
		<InteractionDraftReply
			draft={draft}
			drafterName={namedWorkPrincipal("tedi", draft.drafterId, names)}
			host={
				typeof request.metadata?.host === "string"
					? request.metadata.host
					: request.metadata?.agentHarness === "codex"
						? "codex"
						: undefined
			}
			pending={respond.isPending}
			onAnswer={(body, metadata) =>
				respond.mutate({
					responseKind: "answer",
					body,
					resolvesRequest: true,
					metadata,
				})
			}
		/>
	) : null;
	const questionSource =
		decisionCapture?.source ||
		originChatTitle ||
		(typeof request.metadata?.originChatId === "string" &&
		request.metadata?.agentHarness === "codex"
			? "your Codex chat"
			: namedWorkPrincipal(request.creatorType, request.creatorId, names));
	const responseOptions = (
		<>
			<FormField form={responseForm} name="responseKind" label="Response kind">
				{(field, meta) => (
					<FormSelect field={field} {...meta}>
						<SelectItem value="answer">Answer</SelectItem>
						<SelectItem value="input_provided">Input provided</SelectItem>
						<SelectItem value="handoff_accepted">Handoff accepted</SelectItem>
						<SelectItem value="handoff_declined">Handoff declined</SelectItem>
						<SelectItem value="coordination_update">
							Coordination update
						</SelectItem>
					</FormSelect>
				)}
			</FormField>
			<FormField
				form={responseForm}
				name="resolvesRequest"
				label="Resolve request"
				orientation="horizontal"
			>
				{(field, meta) => (
					<Switch
						id={meta.id}
						aria-describedby={meta.descriptionId}
						aria-invalid={meta.invalid || undefined}
						checked={Boolean(field.state.value)}
						onCheckedChange={(checked) => field.handleChange(checked)}
					/>
				)}
			</FormField>
		</>
	);
	return (
		<Page width="lg">
			<PageBack render={<Link href="/work/interactions" />}>
				All interactions
			</PageBack>
			<Header
				title={interactionSubject(request)}
				description={
					externalAction ? (
						`Action from ${questionSource}`
					) : decisionCapture ? (
						<span
							title={
								decisionCapture.shortSessionId
									? `Session ${decisionCapture.shortSessionId}`
									: undefined
							}
						>
							{decisionCapture.origin}
						</span>
					) : isQuestion ? (
						`Question from ${questionSource}`
					) : (
						`${sentenceCase(request.kind)} · version ${request.version}`
					)
				}
			/>
			<Card>
				<CardHeader>
					<CardTitle>
						{externalAction
							? effectiveState === "open"
								? "Waiting for your action"
								: "Step closed"
							: isQuestion
								? effectiveState === "resolved"
									? "Answer saved"
									: effectiveState === "open"
										? decisionCapture?.attention === "fyi"
											? "Update: nothing needed from you"
											: "What's needed from you"
										: "Question closed"
								: "Request"}
					</CardTitle>
					<CardDescription>
						{externalAction ? (
							effectiveState === "open" ? (
								"Complete this step on the linked site. Opening it does not mark it done."
							) : (
								"No action is needed from you here."
							)
						) : isQuestion ? (
							effectiveState === "resolved" ? (
								`Your answer is saved for ${questionSource}.`
							) : effectiveState === "open" &&
							  decisionCapture?.attention === "fyi" ? (
								"Your agent reported progress and asked for nothing. Reply only to redirect it."
							) : effectiveState === "open" && query.data.canRespond ? (
								`Your reply will be saved with this task for ${questionSource}.`
							) : (
								"No answer is needed from you here."
							)
						) : (
							<>
								From{" "}
								<span title={request.creatorId}>
									{namedWorkPrincipal(
										request.creatorType,
										request.creatorId,
										names,
									)}
								</span>{" "}
								to{" "}
								<span title={request.requestedFromId}>
									{namedWorkPrincipal(
										request.requestedFromType,
										request.requestedFromId,
										names,
									)}
								</span>
							</>
						)}
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-2">
					{isQuestion ? (
						<>
							{decisionCapture?.urgency === "now" ? (
								<span className="flex flex-wrap gap-1">
									{decisionCapture.reasons.length > 0 ? (
										decisionCapture.reasons.map((reason) => (
											<Badge key={reason} variant="error">
												{reason}
											</Badge>
										))
									) : (
										<Badge variant="warning">Needs you</Badge>
									)}
								</span>
							) : decisionCapture?.urgency === "later" ? (
								<Text as="p" role="label" tone="secondary">
									{decisionCapture.attention === "fyi" ? "Update" : "Can wait"}
								</Text>
							) : null}
							{decisionCapture && draftReply ? draftReply : null}
							{decisionCapture ? (
								<>
									{draftReply || decisionCapture.need ? (
										<Text as="h3" role="label" tone="secondary">
											What your agent said
										</Text>
									) : null}
									<ChatMarkdown content={request.prompt} />
								</>
							) : (
								<p className="whitespace-pre-wrap">{request.prompt}</p>
							)}
							<Collapsible>
								<CollapsibleTrigger
									render={<Button variant="ghost" className="w-fit" />}
								>
									Request details
								</CollapsibleTrigger>
								<CollapsibleContent>
									<Text role="label" tone="secondary">
										{sentenceCase(effectiveState)} · version {request.version} ·
										From{" "}
										{namedWorkPrincipal(
											request.creatorType,
											request.creatorId,
											names,
										)}{" "}
										to{" "}
										{namedWorkPrincipal(
											request.requestedFromType,
											request.requestedFromId,
											names,
										)}
									</Text>
									{effectiveState === "open" && query.data.canCancel ? (
										<Button
											variant="ghost"
											disabled={cancel.isPending}
											onClick={() => cancel.mutate()}
										>
											Cancel request
										</Button>
									) : null}
								</CollapsibleContent>
							</Collapsible>
						</>
					) : (
						<>
							<Badge
								variant={effectiveState === "open" ? "warning" : "outline"}
							>
								{sentenceCase(effectiveState)}
							</Badge>
							<p className="whitespace-pre-wrap">{request.prompt}</p>
						</>
					)}
					{effectiveState === "open" &&
					(query.data.canRespond || query.data.canCancel) ? (
						<>
							{query.data.canRespond && externalAction ? (
								<Button
									className="w-fit"
									render={
										<a
											href={externalAction.url}
											target="_blank"
											rel="noopener noreferrer"
										/>
									}
								>
									{externalAction.label}
								</Button>
							) : query.data.canRespond ? (
								<>
									{decisionCapture ? null : draftReply}
									<form
										className="grid gap-3"
										onSubmit={(event) => {
											event.preventDefault();
											void responseForm.handleSubmit();
										}}
									>
										<FormField
											form={responseForm}
											name="body"
											label={isQuestion ? "Your answer" : "Response"}
										>
											{(field, meta) => (
												<FormTextarea
													field={field}
													{...meta}
													placeholder={
														isQuestion
															? "Type your answer…"
															: "Type your response…"
													}
												/>
											)}
										</FormField>
										{isQuestion ? (
											<Collapsible>
												<CollapsibleTrigger
													render={<Button variant="ghost" className="w-fit" />}
												>
													More options
												</CollapsibleTrigger>
												<CollapsibleContent className="grid gap-3">
													{responseOptions}
												</CollapsibleContent>
											</Collapsible>
										) : (
											responseOptions
										)}
										<responseForm.Subscribe
											selector={(state) => [
												state.values.resolvesRequest,
												state.canSubmit,
											]}
										>
											{([resolvesRequest, canSubmit]) => (
												<Button
													type="submit"
													disabled={!canSubmit || respond.isPending}
												>
													{respond.isPending
														? "Sending…"
														: isQuestion
															? originChatTitle
																? `Send to ${originChatTitle}`
																: "Send reply"
															: resolvesRequest
																? "Respond and resolve"
																: "Respond"}
												</Button>
											)}
										</responseForm.Subscribe>
									</form>
								</>
							) : null}
							<div className="flex flex-wrap gap-2">
								{query.data.canCancel && !isQuestion ? (
									<Button
										variant="destructive"
										disabled={cancel.isPending}
										onClick={() => cancel.mutate()}
									>
										Cancel request
									</Button>
								) : null}
							</div>
						</>
					) : null}
				</CardContent>
			</Card>
			<MutationError error={respond.error ?? cancel.error} />
			{responses.data.length || responses.hasMore || cursor ? (
				<SectionCollection
					title={
						isQuestion ? "Answers" : `Responses (${responses.data.length})`
					}
					description="Previous replies to this request."
					empty="No responses on this page."
					footer={
						responses.hasMore && responses.nextCursor ? (
							<Button
								className="w-fit"
								variant="outline"
								onClick={() => setCursor(responses.nextCursor ?? undefined)}
							>
								Next response page
							</Button>
						) : cursor ? (
							<Button
								className="w-fit"
								variant="outline"
								onClick={() => setCursor(undefined)}
							>
								Newest response page
							</Button>
						) : null
					}
				>
					{responses.data.length
						? responses.data.map((response) => (
								<Text
									as="li"
									role="body"
									key={response.id}
									className="grid gap-1"
								>
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
										<Text as="strong" role="body" tone="strong" weight="medium">
											{sentenceCase(response.responseKind)}
										</Text>
										<Text as="span" role="label" tone="secondary">
											by{" "}
											<span title={response.respondedById}>
												{namedWorkPrincipal(
													response.respondedByType,
													response.respondedById,
													names,
												)}
											</span>
										</Text>
									</div>
									<div className="whitespace-pre-wrap text-kumo-default">
										{response.body}
									</div>
								</Text>
							))
						: undefined}
				</SectionCollection>
			) : null}
		</Page>
	);
}

function MetricCard({
	title,
	value,
	description,
}: {
	title: string;
	value: number | string;
	description?: string;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				{description ? <CardDescription>{description}</CardDescription> : null}
			</CardHeader>
			<CardContent>
				<Text as="p" role="metric" className="m-0">
					{value}
				</Text>
			</CardContent>
		</Card>
	);
}

export function SchedulerTruncationWarnings({
	factsTruncated,
	truncatedFacts,
	graphTruncated,
}: {
	factsTruncated: boolean;
	truncatedFacts: (
		| "dependencies"
		| "capabilities"
		| "approvals"
		| "resources"
		| "budgets"
		| "cases"
	)[];
	graphTruncated: boolean;
}) {
	return (
		<>
			{factsTruncated ? (
				<Alert variant="destructive">
					<AlertTitle>Admission facts incomplete</AlertTitle>
					<AlertDescription>
						Bounded {truncatedFacts.map(sentenceCase).join(", ")} reads
						overflowed. Affected candidates are withheld as evaluation required;
						the ready queue is partial and absence is not an eligibility
						decision.
					</AlertDescription>
				</Alert>
			) : null}
			{graphTruncated ? (
				<Alert>
					<AlertTitle>Dependency ranking is approximate</AlertTitle>
					<AlertDescription>
						Bounded graph traversal was truncated. Emitted candidates passed
						hard admission gates, but downstream and critical-path scores may be
						partial.
					</AlertDescription>
				</Alert>
			) : null}
		</>
	);
}

export function WorkControlPage() {
	const fleet = useQuery(workFleetQueryOptions());
	return (
		<Page width="full">
			<Header
				title="Attention"
				description="See what needs a decision and what is working across your organization."
				action={
					<Link href="/work/queue?disposition=completed">Completed work</Link>
				}
			/>
			{fleet.isPending ? (
				<Loading />
			) : fleet.isError ? (
				<Failure title="Attention unavailable" error={fleet.error} />
			) : (
				<>
					<WorkAttentionSummary
						snapshot={fleet.data}
						refreshing={fleet.isFetching}
						onRefresh={() => {
							void fleet.refetch();
						}}
					/>
					<MetricGrid columns={3} aria-label="Work activity">
						<MetricItem
							label="In progress"
							emphasis="metric"
							value={
								<Link href="/work/attempts?view=active">
									{fleet.data.attempts.active}
								</Link>
							}
							description="Current reservations recorded in OS"
						/>
						<MetricItem
							label="Decisions"
							emphasis="metric"
							value={
								<Link href="/work/approvals">
									{fleet.data.approvals.awaitingDecision}
								</Link>
							}
							description="Waiting for an approver"
						/>
						<MetricItem
							label="Organization requests"
							emphasis="metric"
							value={
								<Link href="/work/interactions?view=audit&state=open">
									{fleet.data.interactions.awaitingResponse}
								</Link>
							}
							description={`${fleet.data.interactions.overdue} overdue · check the recipient`}
						/>
					</MetricGrid>
					<Collapsible>
						<CollapsibleTrigger>Operational details</CollapsibleTrigger>
						<CollapsibleContent>
							<Text as="p" role="body" tone="secondary">
								{fleet.data.attempts.staleLeases} missed reservation updates ·{" "}
								{fleet.data.admissions.latestRejected} work starts rejected
							</Text>
							{fleet.data.resources.saturatedResourceKeys.length ? (
								<ResourcePressureLinks
									resourceKeys={fleet.data.resources.saturatedResourceKeys}
								/>
							) : null}
						</CollapsibleContent>
					</Collapsible>
				</>
			)}
		</Page>
	);
}

const clusterLookupSchema = z.object({
	tediId: z.string().trim().uuid("Enter a canonical tedi UUID."),
});

const caseAttachmentSchema = z.object({
	workItemId: z.string().trim().uuid("Enter a canonical Work Item UUID."),
	rationale: z.string().trim(),
});

const caseDependencySchema = z.object({
	dependentCaseId: z.string().trim().uuid("Enter a canonical case UUID."),
});

export function WorkClustersPage() {
	const [executorId, setExecutorId] = useState("");
	const clusters = useQuery({
		...workExecutionClustersQueryOptions(
			executorId || "00000000-0000-4000-8000-000000000000",
		),
		enabled: Boolean(executorId),
	});
	const form = useZodForm({
		schema: clusterLookupSchema,
		defaultValues: { tediId: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => setExecutorId(value.tediId),
	});
	return (
		<Page width="full">
			<Header
				title="Execution clusters"
				description="Plan bounded, resource-compatible execution waves for one active tedi. The projection is advisory; every start re-evaluates admission."
			/>
			<Card>
				<CardHeader>
					<CardTitle>Executor snapshot</CardTitle>
					<CardDescription>
						Enter the canonical tedi id whose capabilities should be evaluated.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form
						className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
						onSubmit={(event) => {
							event.preventDefault();
							void form.handleSubmit();
						}}
					>
						<FormField form={form} name="tediId" label="Executor tedi id">
							{(field, meta) => (
								<FormInput field={field} {...meta} placeholder="Tedi UUID" />
							)}
						</FormField>
						<Button type="submit" variant="outline">
							Plan waves
						</Button>
					</form>
				</CardContent>
			</Card>
			{clusters.isPending && executorId ? <Loading /> : null}
			{clusters.isError ? (
				<Failure
					title="Execution cluster plan unavailable"
					error={clusters.error}
				/>
			) : clusters.data ? (
				<>
					<SchedulerTruncationWarnings {...clusters.data} />
					<Alert>
						<AlertTitle>Advisory execution plan</AlertTitle>
						<AlertDescription>
							Launch items within one wave in parallel. Re-read the plan before
							advancing to the next wave; admission remains authoritative.
						</AlertDescription>
					</Alert>
					{clusters.data.clusters.length ? (
						<div className="grid gap-3 lg:grid-cols-2">
							{clusters.data.clusters.map((cluster) => (
								<Card key={cluster.index}>
									<CardHeader>
										<CardTitle>Wave {cluster.index}</CardTitle>
										<CardDescription>
											{cluster.recommendedMaxParallelism} parallel ·{" "}
											{cluster.resourceKeys.length
												? cluster.resourceKeys.join(", ")
												: "no declared resource collision"}
										</CardDescription>
									</CardHeader>
									<CardContent>
										<ol className="m-0 grid gap-2 pl-5">
											{cluster.items.map((item) => (
												<li key={item.workItemId}>
													<Link href={`/work/items/${item.workItemId}`}>
														{item.title}
													</Link>{" "}
													· score {item.score}
												</li>
											))}
										</ol>
									</CardContent>
								</Card>
							))}
						</div>
					) : (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No eligible execution waves</EmptyTitle>
								<EmptyDescription>
									No Work Item passed every hard gate for this tedi in the
									bounded snapshot.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					)}
				</>
			) : null}
		</Page>
	);
}

const admissionLookupSchema = z.object({
	itemId: z.string().trim().uuid("Enter a canonical Work Item UUID."),
});

const admissionSpecificationSchema = z.object({
	rawSpec: z.string().refine((value) => {
		try {
			const parsed = JSON.parse(value) as unknown;
			return Boolean(
				parsed && typeof parsed === "object" && !Array.isArray(parsed),
			);
		} catch {
			return false;
		}
	}, "Enter a valid JSON object."),
});

export function WorkAdmissionPage() {
	const client = useQueryClient();
	const [loadedId, setLoadedId] = useState("");
	const spec = useQuery({
		...workAdmissionSpecificationQueryOptions(
			loadedId || "00000000-0000-4000-8000-000000000000",
		),
		enabled: Boolean(loadedId),
	});
	const readiness = useQuery({
		...workItemReadinessQueryOptions(
			loadedId || "00000000-0000-4000-8000-000000000000",
		),
		enabled: Boolean(loadedId),
	});
	const replace = useMutation({
		mutationFn: (value: z.output<typeof admissionSpecificationSchema>) => {
			if (!spec.data)
				throw new Error(
					"Load the current admission specification before editing",
				);
			return osApi.workItems.replaceAdmissionSpecification({
				id: loadedId,
				expectedWorkItemVersion: spec.data.workItemVersion,
				expectedAdmissionSpecRevision: spec.data.admissionSpecRevision,
				specification: JSON.parse(value.rawSpec) as never,
			});
		},
		onSuccess: async (value) => {
			editorForm.setFieldValue(
				"rawSpec",
				JSON.stringify(
					{ resources: value.resources, budget: value.budget },
					null,
					2,
				),
			);
			await Promise.all([
				client.invalidateQueries({
					queryKey: workAdmissionSpecificationQueryOptions(loadedId).queryKey,
				}),
				client.invalidateQueries({
					queryKey: workItemReadinessQueryOptions(loadedId).queryKey,
				}),
				client.invalidateQueries({
					queryKey: workSchedulerQueryOptions().queryKey,
				}),
				client.invalidateQueries({
					queryKey: workFleetQueryOptions().queryKey,
				}),
			]);
		},
	});
	const editorForm = useZodForm({
		schema: admissionSpecificationSchema,
		defaultValues: { rawSpec: '{"resources":[],"budget":null}' },
		validateOn: "submit",
		onSubmit: ({ value }) => replace.mutate(value),
	});
	const lookupForm = useZodForm({
		schema: admissionLookupSchema,
		defaultValues: { itemId: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => {
			setLoadedId(value.itemId);
			editorForm.reset();
		},
	});
	return (
		<Page width="full">
			<Header
				title="Admission"
				description="Inspect ranked eligibility and normalized Work Item admission requirements. Starting an Attempt re-evaluates all gates atomically."
			/>
			<Card>
				<CardHeader>
					<CardTitle>Admission specification</CardTitle>
					<CardDescription>
						Resources and budget are explicit normalized requirements, not
						metadata. Load a canonical Work Item UUID before editing.
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-3">
					<form
						className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
						onSubmit={(event) => {
							event.preventDefault();
							void lookupForm.handleSubmit();
						}}
					>
						<FormField form={lookupForm} name="itemId" label="Work Item id">
							{(field, meta) => (
								<FormInput
									field={field}
									{...meta}
									placeholder="Work Item UUID"
								/>
							)}
						</FormField>
						<Button type="submit" variant="outline">
							Load
						</Button>
					</form>
					{spec.data ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								editorForm.setFieldValue(
									"rawSpec",
									JSON.stringify(
										{
											resources: spec.data.resources,
											budget: spec.data.budget,
										},
										null,
										2,
									),
								)
							}
						>
							Use current specification
						</Button>
					) : null}
					<form
						className="grid gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							void editorForm.handleSubmit();
						}}
					>
						<FormField
							form={editorForm}
							name="rawSpec"
							label="Admission specification JSON"
						>
							{(field, meta) => (
								<FormTextarea
									field={field}
									{...meta}
									className="min-h-48 font-mono"
								/>
							)}
						</FormField>
						<Button type="submit" disabled={!loadedId || replace.isPending}>
							Replace specification
						</Button>
					</form>
					<MutationError
						error={readiness.error ?? spec.error ?? replace.error}
					/>
				</CardContent>
			</Card>
			{readiness.data ? (
				<Card>
					<CardHeader>
						<CardTitle>Current readiness</CardTitle>
						<CardDescription>
							Derived {new Date(readiness.data.derivedAt).toLocaleString()} from
							every admission gate; this state is read-only.
						</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-3">
						<Badge variant={readiness.data.ready ? "success" : "warning"}>
							{sentenceCase(readiness.data.state)}
						</Badge>
						<ul className="m-0 grid gap-2 pl-5">
							{readiness.data.gates.map((gate) => (
								<li key={gate.gate}>
									<strong>{sentenceCase(gate.gate)}</strong>: {gate.detail}{" "}
									<Badge
										variant={
											gate.evaluation === "passed" ? "success" : "warning"
										}
									>
										{sentenceCase(gate.evaluation)}
									</Badge>
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			) : null}
		</Page>
	);
}

const positiveIntegerString = z
	.string()
	.regex(/^\d+$/, "Enter a whole number.")
	.transform(Number)
	.refine((value) => value >= 1, "Value must be at least 1.");

const nonNegativeIntegerString = z
	.string()
	.regex(/^\d+$/, "Enter a whole number.")
	.transform(Number)
	.refine((value) => value >= 0, "Value cannot be negative.");

const resourcePoolSchema = z.object({
	resourceKey: z.string().trim().min(1, "Enter a resource key."),
	allocationMode: z.enum(["exclusive", "capacity"]),
	capacity: positiveIntegerString,
});

const budgetEnvelopeSchema = z
	.object({
		scopeType: z.enum(["organization", "project", "case", "work_item"]),
		scopeId: z.string().trim().uuid("Enter the scope UUID."),
		limitMicros: nonNegativeIntegerString,
		reservationMicros: nonNegativeIntegerString,
	})
	.refine((value) => value.reservationMicros <= value.limitMicros, {
		message: "Reservation cannot exceed the limit.",
		path: ["reservationMicros"],
	});

export function BudgetScopeLink({
	scopeType,
	scopeId,
}: {
	scopeType: string;
	scopeId: string;
}) {
	const work = useQuery({
		...workItemDetailQueryOptions(scopeId),
		enabled: scopeType === "work_item",
		retry: false,
	});
	if (scopeType === "work_item")
		return (
			<Link variant="record" href={`/work/items/${scopeId}`} title={scopeId}>
				{work.data?.workItem.title ?? `Work ${workPrincipalLabel(scopeId)}`}
			</Link>
		);
	const href =
		scopeType === "project"
			? `/work/projects/${scopeId}`
			: scopeType === "case"
				? `/work/cases/${scopeId}`
				: undefined;
	const label = `${sentenceCase(scopeType)} · ${workPrincipalLabel(scopeId)}`;
	return href ? (
		<Link variant="record" href={href} title={scopeId}>
			{label}
		</Link>
	) : (
		<span title={scopeId}>{label}</span>
	);
}

interface ResourceHolder {
	attemptId: string;
	workItemId: string;
	workTitle: string;
	executorType: string;
	executorId: string | null;
	externalSessionKey: string | null;
	quantity: number;
	expiresAt: string;
}

export function ResourceHolders({
	details,
	names,
	activeReserved,
}: {
	details: { holders?: ResourceHolder[]; holdersTruncated?: boolean };
	names: ReadonlyMap<string, string>;
	activeReserved: number;
}) {
	if (!details.holders)
		return (
			<Text as="p" role="label" tone="secondary">
				{activeReserved
					? "Holder details unavailable. Refresh capacity before coordinating."
					: "No active reservations."}
			</Text>
		);
	return (
		<Surface className="grid gap-1 mt-2" render={<div />}>
			{details.holders.map((holder) => (
				<Text as="p" role="body" key={holder.attemptId}>
					<Link variant="record" href={`/work/items/${holder.workItemId}`}>
						{holder.workTitle}
					</Link>
					{" · "}
					<span title={holder.executorId ?? undefined}>
						{holder.executorId
							? namedWorkPrincipal(
									holder.executorType,
									holder.executorId,
									names,
								)
							: "Executor unavailable"}
					</span>
					{" · "}
					{holder.quantity} reserved · lease until{" "}
					<time dateTime={holder.expiresAt}>
						{new Date(holder.expiresAt).toLocaleString()}
					</time>
					{holder.externalSessionKey ? (
						<Text as="span" role="label" tone="secondary">
							{" "}
							· {holder.externalSessionKey}
						</Text>
					) : null}
				</Text>
			))}
			{!details.holders.length && activeReserved > 0 ? (
				<Text as="p" role="label" tone="secondary">
					No current linked Work holder is available in this snapshot.
				</Text>
			) : null}
			{details.holdersTruncated ? (
				<Text as="p" role="label" tone="secondary">
					Additional holders are omitted from this bounded snapshot.
				</Text>
			) : null}
			<Text as="p" role="label" tone="secondary">
				{activeReserved
					? "Open the holding Work to coordinate or wait for its reservation to release, then retry admission."
					: "No active reservations."}
			</Text>
		</Surface>
	);
}

export function WorkCapacityPage({
	resourceKey,
	saturatedOnly = false,
	view = "resources",
	exhaustedOnly = false,
}: {
	resourceKey?: string;
	saturatedOnly?: boolean;
	view?: "resources" | "budgets";
	exhaustedOnly?: boolean;
} = {}) {
	const client = useQueryClient();
	const poolPaging = useCursorPaging<string>();
	const budgetPaging = useCursorPaging<string>();
	const poolOptions = workResourcePoolsQueryOptions(
		poolPaging.cursor,
		resourceKey,
		saturatedOnly,
	);
	const budgetOptions = workBudgetEnvelopesQueryOptions(budgetPaging.cursor);
	const pools = useQuery(poolOptions);
	const names = useWorkPrincipalNames(pools.data?.data[0]?.pool.orgId);
	useEffect(() => poolPaging.reset(), [resourceKey, saturatedOnly]);
	const budgets = useQuery(budgetOptions);
	const [poolVersion, setPoolVersion] = useState<number | undefined>();
	const [budgetVersion, setBudgetVersion] = useState<number | undefined>();
	const [poolFormOpen, setPoolFormOpen] = useState(false);
	const [budgetFormOpen, setBudgetFormOpen] = useState(false);
	const factoryInvalidations = () => [
		client.invalidateQueries({
			queryKey: workSchedulerQueryOptions().queryKey,
		}),
		client.invalidateQueries({ queryKey: workFleetQueryOptions().queryKey }),
	];
	const refreshPools = () =>
		Promise.all([
			client.invalidateQueries({ queryKey: osQueryKeys.workResourcePools() }),
			...factoryInvalidations(),
		]);
	const refreshBudgets = () =>
		Promise.all([
			client.invalidateQueries({ queryKey: osQueryKeys.workBudgetEnvelopes() }),
			...factoryInvalidations(),
		]);
	const putPool = useMutation({
		mutationFn: (value: z.output<typeof resourcePoolSchema>) =>
			osApi.workItems.putResourcePool({
				resourceKey: value.resourceKey,
				allocationMode: value.allocationMode,
				capacity: value.capacity,
				...(poolVersion ? { expectedVersion: poolVersion } : {}),
			}),
		onSuccess: async () => {
			poolForm.reset();
			setPoolVersion(undefined);
			setPoolFormOpen(false);
			poolPaging.reset();
			await refreshPools();
		},
	});
	const poolForm = useZodForm({
		schema: resourcePoolSchema,
		defaultValues: {
			resourceKey: "",
			allocationMode: "capacity",
			capacity: "1",
		},
		validateOn: "submit",
		onSubmit: ({ value }) => putPool.mutate(value),
	});
	const putBudget = useMutation({
		mutationFn: (value: z.output<typeof budgetEnvelopeSchema>) =>
			osApi.workItems.putBudgetEnvelope({
				scopeType: value.scopeType,
				scopeId: value.scopeId,
				limitMicros: value.limitMicros,
				reservationMicros: value.reservationMicros,
				...(budgetVersion ? { expectedVersion: budgetVersion } : {}),
			}),
		onSuccess: async () => {
			budgetForm.reset();
			setBudgetVersion(undefined);
			setBudgetFormOpen(false);
			budgetPaging.reset();
			await refreshBudgets();
		},
	});
	const budgetForm = useZodForm({
		schema: budgetEnvelopeSchema,
		defaultValues: {
			scopeType: "organization",
			scopeId: "",
			limitMicros: "0",
			reservationMicros: "0",
		},
		validateOn: "submit",
		onSubmit: ({ value }) => putBudget.mutate(value),
	});
	return (
		<Page width="full">
			<Header
				title={view === "budgets" ? "Budgets" : "Resources"}
				description={
					view === "budgets"
						? "Check the affected work and remaining allowance before changing a budget."
						: "See which work is using shared resources before starting overlapping work."
				}
			/>
			<div className="flex flex-wrap gap-3">
				<Link href="/work/capacity">Resources</Link>
				<Link href="/work/capacity?view=budgets">Budgets</Link>
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						setPoolFormOpen(!poolFormOpen);
						setBudgetFormOpen(!budgetFormOpen);
					}}
				>
					{" "}
					{poolFormOpen || budgetFormOpen
						? "Hide settings"
						: "Change settings"}{" "}
				</Button>
			</div>
			<Collapsible open={poolFormOpen || budgetFormOpen}>
				<CollapsibleContent keepMounted>
					<div className="grid gap-3 lg:grid-cols-2">
						<ResponsiveFormSurface
							title={
								poolVersion ? "Edit resource pool" : "Create resource pool"
							}
							description="Capacity is integer concurrent quantity; admission owns reservations."
							mobileOpen={poolFormOpen}
							onMobileOpenChange={setPoolFormOpen}
						>
							<form
								className="grid gap-3"
								onSubmit={(event) => {
									event.preventDefault();
									void poolForm.handleSubmit();
								}}
							>
								<FormField
									form={poolForm}
									name="resourceKey"
									label="Resource key"
								>
									{(field, meta) => (
										<FormInput
											field={field}
											{...meta}
											disabled={Boolean(poolVersion)}
										/>
									)}
								</FormField>
								<FormField form={poolForm} name="capacity" label="Capacity">
									{(field, meta) => (
										<FormInput field={field} {...meta} type="number" min="1" />
									)}
								</FormField>
								<FormField
									form={poolForm}
									name="allocationMode"
									label="Allocation mode"
								>
									{(field, meta) => (
										<FormSelect field={field} {...meta}>
											<SelectItem value="capacity">Capacity</SelectItem>
											<SelectItem value="exclusive">Exclusive</SelectItem>
										</FormSelect>
									)}
								</FormField>
								<Button type="submit" disabled={putPool.isPending}>
									{poolVersion ? `Save version ${poolVersion}` : "Create pool"}
								</Button>
								<MutationError error={putPool.error} />
							</form>
						</ResponsiveFormSurface>
						<ResponsiveFormSurface
							title={
								budgetVersion
									? "Edit budget envelope"
									: "Create budget envelope"
							}
							description="Enter organization, project, case, or work_item scope and the exact UUID."
							mobileOpen={budgetFormOpen}
							onMobileOpenChange={setBudgetFormOpen}
						>
							<form
								className="grid gap-3"
								onSubmit={(event) => {
									event.preventDefault();
									void budgetForm.handleSubmit();
								}}
							>
								<FormField
									form={budgetForm}
									name="scopeType"
									label="Scope type"
								>
									{(field, meta) => (
										<FormSelect
											field={field}
											{...meta}
											disabled={Boolean(budgetVersion)}
										>
											<SelectItem value="organization">Organization</SelectItem>
											<SelectItem value="project">Project</SelectItem>
											<SelectItem value="case">Case</SelectItem>
											<SelectItem value="work_item">Work Item</SelectItem>
										</FormSelect>
									)}
								</FormField>
								<FormField form={budgetForm} name="scopeId" label="Scope id">
									{(field, meta) => (
										<FormInput
											field={field}
											{...meta}
											disabled={Boolean(budgetVersion)}
											placeholder="Scope UUID"
										/>
									)}
								</FormField>
								<FormField
									form={budgetForm}
									name="limitMicros"
									label="Limit (micros)"
								>
									{(field, meta) => (
										<FormInput field={field} {...meta} type="number" min="0" />
									)}
								</FormField>
								<FormField
									form={budgetForm}
									name="reservationMicros"
									label="Reservation (micros)"
								>
									{(field, meta) => (
										<FormInput field={field} {...meta} type="number" min="0" />
									)}
								</FormField>
								<Button type="submit" disabled={putBudget.isPending}>
									{budgetVersion
										? `Save version ${budgetVersion}`
										: "Create envelope"}
								</Button>
								<MutationError error={putBudget.error} />
							</form>
						</ResponsiveFormSurface>
					</div>
				</CollapsibleContent>
			</Collapsible>
			{pools.isPending || budgets.isPending ? (
				<Loading />
			) : pools.isError || budgets.isError ? (
				<Failure
					title="Capacity unavailable"
					error={pools.error ?? budgets.error}
				/>
			) : (
				<div className="grid gap-3">
					{view === "resources" ? (
						<Card>
							<CardHeader>
								<CardTitle>Resource pools</CardTitle>
								<CardDescription>
									{resourceKey
										? `Exact resource: ${resourceKey}`
										: saturatedOnly
											? "Showing saturated pools"
											: "Organization capacity"}{" "}
									·{" "}
									<Link href="/work/capacity?saturated=true">
										Saturated pools
									</Link>{" "}
									· <Link href="/work/capacity?saturated=false">All pools</Link>
								</CardDescription>
							</CardHeader>
							<CardContent>
								{pools.data.data.length ? (
									<Collection appearance="inline">
										{pools.data.data.map(
											({
												pool,
												activeReserved,
												effectiveAvailable,
												...reservationDetails
											}) => (
												<Surface
													className="flex items-center justify-between gap-3 rounded-none border-0 p-3"
													key={pool.id}
													render={<li />}
												>
													<div>
														<strong>{pool.resourceKey}</strong>
														<br />
														<Text as="span" role="label" tone="secondary">
															{activeReserved} reserved · {effectiveAvailable}{" "}
															available · v{pool.version}
														</Text>
														<ResourceHolders
															details={reservationDetails}
															names={names}
															activeReserved={activeReserved}
														/>
													</div>
													<Button
														size="sm"
														variant="outline"
														onClick={() => {
															poolForm.setFieldValue(
																"resourceKey",
																pool.resourceKey,
															);
															poolForm.setFieldValue(
																"allocationMode",
																pool.allocationMode,
															);
															poolForm.setFieldValue(
																"capacity",
																String(pool.capacity),
															);
															setPoolVersion(pool.version);
															setPoolFormOpen(true);
														}}
													>
														Edit
													</Button>
												</Surface>
											),
										)}
									</Collection>
								) : saturatedOnly ? (
									"No saturated pools in this view."
								) : (
									"No pools."
								)}
								<PageControls
									label="resource pools"
									hasPrevious={poolPaging.hasPrevious}
									hasNext={Boolean(pools.data.nextCursor)}
									onPrevious={poolPaging.reset}
									onBack={poolPaging.previous}
									onNext={() => {
										if (pools.data.nextCursor)
											poolPaging.next(pools.data.nextCursor);
									}}
								/>
							</CardContent>
						</Card>
					) : null}
					{view === "budgets" ? (
						<Card>
							<CardHeader>
								<CardTitle>Allowance</CardTitle>
								<CardDescription>
									{exhaustedOnly
										? "Exhausted budgets on this page"
										: "All budgets on this page"}{" "}
									·{" "}
									<Link href="/work/capacity?view=budgets&exhausted=true">
										Exhausted
									</Link>{" "}
									· <Link href="/work/capacity?view=budgets">All budgets</Link>
								</CardDescription>
							</CardHeader>
							<CardContent>
								{budgets.data.data.filter(
									(row) => !exhaustedOnly || row.availableMicros <= 0,
								).length ? (
									<Collection appearance="inline">
										{budgets.data.data
											.filter(
												(row) => !exhaustedOnly || row.availableMicros <= 0,
											)
											.map(({ envelope, committedMicros, availableMicros }) => (
												<Surface
													className="flex items-center justify-between gap-3 rounded-none border-0 p-3"
													key={envelope.id}
													render={<li />}
												>
													<div className="min-w-0 break-words">
														<strong>
															<BudgetScopeLink
																scopeType={envelope.scopeType}
																scopeId={envelope.scopeId}
															/>
														</strong>
														<br />
														<Badge
															variant={
																availableMicros <= 0 ? "destructive" : "outline"
															}
														>
															{availableMicros <= 0 ? "Exhausted" : "Available"}
														</Badge>
														<Collapsible>
															<CollapsibleTrigger>
																Budget details
															</CollapsibleTrigger>
															<CollapsibleContent>
																<Text as="span" role="label" tone="secondary">
																	{committedMicros} committed ·{" "}
																	{availableMicros} available (micros) · version{" "}
																	{envelope.version}
																</Text>
															</CollapsibleContent>
														</Collapsible>
													</div>
													<Button
														size="sm"
														variant="outline"
														onClick={() => {
															budgetForm.setFieldValue(
																"scopeType",
																envelope.scopeType,
															);
															budgetForm.setFieldValue(
																"scopeId",
																envelope.scopeId,
															);
															budgetForm.setFieldValue(
																"limitMicros",
																String(envelope.limitMicros),
															);
															budgetForm.setFieldValue(
																"reservationMicros",
																String(envelope.reservationMicros),
															);
															setBudgetVersion(envelope.version);
															setBudgetFormOpen(true);
														}}
													>
														Edit
													</Button>
												</Surface>
											))}
									</Collection>
								) : exhaustedOnly ? (
									"No exhausted budgets on this page. Use Next page to check more budgets."
								) : (
									"No budgets on this page."
								)}
								<PageControls
									label="budget envelopes"
									hasPrevious={budgetPaging.hasPrevious}
									hasNext={Boolean(budgets.data.nextCursor)}
									onPrevious={budgetPaging.reset}
									onBack={budgetPaging.previous}
									onNext={() => {
										if (budgets.data.nextCursor)
											budgetPaging.next(budgets.data.nextCursor);
									}}
								/>
							</CardContent>
						</Card>
					) : null}
				</div>
			)}
		</Page>
	);
}
