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
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
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
import { Surface } from "@/components/kumo/surface";
import { Switch } from "@/components/kumo/switch";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import { LoadingArea } from "@/components/loading-area";
import { RestrictedNotice } from "@/components/restricted-notice";
import {
	allowanceUsage,
	type CreditUsage,
	formatUsagePercent,
	monthlyAllowanceCredits,
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

export type UsageTab = "overview" | "tedis" | "members";
type UsageWindow = "month" | "30d" | "7d";
const WINDOWS = {
	month: "This month",
	"30d": "Last 30 days",
	"7d": "Last 7 days",
} as const;
const LABELS = {
	aiPercent: "AI replies",
	codeRunPercent: "Code runs",
	toolPercent: "Tools",
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
				<LoadingArea label="Loading usage" />
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
				<LoadingArea label="Loading usage" />
			) : overview.isError ? (
				<LoadError
					title="Usage could not be loaded"
					error={overview.error}
					onRetry={() => void overview.refetch()}
				/>
			) : (
				<>
					<UsageSummary credits={overview.data.credits} />
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
							<UsageOverview />
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

function UsageSummary({ credits }: { credits: CreditUsage }) {
	const usage = allowanceUsage(credits);
	return (
		<Surface className="grid gap-2 p-tedix-card">
			<Meter
				label={`${usage.label} of this month's credits used`}
				value={usage.percent}
				showValue={false}
				getAriaValueText={() => usage.label}
			/>
			<Text tone="secondary">
				{formatCreditPeriod(credits.periodStart, credits.periodEnd)} · Renews{" "}
				{formatResetDate(credits.periodEnd)}
			</Text>
		</Surface>
	);
}

function UsageOverview() {
	const [window, setWindow] = useState<UsageWindow>("month");
	const usage = useQuery(
		osQuery.billing.getDailyUsage.queryOptions({ input: { window } }),
	);
	const days = usage.data ?? [];
	const metrics = Object.entries(LABELS).map(([field, label]) => {
		const key = field as keyof typeof LABELS;
		return { label, total: days.reduce((sum, day) => sum + day[key], 0) };
	});

	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<Text as="h2" role="section" weight="semibold">
					Share of credits used
				</Text>
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
			</div>
			{usage.isPending ? (
				<LoadingArea label="Loading daily usage" />
			) : usage.isError ? (
				<LoadError
					title="Daily usage could not be loaded"
					error={usage.error}
					onRetry={() => void usage.refetch()}
				/>
			) : metrics.every(({ total }) => total === 0) ? (
				<Empty title="No usage in this period" />
			) : (
				<>
					<MetricGrid
						columns={3}
						appearance="bounded"
						aria-label="Share by activity"
					>
						{metrics.map(({ label, total }) => (
							<MetricItem
								key={label}
								label={label}
								value={total > 0 && total < 1 ? "<1%" : `${Math.round(total)}%`}
							/>
						))}
					</MetricGrid>
					<Suspense fallback={<LoadingArea label="Loading chart" />}>
						<UsageChart days={days} />
					</Suspense>
				</>
			)}
		</div>
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
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center gap-4">
				<Input
					aria-label="Search by name"
					placeholder="Search by name"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<label className="flex items-center gap-2">
					<Switch checked={showUnused} onCheckedChange={setShowUnused} /> Show
					unused
				</label>
				<Select
					items={{ most: "Highest share first", least: "Lowest share first" }}
					value={mostFirst ? "most" : "least"}
					onValueChange={(value) => setMostFirst(value !== "least")}
				>
					<SelectTrigger aria-label="Sort by share">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="most">Highest share first</SelectItem>
						<SelectItem value="least">Lowest share first</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<BillingTable
				key={JSON.stringify([searchTerm, showUnused, mostFirst])}
				data={rows}
				rowKey="id"
				emptyTitle="No matching usage"
				emptyMessage={
					showUnused
						? "Try a different name."
						: "Turn on Show unused to include people or tedis with no usage."
				}
				columns={[
					{ header: "Name", accessor: "name" },
					{
						header: "Share of monthly credits",
						accessor: (row) => (
							<div className="flex min-w-28 items-center gap-3">
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
									className="w-16"
								/>
							</div>
						),
					},
					{
						header: "Cap",
						accessor: (row) =>
							row.monthlyCapCredits === null
								? "No cap"
								: row.usedCredits >= row.monthlyCapCredits
									? "Cap reached"
									: `Cap: ${formatUsagePercent(row.monthlyCapCredits - row.usedCredits, row.monthlyCapCredits)} left`,
					},
				]}
			/>
		</div>
	);
}

function UsageRecordDetails() {
	const [open, setOpen] = useState(false);
	const posture = useQuery({
		...computePostureQueryOptions("30d"),
		enabled: open,
	});
	return (
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
						<LoadingArea label="Loading call records" />
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
	);
}
