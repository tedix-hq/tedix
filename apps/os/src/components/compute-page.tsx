import { BillingSectionHeader } from "@/components/billing-section-header";
import type { ComputePosture } from "@tedix/api-contract/contracts/os-compute";
import {
	COST_PROVENANCE_DETAIL,
	COST_PROVENANCE_PRODUCED_TODAY,
	COST_PROVENANCE_SOURCE,
	type CostProvenance,
	CostProvenanceSchema,
} from "@tedix/api-contract/schemas/cost-provenance";
import { Link } from "@/components/kumo/link";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import {
	Collection,
	Page,
	PageActions,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
} from "@/components/kumo/page";
import {
	SegmentedControl,
	USAGE_PERIOD_OPTIONS,
} from "@/components/kumo/segmented-control";
import { Surface } from "@/components/kumo/surface";
import { Meter } from "@/components/kumo/meter";
import { Text } from "@/components/kumo/text";
import { CostChip } from "@/components/cost-chip";
import { ListSkeleton } from "@/components/list-skeleton";
import { LimitsSection } from "@/components/limits-section";
import { ModelCatalogSection } from "@/components/model-catalog-card";
import {
	formatUsd,
	postureSpendReading,
	queryReading,
} from "@/lib/cost-reading";
import {
	billingOverviewQueryOptions,
	computePostureQueryOptions,
} from "@/lib/os-query-options";
import {
	type CreditUsage,
	availableCredits,
	creditPercent,
	creditsPaused,
	formatCredits,
} from "@/lib/billing-credits";
import { useOsFormattingPreferences, formatCount } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";
import { OS_COPY } from "@/shared/os-copy";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

type PostureTone = "ok" | "warn" | "bad" | "unknown";

type ComputeSummaryProps = {
	children: ReactNode;
	embedded?: boolean;
	spacious?: boolean;
};

const TONE_VARIANTS: Record<PostureTone, BadgeVariant> = {
	ok: "success",
	warn: "warning",
	bad: "destructive",
	unknown: "outline",
};

function ComputeSummary({
	children,
	embedded = false,
	spacious = false,
}: ComputeSummaryProps) {
	const className = `grid ${spacious ? "gap-2" : "gap-1.5"} px-4 py-3`;
	if (embedded) return <div className={className}>{children}</div>;
	return (
		<Surface tier="panel" className={className}>
			{children}
		</Surface>
	);
}

/**
 * Freshness tone. `never_ingested` is deliberately NOT neutral — it is the
 * exact shape a week-long ingestion blackout wore while every dashboard read
 * "clean", so it tones as bad and says so rather than looking quiet.
 */
export function freshnessTone(
	state: ComputePosture["freshness"]["state"],
): PostureTone {
	switch (state) {
		case "fresh":
			return "ok";
		case "ingestion_pending":
			return "warn";
		case "lagging":
			return "warn";
		case "dark":
		case "never_ingested":
			return "bad";
	}
}

export function freshnessLabel(
	state: ComputePosture["freshness"]["state"],
): string {
	switch (state) {
		case "fresh":
			return "Ingestion fresh";
		case "ingestion_pending":
			return "Ingestion pending";
		case "lagging":
			return "Ingestion lagging";
		case "dark":
			return "Ingestion dark";
		case "never_ingested":
			return "No rows ingested";
	}
}

/**
 * Credential health tone. There is no `healthy` value to render: nothing stores
 * a passing probe, so the best available state is `evidenced_ok` — inferred
 * from rows actually arriving — and everything else is explicitly unattested.
 */
export function credentialTone(
	status: ComputePosture["credentialHealth"]["status"],
): PostureTone {
	switch (status) {
		case "firing":
			return "bad";
		case "evidenced_ok":
			return "ok";
		case "unattested":
			return "unknown";
	}
}

export function credentialLabel(
	status: ComputePosture["credentialHealth"]["status"],
): string {
	switch (status) {
		case "firing":
			return "Gateway credential drift";
		case "evidenced_ok":
			return "Credentials evidenced by ingestion";
		case "unattested":
			return "Credential health unattested";
	}
}

/**
 * The full provenance legend, including labels that earned nothing.
 *
 * Every label in the vocabulary appears, because the interesting fact about
 * `provider_reported` is precisely that it is empty and structurally cannot be
 * anything else here. A legend that silently omitted it would leave the reader
 * believing the numbers above might be provider-reported.
 */
export function provenanceLegend(buckets: ComputePosture["provenance"]): Array<{
	provenance: CostProvenance;
	bucket: ComputePosture["provenance"][number] | null;
	producible: boolean;
}> {
	const byLabel = new Map(
		buckets.map((bucket) => [bucket.provenance, bucket] as const),
	);
	return CostProvenanceSchema.options.map((provenance) => ({
		provenance,
		bucket: byLabel.get(provenance) ?? null,
		producible: COST_PROVENANCE_PRODUCED_TODAY[provenance],
	}));
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

export function LedgerCard({
	posture,
	embedded = false,
}: {
	posture: ComputePosture;
	embedded?: boolean;
}) {
	useOsFormattingPreferences();
	const tone = freshnessTone(posture.freshness.state);
	return (
		<ComputeSummary embedded={embedded}>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body" weight="medium" tone="strong">
					Model-cost ledger
				</Text>
				<Badge variant={TONE_VARIANTS[tone]} data-tone={tone}>
					{freshnessLabel(posture.freshness.state)}
				</Badge>
				<CostChip
					reading={postureSpendReading(posture)}
					subject={`Model spend recorded in the last ${posture.window}`}
				/>
			</div>
			<Text as="span" role="label" tone="secondary">
				{posture.freshness.detail}
			</Text>
			{posture.freshness.lastRowAt !== null && (
				<Text as="span" role="label" tone="secondary">
					Newest row{" "}
					<time
						dateTime={posture.freshness.lastRowAt}
						title={absoluteTime(posture.freshness.lastRowAt)}
					>
						{relativeTime(posture.freshness.lastRowAt)}
					</time>{" "}
					· {formatCount(posture.freshness.rowsLast24h)} in 24h ·{" "}
					{formatCount(posture.freshness.rowsLast30d)} in 30d
				</Text>
			)}
			<Text as="span" role="label" tone="secondary">
				Organization-attributed model costs · excludes total infrastructure
				spend. {formatCount(posture.spend.pricedRowCount)} priced rows ·{" "}
				{formatCount(posture.spend.unpricedRowCount)} unpriced rows.
			</Text>
			{posture.spend.quarantinedRowCount > 0 && (
				<Text as="span" role="label" tone="secondary">
					{formatCount(posture.spend.quarantinedRowCount)} row
					{posture.spend.quarantinedRowCount === 1 ? " is" : "s are"} held
					outside the model-spend amount above.{" "}
					{posture.spend.quarantinedCostUsd !== null
						? `Recorded held amount ${formatUsd(posture.spend.quarantinedCostUsd)}.`
						: `Held total unknown; known subtotal ${formatUsd(posture.spend.quarantinedKnownSubtotalUsd)}.`}
				</Text>
			)}
		</ComputeSummary>
	);
}

/** Unknown held amounts remain distinct from explicitly recorded zero. */
export function bucketAmountLabel(bucket: {
	provenance: CostProvenance;
	costUsd: number | null;
}): string {
	return bucket.costUsd !== null ? formatUsd(bucket.costUsd) : "amount unknown";
}

export function ProvenanceCard({
	posture,
	embedded = false,
}: {
	posture: ComputePosture;
	embedded?: boolean;
}) {
	useOsFormattingPreferences();
	const legend = provenanceLegend(posture.provenance);
	const details = (
		<ul className="m-0 grid gap-2 p-0">
			{legend.map((entry) => (
				<li key={entry.provenance} className="grid gap-0.5 list-none">
					<div className="flex flex-wrap items-center gap-2">
						<Text as="span" role="label" weight="medium" tone="strong">
							{entry.provenance.replaceAll("_", " ")}
						</Text>
						{entry.bucket === null ? (
							<Badge
								variant="outline"
								data-cost-provenance={entry.provenance}
								data-produced={entry.producible ? "possible" : "never"}
							>
								{entry.producible
									? "no rows in this window"
									: "never produced here"}
							</Badge>
						) : (
							<Badge
								variant="secondary"
								data-cost-provenance={entry.provenance}
								data-produced="yes"
							>
								<span className="tabular-nums">
									{bucketAmountLabel(entry.bucket)} ·{" "}
									{formatCount(entry.bucket.rowCount)} calls
								</span>
							</Badge>
						)}
					</div>
					<Text as="span" role="label" tone="secondary">
						{COST_PROVENANCE_DETAIL[entry.provenance]}
					</Text>
					<Text
						as="span"
						className="opacity-70"
						role="caption"
						tone="secondary"
					>
						Read from {COST_PROVENANCE_SOURCE[entry.provenance]}
					</Text>
				</li>
			))}
		</ul>
	);
	return (
		<ComputeSummary embedded={embedded} spacious>
			<Collapsible>
				<CollapsibleTrigger className="w-full justify-between px-0 text-kumo-default">
					<Text as="span" role="label" weight="medium" tone="strong">
						Where these numbers come from
					</Text>
					<Badge variant="outline">{legend.length} sources</Badge>
				</CollapsibleTrigger>
				<CollapsibleContent keepMounted className="pt-3">
					{details}
				</CollapsibleContent>
			</Collapsible>
		</ComputeSummary>
	);
}

/**
 * Credits this month for the organization, from `billing.getOverview`. The
 * same numbers as Billing; every limit is monthly.
 */
export function CreditsCard({
	credits,
	embedded = false,
}: {
	credits: CreditUsage;
	embedded?: boolean;
}) {
	useOsFormattingPreferences();
	const paused = creditsPaused(credits);
	const percent = creditPercent(credits.usedCredits, credits.includedCredits);
	return (
		<ComputeSummary embedded={embedded}>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body" weight="medium" tone="strong">
					Credits this month
				</Text>
				<Badge
					variant={paused ? "destructive" : "info"}
					data-tone={paused ? "bad" : "ok"}
				>
					{paused
						? "Out of credits"
						: `${formatCredits(availableCredits(credits))} left`}
				</Badge>
			</div>
			{paused && (
				<Text role="label" tone="error" className="m-0">
					New work that uses credits has stopped until the credits renew.
				</Text>
			)}
			<Text as="span" role="label" tone="secondary">
				{formatCredits(credits.usedCredits)} used of{" "}
				{formatCredits(credits.includedCredits)} included · {percent}% ·{" "}
				{formatCredits(credits.topUpCredits)} top-up credits
			</Text>
			<Meter label="Included credits used" value={percent} />
			<Text as="span" role="label" tone="secondary">
				AI {formatCredits(credits.breakdown.ai)} · Code runs{" "}
				{formatCredits(credits.breakdown.codeRuns)} · Services{" "}
				{formatCredits(credits.breakdown.services)}
			</Text>
			<Text as="span" className="opacity-70" role="caption" tone="secondary">
				Caps, credit packs, and pay-as-you-go are managed in{" "}
				<Link href="/admin/billing">Billing</Link>.
			</Text>
		</ComputeSummary>
	);
}

function CreditsUnavailable({ refused }: { refused: boolean }) {
	return (
		<ComputeSummary embedded>
			<Text as="strong" role="body" weight="medium" tone="strong">
				Credits this month
			</Text>
			<Text as="span" role="label" tone="secondary">
				{refused
					? "Credits are shown to people who can view billing."
					: "Credits could not be read. They are unknown, not zero."}
			</Text>
		</ComputeSummary>
	);
}

export function RoutingCard({
	posture,
	embedded = false,
}: {
	posture: ComputePosture;
	embedded?: boolean;
}) {
	return (
		<ComputeSummary embedded={embedded}>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body" weight="medium" tone="strong">
					Routing
				</Text>
				<Badge
					variant={posture.routing.modelRef ? "info" : "outline"}
					title={posture.routing.modelRef ?? undefined}
				>
					{posture.routing.modelRef ? "Auto" : "No model selected"}
				</Badge>
				<Badge variant="secondary">
					{posture.routing.allowedCount} allowed
				</Badge>
				{posture.routing.deniedCount > 0 && (
					<Badge variant="outline">{posture.routing.deniedCount} denied</Badge>
				)}
			</div>
			<Text as="span" role="label" tone="secondary">
				{posture.routing.detail}
			</Text>
			<Text as="span" role="label" tone="secondary">
				{posture.routing.observedProviders.length > 0
					? `Served in this window by ${posture.routing.observedProviders.join(" · ")}`
					: "No provider served a call in this window."}
			</Text>
			{posture.routing.fallbackDetail !== null && (
				<Text
					role="label"
					tone="warning"
					className="m-0"
					data-testid="routing-fallback"
				>
					{posture.routing.fallbackDetail}
				</Text>
			)}
		</ComputeSummary>
	);
}

export function HealthCard({
	posture,
	embedded = false,
}: {
	posture: ComputePosture;
	embedded?: boolean;
}) {
	useOsFormattingPreferences();
	const tone = credentialTone(posture.credentialHealth.status);
	return (
		<ComputeSummary embedded={embedded}>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body" weight="medium" tone="strong">
					Credentials and policy
				</Text>
				<Badge
					variant={TONE_VARIANTS[tone]}
					data-tone={tone}
					data-credential-status={posture.credentialHealth.status}
				>
					{credentialLabel(posture.credentialHealth.status)}
				</Badge>
				<Badge variant="outline" data-provider-health="unknown">
					Provider health unknown
				</Badge>
			</div>
			<Text as="span" role="label" tone="secondary">
				{posture.credentialHealth.detail}
			</Text>
			<Text as="span" role="label" tone="secondary">
				{posture.providerHealth.detail}
			</Text>
			<Text as="span" role="label" tone="secondary">
				{posture.admissionPolicy.detail}
			</Text>
		</ComputeSummary>
	);
}

export function AttributionCard({
	posture,
	embedded = false,
}: {
	posture: ComputePosture;
	embedded?: boolean;
}) {
	useOsFormattingPreferences();
	const gap = posture.attribution;
	return (
		<ComputeSummary embedded={embedded}>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body" weight="medium" tone="strong">
					Unattributed cost
				</Text>
				<Badge
					variant={gap.unattributedRowCount > 0 ? "warning" : "outline"}
					data-unattributed-rows={gap.unattributedRowCount}
				>
					{gap.unattributedRowCount === 0
						? "None in scope"
						: `${formatUsd(gap.unattributedCostUsd)} across ${formatCount(gap.unattributedRowCount)} calls`}
				</Badge>
			</div>
			<Text as="span" role="label" tone="secondary">
				{gap.detail}
			</Text>
		</ComputeSummary>
	);
}

// ---------------------------------------------------------------------------
// Query container
// ---------------------------------------------------------------------------

/**
 * Compute and Models — the OS's answer to "what is this costing, and can I
 * trust the number".
 *
 * One read of `osCompute.posture`, whose every field is already labeled by the
 * API. This container adds no arithmetic: it renders the labels, and it keeps
 * pending, refused, broken and empty as four distinct branches, because
 * collapsing them lets a dead ingestion pipeline render as a clean $0.
 */
export function ComputePage() {
	const [window, setWindow] = useState<ComputePosture["window"]>("7d");
	const posture = useQuery({
		...computePostureQueryOptions(window),
		staleTime: 60_000,
	});
	const nonData = queryReading(posture);
	const overview = useQuery({
		...billingOverviewQueryOptions(),
		staleTime: 60_000,
	});
	const credits = overview.data?.credits;
	const creditsReading = queryReading(overview);

	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>{OS_COPY.navigation.usage}</PageTitle>
					<PageDescription>
						Credits used this month, recorded model costs, and model routing.
						For your plan, caps, credit packs, and invoices, open{" "}
						<Link href="/admin/billing">Billing</Link>.
					</PageDescription>
				</PageHeading>
				<PageActions>
					<SegmentedControl
						ariaLabel="Cost window"
						value={window}
						onValueChange={setWindow}
						options={USAGE_PERIOD_OPTIONS}
						compact
					/>
				</PageActions>
			</PageHeader>

			<PageSection>
				<BillingSectionHeader
					title="Credits and cost"
					description="Credits used this month, recorded spend, ingestion freshness, and source basis."
				/>
				{posture.isPending && <ListSkeleton rows={3} rowClassName="h-24" />}
				{nonData?.kind === "refused" && (
					<Alert>
						<AlertTitle>Cost is not visible to this account</AlertTitle>
						<AlertDescription>
							Reading compute posture needs the OS read verb on this workspace.
							Nothing here is zero — the read was refused, not empty.
						</AlertDescription>
					</Alert>
				)}
				{nonData?.kind === "broken" && (
					<LoadError
						title="The compute posture is unavailable"
						error={nonData.message}
						help="Spending and budget information are unknown until this loads."
					/>
				)}
				{posture.data && (
					<Collection
						aria-label="Cost and budget status"
						className="[&>li]:min-w-0"
					>
						<li>
							<LedgerCard posture={posture.data} embedded />
						</li>
						<li>
							{credits ? (
								<CreditsCard credits={credits} embedded />
							) : overview.isPending ? (
								<ListSkeleton rows={1} rowClassName="h-16" />
							) : (
								<CreditsUnavailable
									refused={creditsReading?.kind === "refused"}
								/>
							)}
						</li>
						<li>
							<ProvenanceCard posture={posture.data} embedded />
						</li>
						<li>
							<AttributionCard posture={posture.data} embedded />
						</li>
					</Collection>
				)}
			</PageSection>

			<Collapsible className="space-y-4">
				<CollapsibleDefaultTrigger>
					Advanced usage diagnostics
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent keepMounted>
					<div className="space-y-6">
						{credits && <LimitsSection credits={credits} />}

						<PageSection>
							<BillingSectionHeader
								title="Routing and models"
								description="Selected model, allowed catalog, observed providers, and fallback."
							/>
							<Collection
								aria-label="Routing and model status"
								className="[&>li]:min-w-0"
							>
								{posture.data && (
									<li>
										<RoutingCard posture={posture.data} embedded />
									</li>
								)}
								<li>
									<ModelCatalogSection embedded />
								</li>
							</Collection>
						</PageSection>

						<PageSection>
							<BillingSectionHeader
								title="Admission health"
								description="Credential evidence, provider visibility, and the admission policy."
							/>
							{posture.data && (
								<Collection
									aria-label="Admission health status"
									className="[&>li]:min-w-0"
								>
									<li>
										<HealthCard posture={posture.data} embedded />
									</li>
								</Collection>
							)}
						</PageSection>
					</div>
				</CollapsibleDefaultContent>
			</Collapsible>
		</Page>
	);
}
