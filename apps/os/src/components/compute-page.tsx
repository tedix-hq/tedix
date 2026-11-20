import { monthlyAllowanceCredits } from "@tedix/api-contract/utils/credit-pricing";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import {
	BillingTable,
	billingSubjectRows,
	type BillingSubjectGroup,
} from "@/components/billing-table";
import {
	formatCreditPeriod,
	formatResetDate,
} from "@/components/billing-credit-usage";
import { BillingCard, BillingCardSkeleton } from "@/components/billing-card";
import { Button } from "@/components/kumo/button";
import { ChartPalette } from "@/components/kumo/event-chart";
import { useTheme } from "@/hooks/use-theme";
import { LoadError } from "@/components/kumo/alert";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import { Empty } from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { Link } from "@/components/kumo/link";
import { Meter } from "@/components/kumo/meter";
import {
	Page,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Switch } from "@/components/kumo/switch";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import { RestrictedNotice } from "@/components/restricted-notice";
import {
	formatChartShare,
	USAGE_ACTIVITIES,
	type CreditUsage,
	formatUsagePercent,
	usagePercent,
} from "@/lib/billing-credits";
import { formatCount } from "@/lib/format";
import {
	billingOverviewQueryOptions,
	computePostureQueryOptions,
	osQuery,
} from "@/lib/os-query-options";
import { OS_COPY } from "@/shared/os-copy";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

const UsageChart = lazy(() =>
	import("@/components/usage-chart").then((module) => ({
		default: module.UsageChart,
	})),
);

const UsageBreakdownChart = lazy(() =>
	import("@/components/usage-chart").then((module) => ({
		default: module.UsageBreakdownChart,
	})),
);

export type UsageTab = "overview" | "tedis" | "members";
type UsageWindow = "month" | "30d" | "7d";
const WINDOWS = {
	month: "This month",
	"30d": "Last 30 days",
	"7d": "Last 7 days",
} as const;

export function ComputePage({
	tab,
	onTabChange,
}: {
	tab: UsageTab;
	onTabChange: (tab: UsageTab) => void;
}) {
	const context = useOsOperationalContext();
	const permissions = context.data?.authority.permissions;
	const canRead = permissions?.includes("billing:read") ?? false;
	const canManage = permissions?.includes("billing:manage") ?? false;
	const overview = useQuery({
		...billingOverviewQueryOptions(),
		enabled: canRead,
	});

	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>{OS_COPY.navigation.usage}</PageTitle>
				</PageHeading>
			</PageHeader>
			{context.isPending ? (
				<BillingCard title="This month">
					<BillingCardSkeleton label="Loading usage" />
				</BillingCard>
			) : context.isError ? (
				<LoadError
					title="Usage is unavailable"
					error={context.error}
					onRetry={() => void context.refetch()}
				/>
			) : !canRead ? (
				<RestrictedNotice
					title="You don’t have access to usage"
					description="Ask an organization owner for help."
				/>
			) : overview.isPending ? (
				<BillingCard title="This month">
					<BillingCardSkeleton label="Loading usage" />
				</BillingCard>
			) : overview.isError ? (
				<LoadError
					title="Usage could not be loaded"
					error={overview.error}
					onRetry={() => void overview.refetch()}
				/>
			) : (
				<>
					<UsageSummary
						credits={overview.data.credits}
						showBreakdown={tab === "overview"}
					/>
					<Tabs
						value={tab}
						onValueChange={(value) => onTabChange(value as UsageTab)}
					>
						<TabsList aria-label="Usage sections" variant="line">
							<TabsTrigger value="overview">Overview</TabsTrigger>
							<TabsTrigger value="tedis">Tedis</TabsTrigger>
							<TabsTrigger value="members">Members</TabsTrigger>
						</TabsList>
						<TabsContent value="overview" className="pt-4">
							<UsageOverview
								hasAllowance={
									monthlyAllowanceCredits(overview.data.credits) > 0
								}
							/>
						</TabsContent>
						<TabsContent value="tedis" className="pt-4">
							<UsageSubjects group="tedis" credits={overview.data.credits} />
						</TabsContent>
						<TabsContent value="members" className="pt-4">
							<UsageSubjects group="members" credits={overview.data.credits} />
						</TabsContent>
					</Tabs>
					<UsageRecordDetails />
					{canManage && (
						<Link href="/admin/billing">
							Exact credits, caps and invoices are on Billing
						</Link>
					)}
				</>
			)}
		</Page>
	);
}

function UsageSummary({
	credits,
	showBreakdown,
}: {
	credits: CreditUsage;
	showBreakdown: boolean;
}) {
	const { theme } = useTheme();
	const allowance = monthlyAllowanceCredits(credits);
	const percent = allowance > 0 ? (credits.usedCredits * 100) / allowance : 0;
	const label = allowance > 0 ? formatChartShare(percent) : "—";
	const series = USAGE_ACTIVITIES.map(({ name, breakdownKey }, index) => ({
		name,
		value:
			allowance > 0 ? (credits.breakdown[breakdownKey] * 100) / allowance : 0,
		color: ChartPalette.categorical(index, theme === "dark"),
	}));
	return (
		<BillingCard title="This month">
			<div
				className={
					showBreakdown ? "grid items-center gap-4 sm:grid-cols-2" : undefined
				}
			>
				<div className="grid gap-3">
					<div>
						<Text
							role="label"
							tone="secondary"
							className="uppercase tracking-wider"
						>
							Monthly credits used
						</Text>
						<Text role="metric" weight="semibold" className="tabular-nums">
							{label}
						</Text>
					</div>
					{allowance > 0 && (
						<Meter
							label={`${label} of this month's credits used`}
							hideLabel
							value={Math.min(percent, 100)}
							getAriaValueText={() => label}
						/>
					)}
					<Text tone="secondary">
						{formatCreditPeriod(credits.periodStart, credits.periodEnd)} ·
						Renews {formatResetDate(credits.periodEnd)}
					</Text>
					{showBreakdown && allowance > 0 && (
						<dl className="divide-y divide-kumo-hairline">
							{series.map(({ name, value, color }) => (
								<div
									key={name}
									className="flex items-center justify-between gap-3 py-2"
								>
									<dt className="flex items-center gap-2">
										<span
											aria-hidden="true"
											className="size-2.5 rounded-full"
											style={{ backgroundColor: color }}
										/>
										{name}
									</dt>
									<dd className="m-0 text-right tabular-nums">
										{formatChartShare(value)}
									</dd>
								</div>
							))}
						</dl>
					)}
				</div>
				{showBreakdown && percent > 0 && (
					<Suspense
						fallback={
							<BillingCardSkeleton label="Loading monthly usage chart" />
						}
					>
						<UsageBreakdownChart series={series} />
					</Suspense>
				)}
			</div>
		</BillingCard>
	);
}

function UsageOverview({ hasAllowance }: { hasAllowance: boolean }) {
	const [window, setWindow] = useState<UsageWindow>("month");
	const usage = useQuery({
		...osQuery.billing.getDailyUsage.queryOptions({ input: { window } }),
		enabled: hasAllowance,
	});
	const days = usage.data ?? [];

	return (
		<BillingCard
			title="Daily usage"
			actions={
				<Select
					items={WINDOWS}
					value={window}
					onValueChange={(value) => value && setWindow(value)}
				>
					<SelectTrigger aria-label="Period">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{Object.entries(WINDOWS).map(([value, label]) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
		>
			{!hasAllowance ? (
				<Empty
					appearance="inline"
					title="There is no credit allowance for this month."
				/>
			) : usage.isPending ? (
				<BillingCardSkeleton label="Loading daily usage" />
			) : usage.isError ? (
				<LoadError
					title="Daily usage could not be loaded"
					error={usage.error}
					onRetry={() => void usage.refetch()}
				/>
			) : days.every((day) =>
					USAGE_ACTIVITIES.every(({ dailyKey }) => day[dailyKey] === 0),
			  ) ? (
				<Empty appearance="inline" title="There is no usage in this period." />
			) : (
				<Suspense
					fallback={<BillingCardSkeleton label="Loading daily usage chart" />}
				>
					<UsageChart days={days} />
				</Suspense>
			)}
		</BillingCard>
	);
}

function UsageSubjects({
	credits,
	group,
}: {
	credits: CreditUsage;
	group: BillingSubjectGroup;
}) {
	const [search, setSearch] = useState("");
	const [showUnused, setShowUnused] = useState(false);
	const [mostFirst, setMostFirst] = useState(true);
	const allowance = monthlyAllowanceCredits(credits);
	const searchTerm = search.trim().toLowerCase();
	const rows = billingSubjectRows(credits, group)
		.filter(
			(row) =>
				(showUnused || row.usedCredits > 0) &&
				row.name.toLowerCase().includes(searchTerm),
		)
		.sort(
			(a, b) =>
				(mostFirst
					? b.usedCredits - a.usedCredits
					: a.usedCredits - b.usedCredits) || a.name.localeCompare(b.name),
		);

	return (
		<BillingCard
			title={group === "tedis" ? "Usage by tedi" : "Usage by member"}
			bodyClassName="p-0"
			actions={
				<div className="flex flex-wrap items-center gap-3">
					<Input
						aria-label="Search by name"
						placeholder="Search by name"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<label className="flex items-center gap-2">
						<Switch checked={showUnused} onCheckedChange={setShowUnused} />
						Show unused
					</label>
				</div>
			}
		>
			<BillingTable
				key={JSON.stringify([searchTerm, showUnused, mostFirst])}
				data={rows}
				rowKey="id"
				emptyTitle="No matching usage."
				columns={[
					{
						header: "Name",
						accessor: (row) => (
							<>
								<Text weight="medium">{row.name}</Text>
								<Text role="label" tone="secondary">
									{row.monthlyCapCredits === null
										? "No cap"
										: row.usedCredits >= row.monthlyCapCredits
											? "Cap reached"
											: `${formatUsagePercent(row.monthlyCapCredits - row.usedCredits, row.monthlyCapCredits)} of cap left`}
								</Text>
							</>
						),
					},
					{
						header: (
							<Button
								variant="ghost"
								aria-label={
									mostFirst
										? "Sort lowest share first"
										: "Sort highest share first"
								}
								icon={
									mostFirst ? (
										<ArrowDown aria-hidden />
									) : (
										<ArrowUp aria-hidden />
									)
								}
								onClick={() => setMostFirst(!mostFirst)}
							>
								Share of monthly credits
							</Button>
						),
						align: "right",
						accessor: (row) => (
							<div className="flex items-center justify-end gap-3">
								<Text as="span" className="tabular-nums">
									{formatUsagePercent(row.usedCredits, allowance)}
								</Text>
								<Meter
									label={`Share used by ${row.name}`}
									hideLabel
									value={usagePercent(row.usedCredits, allowance)}
									getAriaValueText={() =>
										formatUsagePercent(row.usedCredits, allowance)
									}
									className="hidden w-16 sm:block"
								/>
							</div>
						),
					},
				]}
			/>
		</BillingCard>
	);
}

function UsageRecordDetails() {
	const [open, setOpen] = useState(false);
	const posture = useQuery({
		...computePostureQueryOptions("30d"),
		enabled: open,
	});
	return (
		<BillingCard title="Usage records">
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleDefaultTrigger>
					How these figures are recorded
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<div className="grid gap-2 pt-2">
						<Text tone="secondary">
							Credits are counted when AI replies, code runs and tools finish.
						</Text>
						{posture.isPending ? (
							<BillingCardSkeleton label="Loading call records" />
						) : posture.isError ? (
							<Text tone="secondary">
								Call records are unavailable right now.
							</Text>
						) : (
							<>
								<Text tone="secondary">
									{posture.data.freshness.lastRowAt
										? `Latest AI call recorded on ${formatResetDate(posture.data.freshness.lastRowAt)}.`
										: "No AI calls have been recorded yet."}
								</Text>
								<Text tone="secondary">
									{formatCount(
										posture.data.provenance.filter(
											(source) => source.rowCount > 0,
										).length,
									)}{" "}
									sources in the last 30 days.
								</Text>
								<Text tone="secondary">
									{formatCount(posture.data.attribution.unattributedRowCount)}{" "}
									calls were recorded without a linked session in the last 30
									days.
								</Text>
							</>
						)}
					</div>
				</CollapsibleDefaultContent>
			</Collapsible>
		</BillingCard>
	);
}
