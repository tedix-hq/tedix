import {
	WorkPageHeader,
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import { markdownLineToPlainText } from "@tedix/api-contract/utils/markdown-plain-text";
import { latestDraftOf } from "@/components/work-interaction-draft";
import {
	interactionContextLabel,
	interactionSubject,
} from "@/lib/work-interaction-display";
import { workInteractionsSearch } from "@/lib/work-route-search";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import { useEffect, useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import { WorkInteractionDecisionCard } from "@/components/work-interaction-decision-card";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Link } from "@/components/kumo/link";
import {
	Collection,
	Page,
	PageBack,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { SelectItem } from "@/components/kumo/select";
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
import { osApi } from "@/lib/api";
import { useOsFormattingPreferences, sentenceCase } from "@/lib/format";
import {
	workFleetQueryOptions,
	workInteractionDetailQueryOptions,
	workInteractionsQueryOptions,
	workItemReadinessQueryOptions,
	osQueryKeys,
	workSchedulerQueryOptions,
	workUrgentInteractionsQueryOptions,
} from "@/lib/os-query-options";
import { useDocumentTitle } from "@/lib/use-document-title";
import {
	namedWorkPrincipal,
	useWorkPrincipalNames,
	OperationActor,
	MutationError,
	useCursorPaging,
	PageControls,
	answerDeliveryLine,
	urgentInteractionSummary,
	groupSessionQuestions,
} from "./work-operations-shared";

const interactionRequestSchema = z.object({
	contextType: z.enum(["work_item", "case", "project"]),
	contextId: z.string().trim().min(1, "Enter a context id."),
	kind: z.enum(["question", "input", "handoff", "coordination"]),
	subject: z.string().trim().min(1, "Enter a subject."),
	reason: z.string().trim().max(300, "Keep the reason to one line."),
	prompt: z.string().trim().min(1, "Enter the requested input."),
	targetType: z.enum(["user", "tedi", "external_agent"]),
	targetId: z.string().trim().min(1, "Enter a target principal id."),
});

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

export function NeedsYouNowSection() {
	const query = useQuery(workUrgentInteractionsQueryOptions());
	const groups = useExpandedGroups();
	const rows = query.data?.data ?? [];
	if (rows.length === 0) return null;
	type UrgentRow = (typeof rows)[number];
	const renderRow = (
		{ request, workItem }: UrgentRow,
		earlier?: UrgentRow[],
		mobile = false,
	) => {
		const summary = urgentInteractionSummary(request.metadata);
		const subject = interactionSubject(request);
		const reason = markdownLineToPlainText(
			request.prompt.split("\n").find((line) => line.trim()) ?? "",
		).slice(0, 240);
		const title = (
			<>
				<Link
					variant="record"
					className="inline-flex min-h-11 items-center py-2"
					href={`/work/interactions/${request.id}`}
				>
					{subject}
				</Link>
				{workItem && workItem.title.trim() !== subject.trim() && (
					<Text as="p" role="label" tone="secondary">
						{workItem.title}
					</Text>
				)}
				{earlier && (
					<EarlierTurnsToggle
						count={earlier.length}
						expanded={groups.isExpanded(request.id)}
						onToggle={() => groups.toggle(request.id)}
					/>
				)}
			</>
		);
		const reasons = (
			<div className="grid gap-2">
				<span className="flex flex-wrap gap-1">
					{summary.reasons.length ? (
						summary.reasons.map((reason) => (
							<Badge key={reason} variant="error">
								{reason}
							</Badge>
						))
					) : (
						<Badge variant="warning">Needs you</Badge>
					)}
				</span>
				{reason && reason !== subject.trim() && (
					<Text as="p" role="label" tone="secondary" className="line-clamp-3">
						{reason}
					</Text>
				)}
			</div>
		);
		const origin = (
			<div className="grid min-w-0 gap-1 break-words">
				<OperationActor type={request.creatorType} id={request.creatorId} />
				{summary.origin.length ? (
					<Text as="p" role="label" tone="secondary" title={summary.sessionId}>
						{summary.origin.join(" · ")}
					</Text>
				) : workItem ? (
					<Link href={`/work/items/${workItem.id}`} className="min-h-11 py-2">
						Open linked Work
					</Link>
				) : request.caseId ? (
					<Link
						href={`/work/cases/${request.caseId}`}
						className="min-h-11 py-2"
					>
						Linked epic
					</Link>
				) : request.projectId ? (
					<Link
						href={`/work/projects/${request.projectId}`}
						className="min-h-11 py-2"
					>
						Linked project
					</Link>
				) : request.creatorSessionId ? (
					<Text
						as="p"
						role="label"
						tone="secondary"
						title={request.creatorSessionId}
					>
						Requesting session {request.creatorSessionId.slice(0, 8)}
					</Text>
				) : (
					<Text as="p" role="label" tone="secondary">
						Origin not recorded
					</Text>
				)}
			</div>
		);
		return mobile ? (
			<li key={request.id} className="grid min-w-0 gap-2 px-3 py-3">
				<div>{title}</div>
				{reasons}
				{origin}
			</li>
		) : (
			<TableRow key={request.id}>
				<TableCell className="whitespace-normal">{title}</TableCell>
				<TableCell className="whitespace-normal">{reasons}</TableCell>
				<TableCell className="whitespace-normal">{origin}</TableCell>
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
			<Collection
				appearance="inline"
				aria-label="Requests that need you now"
				className="sm:hidden"
			>
				{groupSessionQuestions(rows).flatMap(({ row, earlier }) => [
					renderRow(row, earlier, true),
					...(groups.isExpanded(row.request.id)
						? earlier.map((older) => renderRow(older, undefined, true))
						: []),
				])}
			</Collection>
			<Table
				scrollLabel="Requests that need you now"
				containerClassName="hidden sm:block"
			>
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
				...(value.reason ? { reason: value.reason } : {}),
				prompt: value.prompt,
				requestedFrom: { type: value.targetType, id: value.targetId },
				metadata: {},
			}),
		onSuccess: async (_result, value) => {
			form.setFieldValue("subject", "");
			form.setFieldValue("reason", "");
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
			reason: "",
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
		mobile = false,
	) => {
		const context = (
			<Text as="p" role="label" tone="secondary" className="break-words">
				{interactionContextLabel(request, workItem?.title)} ·{" "}
				{sentenceCase(request.kind)}
			</Text>
		);
		const toggle = earlier ? (
			<EarlierTurnsToggle
				count={earlier.length}
				expanded={groups.isExpanded(request.id)}
				onToggle={() => groups.toggle(request.id)}
			/>
		) : null;
		const state = (
			<Badge
				variant={effectiveState === "open" ? "warning" : "outline"}
				className={mobile ? "mt-1 shrink-0" : undefined}
			>
				{sentenceCase(effectiveState)}
			</Badge>
		);
		const target = (
			<span title={`${request.requestedFromType}:${request.requestedFromId}`}>
				{namedWorkPrincipal(
					request.requestedFromType,
					request.requestedFromId,
					names,
				)}
			</span>
		);
		// A four-column table squeezed the subject into a sliver on phones.
		return mobile ? (
			<li
				key={request.id}
				className="grid min-w-0 gap-1 px-3 py-2"
				data-mobile-interaction-row
			>
				<div className="flex min-w-0 items-start justify-between gap-3">
					<Link
						variant="record"
						href={`/work/interactions/${request.id}`}
						className="flex min-h-11 min-w-0 flex-1 items-center py-1 font-medium leading-snug"
					>
						<span className="line-clamp-2">{interactionSubject(request)}</span>
					</Link>
					{state}
				</div>
				{context}
				<Text as="p" role="label" tone="secondary" className="truncate">
					To {target} ·{" "}
					{responseCount === 1 ? "1 response" : `${responseCount} responses`}
				</Text>
				{toggle}
			</li>
		) : (
			<TableRow key={request.id}>
				<TableCell className="whitespace-normal">
					<Link variant="record" href={`/work/interactions/${request.id}`}>
						{interactionSubject(request)}
					</Link>
					{toggle}
					{context}
				</TableCell>
				<TableCell>{state}</TableCell>
				<TableCell>{target}</TableCell>
				<TableCell>{responseCount}</TableCell>
			</TableRow>
		);
	};
	const interactionRows = (mobile: boolean) =>
		(listView === "inbox"
			? groupSessionQuestions(visibleRows)
			: visibleRows.map((row) => ({ row, earlier: [] }))
		).flatMap(({ row, earlier }) => [
			renderInteractionRow(row, earlier, mobile),
			...(groups.isExpanded(row.request.id)
				? earlier.map((older) => renderInteractionRow(older, undefined, mobile))
				: []),
		]);
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
			<WorkPageHeader
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
				aria-label="Request view"
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
										<SelectItem value="case">Epic</SelectItem>
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
									["reason", "Why it needs them (one line)"],
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
					<WorkListSkeleton />
				) : query.isError ? (
					<WorkReadFailure
						title="Requests unavailable"
						error={query.error}
						onRetry={() => query.refetch()}
						retrying={query.isFetching}
					/>
				) : visibleRows.length === 0 ? (
					<WorkEmpty
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
					<>
						<Collection
							appearance="inline"
							aria-label="Requests"
							className="border-kumo-line border-y sm:hidden"
						>
							{interactionRows(true)}
						</Collection>
						<Table scrollLabel="Requests" containerClassName="hidden sm:block">
							<TableHeader>
								<TableRow>
									<TableHead>Request</TableHead>
									<TableHead>State</TableHead>
									<TableHead>Target</TableHead>
									<TableHead>Responses</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>{interactionRows(false)}</TableBody>
						</Table>
					</>
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

export function WorkInteractionPage({ requestId }: { requestId: string }) {
	useOsFormattingPreferences();
	const query = useQuery(workInteractionDetailQueryOptions(requestId));
	const names = useWorkPrincipalNames(query.data?.request.orgId);
	const request = query.data?.request;
	const draft = latestDraftOf(query.data);
	useDocumentTitle(
		request ? `${interactionSubject(request)} · Requests` : "Request · Work",
	);
	return (
		<Page width="lg">
			<PageBack render={<Link href="/work?view=deck" />}>Decisions</PageBack>
			<WorkInteractionDecisionCard
				deliveryText={answerDeliveryLine(request?.metadata)?.text}
				requestId={requestId}
				askedBy={
					request
						? names.get(`${request.creatorType}:${request.creatorId}`)
						: undefined
				}
				drafterName={draft ? names.get(`tedi:${draft.drafterId}`) : undefined}
			/>
		</Page>
	);
}
