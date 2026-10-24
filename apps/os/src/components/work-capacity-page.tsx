import {
	WorkPageHeader,
	WorkListSkeleton,
	WorkReadFailure,
	WorkEmpty,
} from "@/components/work-surface-primitives";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
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
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Link } from "@/components/kumo/link";
import { ResponsiveFormSurface } from "@/components/kumo/responsive-form-surface";
import { Collection, Page } from "@/components/kumo/page";
import { SelectItem } from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { useOsFormattingPreferences, sentenceCase } from "@/lib/format";
import { absoluteTime } from "@/lib/time";
import {
	workBudgetEnvelopesQueryOptions,
	workFleetQueryOptions,
	workItemDetailQueryOptions,
	osQueryKeys,
	workResourcePoolsQueryOptions,
	workSchedulerQueryOptions,
} from "@/lib/os-query-options";
import { workPrincipalLabel } from "@/lib/work-display";
import {
	namedWorkPrincipal,
	useWorkPrincipalNames,
	MutationError,
	useCursorPaging,
	PageControls,
} from "./work-operations-shared";

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
	useOsFormattingPreferences();
	if (!details.holders)
		return (
			<Text as="p" role="label" tone="secondary">
				{activeReserved
					? "Holder details unavailable. Refresh capacity before coordinating."
					: "No active reservations."}
			</Text>
		);
	return (
		<div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
			{details.holders.map((holder) => (
				<Text
					as="p"
					role="body"
					className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]"
					key={holder.attemptId}
				>
					<Link
						variant="record"
						className="max-w-full [overflow-wrap:anywhere]"
						href={`/work/items/${holder.workItemId}`}
					>
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
					<time
						dateTime={holder.expiresAt}
						title={absoluteTime(holder.expiresAt)}
					>
						{absoluteTime(holder.expiresAt)}
					</time>
					{holder.externalSessionKey ? (
						<Text
							as="span"
							role="label"
							tone="secondary"
							className="[overflow-wrap:anywhere]"
						>
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
		</div>
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
	const visibleBudgets = (budgets.data?.data ?? []).filter(
		(row) => !exhaustedOnly || row.availableMicros <= 0,
	);
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
			<WorkPageHeader
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
				<WorkListSkeleton />
			) : pools.isError || budgets.isError ? (
				<WorkReadFailure
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
												<li
													className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-3"
													key={pool.id}
												>
													<div className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
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
												</li>
											),
										)}
									</Collection>
								) : (
									<WorkEmpty
										title={
											saturatedOnly ? "No saturated pools" : "No resource pools"
										}
										description={
											saturatedOnly
												? "No saturated pools in this view."
												: "Create a pool to manage shared capacity."
										}
									/>
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
								{visibleBudgets.length ? (
									<Collection appearance="inline">
										{visibleBudgets.map(
											({ envelope, committedMicros, availableMicros }) => (
												<li
													className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-3"
													key={envelope.id}
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
												</li>
											),
										)}
									</Collection>
								) : (
									<WorkEmpty
										title={
											exhaustedOnly ? "No exhausted budgets" : "No budgets"
										}
										description={
											exhaustedOnly
												? "No exhausted budgets on this page. Use Next page to check more budgets."
												: "No budgets on this page."
										}
									/>
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
