import {
	WorkPageHeader,
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import { approvalDecision } from "@tedix/api-contract/utils/approval-decision";
import { ApprovalDecisionCopy } from "@/components/approval-decision-copy";
import type { ApprovalRequest } from "@tedix/api-contract/contracts/tedi-approvals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import * as z from "zod";
import { ApprovalManifestReview } from "@/components/approval-manifest";
import { BrowserTakeoverLiveView } from "@/components/browser-takeover-live-view";
import { ApprovalProvenanceHistory } from "@/components/approval-provenance";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
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
import { CodeBlock } from "@/components/kumo/code";
import { DateTimePicker } from "@/components/kumo/date-picker";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Link } from "@/components/kumo/link";
import { ResponsiveFormSurface } from "@/components/kumo/responsive-form-surface";
import {
	Page,
	PageSection,
	SectionCollection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { SelectItem } from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { useOsFormattingPreferences, sentenceCase } from "@/lib/format";
import { absoluteTime } from "@/lib/time";
import {
	pendingApprovalsQueryOptions,
	workApprovalsQueryOptions,
	workPendingApprovalsQueryOptions,
	workFleetQueryOptions,
	workItemReadinessQueryOptions,
	osQueryKeys,
	workSchedulerQueryOptions,
} from "@/lib/os-query-options";
import {
	MutationError,
	ApprovalRequestError,
	useCursorPaging,
	PageControls,
} from "./work-operations-shared";

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
	useOsFormattingPreferences();
	const client = useQueryClient();
	const paging = useCursorPaging<{ at: string; id: string }>();
	const approvalOptions = workApprovalsQueryOptions(paging.cursor);
	const query = useQuery(approvalOptions);
	const pendingApprovals = useQuery(workPendingApprovalsQueryOptions());
	const runtimeApprovals = useQuery(pendingApprovalsQueryOptions());
	const delegate = useMutation({
		mutationFn: (approval: ApprovalRequest) =>
			osApi.tediApprovals.resolve({
				id: approval.id,
				status: approvalDecision(approval).recommendation,
				delegateRecommendation: true,
			}),
		onSuccess: () =>
			client.invalidateQueries({ queryKey: osQueryKeys.approvals() }),
	});
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
	const pendingDecisions = (pendingApprovals.data?.data ?? []).filter(
		({ effectiveStatus, canDecide }) =>
			effectiveStatus === "pending" && canDecide,
	);
	const proposalHistory = approvalRows.filter(
		({ effectiveStatus, canDecide }) =>
			effectiveStatus !== "pending" || !canDecide,
	);
	return (
		<Page width="xl">
			<WorkPageHeader
				title="Approvals"
				description="Decisions waiting for you, and approvals that let work start."
			/>
			<PageSection aria-labelledby="runtime-approvals-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="runtime-approvals-title">
							Actions waiting for approval
						</SectionTitle>
						<SectionDescription>
							Actions a tedi or automation paused until someone approves them.
							Check what each one will do before you approve it.
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
					<WorkListSkeleton />
				) : runtimeApprovals.isError ? (
					<WorkReadFailure
						title="Waiting actions unavailable"
						error={runtimeApprovals.error}
					/>
				) : runtimeApprovals.data.data.length === 0 ? (
					<WorkEmpty
						title="No runtime decisions need attention"
						description="When a tedi or automation pauses for your approval, it appears here."
					/>
				) : (
					<ul className="m-0 grid list-none gap-2 p-0">
						{runtimeApprovals.data.data.map((approval) => (
							<Surface
								key={approval.id}
								className="grid gap-3 px-3 py-3"
								render={<li />}
							>
								<ApprovalDecisionCopy approval={approval} />
								<div className="flex flex-wrap gap-x-4 gap-y-1">
									<Text as="span" role="label" tone="secondary">
										Expires{" "}
										<time
											dateTime={approval.expiresAt}
											title={absoluteTime(approval.expiresAt)}
										>
											{absoluteTime(approval.expiresAt)}
										</time>
									</Text>
								</div>
								<Collapsible>
									<CollapsibleTrigger>
										Exact payload and evidence
									</CollapsibleTrigger>
									<CollapsibleContent>
										<CodeBlock
											className="mt-2 max-h-64 overflow-auto"
											code={JSON.stringify(
												{
													approvalRequestId: approval.id,
													description: approval.description,
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
									</CollapsibleContent>
								</Collapsible>
								{approval.actionType === "browser.live_view_takeover" ? (
									<BrowserTakeoverLiveView approvalId={approval.id} />
								) : null}
								{approval.review.decisionMode === "approve_or_reject" ? (
									<div className="flex flex-wrap gap-2">
										<Button
											disabled={delegate.isPending}
											onClick={() => delegate.mutate(approval)}
										>
											Decide for me
										</Button>
										<MutationError error={delegate.error} />
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
			<PageSection aria-label="Past approval decisions">
				<ApprovalProvenanceHistory />
			</PageSection>
			<PageSection aria-labelledby="work-admission-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="work-admission-title">
							Approvals to start work
						</SectionTitle>
						<SectionDescription>
							Approvals a Work item needs before it can start.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{pendingApprovals.isPending ? (
					<WorkListSkeleton />
				) : pendingApprovals.isError ? (
					<WorkReadFailure
						title="Approvals unavailable"
						error={pendingApprovals.error}
					/>
				) : pendingDecisions.length === 0 &&
				  approvalRows.length === 0 &&
				  !query.isPending &&
				  !query.isError ? (
					<WorkEmpty
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
														<time
															dateTime={proposal.expiresAt}
															title={absoluteTime(proposal.expiresAt)}
														>
															{absoluteTime(proposal.expiresAt)}
														</time>
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
								{query.isPending ? (
									<WorkListSkeleton />
								) : query.isError ? (
									<WorkReadFailure
										title="Approval history unavailable"
										error={query.error}
									/>
								) : null}
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
					collapse="always"
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
