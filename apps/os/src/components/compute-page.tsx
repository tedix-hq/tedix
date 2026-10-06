import type { ComputePosture } from "@tedix/api-contract/contracts/os-compute";
import {
	COST_PROVENANCE_DETAIL,
	COST_PROVENANCE_PRODUCED_TODAY,
	COST_PROVENANCE_SOURCE,
	type CostProvenance,
	CostProvenanceSchema,
} from "@tedix/api-contract/schemas/cost-provenance";
import { getOsSurface } from "@/lib/os-navigation";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
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
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	SegmentedControl,
	USAGE_PERIOD_OPTIONS,
} from "@/components/kumo/segmented-control";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { CostChip } from "@/components/cost-chip";
import { ListSkeleton } from "@/components/list-skeleton";
import { ModelCatalogSection } from "@/components/model-catalog-card";
import {
	formatUsd,
	postureSpendReading,
	queryReading,
} from "@/lib/cost-reading";
import { computePostureQueryOptions } from "@/lib/os-query-options";
import { formatCount } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The windows the posture read accepts. Mirrors `CostComputeWindowSchema`. */
export const COMPUTE_WINDOWS = ["24h", "7d", "30d"] as const;
export type ComputeWindow = (typeof COMPUTE_WINDOWS)[number];

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

/** Customer allowance and included balance are distinct from runtime admission. */
export function remainingTokensLabel(
	budget: Pick<
		ComputePosture["budget"],
		"configured" | "remainingIncludedTokens" | "unlimitedTokenUsage"
	>,
): string {
	if (!budget.configured || budget.unlimitedTokenUsage === null) {
		return "No budget known";
	}
	if (budget.unlimitedTokenUsage) return "Unlimited";
	if (budget.remainingIncludedTokens === null) return "No budget known";
	return `${formatCount(budget.remainingIncludedTokens)} included tokens left`;
}

/**
 * Consumed share of the included allowance. Null — not 0 — whenever the
 * denominator is absent or unlimited, so the meter renders as unknown rather
 * than as a full bar or an empty one.
 */
export function consumedShare(
	budget: Pick<
		ComputePosture["budget"],
		"includedTokens" | "usedTokens" | "configured" | "unlimitedTokenUsage"
	>,
): number | null {
	if (!budget.configured || budget.unlimitedTokenUsage !== false) return null;
	if (budget.includedTokens === null || budget.usedTokens === null) return null;
	if (budget.includedTokens <= 0) return null;
	return Math.min(1, budget.usedTokens / budget.includedTokens);
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
				{formatCount(posture.spend.unpricedRowCount)} unpriced rows ·{" "}
				{formatCount(posture.spend.unpricedTokens)} unpriced tokens.
			</Text>
			{posture.spend.quarantinedRowCount > 0 && (
				<Text as="span" role="label" tone="secondary">
					{formatCount(posture.spend.quarantinedRowCount)} row
					{posture.spend.quarantinedRowCount === 1 ? " is" : "s are"} held
					outside the model-spend amount above ·{" "}
					{formatCount(posture.spend.quarantinedTokens)} held tokens.{" "}
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
	totalTokens: number;
}): string {
	if (bucket.costUsd !== null) return formatUsd(bucket.costUsd);
	return bucket.totalTokens > 0
		? `${formatCount(bucket.totalTokens)} tokens · amount unknown`
		: "amount unknown";
}

export function ProvenanceCard({
	posture,
	embedded = false,
}: {
	posture: ComputePosture;
	embedded?: boolean;
}) {
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

export function BudgetCard({
	posture,
	embedded = false,
}: {
	posture: ComputePosture;
	embedded?: boolean;
}) {
	const share = consumedShare(posture.budget);
	const blocked = posture.budget.entitlementActive === false;
	return (
		<ComputeSummary embedded={embedded}>
			<div className="flex flex-wrap items-center gap-2">
				<Text as="strong" role="body" weight="medium" tone="strong">
					Budget
				</Text>
				<Badge
					variant={
						blocked
							? "destructive"
							: posture.budget.configured
								? "info"
								: "outline"
					}
					data-tone={
						blocked ? "bad" : posture.budget.configured ? "ok" : "unknown"
					}
				>
					{remainingTokensLabel(posture.budget)}
				</Badge>
			</div>
			{posture.budget.configured &&
				posture.budget.unlimitedTokenUsage === false &&
				posture.budget.allowOverage === true && (
					<Text role="label" tone="secondary" className="m-0">
						Your plan permits additional token usage. Other usage limits still
						apply.
					</Text>
				)}
			{blocked && (
				<Text role="label" tone="error" className="m-0">
					Runtime inference is not admitted for this workspace right now.
				</Text>
			)}
			<Text as="span" role="label" tone="secondary">
				{posture.budget.configured && posture.budget.usedTokens !== null ? (
					<>
						{formatCount(posture.budget.usedTokens)} tokens consumed
						{posture.budget.reservedTokens !== null &&
							posture.budget.reservedTokens > 0 && (
								<>
									{" "}
									· {formatCount(posture.budget.reservedTokens)} reserved in
									flight
								</>
							)}
						{share !== null && <> · {Math.round(share * 100)}% of allowance</>}
					</>
				) : (
					"Consumption is unknown, not zero."
				)}
			</Text>
			<Text as="span" role="label" tone="secondary">
				{posture.budget.detail}
			</Text>
			<Text as="span" className="opacity-70" role="caption" tone="secondary">
				Invoices, payment methods and reconciliation live in Admin Billing.
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
				<Badge variant={posture.routing.modelRef ? "info" : "outline"}>
					{posture.routing.modelRef ?? "No model selected"}
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
				D1 daily ceiling:{" "}
				{posture.admissionPolicy.desiredDailyTokenLimit === null &&
				posture.admissionPolicy.desiredDailySpendLimitMicros === null
					? "none configured"
					: [
							posture.admissionPolicy.desiredDailyTokenLimit !== null
								? `${formatCount(posture.admissionPolicy.desiredDailyTokenLimit)} tokens/day`
								: null,
							posture.admissionPolicy.desiredDailySpendLimitMicros !== null
								? `${formatUsd(posture.admissionPolicy.desiredDailySpendLimitMicros / 1_000_000)}/day`
								: null,
						]
							.filter((part): part is string => part !== null)
							.join(" · ")}
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
	const surface = getOsSurface("compute");
	const [window, setWindow] = useState<ComputeWindow>("7d");
	const posture = useQuery({
		...computePostureQueryOptions(window),
		staleTime: 60_000,
	});
	const nonData = queryReading(posture);

	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>{surface.description}</PageDescription>
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
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Cost and budget</SectionTitle>
						<SectionDescription>
							Recorded spend, ingestion freshness, capacity, and source basis.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
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
					<Alert variant="destructive">
						<AlertTitle>The compute posture is unavailable</AlertTitle>
						<AlertDescription>
							{nonData.message} — no spend, budget or ingestion state is known
							for this workspace right now. This is not zero spend.
						</AlertDescription>
					</Alert>
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
							<BudgetCard posture={posture.data} embedded />
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

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Routing and models</SectionTitle>
						<SectionDescription>
							Selected model, allowed catalog, observed providers, and fallback.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
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
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Admission health</SectionTitle>
						<SectionDescription>
							Credential evidence, provider visibility, and D1 policy ceilings.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
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
		</Page>
	);
}
