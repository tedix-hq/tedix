/**
 * Admin › Payments
 *
 * Read-only view of paid MCP tool requirements, settlements, budgets, and
 * receipts on the `mcpPayments` contract. Every filter, the spend window, and the
 * open receipt live in the URL (`admin-payments-search.ts`), and every read
 * sits on the generated `mcpPayments*QueryOptions` keys the route loader
 * warms through the same input builders.
 *
 * Authority: the /admin layout gate admits `settings:manage`/`os:admin` and
 * the owner/admin roles, but `billing:manage` is OWNER-only in
 * `packages/auth/src/rbac.ts` — an admin passes the layout and must still not
 * see the org's spend ledger. So this page carries its own narrower in-page
 * check, mirroring (not replacing) the API's guards.
 */

import { useQuery } from "@tanstack/react-query";
import type {
	McpPaymentEvent,
	McpPaymentPolicy,
} from "@tedix/api-contract/schemas/mcp-payments";
import {
	CaretDown,
	CheckCircle,
	Clock,
	Receipt,
	ShieldCheck,
	XCircle,
} from "@phosphor-icons/react";
import { type ReactNode, useMemo, useState } from "react";
import { isImeComposing } from "@/lib/keyboard";
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
import { Empty } from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	Page,
	PageActions,
	Collection,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	PageToolbar,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/kumo/sheet";
import { Skeleton } from "@/components/kumo/skeleton";
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
import {
	type AdminPaymentsSearch,
	PAYMENT_EVENTS_LIMIT,
	paymentsEventsInput,
	paymentsPoliciesInput,
	paymentsSummaryInput,
	paymentsTediFilter,
	type PaymentStatusFilter,
	type PaymentWindowHours,
} from "@/lib/admin-payments-search";
import {
	mcpPaymentsEventsQueryOptions,
	mcpPaymentsPoliciesQueryOptions,
	mcpPaymentsReceiptQueryOptions,
	mcpPaymentsSpendSummaryQueryOptions,
} from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { asRecord } from "@tedix/api-contract/utils/is-record";

const PAYMENT_EVENTS_PAGE_SIZE = 15;

function PaymentsRestricted() {
	return (
		<Card size="sm">
			<CardContent className="flex items-center gap-3">
				<ShieldCheck className="size-5 shrink-0" aria-hidden />
				<div>
					<Text role="body" weight="medium">
						Payments needs the billing:manage grant
					</Text>
					<Text tone="secondary">
						Your credential resolves administrative access but not
						billing:manage, which only owners hold. Ask an owner to review paid
						tool spend or receipts.
					</Text>
				</div>
			</CardContent>
		</Card>
	);
}

function PaymentsPending() {
	return (
		<div aria-busy="true" aria-label="Loading payments" className="space-y-4">
			<MetricGrid columns={4} aria-hidden>
				{Array.from({ length: 4 }).map((_, index) => (
					<MetricItem
						key={`payment-metric-${index}`}
						label={<Skeleton className="h-3 w-20" />}
						value={<Skeleton className="h-7 w-16" />}
						description={<Skeleton className="h-3 w-28 max-w-full" />}
					/>
				))}
			</MetricGrid>
			<Skeleton className="h-24" />
			<div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_18rem]">
				<Skeleton className="h-96" />
				<Skeleton className="h-96" />
			</div>
		</div>
	);
}

export function AdminPaymentsPage({
	search,
	onSearchChange,
}: {
	search: AdminPaymentsSearch;
	onSearchChange: (next: Partial<AdminPaymentsSearch>) => void;
}) {
	const context = useOsOperationalContext();

	return (
		<Page width="full">
			<PageHeader>
				<PageHeading>
					<PageTitle>Payments</PageTitle>
					<PageDescription>
						Read-only view of paid tool requirements, settlements, budgets, and
						receipts across this organization.
					</PageDescription>
				</PageHeading>
				<PageActions>
					<Badge variant="outline" className="w-fit">
						Test data
					</Badge>
				</PageActions>
			</PageHeader>
			{context.isPending ? (
				<PaymentsPending />
			) : context.isError || !context.data ? (
				<Alert variant="destructive">
					<AlertTitle>Payments are unavailable</AlertTitle>
					<AlertDescription>
						{errorMessage(
							context.error,
							"The operational context read failed.",
						)}
					</AlertDescription>
				</Alert>
			) : !context.data.authority.permissions.includes("billing:manage") ? (
				<PaymentsRestricted />
			) : (
				<AdminPaymentsBody search={search} onSearchChange={onSearchChange} />
			)}
		</Page>
	);
}

function AdminPaymentsBody({
	search,
	onSearchChange,
}: {
	search: AdminPaymentsSearch;
	onSearchChange: (next: Partial<AdminPaymentsSearch>) => void;
}) {
	const eventsQuery = useQuery({
		...mcpPaymentsEventsQueryOptions(paymentsEventsInput(search)),
		refetchInterval: 30_000,
	});
	const spendQuery = useQuery({
		...mcpPaymentsSpendSummaryQueryOptions(paymentsSummaryInput(search)),
		refetchInterval: 30_000,
	});
	const policiesQuery = useQuery({
		...mcpPaymentsPoliciesQueryOptions(paymentsPoliciesInput(search)),
		refetchInterval: 30_000,
	});
	const selectedReceiptId = search.receipt ?? null;
	const receiptQuery = useQuery({
		...mcpPaymentsReceiptQueryOptions(selectedReceiptId ?? ""),
		enabled: selectedReceiptId !== null,
	});

	const events = eventsQuery.data?.events;
	const policies = policiesQuery.data?.policies;
	const latestBudget = useMemo(() => findLatestBudget(events ?? []), [events]);
	const droppedTediFilter =
		search.tedi !== undefined && paymentsTediFilter(search) === undefined;

	if (
		eventsQuery.isPending ||
		spendQuery.isPending ||
		policiesQuery.isPending
	) {
		return <PaymentsPending />;
	}

	if (
		eventsQuery.isError ||
		spendQuery.isError ||
		policiesQuery.isError ||
		!events ||
		!spendQuery.data ||
		!policies
	) {
		return (
			<Alert variant="destructive">
				<AlertTitle>The payment ledger could not be read</AlertTitle>
				<AlertDescription>
					{errorMessage(
						eventsQuery.error ?? spendQuery.error ?? policiesQuery.error,
						"The payments read failed.",
					)}
				</AlertDescription>
			</Alert>
		);
	}

	const spendData = spendQuery.data;
	const activePolicies = policies.filter((policy) => policy.enabled);
	const topTool = spendData.summary[0] ?? null;
	const primaryTotal = spendData.totals[0] ?? null;
	const latestSettlement = events.find((event) => event.status === "settled");

	return (
		<>
			<MetricGrid columns={4} aria-label="Payment summary">
				<MetricItem
					label="Settled spend"
					emphasis="metric"
					value={
						primaryTotal
							? formatMoney(primaryTotal.totalAmount, primaryTotal.currency)
							: "0"
					}
					description={`${primaryTotal?.settledCount ?? 0} settled calls in ${search.hours}h`}
				/>
				<MetricItem
					label="Recent events"
					emphasis="metric"
					value={String(events.length)}
					description="Requirements, settlements, and rejections"
				/>
				<MetricItem
					label="Active policies"
					emphasis="metric"
					value={String(activePolicies.length)}
					description={`${policies.length} managed budget policies`}
				/>
				<MetricItem
					label="Budget window"
					emphasis="dialog"
					value={
						latestBudget
							? `${formatMoney(latestBudget.projected, latestBudget.currency)} / ${formatMoney(latestBudget.maxAmount, latestBudget.currency)}`
							: "No policy"
					}
					description={
						latestBudget
							? `${latestBudget.scope} ${latestBudget.mode} budget`
							: "No recent budget decision found"
					}
				/>
			</MetricGrid>

			<PaymentsFilters
				search={search}
				onSearchChange={onSearchChange}
				droppedTediFilter={droppedTediFilter}
			/>

			<div className="grid min-w-0 grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_18rem]">
				<PaymentEventsTable
					events={events}
					onSelectReceipt={(id) => onSearchChange({ receipt: id })}
				/>
				<div className="space-y-4">
					<ToolSpendBreakdown rows={spendData.summary} topTool={topTool} />
					<BudgetPoliciesPanel
						policies={policies}
						latestSettlement={latestSettlement}
					/>
				</div>
			</div>

			<Sheet
				open={selectedReceiptId !== null}
				onOpenChange={(open) => {
					if (!open) onSearchChange({ receipt: undefined });
				}}
			>
				<SheetContent size="2xl" className="overflow-y-auto">
					<SheetHeader>
						<SheetTitle>Payment receipt</SheetTitle>
						<SheetDescription>
							Settlement, budget, audit, and rationale details.
						</SheetDescription>
					</SheetHeader>
					<div className="space-y-4 px-6 pb-6">
						{receiptQuery.isLoading ? (
							<Skeleton className="h-64 w-full" />
						) : receiptQuery.isError ? (
							<Alert variant="destructive">
								<AlertTitle>Could not load the receipt</AlertTitle>
								<AlertDescription>
									{errorMessage(receiptQuery.error, "The receipt read failed.")}
								</AlertDescription>
							</Alert>
						) : receiptQuery.data ? (
							<ReceiptDetails receipt={receiptQuery.data.receipt} />
						) : (
							<Text tone="secondary">Receipt details are unavailable.</Text>
						)}
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}

/**
 * Filters commit to the URL — the free-text fields hold a local draft and
 * commit on blur or Enter so each keystroke does not rewrite history and
 * re-run the route loader.
 */
function PaymentsFilters({
	search,
	onSearchChange,
	droppedTediFilter,
}: {
	search: AdminPaymentsSearch;
	onSearchChange: (next: Partial<AdminPaymentsSearch>) => void;
	droppedTediFilter: boolean;
}) {
	const activeFilterCount = [
		search.status !== "all",
		Boolean(search.app),
		Boolean(search.tool),
		Boolean(search.tedi),
	].filter(Boolean).length;
	const [mobileFiltersOpen, setMobileFiltersOpen] = useState(
		() => activeFilterCount > 0,
	);
	const filterSummary = `${paymentWindowLabel(search.hours)} · ${paymentStatusLabel(search.status)}${activeFilterCount > 0 ? ` · ${activeFilterCount} active` : ""}`;

	return (
		<PageSection>
			<Surface
				className="md:hidden"
				render={
					<Collapsible
						open={mobileFiltersOpen}
						onOpenChange={setMobileFiltersOpen}
					/>
				}
			>
				<CollapsibleTrigger className="w-full justify-between rounded-lg px-3 py-2 text-left hover:bg-kumo-tint">
					<span className="min-w-0">
						<span className="block font-medium text-kumo-default">Filters</span>
						<span className="block truncate text-kumo-subtle type-tedix-label">
							{filterSummary}
						</span>
					</span>
					<CaretDown
						aria-hidden
						className={`size-4 shrink-0 transition-transform duration-tedix-standard motion-reduce:transition-none ${mobileFiltersOpen ? "rotate-180" : ""}`}
					/>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="border-kumo-line border-t p-3">
						<PaymentFilterControls
							idPrefix="mobile-"
							search={search}
							onSearchChange={onSearchChange}
							droppedTediFilter={droppedTediFilter}
						/>
					</div>
				</CollapsibleContent>
			</Surface>

			<SectionHeader className="max-md:hidden">
				<SectionHeading>
					<SectionTitle>Filters</SectionTitle>
					<SectionDescription>
						Narrow the ledger without changing payment state.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<Surface tier="panel" className="hidden p-3 md:block">
				<PaymentFilterControls
					idPrefix=""
					search={search}
					onSearchChange={onSearchChange}
					droppedTediFilter={droppedTediFilter}
				/>
			</Surface>
		</PageSection>
	);
}

function PaymentFilterControls({
	idPrefix,
	search,
	onSearchChange,
	droppedTediFilter,
}: {
	idPrefix: string;
	search: AdminPaymentsSearch;
	onSearchChange: (next: Partial<AdminPaymentsSearch>) => void;
	droppedTediFilter: boolean;
}) {
	return (
		<PageToolbar
			appearance="inline"
			className="grid grid-cols-1 items-start sm:grid-cols-2 lg:grid-cols-5 xl:grid xl:items-start"
		>
			<div className="min-w-0 space-y-1.5">
				<Label htmlFor={`${idPrefix}payment-time-window`}>Time window</Label>
				<Select
					value={String(search.hours)}
					onValueChange={(value) =>
						onSearchChange({
							hours: Number(value) as PaymentWindowHours,
						})
					}
				>
					<SelectTrigger
						id={`${idPrefix}payment-time-window`}
						className="w-full"
					>
						<SelectValue>{paymentWindowLabel(search.hours)}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="24">Last 24 hours</SelectItem>
						<SelectItem value="168">Last 7 days</SelectItem>
						<SelectItem value="720">Last 30 days</SelectItem>
						<SelectItem value="2160">Last 90 days</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<div className="min-w-0 space-y-1.5">
				<Label htmlFor={`${idPrefix}payment-status`}>Status</Label>
				<Select
					value={search.status}
					onValueChange={(value) =>
						onSearchChange({ status: value as PaymentStatusFilter })
					}
				>
					<SelectTrigger id={`${idPrefix}payment-status`} className="w-full">
						<SelectValue>{paymentStatusLabel(search.status)}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All statuses</SelectItem>
						<SelectItem value="required">Required</SelectItem>
						<SelectItem value="settled">Settled</SelectItem>
						<SelectItem value="rejected">Rejected</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<DraftFilterField
				id={`${idPrefix}payment-app`}
				label="App"
				placeholder="App slug"
				value={search.app ?? ""}
				onCommit={(value) => onSearchChange({ app: value || undefined })}
			/>
			<DraftFilterField
				id={`${idPrefix}payment-tool`}
				label="Tool"
				placeholder="Tool ID"
				value={search.tool ?? ""}
				onCommit={(value) => onSearchChange({ tool: value || undefined })}
			/>
			<DraftFilterField
				id={`${idPrefix}payment-tedi`}
				label="Tedi"
				placeholder="Tedi ID"
				value={search.tedi ?? ""}
				onCommit={(value) => onSearchChange({ tedi: value || undefined })}
				hint={
					droppedTediFilter
						? "Not a tedi id (UUID) — filter not applied."
						: undefined
				}
			/>
		</PageToolbar>
	);
}

function paymentWindowLabel(hours: PaymentWindowHours) {
	if (hours === 24) return "Last 24 hours";
	if (hours === 168) return "Last 7 days";
	if (hours === 720) return "Last 30 days";
	return "Last 90 days";
}

function paymentStatusLabel(status: PaymentStatusFilter) {
	if (status === "all") return "All statuses";
	return status.charAt(0).toUpperCase() + status.slice(1);
}

function DraftFilterField({
	id,
	label,
	placeholder,
	value,
	onCommit,
	hint,
}: {
	id: string;
	label: string;
	placeholder: string;
	value: string;
	onCommit: (value: string) => void;
	hint?: string;
}) {
	const [draft, setDraft] = useState(value);
	// Re-sync when the URL changes underneath (back/forward, shared link).
	const [lastValue, setLastValue] = useState(value);
	if (value !== lastValue) {
		setLastValue(value);
		setDraft(value);
	}
	const commit = () => {
		const trimmed = draft.trim();
		if (trimmed !== value) onCommit(trimmed);
	};
	return (
		<div className="min-w-0 space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				aria-label={label}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !isImeComposing(event)) commit();
				}}
				placeholder={placeholder}
			/>
			{hint && (
				<Text role="label" tone="warning">
					{hint}
				</Text>
			)}
		</div>
	);
}

function BudgetPoliciesPanel({
	policies,
	latestSettlement,
}: {
	policies: McpPaymentPolicy[];
	latestSettlement: McpPaymentEvent | undefined;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Budget policies</CardTitle>
				<CardDescription>
					Spending limits enforced before a paid tool runs.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{policies.length === 0 ? (
					<Text tone="secondary">
						No managed payment policies match these filters.
					</Text>
				) : (
					<div className="space-y-3">
						{policies.map((policy) => (
							<div
								key={policy.id}
								className="space-y-2 border-b pb-3 last:border-b-0 last:pb-0"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<Text weight="medium" truncate>
											{policy.toolId ?? "All paid tools"}
										</Text>
										<Text role="label" tone="secondary" truncate>
											{policy.appSlug ?? "All apps"}
											{policy.tediId ? ` · ${shortId(policy.tediId)}` : ""}
										</Text>
									</div>
									<Badge variant={policy.enabled ? "success" : "outline"}>
										{policy.enabled ? "Active" : "Disabled"}
									</Badge>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<PolicyStat
										label="Window"
										value={`${formatDuration(policy.windowSeconds)}`}
									/>
									<PolicyStat label="Mode" value={policy.mode} />
									<PolicyStat
										label="Budget"
										value={formatMoney(policy.maxAmount, policy.currency)}
									/>
									<PolicyStat label="Network" value={policy.network} />
								</div>
							</div>
						))}
					</div>
				)}
				{latestSettlement ? (
					<Text role="label" tone="secondary" className="mt-4">
						Latest settlement:{" "}
						{formatMoney(latestSettlement.amount, latestSettlement.currency)}{" "}
						for {latestSettlement.toolId}.
					</Text>
				) : null}
			</CardContent>
		</Card>
	);
}

function PolicyStat({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<Text role="label" tone="secondary">
				{label}
			</Text>
			<Text role="label" weight="medium" truncate>
				{value}
			</Text>
		</div>
	);
}

function PaymentEventsTable({
	events,
	onSelectReceipt,
}: {
	events: McpPaymentEvent[];
	onSelectReceipt: (id: string) => void;
}) {
	const [visibleCount, setVisibleCount] = useState(PAYMENT_EVENTS_PAGE_SIZE);
	const visibleEvents = events.slice(0, visibleCount);
	const showingCount = visibleEvents.length;
	const hasMoreEvents = showingCount < events.length;

	return (
		<PageSection className="min-w-0">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Payment events</SectionTitle>
					<SectionDescription>
						Latest payment requirements and outcomes, up to{" "}
						{PAYMENT_EVENTS_LIMIT} events.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<Collection aria-label="Payment events" className="lg:hidden">
				{events.length === 0 ? (
					<li>
						<Empty
							appearance="inline"
							title="No payment events"
							description="No payment events match these filters."
						/>
					</li>
				) : (
					visibleEvents.map((event) => (
						<li key={event.id}>
							<article className="space-y-3 p-3">
								<header className="flex min-w-0 items-start justify-between gap-3">
									<div className="min-w-0">
										<Text weight="medium" className="break-words">
											{event.toolId}
										</Text>
										<Text role="label" tone="secondary" className="break-words">
											{event.appSlug}
											{event.tediId ? ` · ${shortId(event.tediId)}` : ""}
										</Text>
									</div>
									<StatusBadge event={event} />
								</header>
								<dl className="grid grid-cols-2 gap-x-4 gap-y-2">
									<div className="min-w-0">
										<dt className="text-kumo-subtle type-tedix-label">
											Amount
										</dt>
										<dd className="mt-0.5 text-kumo-default type-tedix-body">
											{formatMoney(event.amount, event.currency)}
											<span className="block truncate text-kumo-subtle type-tedix-label">
												{event.network}
											</span>
										</dd>
									</div>
									<div className="min-w-0">
										<dt className="text-kumo-subtle type-tedix-label">
											Budget
										</dt>
										<dd className="mt-1">
											<BudgetBadge event={event} />
										</dd>
									</div>
								</dl>
								<footer className="flex min-w-0 items-center justify-between gap-3 border-kumo-hairline border-t pt-2">
									<time dateTime={event.createdAt}>
										<Text as="span" role="label" tone="secondary">
											{formatDateTime(event.createdAt)}
										</Text>
									</time>
									{event.settled ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => onSelectReceipt(event.id)}
										>
											<Receipt className="mr-1.5 h-3.5 w-3.5" />
											View receipt
										</Button>
									) : null}
								</footer>
							</article>
						</li>
					))
				)}
			</Collection>
			<Surface tier="panel" className="hidden overflow-hidden lg:block">
				<Table scrollLabel="Payment events">
					<TableHeader>
						<TableRow>
							<TableHead>Time</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Tool</TableHead>
							<TableHead>Amount</TableHead>
							<TableHead>Budget</TableHead>
							<TableHead className="text-right">Receipt</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{events.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={6}
									className="h-28 text-center text-kumo-subtle"
								>
									No payment events match these filters.
								</TableCell>
							</TableRow>
						) : (
							visibleEvents.map((event) => (
								<TableRow key={event.id}>
									<TableCell className="whitespace-nowrap text-kumo-subtle">
										{formatDateTime(event.createdAt)}
									</TableCell>
									<TableCell>
										<StatusBadge event={event} />
									</TableCell>
									<TableCell className="min-w-56">
										<Text weight="medium">{event.toolId}</Text>
										<Text role="label" tone="secondary">
											{event.appSlug}
											{event.tediId ? ` · ${shortId(event.tediId)}` : ""}
										</Text>
									</TableCell>
									<TableCell className="whitespace-nowrap">
										{formatMoney(event.amount, event.currency)}
										<Text role="label" tone="secondary">
											{event.network}
										</Text>
									</TableCell>
									<TableCell>
										<BudgetBadge event={event} />
									</TableCell>
									<TableCell className="text-right">
										{event.settled ? (
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => onSelectReceipt(event.id)}
											>
												<Receipt className="mr-1.5 h-3.5 w-3.5" />
												View
											</Button>
										) : (
											<Text as="span" role="label" tone="secondary">
												-
											</Text>
										)}
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</Surface>
			{events.length > 0 ? (
				<div className="flex min-h-11 items-center justify-between gap-3 border-kumo-hairline border-t pt-3">
					<Text role="label" tone="secondary">
						Showing {showingCount} of {events.length} events
					</Text>
					{hasMoreEvents ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="max-sm:min-h-11"
							onClick={() =>
								setVisibleCount((count) => count + PAYMENT_EVENTS_PAGE_SIZE)
							}
						>
							Show more
						</Button>
					) : null}
				</div>
			) : null}
		</PageSection>
	);
}

function ToolSpendBreakdown({
	rows,
	topTool,
}: {
	rows: Array<{
		appSlug: string;
		toolId: string;
		currency: string | null;
		network: string;
		settledCount: number;
		totalAmount: number;
	}>;
	topTool: {
		appSlug: string;
		toolId: string;
		totalAmount: number;
		currency: string | null;
		settledCount: number;
	} | null;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Tool spend</CardTitle>
				<CardDescription>Settled spend grouped by paid tool.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{topTool ? (
					<Surface className="p-3">
						<Text role="label" tone="secondary">
							Top paid tool
						</Text>
						<Text weight="medium" truncate className="mt-1">
							{topTool.toolId}
						</Text>
						<Text tone="secondary" className="mt-1">
							{formatMoney(topTool.totalAmount, topTool.currency)} across{" "}
							{topTool.settledCount} calls
						</Text>
					</Surface>
				) : null}

				<div className="space-y-3">
					{rows.length === 0 ? (
						<Text tone="secondary">No settled spend in this window.</Text>
					) : (
						rows.map((row) => (
							<div
								key={`${row.appSlug}:${row.toolId}:${row.network}`}
								className="space-y-1 border-b pb-3 last:border-b-0 last:pb-0"
							>
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0">
										<Text weight="medium" truncate>
											{row.toolId}
										</Text>
										<Text role="label" tone="secondary">
											{row.appSlug} · {row.network}
										</Text>
									</div>
									<div className="text-right">
										<Text weight="medium">
											{formatMoney(row.totalAmount, row.currency)}
										</Text>
										<Text role="label" tone="secondary">
											{row.settledCount} calls
										</Text>
									</div>
								</div>
							</div>
						))
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function ReceiptDetails({ receipt }: { receipt: McpPaymentEvent }) {
	const budgetDecision = asRecord(receipt.budgetDecision);
	const budgetPolicy = asRecord(receipt.budgetPolicy);

	return (
		<div className="space-y-4">
			<div className="grid gap-3 sm:grid-cols-2">
				<Detail label="Receipt id" value={receipt.id} />
				<Detail label="Requirement" value={receipt.requirementId} />
				<Detail label="Tool" value={receipt.toolId} />
				<Detail
					label="Amount"
					value={formatMoney(receipt.amount, receipt.currency)}
				/>
				<Detail label="Network" value={receipt.network} />
				<Detail label="Created" value={formatDateTime(receipt.createdAt)} />
				<Detail label="Audit event" value={receipt.auditEventId ?? "-"} />
				<Detail label="Rationale" value={receipt.rationaleRecordId ?? "-"} />
			</div>

			<JsonBlock title="Budget Policy" value={budgetPolicy} />
			<JsonBlock title="Budget Decision" value={budgetDecision} />
			<JsonBlock title="Payment Response" value={receipt.paymentResponse} />
		</div>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<Surface className="p-3">
			<Text role="label" tone="secondary">
				{label}
			</Text>
			<Text weight="medium" className="mt-1 break-all">
				{value}
			</Text>
		</Surface>
	);
}

function JsonBlock({
	title,
	value,
}: {
	title: string;
	value: Record<string, unknown> | null;
}) {
	return (
		<div className="space-y-2">
			<Text weight="medium">{title}</Text>
			<pre className="max-h-56 overflow-auto rounded-lg bg-kumo-fill p-3 text-xs">
				{value ? JSON.stringify(value, null, 2) : "null"}
			</pre>
		</div>
	);
}

function StatusBadge({ event }: { event: McpPaymentEvent }): ReactNode {
	if (event.status === "settled") {
		return (
			<Badge variant="success" className="gap-1">
				<CheckCircle className="h-3 w-3" />
				Settled
			</Badge>
		);
	}
	if (event.status === "rejected") {
		return (
			<Badge variant="destructive" className="gap-1">
				<XCircle className="h-3 w-3" />
				Rejected
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="gap-1">
			<Clock className="h-3 w-3" />
			Required
		</Badge>
	);
}

function BudgetBadge({ event }: { event: McpPaymentEvent }): ReactNode {
	const decision = asRecord(event.budgetDecision);
	if (decision) {
		return decision.allowed === false ? (
			<Badge variant="destructive">Denied</Badge>
		) : (
			<Badge variant="success">Allowed</Badge>
		);
	}
	return event.budgetPolicy ? (
		<Badge variant="outline">Policy</Badge>
	) : (
		<Text as="span" role="label" tone="secondary">
			-
		</Text>
	);
}

function findLatestBudget(events: McpPaymentEvent[]) {
	for (const event of events) {
		const decision = asRecord(event.budgetDecision);
		if (decision) {
			return {
				projected: asText(decision.projected),
				maxAmount: asText(decision.maxAmount),
				currency: asText(decision.currency),
				scope: asText(decision.scope),
				mode: asText(decision.mode),
			};
		}
	}
	return null;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function formatMoney(amount: number | string, currency: string | null) {
	const numeric = typeof amount === "number" ? amount : Number(amount);
	const unit = currency ?? "USDC";
	if (!Number.isFinite(numeric)) return `0 ${unit}`;
	return `${numeric.toLocaleString(undefined, {
		minimumFractionDigits: numeric < 1 ? 2 : 0,
		maximumFractionDigits: 6,
	})} ${unit}`;
}

function formatDateTime(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value.replace(" ", "T")));
}

function formatDuration(seconds: number) {
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	return `${Math.round(seconds / 60)}m`;
}

function shortId(value: string) {
	return `${value.slice(0, 8)}...`;
}
