import type {
	WorkItem,
	WorkItemRelationEdge,
} from "@tedix/api-contract/schemas/work-items";
import type { Project } from "@tedix/api-contract/contracts/projects";
import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Link } from "@/components/kumo/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import type { WorkActivityView } from "@/lib/os-query-options";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/kumo/empty";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Page,
	PageBack,
	Collection,
	PageDescription,
	PageGrid,
	PageHeader,
	PageHeading,
	SectionCollection,
	PageTitle,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { Skeleton } from "@/components/kumo/skeleton";
import { SearchInput } from "@/components/kumo/search-input";
import { SelectItem } from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { useWorkItemWebMcpTools } from "@/components/work-item-webmcp-tools";
import { WorkAttentionSummary } from "@/components/work-attention-summary";
import { WorkstationInspectionPanel } from "@/components/workstation-inspection-panel";
import { formatRatioPercent, sentenceCase } from "@/lib/format";
import {
	projectDetailQueryOptions,
	projectListQueryOptions,
	projectRollupQueryOptions,
	projectHealthJudgmentsQueryOptions,
	projectMilestonesQueryOptions,
	osQueryKeys,
	workFleetQueryOptions,
	workAttemptProjectionQueryOptions,
	workGraphItemsQueryOptions,
	workItemAttemptsQueryOptions,
	workItemDetailQueryOptions,
	workItemEventsQueryOptions,
	workItemEvidenceQueryOptions,
	workEvidencePreviewQueryOptions,
	workItemListQueryOptions,
	workItemReadinessQueryOptions,
	workItemRelationsQueryOptions,
	workRecoveryProjectionQueryOptions,
	workReadinessProjectionQueryOptions,
} from "@/lib/os-query-options";
import { osApi } from "@/lib/api";
import { absoluteTime } from "@/lib/time";
import { errorMessage } from "@/lib/orpc-error";
import { useDocumentTitle } from "@/lib/use-document-title";
import { workPrincipalLabel } from "@/lib/work-display";
import { PageControls, useCursorPaging } from "./work-operations-pages";

const WORK_LIST_LIMIT = 100;
const PORTFOLIO_PAGE_SIZE = 20;

function FactoryPageHeader({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	useDocumentTitle(`${title} · Work`);
	return (
		<PageHeader>
			<PageHeading>
				<PageTitle>{title}</PageTitle>
				<PageDescription>{description}</PageDescription>
			</PageHeading>
		</PageHeader>
	);
}

export function WorkItemInspectorPage({ children }: { children: ReactNode }) {
	return (
		<Page width="lg">
			<PageBack render={<Link href="/work" />}>All work</PageBack>
			{children}
		</Page>
	);
}

export function WorkItemReadOnlyLedgers({
	acceptanceContract,
	attempts,
	attemptsError,
	attemptControls,
	evidence,
	evidenceError,
	evidenceControls,
	events,
	workItemId,
}: {
	workItemId: string;
	acceptanceContract: WorkItem["acceptanceContract"];
	attempts: Array<
		{
			id: string;
			runtimeState: string;
			executorType: string;
			executorId: string;
			attemptNumber: number;
		} & WorkAttemptActivityFields
	>;

	attemptsError?: unknown;
	attemptControls?: ReactNode;
	evidence: Array<{
		id: string;
		uri: string;
		label: string | null;
		kind: string;
		claimKey: string;
		disposition: string;
		reference?: {
			kind: string;
			status: string;
			reason?: string | null;
			bundleDigestKind?: string | null;
		};
	}>;
	evidenceError?: unknown;
	evidenceControls?: ReactNode;
	events: Array<{
		id: string;
		eventType: string;
		actorType: string;
		actorId: string;
		occurredAt: string;
	}>;
}) {
	return (
		<>
			<SectionCollection
				title="Acceptance contract"
				description={
					acceptanceContract
						? "What done looks like"
						: "Required before proposed work can become execution-ready."
				}
				empty="No acceptance contract defined."
			>
				{acceptanceContract?.doneLooksLike ? (
					<li>{acceptanceContract.doneLooksLike}</li>
				) : undefined}
			</SectionCollection>
			<PageGrid className="items-start">
				<SectionCollection
					title={`Attempts on this page (${attempts.length})`}
					description="Runtime outcomes remain separate from business disposition."
					empty="No execution attempts on this page."
					footer={attemptControls}
				>
					{attemptsError ? (
						<li>
							<QueryFailure
								title="Attempts unavailable"
								error={attemptsError}
							/>
						</li>
					) : attempts.length ? (
						attempts.map((attempt) => (
							<li
								className="flex min-w-0 items-center justify-between gap-3"
								key={attempt.id}
							>
								<div className="min-w-0">
									<Text weight="medium">Attempt {attempt.attemptNumber}</Text>
									<Text
										role="label"
										tone="mono-secondary"
										title={`${attempt.executorType}:${attempt.executorId}`}
									>
										{workPrincipalLabel(
											attempt.executorId,
											attempt.executorType,
										)}
									</Text>
									<WorkAttemptActivity attempt={attempt} />
								</div>
								<Badge variant="outline">
									{sentenceCase(attempt.runtimeState)}
								</Badge>
								{attempt.executorType === "tedi" &&
								["queued", "running", "waiting", "retrying"].includes(
									attempt.runtimeState,
								) ? (
									<WorkstationInspectionPanel
										workItemId={workItemId}
										attemptId={attempt.id}
									/>
								) : null}
							</li>
						))
					) : undefined}
				</SectionCollection>
				<SectionCollection
					title={`Evidence on this page (${evidence.length})`}
					description="Submission and independent review are separate transitions."
					empty="No evidence submitted on this page."
					footer={evidenceControls}
				>
					{evidenceError ? (
						<li>
							<QueryFailure
								title="Evidence unavailable"
								error={evidenceError}
							/>
						</li>
					) : evidence.length ? (
						evidence.map((record) => (
							<li className="grid min-w-0 gap-2" key={record.id}>
								<div className="flex min-w-0 items-center justify-between gap-3">
									<div className="min-w-0 flex-1">
										<EvidenceReference
											uri={record.uri}
											label={record.label ?? sentenceCase(record.kind)}
											compact
										/>
										<Text role="label" tone="secondary">
											{sentenceCase(record.claimKey)}
										</Text>
										<EvidenceTrustBadge
											reference={
												record.reference ?? {
													kind: "unsupported",
													status: "unavailable",
												}
											}
										/>
									</div>
									<Badge
										variant={evidenceDispositionVariant(record.disposition)}
									>
										{sentenceCase(record.disposition)}
									</Badge>
								</div>
								{record.reference ? (
									<EvidencePreview
										workItemId={workItemId}
										evidenceId={record.id}
									/>
								) : null}
							</li>
						))
					) : undefined}
				</SectionCollection>
			</PageGrid>
			<SectionCollection
				title="Immutable events"
				description="Discussion remains in comments; lifecycle state is recorded here."
				empty="No lifecycle events recorded."
			>
				{events.length
					? events.map((event) => (
							<li className="min-w-0" key={event.id}>
								<Text weight="medium">
									{sentenceCase(event.eventType.replaceAll(".", "_"))}
								</Text>
								<Text role="label" tone="secondary">
									<span title={`${event.actorType}:${event.actorId}`}>
										{workEventActorLabel(event.actorId, event.actorType)}
									</span>{" "}
									·{" "}
									<time dateTime={event.occurredAt}>
										{new Date(event.occurredAt).toLocaleString()}
									</time>
								</Text>
							</li>
						))
					: undefined}
			</SectionCollection>
		</>
	);
}

export function evidenceTrustLabel(reference: {
	kind: string;
	status: string;
	bundleDigestKind?: string | null;
}) {
	if (reference.kind === "external_https") return "Unverified external";
	if (reference.status === "unverified_legacy") return "Unverified legacy";
	if (reference.status !== "available") return "Source access unavailable";
	if (reference.kind === "output_revision") return "Exact output revision";
	if (reference.bundleDigestKind === "manifest")
		return "Governed artifact · manifest digest";
	return "Governed artifact";
}

function EvidenceTrustBadge({
	reference,
}: {
	reference: { kind: string; status: string; bundleDigestKind?: string | null };
}) {
	return (
		<Badge variant={reference.status === "available" ? "success" : "outline"}>
			{evidenceTrustLabel(reference)}
		</Badge>
	);
}

function EvidencePreview({
	workItemId,
	evidenceId,
}: {
	workItemId: string;
	evidenceId: string;
}) {
	const preview = useQuery({
		...workEvidencePreviewQueryOptions(workItemId, evidenceId),
		enabled: false,
	});
	return (
		<div className="grid gap-2">
			<Button
				size="sm"
				variant="secondary"
				onClick={() => void preview.refetch()}
				disabled={preview.isFetching}
			>
				{preview.isFetching ? "Loading preview…" : "Preview evidence"}
			</Button>
			<EvidencePreviewResult failed={preview.isError} preview={preview.data} />
		</div>
	);
}

export function EvidencePreviewResult({
	failed,
	preview,
}: {
	failed: boolean;
	preview:
		| { status: "available"; text: string; truncated: boolean }
		| { status: "external" }
		| { status: "unavailable" }
		| undefined;
}) {
	if (failed) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Preview request failed</AlertTitle>
				<AlertDescription>
					Tedix could not load this preview. Retry without changing the evidence
					record.
				</AlertDescription>
			</Alert>
		);
	}
	return preview?.status === "available" ? (
		<>
			<Surface className="max-h-64 overflow-auto p-3">
				<Text as="pre" role="body" className="whitespace-pre-wrap break-words">
					{preview.text}
				</Text>
			</Surface>
			{preview.truncated ? (
				<Text role="label" tone="secondary">
					Preview truncated at 50 KiB. Open the governed source for the complete
					evidence.
				</Text>
			) : null}
		</>
	) : preview?.status === "external" ? (
		<Alert>
			<AlertTitle>Unverified external evidence</AlertTitle>
			<AlertDescription>
				Open the external source to inspect it. Tedix has not verified its
				bytes.
			</AlertDescription>
		</Alert>
	) : preview?.status === "unavailable" ? (
		<Alert variant="destructive">
			<AlertTitle>Preview unavailable</AlertTitle>
			<AlertDescription>
				Source access is unavailable or the evidence is not immutable.
			</AlertDescription>
		</Alert>
	) : null;
}

function QueryFailure({ title, error }: { title: string; error?: unknown }) {
	return (
		<Alert variant="destructive">
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>
				{errorMessage(
					error,
					"The canonical projection failed. Retry once; if the failure persists, inspect the API Work projection health.",
				)}
			</AlertDescription>
		</Alert>
	);
}

function LoadingTable() {
	return (
		<div className="grid gap-2" aria-label="Loading">
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-10 w-full" />
		</div>
	);
}

function EmptyState({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

function dispositionVariant(disposition: WorkItem["disposition"]) {
	if (disposition === "completed") return "success" as const;
	if (disposition === "cancelled") return "outline" as const;
	if (disposition === "accepted") return "secondary" as const;
	return "warning" as const;
}

type WorkItemSummary = Pick<
	WorkItem,
	| "id"
	| "title"
	| "disposition"
	| "workKind"
	| "accountableOwnerId"
	| "createdAt"
	| "updatedAt"
>;

type WorkItemReadiness =
	| { status: "evaluated"; state: string; ready: boolean }
	| { status: "evaluating" | "unavailable" };

function ReadinessStatus({ state }: { state?: WorkItemReadiness }) {
	if (state?.status === "evaluated") {
		return (
			<Badge variant={state.ready ? "success" : "warning"}>
				{sentenceCase(state.state)}
			</Badge>
		);
	}
	if (state?.status === "evaluating") {
		return <Badge variant="outline">Evaluating gates</Badge>;
	}
	if (state?.status === "unavailable") {
		return <Badge variant="error">Gates unavailable</Badge>;
	}
	return <span className="text-kumo-subtle">Not evaluated</span>;
}

export function WorkItemStatusSummary({
	disposition,
	accountableOwnerId,
	readiness,
}: {
	disposition: WorkItem["disposition"];
	accountableOwnerId: string | null;
	readiness?: {
		state: string;
		ready: boolean;
		reasons: Array<{ detail: string }>;
	};
}) {
	return (
		<div className="border-kumo-line border-y">
			<dl
				aria-label="Work item status"
				className="m-0 grid sm:grid-cols-3 sm:divide-x sm:divide-kumo-line"
			>
				<div className="grid gap-1 px-4 py-3">
					<Text as="dt" role="body" tone="secondary">
						Business disposition
					</Text>
					<dd className="m-0">
						<Badge variant={dispositionVariant(disposition)}>
							{sentenceCase(disposition)}
						</Badge>
					</dd>
				</div>
				<div className="grid gap-1 border-kumo-line border-t px-4 py-3 sm:border-t-0">
					<Text as="dt" role="body" tone="secondary">
						Readiness
					</Text>
					<dd className="m-0">
						{readiness ? (
							<Badge variant={readiness.ready ? "success" : "warning"}>
								{sentenceCase(readiness.state)}
							</Badge>
						) : (
							<span className="text-kumo-subtle">Unavailable</span>
						)}
					</dd>
				</div>
				<div className="grid gap-1 border-kumo-line border-t px-4 py-3 sm:border-t-0">
					<Text as="dt" role="body" tone="secondary">
						Accountable
					</Text>
					<dd className="m-0 truncate font-medium">
						{accountableOwnerId ?? "Unassigned"}
					</dd>
				</div>
			</dl>
			{readiness?.reasons.length ? (
				<ul className="m-0 grid gap-1 border-kumo-line border-t px-4 py-3 pl-9 text-sm">
					{readiness.reasons.map((reason, index) => (
						<li key={`${reason.detail}-${index}`}>{reason.detail}</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

function WorkItemMobileList({
	items,
	readiness,
	showDisposition,
	showReadiness,
}: {
	items: WorkItemSummary[];
	readiness?: Map<string, WorkItemReadiness>;
	showDisposition: boolean;
	showReadiness: boolean;
}) {
	return (
		<Collection
			appearance="inline"
			aria-label="Work queue"
			className="border-kumo-line border-y md:hidden"
		>
			{items.map((item) => {
				const updatedAt = item.updatedAt ?? item.createdAt;
				return (
					<li className="min-w-0 py-1" key={item.id}>
						<Link
							variant="record"
							href={`/work/items/${item.id}`}
							className="flex min-h-11 min-w-0 flex-col items-start justify-center py-1 text-left font-medium leading-snug coarse:min-h-11"
						>
							<span className="line-clamp-2">{item.title}</span>
							<Text as="span" role="label" tone="mono-secondary">
								{item.id.slice(0, 8)}
							</Text>
						</Link>
						<div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-1">
							{showDisposition ? (
								<Badge variant={dispositionVariant(item.disposition)}>
									{sentenceCase(item.disposition)}
								</Badge>
							) : null}
							{showReadiness ? (
								<ReadinessStatus state={readiness?.get(item.id)} />
							) : null}
							<dl className="m-0 flex min-w-0 basis-full flex-wrap items-center gap-x-1 gap-y-0.5 text-kumo-subtle type-tedix-label">
								<div className="min-w-0">
									<dt className="sr-only">Kind</dt>
									<dd className="m-0 whitespace-nowrap text-kumo-default">
										{sentenceCase(item.workKind)}
									</dd>
								</div>
								<span aria-hidden="true">·</span>
								<div className="min-w-0">
									<dt className="sr-only">Updated</dt>
									<dd className="m-0 whitespace-nowrap">
										<time dateTime={updatedAt} title={absoluteTime(updatedAt)}>
											{new Date(updatedAt).toLocaleDateString()}
										</time>
									</dd>
								</div>
								<span aria-hidden="true">·</span>
								<div className="min-w-0 max-w-full">
									<dt className="sr-only">Accountable</dt>
									<dd
										className="m-0 font-mono"
										title={`Accountable: ${item.accountableOwnerId ?? "Unassigned"}`}
									>
										{workPrincipalLabel(item.accountableOwnerId)}
									</dd>
								</div>
							</dl>
						</div>
					</li>
				);
			})}
		</Collection>
	);
}

export function WorkItemsTable({
	items,
	readiness,
	showDisposition = true,
	showReadiness = true,
}: {
	items: WorkItemSummary[];
	readiness?: Map<string, WorkItemReadiness>;
	showDisposition?: boolean;
	showReadiness?: boolean;
}) {
	return (
		<>
			<WorkItemMobileList
				items={items}
				readiness={readiness}
				showDisposition={showDisposition}
				showReadiness={showReadiness}
			/>
			<Table
				scrollLabel="Work queue"
				containerClassName="hidden md:block"
				className={
					showDisposition
						? "min-w-[44rem] table-fixed xl:min-w-[54rem]"
						: "min-w-[38rem] table-fixed xl:min-w-[48rem]"
				}
			>
				<TableHeader>
					<TableRow>
						<TableHead
							className={
								showDisposition ? "w-[42%] xl:w-[34%]" : "w-[50%] xl:w-[40%]"
							}
						>
							Outcome
						</TableHead>
						{showDisposition ? (
							<TableHead className="w-[15%] xl:w-[12%]">Disposition</TableHead>
						) : null}
						{showReadiness ? (
							<TableHead
								className={
									showDisposition ? "w-[15%] xl:w-[12%]" : "w-[20%] xl:w-[15%]"
								}
							>
								Readiness
							</TableHead>
						) : null}
						<TableHead
							className={
								showDisposition ? "w-[12%] xl:w-[11%]" : "w-[14%] xl:w-[14%]"
							}
						>
							Kind
						</TableHead>
						<TableHead className="hidden xl:table-cell xl:w-[21%]">
							Accountable
						</TableHead>
						<TableHead className="w-[16%] xl:w-[10%]">Updated</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{items.map((item) => {
						const state = readiness?.get(item.id);
						return (
							<TableRow key={item.id}>
								<TableCell className="py-2! whitespace-normal">
									<Link
										variant="record"
										href={`/work/items/${item.id}`}
										className="line-clamp-2 font-medium"
									>
										{item.title}
									</Link>
									<div className="flex min-w-0 items-center gap-1.5">
										<Text as="span" role="label" tone="mono-secondary">
											{item.id.slice(0, 8)}
										</Text>
										<span
											className="text-kumo-subtle xl:hidden"
											aria-hidden="true"
										>
											·
										</span>
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="truncate xl:hidden"
											title={`Accountable: ${item.accountableOwnerId ?? "Unassigned"}`}
										>
											{workPrincipalLabel(item.accountableOwnerId)}
										</Text>
									</div>
								</TableCell>
								{showDisposition ? (
									<TableCell className="py-2!">
										<Badge variant={dispositionVariant(item.disposition)}>
											{sentenceCase(item.disposition)}
										</Badge>
									</TableCell>
								) : null}
								{showReadiness ? (
									<TableCell className="py-2!">
										<ReadinessStatus state={state} />
									</TableCell>
								) : null}
								<TableCell className="py-2!">
									{sentenceCase(item.workKind)}
								</TableCell>
								<TableCell
									className="hidden truncate py-2! xl:table-cell"
									title={item.accountableOwnerId ?? "Unassigned"}
								>
									{item.accountableOwnerId ?? "Unassigned"}
								</TableCell>
								<TableCell className="py-2!">
									<time
										dateTime={item.updatedAt ?? item.createdAt}
										title={absoluteTime(item.updatedAt ?? item.createdAt)}
									>
										{new Date(
											item.updatedAt ?? item.createdAt,
										).toLocaleDateString()}
									</time>
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</>
	);
}

export function workQueueSearch(search: Record<string, unknown>): {
	disposition?: "completed";
} {
	return search.disposition === "completed" ? { disposition: "completed" } : {};
}

export function WorkCompletedPage() {
	const [offset, setOffset] = useState(0);
	const query = useQuery(
		workItemListQueryOptions({ disposition: "completed", limit: 25, offset }),
	);
	return (
		<Page width="full">
			<FactoryPageHeader
				title="Completed work"
				description="Work recorded as completed. Open a record to inspect its outcome; completion does not by itself prove deployment."
			/>
			<Text as="p" role="body">
				<Link href="/work">Queue</Link>
				{" · "}
				<Link href="/work?disposition=completed" aria-current="page">
					Completed
				</Link>
			</Text>
			{query.isPending ? (
				<LoadingTable />
			) : query.isError ? (
				<QueryFailure title="Completed work unavailable" error={query.error} />
			) : query.data.data.length ? (
				<WorkItemsTable items={query.data.data} showReadiness={false} />
			) : (
				<EmptyState
					title="No completed work on this page"
					description="Completed Work records will appear here."
				/>
			)}
			<PageControls
				hasPrevious={offset > 0}
				hasNext={Boolean(query.data?.pagination.hasMore)}
				onPrevious={() => setOffset(0)}
				onBack={() => setOffset(Math.max(0, offset - 25))}
				onNext={() => setOffset(offset + 25)}
			/>
		</Page>
	);
}

export function WorkQueuePage() {
	const fleet = useQuery(workFleetQueryOptions());
	const paging = useCursorPaging<{ at: string; id: string }>();
	const queueQuery = useQuery(
		workReadinessProjectionQueryOptions(paging.cursor),
	);
	const entries = queueQuery.data?.data ?? [];
	const items = entries.map((entry) => entry.workItem);
	const readiness = new Map(
		entries.map((entry) => [
			entry.workItem.id,
			{ status: "evaluated" as const, ...entry.readiness },
		]),
	);
	return (
		<Page width="full">
			<FactoryPageHeader
				title="Admission queue"
				description="Accepted work is evaluated against dependencies, capabilities, authority, budget, resources, and active attempts. Each row distinguishes completed gate evaluation from pending or unavailable checks."
			/>
			<Text as="p" role="body">
				<Link href="/work" aria-current="page">
					Queue
				</Link>
				{" · "}
				<Link href="/work?disposition=completed">Completed</Link>
			</Text>
			<WorkAttentionSummary
				snapshot={fleet.data}
				pending={fleet.isPending}
				error={fleet.isError}
				refreshing={fleet.isFetching}
				onRefresh={() => {
					void fleet.refetch();
				}}
			/>
			{queueQuery.isPending ? (
				<LoadingTable />
			) : queueQuery.isError ? (
				<QueryFailure title="Work queue unavailable" error={queueQuery.error} />
			) : items.length === 0 ? (
				<EmptyState
					title="No accepted work"
					description="Create a proposed Work Item, define its acceptance contract, and accept it before admission gates are evaluated."
				/>
			) : (
				<WorkItemsTable
					items={items}
					readiness={readiness}
					showDisposition={false}
				/>
			)}
			<PageControls
				hasPrevious={paging.hasPrevious}
				hasNext={Boolean(queueQuery.data?.nextCursor)}
				onPrevious={paging.reset}
				onBack={paging.previous}
				onNext={() => {
					if (queueQuery.data?.nextCursor)
						paging.next(queueQuery.data.nextCursor);
				}}
			/>
		</Page>
	);
}

type PortfolioRollup = {
	percentDone: number;
	aggregateDisposition: string;
};

function projectStatusVariant(status: Project["status"]) {
	if (status === "active") return "success" as const;
	if (status === "paused") return "warning" as const;
	if (status === "done") return "secondary" as const;
	return "outline" as const;
}

export function PortfolioProjectList({
	projects,
	rollups,
}: {
	projects: Project[];
	rollups: Array<PortfolioRollup | undefined>;
}) {
	return (
		<>
			<Collection aria-label="Projects" className="lg:hidden">
				{projects.map((project, index) => {
					const rollup = rollups[index];
					return (
						<li
							className="min-w-0 space-y-1.5 px-3 py-3"
							data-mobile-project-row
							key={project.id}
						>
							<div className="flex min-w-0 items-start justify-between gap-3">
								<Link
									variant="record"
									href={`/work/projects/${project.id}`}
									className="min-w-0 font-medium leading-snug"
								>
									<span className="line-clamp-2">{project.name}</span>
								</Link>
								<Badge variant={projectStatusVariant(project.status)}>
									{sentenceCase(project.status)}
								</Badge>
							</div>
							<div className="grid min-w-0 gap-1">
								<div className="flex min-w-0 items-center justify-between gap-2">
									<Text
										as="span"
										role="label"
										tone="mono-secondary"
										className="min-w-0 truncate"
									>
										{project.key}
									</Text>
									<Text
										as="span"
										role="label"
										tone="secondary"
										className="shrink-0 tabular-nums"
										data-mobile-project-progress
									>
										{rollup
											? `${formatRatioPercent(rollup.percentDone)} · ${sentenceCase(rollup.aggregateDisposition)}`
											: "Loading progress…"}
									</Text>
								</div>
								<div className="flex min-w-0 items-center justify-between gap-2">
									<Text
										as="span"
										role="label"
										tone="secondary"
										className="min-w-0 truncate"
										title={
											project.ownerUserId ?? project.leadTediId ?? "Unassigned"
										}
										data-mobile-project-owner
									>
										Owner:{" "}
										{workPrincipalLabel(
											project.ownerUserId ?? project.leadTediId,
										)}
									</Text>
									{project.targetDate ? (
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="shrink-0 tabular-nums"
											data-mobile-project-horizon
										>
											{project.targetDate}
										</Text>
									) : null}
								</div>
							</div>
						</li>
					);
				})}
			</Collection>
			<Table scrollLabel="Projects" containerClassName="hidden lg:block">
				<TableHeader>
					<TableRow>
						<TableHead>Project</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>Owner</TableHead>
						<TableHead>Horizon</TableHead>
						<TableHead>Outcome progress</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{projects.map((project, index) => {
						const rollup = rollups[index];
						return (
							<TableRow key={project.id}>
								<TableCell className="max-w-md whitespace-normal">
									<Link
										variant="record"
										href={`/work/projects/${project.id}`}
										className="font-medium"
									>
										{project.name}
									</Link>
									<Text as="p" role="label" tone="mono-secondary">
										{project.key}
									</Text>
								</TableCell>
								<TableCell>
									<Badge variant={projectStatusVariant(project.status)}>
										{sentenceCase(project.status)}
									</Badge>
								</TableCell>
								<TableCell
									className="max-w-44 truncate"
									title={
										project.ownerUserId ?? project.leadTediId ?? "Unassigned"
									}
								>
									{workPrincipalLabel(
										project.ownerUserId ?? project.leadTediId,
									)}
								</TableCell>
								<TableCell>{project.targetDate ?? "Not recorded"}</TableCell>
								<TableCell className="tabular-nums">
									{rollup
										? `${formatRatioPercent(rollup.percentDone)} · ${sentenceCase(rollup.aggregateDisposition)}`
										: "Loading…"}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</>
	);
}

export function WorkPortfolioPage() {
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [page, setPage] = useState(0);
	useEffect(() => {
		const timeout = window.setTimeout(() => setDebouncedSearch(search), 250);
		return () => window.clearTimeout(timeout);
	}, [search]);
	const normalizedSearch = debouncedSearch.trim() || undefined;
	const searchIsPending = search.trim() !== debouncedSearch.trim();
	const offset = page * PORTFOLIO_PAGE_SIZE;
	const projectsQuery = useQuery(
		projectListQueryOptions(PORTFOLIO_PAGE_SIZE, {
			offset,
			search: normalizedSearch,
		}),
	);
	const projects = projectsQuery.data?.data ?? [];
	const total = projectsQuery.data?.pagination.total ?? 0;
	useEffect(() => {
		if (projectsQuery.data && page > 0 && offset >= total) {
			setPage(Math.max(0, Math.ceil(total / PORTFOLIO_PAGE_SIZE) - 1));
		}
	}, [projectsQuery.data, page, offset, total]);
	const rollups = useQueries({
		queries: projects.map((project) => projectRollupQueryOptions(project.id)),
	});
	return (
		<Page width="full">
			<FactoryPageHeader
				title="Portfolio and projects"
				description="Project health, ownership, horizon, and outcome progress stay separate from attempt runtime state."
			/>
			{total > 0 || search ? (
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
					<SearchInput
						aria-label="Search projects"
						containerClassName="w-full sm:max-w-md"
						maxLength={200}
						placeholder="Search projects"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setPage(0);
						}}
					/>
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="tabular-nums"
					>
						{searchIsPending || projectsQuery.isPending
							? "Searching…"
							: `${total} ${normalizedSearch ? "matching " : ""}projects`}
					</Text>
				</div>
			) : null}
			{searchIsPending || projectsQuery.isPending ? (
				<LoadingTable />
			) : projectsQuery.isError ? (
				<QueryFailure
					title="Portfolio unavailable"
					error={projectsQuery.error}
				/>
			) : total === 0 && !normalizedSearch ? (
				<EmptyState
					title="No projects yet"
					description="Group related work under one goal and owner."
				/>
			) : projects.length === 0 ? (
				<EmptyState
					title="No matching projects"
					description="Try a project name, key, status, or owner."
				/>
			) : (
				<>
					<PortfolioProjectList
						projects={projects}
						rollups={rollups.map((rollup) => rollup.data)}
					/>
					{total > PORTFOLIO_PAGE_SIZE ? (
						<div
							aria-live="polite"
							className="flex flex-col items-center justify-between gap-2 sm:flex-row"
						>
							<Text as="p" role="label" tone="secondary">
								Showing {offset + 1}–{offset + projects.length} of {total}{" "}
								projects
							</Text>
							<div className="flex w-full gap-2 sm:w-auto">
								<Button
									className="flex-1 sm:flex-none"
									disabled={page === 0}
									onClick={() => setPage((current) => current - 1)}
									variant="outline"
								>
									Previous page
								</Button>
								<Button
									className="flex-1 sm:flex-none"
									disabled={!projectsQuery.data?.pagination.hasMore}
									onClick={() => setPage((current) => current + 1)}
									variant="outline"
								>
									Next page
								</Button>
							</div>
						</div>
					) : null}
				</>
			)}
		</Page>
	);
}

export function milestoneLifecycleUpdateInput({
	projectId,
	milestoneId,
	version,
	lifecycle,
	proofRef,
}: {
	projectId: string;
	milestoneId: string;
	version: number;
	lifecycle: "planned" | "active" | "done" | "cancelled";
	proofRef?: string;
}) {
	const normalizedProof = proofRef?.trim();
	return {
		id: projectId,
		milestoneId,
		expectedVersion: version,
		lifecycle,
		...(lifecycle === "done" && normalizedProof
			? { proofRef: normalizedProof }
			: {}),
	};
}

export function ProjectSummary({
	status,
	percentDone,
	aggregateDisposition,
	targetDate,
}: {
	status: Project["status"];
	percentDone?: number;
	aggregateDisposition?: string;
	targetDate: string | null;
}) {
	return (
		<dl
			aria-label="Project summary"
			className="grid border-kumo-line border-y md:grid-cols-3 md:divide-x md:divide-kumo-line"
		>
			<div className="grid gap-1 py-3 md:px-4 md:first:pl-0">
				<Text as="dt" role="label" tone="secondary">
					Lifecycle
				</Text>
				<dd className="m-0 font-medium">{sentenceCase(status)}</dd>
			</div>
			<div className="grid gap-1 border-kumo-line border-t py-3 md:border-t-0 md:px-4">
				<Text as="dt" role="label" tone="secondary">
					Outcome progress
				</Text>
				<dd className="m-0 font-medium tabular-nums">
					{percentDone !== undefined && aggregateDisposition
						? `${formatRatioPercent(percentDone)} · ${sentenceCase(aggregateDisposition)}`
						: "Unavailable"}
				</dd>
			</div>
			<div className="grid gap-1 border-kumo-line border-t py-3 md:border-t-0 md:px-4 md:last:pr-0">
				<Text as="dt" role="label" tone="secondary">
					Horizon
				</Text>
				<dd className="m-0 font-medium">{targetDate ?? "Not recorded"}</dd>
			</div>
		</dl>
	);
}

const projectMilestoneSchema = z.object({
	title: z.string().trim().min(1, "Enter a milestone outcome."),
	ownerId: z.string().trim().min(1, "Enter an accountable user id."),
});

const milestoneAttachmentSchema = z.object({
	milestoneId: z.string().trim().uuid("Enter a canonical milestone UUID."),
	workItemId: z.string().trim().uuid("Enter a canonical Work Item UUID."),
});

const milestoneDependencySchema = z.object({
	fromMilestoneId: z
		.string()
		.trim()
		.uuid("Enter the prerequisite milestone UUID."),
	toMilestoneId: z.string().trim().uuid("Enter the dependent milestone UUID."),
});

const projectHealthSchema = z.object({
	health: z.enum(["on_track", "at_risk", "off_track", "paused"]),
	summary: z.string().trim().min(1, "Enter an evidence-based rationale."),
});

const milestoneLifecycleSchema = z
	.object({
		lifecycle: z.enum(["planned", "active", "done", "cancelled"]),
		proofRef: z.string().trim(),
	})
	.refine((value) => value.lifecycle !== "done" || Boolean(value.proofRef), {
		message: "A durable proof reference is required for Done.",
		path: ["proofRef"],
	});

function MilestoneLifecycleForm({
	milestone,
	isPending,
	onSubmit,
}: {
	milestone: {
		id: string;
		lifecycle: "proposed" | "planned" | "active" | "done" | "cancelled";
		proofRef: string | null;
		version: number;
	};
	isPending: boolean;
	onSubmit: (value: {
		id: string;
		version: number;
		lifecycle: "planned" | "active" | "done" | "cancelled";
		proofRef?: string;
	}) => void;
}) {
	const form = useZodForm({
		schema: milestoneLifecycleSchema,
		defaultValues: {
			lifecycle:
				milestone.lifecycle === "proposed" ? "planned" : milestone.lifecycle,
			proofRef: milestone.proofRef ?? "",
		},
		validateOn: "submit",
		onSubmit: ({ value }) =>
			onSubmit({
				id: milestone.id,
				version: milestone.version,
				lifecycle: value.lifecycle,
				...(value.proofRef ? { proofRef: value.proofRef } : {}),
			}),
	});
	return (
		<form
			className="grid gap-3 sm:grid-cols-2"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<FormField form={form} name="lifecycle" label="Lifecycle">
				{(field, meta) => (
					<FormSelect field={field} {...meta}>
						<SelectItem value="planned">Planned</SelectItem>
						<SelectItem value="active">Active</SelectItem>
						<SelectItem value="done">Done</SelectItem>
						<SelectItem value="cancelled">Cancelled</SelectItem>
					</FormSelect>
				)}
			</FormField>
			<FormField form={form} name="proofRef" label="Proof reference" optional>
				{(field, meta) => (
					<FormInput
						field={field}
						{...meta}
						placeholder="Required when marking Done"
					/>
				)}
			</FormField>
			<Button className="sm:col-span-2" type="submit" disabled={isPending}>
				Update milestone
			</Button>
		</form>
	);
}

export function WorkProjectPage({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const milestonePaging = useCursorPaging<string>();
	const project = useQuery(projectDetailQueryOptions(projectId));
	const rollup = useQuery(projectRollupQueryOptions(projectId));
	const milestones = useQuery(
		projectMilestonesQueryOptions(projectId, milestonePaging.cursor),
	);
	const health = useQuery(projectHealthJudgmentsQueryOptions(projectId));
	const items = useQuery(
		workItemListQueryOptions({ projectId, limit: WORK_LIST_LIMIT }),
	);
	const refreshMilestones = () => {
		milestonePaging.reset();
		return queryClient.invalidateQueries({
			queryKey: osQueryKeys.projectMilestones(),
		});
	};
	const createMilestone = useMutation({
		mutationFn: (value: z.output<typeof projectMilestoneSchema>) =>
			osApi.projects.createMilestone({
				id: projectId,
				title: value.title,
				accountableOwnerType: "user",
				accountableOwnerId: value.ownerId,
			}),
		onSuccess: async () => {
			createMilestoneForm.reset();
			await refreshMilestones();
		},
	});
	const createMilestoneForm = useZodForm({
		schema: projectMilestoneSchema,
		defaultValues: { title: "", ownerId: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => createMilestone.mutate(value),
	});
	const updateMilestone = useMutation({
		mutationFn: ({
			id,
			version,
			lifecycle,
			proofRef,
		}: {
			id: string;
			version: number;
			lifecycle: "planned" | "active" | "done" | "cancelled";
			proofRef?: string;
		}) =>
			osApi.projects.updateMilestone(
				milestoneLifecycleUpdateInput({
					projectId,
					milestoneId: id,
					version,
					lifecycle,
					proofRef,
				}),
			),
		onSuccess: refreshMilestones,
	});
	const attachMilestone = useMutation({
		mutationFn: (value: z.output<typeof milestoneAttachmentSchema>) =>
			osApi.projects.attachMilestoneWorkItem({
				id: projectId,
				milestoneId: value.milestoneId,
				workItemId: value.workItemId,
			}),
		onSuccess: async () => {
			attachmentForm.reset();
			await refreshMilestones();
		},
	});
	const attachmentForm = useZodForm({
		schema: milestoneAttachmentSchema,
		defaultValues: { milestoneId: "", workItemId: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => attachMilestone.mutate(value),
	});
	const addMilestoneDependency = useMutation({
		mutationFn: (value: z.output<typeof milestoneDependencySchema>) =>
			osApi.projects.addMilestoneDependency({
				id: projectId,
				fromMilestoneId: value.fromMilestoneId,
				toMilestoneId: value.toMilestoneId,
			}),
		onSuccess: async () => {
			dependencyForm.reset();
			await refreshMilestones();
		},
	});
	const dependencyForm = useZodForm({
		schema: milestoneDependencySchema,
		defaultValues: { fromMilestoneId: "", toMilestoneId: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => addMilestoneDependency.mutate(value),
	});
	const recordHealth = useMutation({
		mutationFn: (value: z.output<typeof projectHealthSchema>) =>
			osApi.projects.recordHealthJudgment({
				id: projectId,
				health: value.health,
				summary: value.summary,
			}),
		onSuccess: async () => {
			healthForm.reset();
			await queryClient.invalidateQueries({
				queryKey: projectHealthJudgmentsQueryOptions(projectId).queryKey,
			});
		},
	});
	const healthForm = useZodForm({
		schema: projectHealthSchema,
		defaultValues: { health: "on_track", summary: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => recordHealth.mutate(value),
	});
	if (
		[project, rollup, items, milestones, health].some(
			(query) => query.isPending,
		)
	)
		return (
			<Page width="full">
				<LoadingTable />
			</Page>
		);
	if (project.isError || !project.data)
		return (
			<Page width="full">
				<QueryFailure title="Project unavailable" />
			</Page>
		);
	if (milestones.isError || health.isError)
		return (
			<Page width="full">
				<QueryFailure
					title={
						(milestones.error ?? health.error)?.message ??
						"Project planning controls unavailable"
					}
				/>
			</Page>
		);
	return (
		<Page width="full">
			<FactoryPageHeader
				title={project.data.name}
				description={`${project.data.key} · accountable portfolio container`}
			/>
			<ProjectSummary
				status={project.data.status}
				percentDone={rollup.data?.percentDone}
				aggregateDisposition={rollup.data?.aggregateDisposition}
				targetDate={project.data.targetDate}
			/>
			<div className="grid gap-3 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Milestones</CardTitle>
						<CardDescription>
							Portfolio outcomes with guarded dependencies and linked Work
							Items.
						</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-3">
						<form
							className="grid gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								void createMilestoneForm.handleSubmit();
							}}
						>
							<FormField
								form={createMilestoneForm}
								name="title"
								label="Milestone outcome"
							>
								{(field, meta) => <FormInput field={field} {...meta} />}
							</FormField>
							<FormField
								form={createMilestoneForm}
								name="ownerId"
								label="Accountable user id"
							>
								{(field, meta) => <FormInput field={field} {...meta} />}
							</FormField>
							<Button type="submit" disabled={createMilestone.isPending}>
								Create milestone
							</Button>
						</form>
						{milestones.data?.data.map(({ milestone }) => (
							<Surface key={milestone.id} className="grid gap-2 p-3">
								<div>
									<strong>{milestone.title}</strong>{" "}
									<Badge variant="outline">
										{sentenceCase(milestone.lifecycle)}
									</Badge>
									<Text as="p" role="label" tone="secondary">
										{milestone.id} · v{milestone.version}
									</Text>
								</div>
								<MilestoneLifecycleForm
									milestone={milestone}
									isPending={updateMilestone.isPending}
									onSubmit={(value) => updateMilestone.mutate(value)}
								/>
							</Surface>
						))}
						<PageControls
							hasPrevious={milestonePaging.hasPrevious}
							hasNext={Boolean(milestones.data?.nextCursor)}
							onPrevious={milestonePaging.reset}
							onBack={milestonePaging.previous}
							onNext={() => {
								if (milestones.data?.nextCursor)
									milestonePaging.next(milestones.data.nextCursor);
							}}
						/>
						<div className="grid gap-4 lg:grid-cols-2">
							<form
								className="grid gap-3"
								onSubmit={(event) => {
									event.preventDefault();
									void attachmentForm.handleSubmit();
								}}
							>
								<FormField
									form={attachmentForm}
									name="milestoneId"
									label="Milestone id"
								>
									{(field, meta) => (
										<FormInput
											field={field}
											{...meta}
											placeholder="Milestone UUID"
										/>
									)}
								</FormField>
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
								<Button
									type="submit"
									variant="outline"
									disabled={attachMilestone.isPending}
								>
									Attach Work Item
								</Button>
							</form>
							<form
								className="grid gap-3"
								onSubmit={(event) => {
									event.preventDefault();
									void dependencyForm.handleSubmit();
								}}
							>
								<FormField
									form={dependencyForm}
									name="fromMilestoneId"
									label="Prerequisite milestone id"
								>
									{(field, meta) => (
										<FormInput
											field={field}
											{...meta}
											placeholder="Milestone UUID"
										/>
									)}
								</FormField>
								<FormField
									form={dependencyForm}
									name="toMilestoneId"
									label="Dependent milestone id"
								>
									{(field, meta) => (
										<FormInput
											field={field}
											{...meta}
											placeholder="Milestone UUID"
										/>
									)}
								</FormField>
								<Button
									type="submit"
									variant="outline"
									disabled={addMilestoneDependency.isPending}
								>
									Add prerequisite edge
								</Button>
							</form>
						</div>
						{createMilestone.error ||
						updateMilestone.error ||
						attachMilestone.error ||
						addMilestoneDependency.error ? (
							<QueryFailure
								title={
									(
										createMilestone.error ??
										updateMilestone.error ??
										attachMilestone.error ??
										(addMilestoneDependency.error as Error)
									).message
								}
							/>
						) : null}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Accountable health</CardTitle>
						<CardDescription>
							Immutable judgment history; mechanical completion never
							substitutes for it.
						</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-3">
						<form
							className="grid gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								void healthForm.handleSubmit();
							}}
						>
							<FormField
								form={healthForm}
								name="health"
								label="Health judgment"
							>
								{(field, meta) => (
									<FormSelect field={field} {...meta}>
										<SelectItem value="on_track">On track</SelectItem>
										<SelectItem value="at_risk">At risk</SelectItem>
										<SelectItem value="off_track">Off track</SelectItem>
										<SelectItem value="paused">Paused</SelectItem>
									</FormSelect>
								)}
							</FormField>
							<FormField
								form={healthForm}
								name="summary"
								label="Health rationale"
							>
								{(field, meta) => (
									<FormTextarea
										field={field}
										{...meta}
										placeholder="Evidence-based health rationale"
									/>
								)}
							</FormField>
							<Button type="submit" disabled={recordHealth.isPending}>
								Record judgment
							</Button>
						</form>
						{recordHealth.error ? (
							<QueryFailure title={(recordHealth.error as Error).message} />
						) : null}
						<ul className="m-0 grid gap-2 pl-5">
							{health.data?.map((judgment) => (
								<li key={judgment.id}>
									<Badge
										variant={
											judgment.health === "on_track"
												? "success"
												: judgment.health === "off_track"
													? "error"
													: "warning"
										}
									>
										{sentenceCase(judgment.health)}
									</Badge>{" "}
									{judgment.summary}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			</div>
			{items.isError ? (
				<QueryFailure title="Project work unavailable" />
			) : items.data?.data.length ? (
				<WorkItemsTable items={items.data.data} />
			) : (
				<EmptyState
					title="No work in this project"
					description="Projects are not executable; admit bounded Work Items when outcomes are ready."
				/>
			)}
		</Page>
	);
}

export function WorkGraphPage() {
	const itemsQuery = useQuery(workGraphItemsQueryOptions({}, WORK_LIST_LIMIT));
	const relationsQuery = useQuery(workItemRelationsQueryOptions({}, 5000));
	const items = itemsQuery.data?.data ?? [];
	const titles = new Map(items.map((item) => [item.id, item.title]));
	return (
		<Page width="full">
			<FactoryPageHeader
				title="Work graph"
				description="A durable dependency graph. Portfolio hierarchy is not executor ownership, and external project managers remain projections."
			/>
			{itemsQuery.isError || relationsQuery.isError ? (
				<QueryFailure title="Work graph unavailable" />
			) : itemsQuery.isPending || relationsQuery.isPending ? (
				<LoadingTable />
			) : relationsQuery.data.relations.length === 0 ? (
				<EmptyState
					title="No dependency edges"
					description="Independent work remains visible in the queue; add blocks, duplicates, or references only when the relationship is real."
				/>
			) : (
				<WorkGraphLedger
					relations={relationsQuery.data.relations}
					titles={titles}
					truncated={relationsQuery.data.truncated}
				/>
			)}
		</Page>
	);
}

export function WorkGraphLedger({
	relations,
	titles,
	truncated,
}: {
	relations: WorkItemRelationEdge[];
	titles: ReadonlyMap<string, string>;
	truncated: boolean;
}) {
	const labelFor = (id: string) => titles.get(id) ?? id;

	return (
		<div className="grid gap-3">
			{truncated ? (
				<Alert>
					<AlertTitle>Dependency view is truncated</AlertTitle>
					<AlertDescription>
						This collection shows the first 5,000 returned edges. Refine the
						dependency query before treating it as complete.
					</AlertDescription>
				</Alert>
			) : null}
			<div
				role="region"
				aria-label="Work dependency edges"
				tabIndex={0}
				className="max-h-[min(65vh,40rem)] overflow-y-auto overscroll-y-contain border-y border-kumo-hairline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus"
			>
				<Collection
					appearance="inline"
					aria-label="Work dependency edges"
					className="sm:hidden"
				>
					{relations.map((edge) => {
						const fromLabel = labelFor(edge.fromWorkItemId);
						const toLabel = labelFor(edge.toWorkItemId);
						return (
							<li key={edge.id} className="grid px-3 py-1.5">
								<Link
									href={`/work/items/${edge.fromWorkItemId}`}
									variant="record"
									aria-label={`From ${fromLabel}`}
									className="flex min-h-11 w-full min-w-0 items-center truncate font-medium"
								>
									{fromLabel}
								</Link>
								<div className="flex min-h-11 min-w-0 items-center gap-2">
									<Badge variant="outline" className="shrink-0">
										{sentenceCase(edge.relationType)}
									</Badge>
									<Link
										href={`/work/items/${edge.toWorkItemId}`}
										variant="record"
										aria-label={`To ${toLabel}`}
										className="flex min-h-11 min-w-0 flex-1 items-center truncate"
									>
										{toLabel}
									</Link>
								</div>
							</li>
						);
					})}
				</Collection>
				<Table
					containerClassName="hidden overflow-visible sm:block"
					className="table-fixed"
				>
					<TableHeader className="sticky top-0 z-10 bg-kumo-base">
						<TableRow>
							<TableHead className="w-[42%]">From</TableHead>
							<TableHead className="w-40">Relation</TableHead>
							<TableHead>To</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{relations.map((edge) => (
							<TableRow key={edge.id}>
								<TableCell className="whitespace-normal">
									<Link
										href={`/work/items/${edge.fromWorkItemId}`}
										variant="record"
									>
										{labelFor(edge.fromWorkItemId)}
									</Link>
								</TableCell>
								<TableCell>
									<Badge variant="outline">
										{sentenceCase(edge.relationType)}
									</Badge>
								</TableCell>
								<TableCell className="whitespace-normal">
									<Link
										href={`/work/items/${edge.toWorkItemId}`}
										variant="record"
									>
										{labelFor(edge.toWorkItemId)}
									</Link>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

export function safeEvidenceHref(uri: string): string | null {
	try {
		const parsed = new URL(uri);
		return parsed.protocol === "https:" ? parsed.href : null;
	} catch {
		return null;
	}
}

export function EvidenceReference({
	uri,
	label,
	className,
	compact = false,
}: {
	uri: string;
	label: string;
	className?: string;
	compact?: boolean;
}) {
	const href = safeEvidenceHref(uri);
	if (href)
		return (
			<Link href={href} className={className}>
				{label}
			</Link>
		);
	return (
		<span
			className={className ? `grid gap-0.5 ${className}` : "grid gap-0.5"}
			title={compact ? uri : undefined}
		>
			<span>{label}</span>
			{compact ? (
				<ClipboardText
					size="sm"
					text={compactEvidenceUri(uri)}
					textToCopy={uri}
					className="max-w-full"
				/>
			) : (
				<Text as="code" role="label" tone="secondary" className="break-all">
					{uri}
				</Text>
			)}
		</span>
	);
}

export function compactEvidenceUri(uri: string): string {
	if (uri.length <= 52) return uri;
	return `${uri.slice(0, 35)}…${uri.slice(-14)}`;
}

export function workEventActorLabel(
	actorId: string,
	actorType: string,
): string {
	const label = workPrincipalLabel(actorId, actorType);
	if (label.length <= 28) return label;
	return `${actorType}:${actorId.slice(0, 8)}…`;
}

type WorkAttemptActivityFields = {
	executorSessionId?: string | null;
	externalSessionKey?: string | null;
	heartbeatAt?: string | null;
	expiresAt?: string | null;
	finishedAt?: string | null;
	summary?: string | null;
	metadata?: Record<string, unknown>;
};

export function workAttemptSessionLabel(session: string): string {
	const codex =
		/^codex:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:[-:](.+))?$/i.exec(
			session,
		);
	if (!codex?.[1]) return `Session ${compactEvidenceUri(session)}`;
	return `Codex chat ${codex[1].slice(0, 8)}…${codex[2] ? ` · ${compactEvidenceUri(codex[2])}` : ""}`;
}

export function WorkAttemptActivity({
	attempt,
}: {
	attempt: WorkAttemptActivityFields;
}) {
	const session = attempt.externalSessionKey || attempt.executorSessionId;
	const timestamp = attempt.finishedAt ?? attempt.heartbeatAt;
	const overdue =
		!attempt.finishedAt &&
		attempt.expiresAt &&
		Date.parse(attempt.expiresAt) <= Date.now();
	return (
		<Collapsible className="grid gap-0.5 whitespace-normal">
			{overdue ? (
				<Text as="span" role="label" tone="secondary">
					Update overdue
				</Text>
			) : null}
			<Text as="span" role="label" tone="secondary">
				{timestamp ? (
					<>
						{attempt.finishedAt ? "Finished" : "Last update"}{" "}
						<time dateTime={timestamp}>{absoluteTime(timestamp)}</time>
					</>
				) : (
					"Activity time not recorded"
				)}
			</Text>
			<CollapsibleTrigger>Session details</CollapsibleTrigger>
			<CollapsibleContent keepMounted>
				<Text
					as="span"
					role="label"
					tone="secondary"
					title={session ?? undefined}
					className="break-all"
				>
					{session ? workAttemptSessionLabel(session) : "Session not recorded"}
				</Text>
			</CollapsibleContent>
		</Collapsible>
	);
}

function attemptOutcomeLabel(attempt: {
	outcome: string | null;
	runtimeState: string;
}) {
	if (attempt.outcome) return sentenceCase(attempt.outcome);
	return ["queued", "running", "waiting", "retrying"].includes(
		attempt.runtimeState,
	)
		? "In progress"
		: "No recorded outcome";
}

export function recordedSettlementCommits(
	metadata?: Record<string, unknown>,
): string[] {
	const settlement = metadata?.settlement;
	if (
		typeof settlement !== "object" ||
		settlement === null ||
		Array.isArray(settlement)
	)
		return [];
	const { commitSha, commitShas } = settlement as {
		commitSha?: unknown;
		commitShas?: unknown;
	};
	const values = [...(Array.isArray(commitShas) ? commitShas : []), commitSha];
	return [
		...new Set(
			values.filter(
				(value): value is string =>
					typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value),
			),
		),
	];
}

export function WorkRecordedOutcome({
	attempt,
	pending = false,
	error,
}: {
	attempt?: {
		runtimeState: string;
		outcome: string | null;
	} & WorkAttemptActivityFields;
	pending?: boolean;
	error?: unknown;
}) {
	const commits = recordedSettlementCommits(attempt?.metadata);
	return (
		<SectionCollection
			title="Recorded outcome"
			description="Work is completed. The latest Attempt result is recorded separately from deployment and independent verification."
			empty="No Attempt settlement recorded."
		>
			<li className="grid gap-2">
				{error ? (
					<QueryFailure title="Recorded outcome unavailable" error={error} />
				) : pending ? (
					<Skeleton className="h-16 w-full" />
				) : attempt ? (
					<>
						<Text weight="medium">
							Latest Attempt: {sentenceCase(attempt.runtimeState)} ·{" "}
							{attemptOutcomeLabel(attempt)}
						</Text>
						<WorkAttemptActivity attempt={attempt} />
						{attempt.summary ? (
							<Text as="p" className="m-0 whitespace-pre-wrap break-words">
								{attempt.summary}
							</Text>
						) : null}
						{!attempt.finishedAt || !attempt.outcome ? (
							<Text as="p" role="label" tone="secondary">
								The latest Attempt has no recorded settlement.
							</Text>
						) : null}
						<Text as="p" role="label" tone="secondary">
							Recorded commits
						</Text>
						{commits.length ? (
							commits.map((sha) => (
								<ClipboardText
									key={sha}
									text={sha}
									textToCopy={sha}
									size="sm"
									className="max-w-full"
								/>
							))
						) : (
							<Text as="p" role="label" tone="secondary">
								No commits recorded for this Attempt.
							</Text>
						)}
					</>
				) : (
					<Text as="p" role="body" tone="secondary">
						No Attempt settlement recorded. Completion alone does not establish
						an executor result or deployment.
					</Text>
				)}
			</li>
		</SectionCollection>
	);
}

type WorkAttemptSummary = {
	attempt: {
		id: string;
		runtimeState: string;
		executorType: string;
		executorId: string;
		outcome: string | null;
	} & WorkAttemptActivityFields;
	workItem: { id: string; title: string };
};

function evidenceDispositionVariant(disposition: string) {
	if (disposition === "accepted") return "success" as const;
	if (disposition === "rejected") return "error" as const;
	if (disposition === "superseded") return "outline" as const;
	return "warning" as const;
}

export function WorkAttemptsLedger({
	records,
}: {
	records: WorkAttemptSummary[];
}) {
	return (
		<>
			<Collection
				appearance="inline"
				aria-label="Attempt records"
				className="border-kumo-line border-y lg:hidden"
			>
				{records.map(({ attempt, workItem }) => (
					<li className="min-w-0 py-1" key={attempt.id}>
						<Link
							variant="record"
							href={`/work/items/${workItem.id}`}
							className="flex min-h-11 w-full min-w-0 items-center coarse:min-h-11"
						>
							<span className="min-w-0 flex-1">
								<span className="block truncate font-medium leading-snug">
									{workItem.title}
								</span>
								<span className="block truncate text-kumo-subtle text-xs">
									{sentenceCase(attempt.runtimeState)} ·{" "}
									{attemptOutcomeLabel(attempt)} ·{" "}
									<span title={`${attempt.executorType}:${attempt.executorId}`}>
										{workPrincipalLabel(
											attempt.executorId,
											attempt.executorType,
										)}
									</span>
								</span>
							</span>
						</Link>
						<WorkAttemptActivity attempt={attempt} />
					</li>
				))}
			</Collection>
			<Table scrollLabel="Attempts" containerClassName="hidden lg:block">
				<TableHeader>
					<TableRow>
						<TableHead>Work</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>Worker</TableHead>
						<TableHead>Last update</TableHead>
						<TableHead>Recorded outcome</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{records.map(({ attempt, workItem }) => (
						<TableRow key={attempt.id}>
							<TableCell className="whitespace-normal">
								<Link variant="record" href={`/work/items/${workItem.id}`}>
									{workItem.title}
								</Link>
							</TableCell>
							<TableCell>{sentenceCase(attempt.runtimeState)}</TableCell>
							<TableCell
								title={`${attempt.executorType}:${attempt.executorId}`}
							>
								{workPrincipalLabel(attempt.executorId, attempt.executorType)}
							</TableCell>
							<TableCell>
								<WorkAttemptActivity attempt={attempt} />
							</TableCell>
							<TableCell>{attemptOutcomeLabel(attempt)}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</>
	);
}

export function workActivitySearch(search: Record<string, unknown>): {
	view: WorkActivityView;
} {
	return { view: search.view === "history" ? "history" : "active" };
}

export function WorkAttemptsPage({
	view = "active",
}: {
	view?: WorkActivityView;
}) {
	const paging = useCursorPaging<{ at: string; id: string }>();
	const query = useQuery(
		workAttemptProjectionQueryOptions(paging.cursor, view),
	);
	const description =
		view === "history"
			? "Recorded activity that has ended. A finished run does not by itself mean the work is completed or deployed."
			: "Recorded work in progress, including waiting work and overdue updates. This does not show every local chat.";
	return (
		<Page width="full">
			<FactoryPageHeader title="Activity" description={description} />
			<Text as="p" role="body">
				<Link
					href="/work/attempts?view=active"
					aria-current={view === "active" ? "page" : undefined}
				>
					In progress
				</Link>
				{" · "}
				<Link
					href="/work/attempts?view=history"
					aria-current={view === "history" ? "page" : undefined}
				>
					History
				</Link>
			</Text>
			{query.isError ? (
				<QueryFailure title="Activity unavailable" />
			) : query.isPending ? (
				<LoadingTable />
			) : query.data.data.length === 0 ? (
				<EmptyState
					title={
						view === "active"
							? "No work in progress recorded"
							: "No activity history recorded"
					}
					description={description}
				/>
			) : (
				<WorkAttemptsLedger records={query.data.data} />
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
		</Page>
	);
}

export function WorkRecoveryPage() {
	const paging = useCursorPaging<{ at: string; id: string }>();
	const query = useQuery(workRecoveryProjectionQueryOptions(paging.cursor));
	return (
		<Page width="full">
			<FactoryPageHeader
				title="Recovery"
				description="Blocked admission, stale authority, rejected proof, and exhausted execution are diagnosed before retry. Repeating an unchanged plan is not progress."
			/>
			{query.isError ? (
				<QueryFailure title="Recovery queue unavailable" />
			) : query.isPending ? (
				<LoadingTable />
			) : query.data.data.length === 0 ? (
				<EmptyState
					title="No accepted work needs recovery"
					description="No factual recovery signals were observed for accepted work."
				/>
			) : (
				<WorkRecoveryLedger records={query.data.data} />
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
		</Page>
	);
}

type WorkRecoverySummary = {
	id: string;
	title: string;
	signals: string[];
	blockingDependencyCount: number;
	latestAttemptState: string | null;
	latestAttemptOutcome: string | null;
};

function recoverySignalVariant(signal: string) {
	if (signal === "latest_attempt_failed" || signal === "latest_attempt_expired")
		return "error" as const;
	return "warning" as const;
}

function latestAttemptLabel(record: WorkRecoverySummary) {
	if (!record.latestAttemptState) return "Not started";
	return [record.latestAttemptState, record.latestAttemptOutcome]
		.filter((value): value is string => Boolean(value))
		.map(sentenceCase)
		.join(" · ");
}

export function WorkRecoveryLedger({
	records,
}: {
	records: WorkRecoverySummary[];
}) {
	return (
		<div
			role="region"
			aria-label="Work recovery signals"
			tabIndex={0}
			className="max-h-[min(65vh,40rem)] overflow-y-auto overscroll-y-contain border-y border-kumo-hairline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus"
		>
			<Collection
				appearance="inline"
				aria-label="Work recovery signals"
				className="lg:hidden"
			>
				{records.map((record) => (
					<li key={record.id} className="min-w-0 px-3 py-1.5">
						<Link
							variant="record"
							href={`/work/items/${record.id}`}
							className="flex min-h-11 min-w-0 flex-col items-start justify-center text-left font-medium leading-snug"
						>
							<span className="line-clamp-2">{record.title}</span>
							<Text as="span" role="label" tone="mono-secondary">
								{record.id.slice(0, 8)}
							</Text>
						</Link>
						<div className="flex min-h-11 min-w-0 flex-wrap content-center gap-1 overflow-hidden py-1">
							<div className="flex min-w-0 flex-wrap gap-1">
								{record.signals.map((signal) => (
									<Badge key={signal} variant={recoverySignalVariant(signal)}>
										{sentenceCase(signal)}
									</Badge>
								))}
							</div>
							<Text
								as="span"
								role="label"
								tone="secondary"
								className="w-full min-w-0 truncate"
							>
								{record.blockingDependencyCount} blocked ·{" "}
								{latestAttemptLabel(record)}
							</Text>
						</div>
					</li>
				))}
			</Collection>
			<Table
				containerClassName="hidden overflow-visible lg:block"
				className="table-fixed"
			>
				<TableHeader className="sticky top-0 z-10 bg-kumo-base">
					<TableRow>
						<TableHead className="w-[32%]">Work</TableHead>
						<TableHead className="w-[26%]">Signals</TableHead>
						<TableHead className="w-[12%] text-right">Dependencies</TableHead>
						<TableHead className="w-[16%]">Latest attempt</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{records.map((record) => (
						<TableRow key={record.id}>
							<TableCell className="whitespace-normal">
								<Link
									variant="record"
									href={`/work/items/${record.id}`}
									className="line-clamp-2 font-medium"
								>
									{record.title}
								</Link>
								<Text as="p" role="label" tone="mono-secondary">
									{record.id.slice(0, 8)}
								</Text>
							</TableCell>
							<TableCell className="whitespace-normal">
								<div className="flex flex-wrap gap-1">
									{record.signals.map((signal) => (
										<Badge key={signal} variant={recoverySignalVariant(signal)}>
											{sentenceCase(signal)}
										</Badge>
									))}
								</div>
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{record.blockingDependencyCount}
							</TableCell>
							<TableCell className="whitespace-normal">
								{latestAttemptLabel(record)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

export function WorkItemPage({ itemId }: { itemId: string }) {
	const attemptPaging = useCursorPaging<{ at: string; id: string }>();
	const evidencePaging = useCursorPaging<{ at: string; id: string }>();
	const detail = useQuery(workItemDetailQueryOptions(itemId));
	const readiness = useQuery(workItemReadinessQueryOptions(itemId));
	const attempts = useQuery(
		workItemAttemptsQueryOptions(itemId, attemptPaging.cursor),
	);
	const evidence = useQuery(
		workItemEvidenceQueryOptions(itemId, evidencePaging.cursor),
	);
	const events = useQuery(workItemEventsQueryOptions(itemId));
	const item = detail.data?.workItem;
	const latestAttempts = useQuery({
		...workItemAttemptsQueryOptions(itemId),
		enabled: item?.disposition === "completed",
	});
	useDocumentTitle(item ? `${item.title} · Work` : "Work item");
	useWorkItemWebMcpTools(itemId);
	/*
	 * The detail verdict is checked BEFORE the aggregate pending gate, not after.
	 * The four ledger queries are keyed to the same id, and for an id that does
	 * not exist at least one of them never settles — so gating the not-found
	 * branch behind "any query is pending" made it unreachable, and the page sat
	 * on a loading skeleton indefinitely.
	 */
	if (detail.isError || (!detail.isPending && !item))
		return (
			<WorkItemInspectorPage>
				<QueryFailure title="Work item unavailable" error={detail.error} />
			</WorkItemInspectorPage>
		);
	if (
		[detail, readiness, attempts, evidence, events].some(
			(query) => query.isPending,
		)
	)
		return (
			<WorkItemInspectorPage>
				<LoadingTable />
			</WorkItemInspectorPage>
		);
	// Unreachable given the verdict above; kept so `item` narrows and so a future
	// reorder of these guards cannot silently render the page without a record.
	if (!item)
		return (
			<WorkItemInspectorPage>
				<QueryFailure title="Work item unavailable" />
			</WorkItemInspectorPage>
		);
	return (
		<WorkItemInspectorPage>
			<FactoryPageHeader
				title={item.title}
				description={`${sentenceCase(item.workKind)} · ${item.id}`}
			/>
			<WorkItemStatusSummary
				disposition={item.disposition}
				accountableOwnerId={item.accountableOwnerId}
				readiness={readiness.data}
			/>
			{item.disposition === "completed" ? (
				<WorkRecordedOutcome
					attempt={latestAttempts.data?.data[0]}
					pending={latestAttempts.isPending}
					error={latestAttempts.error}
				/>
			) : null}
			{item.description ? (
				<Card>
					<CardHeader>
						<CardTitle>Work specification</CardTitle>
					</CardHeader>
					<CardContent className="whitespace-pre-wrap">
						{item.description}
					</CardContent>
				</Card>
			) : null}
			<SectionCollection
				title={
					item.disposition === "completed"
						? "Historical updates and discussion"
						: "Updates and discussion"
				}
				description={
					item.disposition === "completed"
						? "Earlier progress reports may describe blockers that preceded completion. Use the recorded outcome above for the latest Attempt result."
						: "Saved progress and questions from people and agents. These updates do not change task status or grant permission."
				}
				empty="No updates saved yet."
			>
				{detail.data?.comments.length
					? detail.data.comments
							.slice(-20)
							.reverse()
							.map((comment) => (
								<li className="min-w-0" key={comment.id}>
									<Text role="label" tone="secondary">
										<span
											title={`${comment.authorType}:${comment.authorId ?? "unknown"}`}
										>
											{sentenceCase(comment.authorType)}
										</span>{" "}
										·{" "}
										<time dateTime={comment.createdAt}>
											{absoluteTime(comment.createdAt)}
										</time>
									</Text>
									<Text as="p" className="whitespace-pre-wrap break-words">
										{comment.body}
									</Text>
								</li>
							))
					: undefined}
			</SectionCollection>
			<WorkItemReadOnlyLedgers
				workItemId={item.id}
				acceptanceContract={item.acceptanceContract}
				attempts={attempts.data?.data ?? []}
				attemptsError={attempts.error}
				attemptControls={
					<PageControls
						hasPrevious={attemptPaging.hasPrevious}
						hasNext={Boolean(attempts.data?.nextCursor)}
						onPrevious={attemptPaging.reset}
						onBack={attemptPaging.previous}
						onNext={() => {
							if (attempts.data?.nextCursor)
								attemptPaging.next(attempts.data.nextCursor);
						}}
					/>
				}
				evidence={evidence.data?.data ?? []}
				evidenceError={evidence.error}
				evidenceControls={
					<PageControls
						hasPrevious={evidencePaging.hasPrevious}
						hasNext={Boolean(evidence.data?.nextCursor)}
						onPrevious={evidencePaging.reset}
						onBack={evidencePaging.previous}
						onNext={() => {
							if (evidence.data?.nextCursor)
								evidencePaging.next(evidence.data.nextCursor);
						}}
					/>
				}
				events={events.data?.events ?? []}
			/>
		</WorkItemInspectorPage>
	);
}
