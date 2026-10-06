import { GraduationCap } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { GrowthSnapshot } from "@tedix/api-contract/contracts/growth-snapshots";
import type { ExpertiseLevel } from "@tedix/api-contract/schemas/memory-graph";
import { useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { formatCount, sentenceCase } from "@/lib/format";
import { errorMessage, isAuthorizationError } from "@/lib/orpc-error";
import {
	latestGrowthSnapshotQueryOptions,
	tediExpertiseQueryOptions,
} from "@/lib/os-query-options";
import { absoluteDate, absoluteTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** One expertise row, already resolved to something nameable. */
export interface ExpertiseRow {
	id: string;
	domainId: string;
	domainName: string;
	factCount: number;
	avgConfidence: number;
	competenceScore: number;
	expertiseLevel: ExpertiseLevel;
	lastActivityAt: string | null;
}

/** The shape the expertise read returns, narrowed to what this surface uses. */
export interface ExpertiseInput {
	id: string;
	domainId: string;
	domainName?: string | null;
	factCount: number;
	avgConfidence: number;
	competenceScore: number;
	expertiseLevel: ExpertiseLevel;
	lastActivityAt?: string | null;
}

/**
 * Rank domains by weighted competence, strongest first.
 *
 * `domainName` is nullable in the contract; an unnamed domain is labeled by
 * its id rather than dropped, because a hidden domain is a hidden competence
 * claim. Ties break on domain id so the ordering is total and stable.
 */
export function expertiseRows(
	expertise: readonly ExpertiseInput[],
): ExpertiseRow[] {
	return expertise
		.map((entry) => ({
			id: entry.id,
			domainId: entry.domainId,
			domainName: entry.domainName ?? `domain ${entry.domainId.slice(0, 8)}`,
			factCount: entry.factCount,
			avgConfidence: entry.avgConfidence,
			competenceScore: entry.competenceScore,
			expertiseLevel: entry.expertiseLevel,
			lastActivityAt: entry.lastActivityAt ?? null,
		}))
		.sort(
			(a, b) =>
				b.competenceScore - a.competenceScore ||
				b.factCount - a.factCount ||
				a.domainId.localeCompare(b.domainId),
		);
}

export const EXPERTISE_LEVEL_VARIANTS: Record<ExpertiseLevel, BadgeVariant> = {
	novice: "outline",
	familiar: "secondary",
	proficient: "info",
	expert: "success",
};

export interface GrowthMetricRow {
	id: string;
	label: string;
	value: string;
}

/**
 * The weekly cognitive snapshot, projected into labeled stats.
 *
 * `autonomyRate` is a RATE (0..1) while everything else is a count or an
 * average — rendering them in one undifferentiated grid is how a 0.64 gets
 * read as "64 things". Each row therefore formats in its own dialect.
 */
export function growthMetricRows(snapshot: GrowthSnapshot): GrowthMetricRow[] {
	const metrics = snapshot.metrics;
	return [
		{ id: "facts", label: "Facts", value: formatCount(metrics.facts) },
		{
			id: "avg-confidence",
			label: "Avg confidence",
			value: `${Math.round(metrics.avgConfidence * 100)}%`,
		},
		{ id: "domains", label: "Domains", value: formatCount(metrics.domains) },
		{ id: "skills", label: "Skills", value: formatCount(metrics.skills) },
		{
			id: "avg-revision",
			label: "Avg skill revision",
			value: metrics.avgRevision.toFixed(1),
		},
		{
			id: "muscles",
			label: "Muscle memories",
			value: formatCount(metrics.muscles),
		},
		{
			id: "avg-usage",
			label: "Avg muscle usage",
			value: metrics.avgUsage.toFixed(1),
		},
		{
			id: "autonomy-rate",
			label: "Autonomy rate",
			value: `${Math.round(metrics.autonomyRate * 100)}%`,
		},
	];
}

/**
 * Whether the weekly snapshot still describes the live expertise read.
 *
 * The snapshot is a photo taken on `snapshotDate`; expertise is read live. A
 * surface that stacks the two without saying which is which invites the
 * operator to read a stale count as current, so the drift is stated instead.
 */
export function snapshotDrift(
	snapshot: GrowthSnapshot | null | undefined,
	liveDomainCount: number,
): { drifted: boolean; snapshotDomains: number } | null {
	if (!snapshot) return null;
	return {
		drifted: snapshot.metrics.domains !== liveDomainCount,
		snapshotDomains: snapshot.metrics.domains,
	};
}

// ---------------------------------------------------------------------------
// Presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

export function ExpertiseDomainRow({ row }: { row: ExpertiseRow }) {
	const filled = Math.max(
		0,
		Math.min(100, Math.round(row.competenceScore * 100)),
	);
	return (
		<li
			data-domain={row.domainId}
			className="grid min-w-0 gap-1 rounded-lg px-3 py-2"
		>
			<span className="flex min-w-0 flex-wrap items-center gap-1.5">
				<Badge
					variant={EXPERTISE_LEVEL_VARIANTS[row.expertiseLevel]}
					data-level={row.expertiseLevel}
				>
					{sentenceCase(row.expertiseLevel)}
				</Badge>
				<Text
					as="strong"
					role="body"
					tone="strong"
					weight="medium"
					className="min-w-0 truncate"
				>
					{row.domainName}
				</Text>
			</span>
			<span
				aria-hidden
				className="h-1.5 overflow-hidden rounded-full bg-kumo-fill"
			>
				<span
					data-filled={filled}
					className={cn(
						"block h-full rounded-full",
						row.expertiseLevel === "expert"
							? "bg-kumo-success"
							: "bg-kumo-info",
					)}
					style={{ width: `${filled}%` }}
				/>
			</span>
			<Text as="span" role="label" tone="secondary" className="tabular-nums">
				competence {Math.round(row.competenceScore * 100)}% ·{" "}
				{formatCount(row.factCount)} {row.factCount === 1 ? "fact" : "facts"} ·{" "}
				{Math.round(row.avgConfidence * 100)}% avg confidence
				{row.lastActivityAt ? (
					<>
						{" · active "}
						<time
							dateTime={row.lastActivityAt}
							title={absoluteTime(row.lastActivityAt)}
						>
							{relativeTime(row.lastActivityAt)}
						</time>
					</>
				) : null}
			</Text>
		</li>
	);
}

export function ExpertiseEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<GraduationCap size={20} />
				</EmptyMedia>
				<EmptyTitle>No domain expertise yet</EmptyTitle>
				<EmptyDescription>
					Expertise is derived from the facts a tedi has learned and actually
					used. Domains appear here as memory accumulates — not from a title or
					a role assignment.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function GrowthSnapshotPanel({
	snapshot,
}: {
	snapshot: GrowthSnapshot;
}) {
	return (
		<MetricGrid
			appearance="bounded"
			aria-label="Learning growth summary"
			columns={4}
		>
			{growthMetricRows(snapshot).map((row) => (
				<MetricItem
					key={row.id}
					data-metric={row.id}
					label={row.label}
					value={row.value}
				/>
			))}
		</MetricGrid>
	);
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

/**
 * What this tedi has actually learned: live per-domain expertise plus the most
 * recent weekly cognitive snapshot.
 *
 * The two reads are deliberately NOT blended into one number set — expertise
 * is current and the snapshot is dated, so each carries its own provenance.
 */
export function LearningEvidence({ tediId }: { tediId: string }) {
	const expertise = useQuery({
		...tediExpertiseQueryOptions(tediId),
		staleTime: 60_000,
	});

	const snapshot = useQuery({
		...latestGrowthSnapshotQueryOptions(tediId),
		staleTime: 60_000,
	});

	const rows = useMemo(
		() => expertiseRows(expertise.data?.expertise ?? []),
		[expertise.data],
	);
	// Drift compares a LIVE count against a dated one, so it may only be stated
	// when the live read actually succeeded. Otherwise `rows` is [] for want of
	// data and the surface prints "live expertise now covers 0 domains"
	// directly beneath "expertise is not readable" — a measurement invented
	// from a read that never happened.
	const drift = expertise.isSuccess
		? snapshotDrift(snapshot.data, rows.length)
		: null;
	const expertiseRefused = isAuthorizationError(expertise.error);
	const snapshotRefused = isAuthorizationError(snapshot.error);

	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Learning evidence</SectionTitle>
					<SectionDescription>
						Observed expertise and the latest dated cognitive snapshot.
					</SectionDescription>
				</SectionHeading>
				{/* Absent, not zero, until the read lands: a confident 0 beside a
				pending or refused read is a claim the surface cannot support. */}
				{expertise.isSuccess ? (
					<Badge variant="secondary">{rows.length}</Badge>
				) : null}
			</SectionHeader>

			{expertise.isPending && <ListSkeleton rows={2} />}
			{expertise.isError && (
				<Alert variant={expertiseRefused ? "warning" : "destructive"}>
					<AlertTitle>
						{expertiseRefused
							? "Expertise is not readable with your access"
							: "Expertise is unavailable"}
					</AlertTitle>
					<AlertDescription>
						{expertiseRefused
							? "The expertise read was refused for this principal. No competence is inferred from a refused read."
							: errorMessage(expertise.error)}
					</AlertDescription>
				</Alert>
			)}
			{expertise.data &&
				(rows.length === 0 ? (
					<ExpertiseEmpty />
				) : (
					<ul className="m-0 grid list-none gap-0.5 p-0">
						{rows.map((row) => (
							<ExpertiseDomainRow key={row.id} row={row} />
						))}
					</ul>
				))}

			<div className="grid min-w-0 gap-1.5">
				<Text as="span" role="label" tone="secondary">
					Latest weekly cognitive snapshot
				</Text>
				{snapshot.isPending && <ListSkeleton rows={1} rowClassName="h-20" />}
				{snapshot.isError && (
					<p className="m-0 text-kumo-subtle text-xs" role="alert">
						{snapshotRefused
							? "The growth-snapshot read was refused for this principal, so no weekly metrics are shown."
							: `Growth snapshots are unavailable: ${errorMessage(snapshot.error)}`}
					</p>
				)}
				{snapshot.isSuccess && snapshot.data === null && (
					<Text role="body" tone="secondary" className="m-0">
						No growth snapshot has been recorded for this tedi yet — the weekly
						snapshot cron writes the first one after a full cycle.
					</Text>
				)}
				{snapshot.data && (
					<>
						<GrowthSnapshotPanel snapshot={snapshot.data} />
						<Text role="label" tone="secondary" className="m-0">
							Snapshot taken {absoluteDate(snapshot.data.snapshotDate)}. It is a
							dated photo, not a live read.
							{drift?.drifted
								? ` Live expertise now covers ${formatCount(rows.length)} ${
										rows.length === 1 ? "domain" : "domains"
									} against ${formatCount(drift.snapshotDomains)} in the snapshot.`
								: ""}
						</Text>
					</>
				)}
			</div>
		</PageSection>
	);
}
