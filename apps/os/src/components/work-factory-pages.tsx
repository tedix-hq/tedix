import {
	WorkPageHeader,
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import { WorkActorAvatar } from "@/components/work-actor-avatar";
import { workActorReference } from "@/lib/work-actor";
import { WorkExecutorChoice } from "@/components/work-dispatch-app";
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
import { type ReactNode, useState } from "react";
import * as z from "zod";
import { WorkItemDescription } from "@/components/work-item-description";
import { WorkItemCommentComposer } from "@/components/work-item-comment-composer";
import { WorkItemSpecificationEditor } from "@/components/work-item-specification-editor";
import { OS_COPY } from "@/shared/os-copy";
import {
	plainWorkText,
	workChecklist,
	workDate,
	workDue,
	workReminders,
} from "@/lib/work-detail";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Link } from "@/components/kumo/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Page,
	PageBack,
	Collection,
	PageGrid,
	SectionCollection,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { Skeleton } from "@/components/kumo/skeleton";
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
import { WorkProjectContributors } from "@/components/work-project-contributors";
import { WorkstationInspectionPanel } from "@/components/workstation-inspection-panel";
import {
	useOsFormattingPreferences,
	formatRatioPercent,
	sentenceCase,
} from "@/lib/format";
import {
	osQuery,
	userProfileQueryOptions,
	projectDetailQueryOptions,
	projectRollupQueryOptions,
	projectHealthJudgmentsQueryOptions,
	projectMilestonesQueryOptions,
	osQueryKeys,
	workItemAttemptsQueryOptions,
	workItemDetailQueryOptions,
	workItemEventsQueryOptions,
	workItemEvidenceQueryOptions,
	workEvidencePreviewQueryOptions,
	workItemListQueryOptions,
	workItemReadinessQueryOptions,
	workItemRelationsQueryOptions,
} from "@/lib/os-query-options";
import { osApi } from "@/lib/api";
import { absoluteDate, absoluteTime } from "@/lib/time";
import { useDocumentTitle } from "@/lib/use-document-title";
import { workPrincipalLabel } from "@/lib/work-display";
import {
	PageControls,
	useCursorPaging,
	useWorkPrincipalNames,
} from "./work-operations-pages";

const WORK_LIST_LIMIT = 100;
const PROJECTION_FAILURE_FALLBACK =
	"The canonical projection failed. Retry once; if the failure persists, inspect the API Work projection health.";

export function WorkItemInspectorPage({ children }: { children: ReactNode }) {
	return (
		<Page width="lg">
			<PageBack render={<Link href="/work/queue" />}>All work</PageBack>
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
	useOsFormattingPreferences();
	return (
		<>
			<SectionCollection
				title="What done looks like"
				description={
					acceptanceContract
						? "The result this task should deliver."
						: "Describe the result before starting work."
				}
				empty="The expected result has not been described yet."
			>
				{acceptanceContract?.doneLooksLike ? (
					<li>{acceptanceContract.doneLooksLike}</li>
				) : undefined}
			</SectionCollection>
			<PageGrid className="items-start">
				<SectionCollection
					title={`Work sessions on this page (${attempts.length})`}
					description="See who worked on this task and how each session ended."
					empty="No work sessions on this page."
					footer={attemptControls}
				>
					{attemptsError ? (
						<li>
							<WorkReadFailure
								fallback={PROJECTION_FAILURE_FALLBACK}
								title="Work sessions unavailable"
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
									<Text weight="medium">Session {attempt.attemptNumber}</Text>
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
					description="Saved evidence may still need to be reviewed."
					empty="No evidence submitted on this page."
					footer={evidenceControls}
				>
					{evidenceError ? (
						<li>
							<WorkReadFailure
								fallback={PROJECTION_FAILURE_FALLBACK}
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
								<WorkActorAvatar
									actor={workActorReference(event.actorType, event.actorId)}
									name={workEventActorLabel(event.actorId, event.actorType)}
								/>
								<Text weight="medium">
									{sentenceCase(event.eventType.replaceAll(".", "_"))}
								</Text>
								<Text role="label" tone="secondary">
									<span title={`${event.actorType}:${event.actorId}`}>
										{workEventActorLabel(event.actorId, event.actorType)}
									</span>{" "}
									·{" "}
									<time
										dateTime={event.occurredAt}
										title={absoluteTime(event.occurredAt)}
									>
										{absoluteTime(event.occurredAt)}
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
		| {
				status: "available";
				text: string;
				truncated: boolean;
				imageDataUrl?: string;
		  }
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
				{preview.imageDataUrl ? (
					<img
						src={preview.imageDataUrl}
						alt={OS_COPY.feed.evidencePreview}
						className="max-w-full"
					/>
				) : (
					<Text
						as="pre"
						role="body"
						className="whitespace-pre-wrap break-words"
					>
						{preview.text}
					</Text>
				)}
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
	| "accountableOwnerType"
	| "accountableOwnerId"
	| "createdAt"
	| "updatedAt"
>;

type PrincipalNames = ReadonlyMap<string, string>;

/**
 * The accountable owner's display name, resolved from the `type:id` name map
 * (people by Descope user id, tedis by id). Opaque identifiers stay hidden
 * while names load or when the reader cannot list members.
 */
export function workOwnerName(
	type: string | null | undefined,
	id: string | null,
	names: PrincipalNames = new Map(),
): string {
	if (!id) return OS_COPY.work.unassigned;
	const named = type
		? names.get(`${type}:${id}`)
		: (names.get(`user:${id}`) ?? names.get(`tedi:${id}`));
	return named ?? OS_COPY.work.ownerUnavailable;
}

export function workOwnerTitle(
	type: string | null | undefined,
	id: string | null,
	names?: PrincipalNames,
): string {
	return `${OS_COPY.work.owner}: ${workOwnerName(type, id, names)}`;
}

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
	accountableOwnerType,
	accountableOwnerId,
	principalNames,
	readiness,
	acceptAction,
}: {
	disposition: WorkItem["disposition"];
	accountableOwnerType?: string | null;
	accountableOwnerId: string | null;
	principalNames?: PrincipalNames;
	readiness?: {
		state: string;
		ready: boolean;
		reasons: Array<{ detail: string }>;
	};
	acceptAction?: ReactNode;
}) {
	const owner = workOwnerName(
		accountableOwnerType,
		accountableOwnerId,
		principalNames,
	);
	const firstName =
		owner === OS_COPY.work.ownerUnavailable || owner === OS_COPY.work.unassigned
			? "The owner"
			: owner.split(/\s+/)[0]!;
	return (
		<div
			className="grid gap-3 border-kumo-line border-y py-4"
			aria-label="Work item status"
		>
			<Text as="p">
				<span className="text-kumo-subtle">{OS_COPY.work.status}: </span>
				{disposition === "proposed"
					? OS_COPY.work.proposed
					: sentenceCase(disposition)}
			</Text>
			{disposition === "proposed" ? (
				<div className="flex flex-wrap items-center gap-3">
					<Text as="p" tone="secondary">
						{OS_COPY.work.needsAcceptance(firstName)}
					</Text>
					{acceptAction}
				</div>
			) : disposition === "accepted" ? (
				<Text as="p" tone="secondary">
					{readiness?.ready ? OS_COPY.work.ready : OS_COPY.work.waitingNextStep}
				</Text>
			) : null}
		</div>
	);
}

function WorkItemAcceptance({ item }: { item: WorkItem }) {
	const viewer = useQuery(userProfileQueryOptions());
	const client = useQueryClient();
	const accept = useMutation({
		mutationFn: () =>
			osApi.workItems.accept({
				id: item.id,
				acceptanceContract: item.acceptanceContract ?? {
					version: 1,
					doneLooksLike: item.title,
				},
			}),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			}),
	});
	if (
		item.accountableOwnerType !== "user" ||
		!viewer.data?.id ||
		viewer.data.id !== item.accountableOwnerId
	)
		return null;
	return (
		<div className="grid gap-1">
			<Button
				size="sm"
				disabled={accept.isPending}
				onClick={() => accept.mutate()}
			>
				{accept.isPending ? OS_COPY.work.accepting : OS_COPY.work.accept}
			</Button>
			{accept.isError ? (
				<Text role="label" tone="error">
					{OS_COPY.work.acceptError}
				</Text>
			) : null}
		</div>
	);
}

function WorkItemMobileList({
	items,
	principalNames,
	readiness,
	showDisposition,
	showReadiness,
}: {
	items: WorkItemSummary[];
	principalNames?: PrincipalNames;
	readiness?: Map<string, WorkItemReadiness>;
	showDisposition: boolean;
	showReadiness: boolean;
}) {
	useOsFormattingPreferences();
	return (
		<Collection
			appearance="inline"
			aria-label="Work queue"
			className="border-kumo-line border-y md:hidden"
		>
			{items.map((item) => {
				const updatedAt = item.updatedAt ?? item.createdAt;
				return (
					<li className="group min-w-0 py-1" key={item.id}>
						<Link
							variant="record"
							href={`/work/items/${item.id}`}
							className="flex min-h-11 min-w-0 flex-col items-start justify-center py-1 text-left font-medium leading-snug coarse:min-h-11"
						>
							<span className="line-clamp-2">{item.title}</span>
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
										{OS_COPY.work.kinds[item.workKind] ??
											OS_COPY.work.kinds.other}
									</dd>
								</div>
								<span aria-hidden="true">·</span>
								<div className="min-w-0">
									<dt className="sr-only">Updated</dt>
									<dd className="m-0 whitespace-nowrap">
										<time dateTime={updatedAt} title={absoluteTime(updatedAt)}>
											{absoluteDate(updatedAt)}
										</time>
									</dd>
								</div>
								<span aria-hidden="true">·</span>
								<div className="min-w-0 max-w-full">
									<dt className="sr-only">{OS_COPY.work.owner}</dt>
									<dd
										className="m-0"
										title={workOwnerTitle(
											item.accountableOwnerType,
											item.accountableOwnerId,
											principalNames,
										)}
									>
										{workOwnerName(
											item.accountableOwnerType,
											item.accountableOwnerId,
											principalNames,
										)}
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
	principalNames,
	readiness,
	showDisposition = true,
	showReadiness = true,
}: {
	items: WorkItemSummary[];
	/** `type:id` → display name, from {@link useWorkPrincipalNames}. */
	principalNames?: PrincipalNames;
	readiness?: Map<string, WorkItemReadiness>;
	showDisposition?: boolean;
	showReadiness?: boolean;
}) {
	useOsFormattingPreferences();
	return (
		<>
			<WorkItemMobileList
				items={items}
				principalNames={principalNames}
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
							<TableHead className="w-[15%] xl:w-[12%]">Status</TableHead>
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
							{OS_COPY.work.owner}
						</TableHead>
						<TableHead className="w-[16%] xl:w-[10%]">Updated</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{items.map((item) => {
						const state = readiness?.get(item.id);
						return (
							<TableRow key={item.id} className="group">
								<TableCell className="py-2! whitespace-normal">
									<Link
										variant="record"
										href={`/work/items/${item.id}`}
										className="font-medium"
									>
										<span className="line-clamp-2">{item.title}</span>
									</Link>
									<div className="flex min-w-0 items-center gap-1.5">
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="truncate xl:hidden"
											title={workOwnerTitle(
												item.accountableOwnerType,
												item.accountableOwnerId,
												principalNames,
											)}
										>
											{workOwnerName(
												item.accountableOwnerType,
												item.accountableOwnerId,
												principalNames,
											)}
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
									{OS_COPY.work.kinds[item.workKind] ??
										OS_COPY.work.kinds.other}
								</TableCell>
								<TableCell
									className="hidden truncate py-2! xl:table-cell"
									title={workOwnerTitle(
										item.accountableOwnerType,
										item.accountableOwnerId,
										principalNames,
									)}
								>
									{workOwnerName(
										item.accountableOwnerType,
										item.accountableOwnerId,
										principalNames,
									)}
								</TableCell>
								<TableCell className="py-2!">
									<time
										dateTime={item.updatedAt ?? item.createdAt}
										title={absoluteTime(item.updatedAt ?? item.createdAt)}
									>
										{absoluteDate(item.updatedAt ?? item.createdAt)}
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

/** The project's brief: its description, shown verbatim with line breaks. */
export function ProjectBrief({ description }: { description: string | null }) {
	const brief = description?.trim();
	return (
		<section aria-label="Brief" className="grid gap-1">
			<Text as="h2" role="label" tone="secondary">
				Brief
			</Text>
			{brief ? (
				<Text as="p" role="body" className="m-0 whitespace-pre-line">
					{brief}
				</Text>
			) : (
				<Text as="p" role="body" tone="secondary" className="m-0">
					This project has no brief yet.
				</Text>
			)}
		</section>
	);
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
	useOsFormattingPreferences();
	return (
		<MetricGrid columns={3} appearance="inline" aria-label="Project summary">
			<MetricItem label="Lifecycle" value={sentenceCase(status)} />
			<MetricItem
				label="Outcome progress"
				value={
					percentDone !== undefined && aggregateDisposition
						? `${formatRatioPercent(percentDone)} · ${sentenceCase(aggregateDisposition)}`
						: "Unavailable"
				}
				valueClassName="tabular-nums"
			/>
			<MetricItem label="Horizon" value={targetDate ?? "Not recorded"} />
		</MetricGrid>
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
	const principalNames = useWorkPrincipalNames(items.data?.data[0]?.orgId);
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
				<WorkListSkeleton />
			</Page>
		);
	if (project.isError || !project.data)
		return (
			<Page width="full">
				<WorkReadFailure
					fallback={PROJECTION_FAILURE_FALLBACK}
					title="Project unavailable"
				/>
			</Page>
		);
	if (milestones.isError || health.isError)
		return (
			<Page width="full">
				<WorkReadFailure
					fallback={PROJECTION_FAILURE_FALLBACK}
					title={
						(milestones.error ?? health.error)?.message ??
						"Project planning controls unavailable"
					}
				/>
			</Page>
		);
	return (
		<Page width="full">
			<WorkPageHeader
				title={project.data.name}
				description={`${project.data.key} · accountable portfolio container`}
			/>
			<ProjectBrief description={project.data.description} />
			<ProjectSummary
				status={project.data.status}
				percentDone={rollup.data?.percentDone}
				aggregateDisposition={rollup.data?.aggregateDisposition}
				targetDate={project.data.targetDate}
			/>
			<WorkProjectContributors projectId={projectId} />
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
							<WorkReadFailure
								fallback={PROJECTION_FAILURE_FALLBACK}
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
							<WorkReadFailure
								fallback={PROJECTION_FAILURE_FALLBACK}
								title={(recordHealth.error as Error).message}
							/>
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
				<WorkReadFailure
					fallback={PROJECTION_FAILURE_FALLBACK}
					title="Project work unavailable"
				/>
			) : items.data?.data.length ? (
				<WorkItemsTable
					items={items.data.data}
					principalNames={principalNames}
				/>
			) : (
				<WorkEmpty
					title="No work in this project"
					description="Projects are not executable; admit bounded Work Items when outcomes are ready."
				/>
			)}
		</Page>
	);
}

const GRAPH_PAGE_SIZE = 25;

export function WorkGraphPage() {
	const relationsQuery = useQuery(workItemRelationsQueryOptions({}, 5000));
	const [page, setPage] = useState(0);
	const relations = relationsQuery.data?.relations ?? [];
	const currentPage = Math.min(
		page,
		Math.max(0, Math.ceil(relations.length / GRAPH_PAGE_SIZE) - 1),
	);
	const offset = currentPage * GRAPH_PAGE_SIZE;
	const visibleRelations = relations.slice(offset, offset + GRAPH_PAGE_SIZE);
	// Resolve only this page's unique endpoints: at most 50 canonical detail reads.
	const endpointIds = [
		...new Set(
			visibleRelations.flatMap((edge) => [
				edge.fromWorkItemId,
				edge.toWorkItemId,
			]),
		),
	];
	const endpointQueries = useQueries({
		queries: endpointIds.map((id) => ({
			...workItemDetailQueryOptions(id),
			retry: false,
		})),
	});
	const titles = new Map(
		endpointIds.map((id, index) => {
			const query = endpointQueries[index]!;
			return [
				id,
				query.data?.workItem.title ??
					(query.isPending ? "Loading task…" : "Task unavailable"),
			];
		}),
	);
	return (
		<Page width="full">
			<WorkPageHeader
				title="Work graph"
				description="A durable dependency graph. Portfolio hierarchy is not executor ownership, and external project managers remain projections."
			/>
			{relationsQuery.isError ? (
				<WorkReadFailure
					fallback={PROJECTION_FAILURE_FALLBACK}
					title="Work graph unavailable"
				/>
			) : relationsQuery.isPending ? (
				<WorkListSkeleton />
			) : relations.length === 0 ? (
				<WorkEmpty
					title="No dependency edges"
					description="Independent work remains visible in the queue; add blocks, duplicates, or references only when the relationship is real."
				/>
			) : (
				<>
					<WorkGraphLedger
						relations={visibleRelations}
						titles={titles}
						truncated={relationsQuery.data.truncated}
					/>
					<div
						className="flex flex-wrap items-center gap-3"
						aria-label="Dependency pages"
					>
						<Text role="label" tone="secondary" aria-live="polite">
							{offset + 1}–
							{Math.min(offset + GRAPH_PAGE_SIZE, relations.length)} of{" "}
							{relations.length} returned dependencies
						</Text>
						<Button
							variant="secondary"
							className="min-h-11"
							disabled={currentPage === 0}
							onClick={() => setPage(currentPage - 1)}
						>
							Previous dependencies
						</Button>
						<Button
							variant="secondary"
							className="min-h-11"
							disabled={offset + GRAPH_PAGE_SIZE >= relations.length}
							onClick={() => setPage(currentPage + 1)}
						>
							Next dependencies
						</Button>
					</div>
				</>
			)}
		</Page>
	);
}

function WorkGraphEndpoint({
	id,
	label,
	direction,
}: {
	id: string;
	label: string;
	direction: "From" | "To";
}) {
	return (
		<div className="grid min-w-0 gap-1">
			<Link
				href={`/work/items/${id}`}
				variant="record"
				aria-label={`${direction} ${label}`}
				className="flex min-h-11 min-w-0 items-center whitespace-normal break-words font-medium [overflow-wrap:anywhere]"
			>
				{label}
			</Link>
			<span title={id}>
				<ClipboardText
					size="sm"
					text={`${id.slice(0, 8)}…`}
					textToCopy={id}
					className="min-h-11 max-w-full text-kumo-subtle [&_button]:min-h-11 [&_button]:min-w-11"
				/>
			</span>
		</div>
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
	const labelFor = (id: string) => titles.get(id) ?? "Task unavailable";

	return (
		<div className="grid gap-3">
			{truncated ? (
				<Alert>
					<AlertTitle>Dependency view is truncated</AlertTitle>
					<AlertDescription>
						Only the first 5,000 returned edges are available in these pages.
						Refine the dependency query before treating it as complete.
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
					{relations.map((edge) => (
						<li key={edge.id} className="grid min-w-0 gap-2 px-3 py-3">
							<WorkGraphEndpoint
								id={edge.fromWorkItemId}
								label={labelFor(edge.fromWorkItemId)}
								direction="From"
							/>
							<Badge variant="outline">{sentenceCase(edge.relationType)}</Badge>
							<WorkGraphEndpoint
								id={edge.toWorkItemId}
								label={labelFor(edge.toWorkItemId)}
								direction="To"
							/>
						</li>
					))}
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
									<WorkGraphEndpoint
										id={edge.fromWorkItemId}
										label={labelFor(edge.fromWorkItemId)}
										direction="From"
									/>
								</TableCell>
								<TableCell>
									<Badge variant="outline">
										{sentenceCase(edge.relationType)}
									</Badge>
								</TableCell>
								<TableCell className="whitespace-normal">
									<WorkGraphEndpoint
										id={edge.toWorkItemId}
										label={labelFor(edge.toWorkItemId)}
										direction="To"
									/>
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
	useOsFormattingPreferences();
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
						<time dateTime={timestamp} title={absoluteTime(timestamp)}>
							{absoluteTime(timestamp)}
						</time>
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
			description="Work is marked complete. Check the latest session result and any published changes below."
			empty="No session result recorded."
		>
			<li className="grid gap-2">
				{error ? (
					<WorkReadFailure
						fallback={PROJECTION_FAILURE_FALLBACK}
						title="Recorded outcome unavailable"
						error={error}
					/>
				) : pending ? (
					<Skeleton className="h-16 w-full" />
				) : attempt ? (
					<>
						<Text weight="medium">
							Latest session: {sentenceCase(attempt.runtimeState)} ·{" "}
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
						No session result recorded. Completion alone does not establish an
						executor result or deployment.
					</Text>
				)}
			</li>
		</SectionCollection>
	);
}

function evidenceDispositionVariant(disposition: string) {
	if (disposition === "accepted") return "success" as const;
	if (disposition === "rejected") return "error" as const;
	if (disposition === "superseded") return "outline" as const;
	return "warning" as const;
}

export function WorkItemPage({ itemId }: { itemId: string }) {
	useOsFormattingPreferences();
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
	const principalNames = useWorkPrincipalNames(item?.orgId);
	const latestAttempts = useQuery({
		...workItemAttemptsQueryOptions(itemId),
		enabled: item?.disposition === "completed",
	});
	useDocumentTitle(item ? `${item.title} · Work` : "Work item");
	useWorkItemWebMcpTools(itemId);
	// Ledger failures must not prevent the task itself from appearing.
	if (detail.isError || (!detail.isPending && !item))
		return (
			<WorkItemInspectorPage>
				<DetailUnavailable resource="Work item" error={detail.error} />
			</WorkItemInspectorPage>
		);
	if (detail.isPending)
		return (
			<WorkItemInspectorPage>
				<WorkListSkeleton />
			</WorkItemInspectorPage>
		);
	// Unreachable given the verdict above; kept so `item` narrows and so a future
	// reorder of these guards cannot silently render the page without a record.
	if (!item)
		return (
			<WorkItemInspectorPage>
				<WorkReadFailure
					fallback={PROJECTION_FAILURE_FALLBACK}
					title="Work item unavailable"
				/>
			</WorkItemInspectorPage>
		);
	return (
		<WorkItemInspectorPage>
			<WorkPageHeader
				title={plainWorkText(item.title)}
				description={OS_COPY.work.kinds[item.workKind]}
			/>
			<WorkExecutorChoice item={item} />
			<WorkItemSpecificationEditor
				key={`${item.id}:${item.version}`}
				item={item}
			/>
			<WorkItemStatusSummary
				disposition={item.disposition}
				accountableOwnerType={item.accountableOwnerType}
				accountableOwnerId={item.accountableOwnerId}
				principalNames={principalNames}
				readiness={readiness.data}
				acceptAction={<WorkItemAcceptance item={item} />}
			/>
			{item.disposition === "completed" ? (
				<WorkRecordedOutcome
					attempt={latestAttempts.data?.data[0]}
					pending={latestAttempts.isPending}
					error={latestAttempts.error}
				/>
			) : null}
			<Surface
				as="section"
				tier="panel"
				aria-label={OS_COPY.work.atAGlance}
				className="grid gap-3 p-4"
			>
				<Text as="h2" weight="semibold">
					{OS_COPY.work.atAGlance}
				</Text>
				<dl className="m-0 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{[
						[
							OS_COPY.work.owner,
							workOwnerName(
								item.accountableOwnerType,
								item.accountableOwnerId,
								principalNames,
							),
						],
						[
							OS_COPY.work.due,
							item.deadline || item.dueDate
								? `${workDate((item.deadline || item.dueDate)!)} · ${workDue((item.deadline || item.dueDate)!)}`
								: OS_COPY.work.noDue,
						],
						[
							OS_COPY.work.nextStep,
							workChecklist(item.description ?? "", detail.data?.comments).find(
								(task) => !task.checked,
							)?.text ?? OS_COPY.work.noNextStep,
						],
						[
							OS_COPY.work.reminders,
							workReminders(item.metadata, item.description ?? "").join(
								" · ",
							) || OS_COPY.work.noReminders,
						],
					].map(([label, value]) => (
						<div key={label} className="min-w-0">
							<Text as="dt" role="label" tone="secondary">
								{label}
							</Text>
							<dd className="m-0">
								<WorkItemDescription
									item={item}
									comments={[]}
									content={value}
									interactive={false}
								/>
							</dd>
						</div>
					))}
					<div className="min-w-0">
						<Text as="dt" role="label" tone="secondary">
							{OS_COPY.work.project}
						</Text>
						<dd className="m-0">
							{detail.data?.project ? (
								<Link
									variant="record"
									href={`/work/projects/${detail.data.project.id}`}
								>
									{detail.data.project.name}
								</Link>
							) : (
								OS_COPY.work.noProject
							)}
						</dd>
					</div>
				</dl>
			</Surface>
			{item.description ? (
				<Card>
					<CardHeader>
						<CardTitle>{OS_COPY.work.description}</CardTitle>
					</CardHeader>
					<CardContent>
						<WorkItemDescription
							item={item}
							comments={detail.data?.comments ?? []}
						/>
					</CardContent>
				</Card>
			) : null}
			<Card>
				<CardContent>
					<WorkItemCommentComposer key={item.id} itemId={item.id} />
				</CardContent>
			</Card>
			<SectionCollection
				title={OS_COPY.work.activity}
				description={OS_COPY.work.activityDescription}
				empty={OS_COPY.work.emptyActivity}
			>
				{detail.data?.comments.length
					? detail.data.comments
							.slice(-20)
							.reverse()
							.map((comment) => (
								<li className="min-w-0" key={comment.id}>
									<WorkActorAvatar
										actor={workActorReference(
											comment.authorType,
											comment.authorId,
											comment.metadata,
										)}
										name={
											principalNames.get(
												`${comment.authorType}:${comment.authorId}`,
											) ?? "Team member"
										}
									/>
									<Text role="label" tone="secondary">
										{principalNames.get(
											`${comment.authorType}:${comment.authorId}`,
										) ?? "Team member"}{" "}
										·{" "}
										<time
											dateTime={comment.createdAt}
											title={absoluteTime(comment.createdAt)}
										>
											{workDate(comment.createdAt, true)}
										</time>
									</Text>
									<WorkItemDescription
										item={item}
										comments={[]}
										content={comment.body}
										interactive={false}
									/>
								</li>
							))
					: undefined}
			</SectionCollection>
			<ClipboardText
				size="sm"
				text={OS_COPY.work.copyLink}
				className="w-fit max-w-full"
				textToCopy={`${window.location.origin}/work/items/${item.id}`}
			/>
			<Collapsible>
				<CollapsibleTrigger>{OS_COPY.work.technicalDetails}</CollapsibleTrigger>
				<CollapsibleContent className="grid gap-4 pt-4">
					<ClipboardText size="sm" text={item.id} textToCopy={item.id} />
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
				</CollapsibleContent>
			</Collapsible>
		</WorkItemInspectorPage>
	);
}
