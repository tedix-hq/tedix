import { TediRecoveryDiagnostic } from "./tedi-recovery-diagnostic";
import { useQuery } from "@tanstack/react-query";
import {
	Link,
	Outlet,
	useParams,
	useRouterState,
} from "@tanstack/react-router";
import type { TediType } from "@tedix/api-contract/schemas/tedi";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	Page,
	PageBack,
	PageDescription,
	PageHeader,
	PageHeading,
	PageMeta,
	PageTitle,
} from "@/components/kumo/page";
import { Tabs, TabsList, TabsTrigger } from "@/components/kumo/tabs";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	type EntrustmentEffectiveStatus,
	entrustmentSummary,
	roleHint,
	TeamChip,
	TediAvatar,
	tediStatusLabel,
	tediStatusTone,
} from "@/components/team-page";
import { formatCount, sentenceCase } from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";
import { isLocalSession } from "@/lib/local-inference";
import {
	tediDetailQueryOptions,
	tediOperationsSummariesQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Structural subset of `TediOperationsSummary` the header reads — the full
 * contract row assigns to it, and tests can build small fixtures.
 */
export interface TediHeaderSummary {
	delegationProfile: {
		activeRole: { roleName: string; careerStage: string } | null;
		entrustments: readonly { effectiveStatus: EntrustmentEffectiveStatus }[];
	};
	pulse: { decisionsLast24h: number; factsLearnedLast24h: number };
}

/**
 * Roster identity for the detail header.
 *
 * The operations summary is the source of the role hint and the entrustment
 * count because it already embeds the full delegation profile — the deep
 * per-tedi reads below re-fetch nothing the header needed.
 */
export function TediDetailHeader({
	tedi,
	summary,
}: {
	tedi: TediType;
	summary?: TediHeaderSummary;
}) {
	const activeRole = summary?.delegationProfile.activeRole ?? null;
	const hint = roleHint(tedi, activeRole);
	const entrustments = summary
		? entrustmentSummary(summary.delegationProfile.entrustments)
		: null;
	const seenAt = tedi.lastActivityAt ?? tedi.lastSeenAt;
	const pulse = summary?.pulse;
	const localRuntimeUnavailable = isLocalSession();
	return (
		<PageHeader>
			<div className="flex min-w-0 items-start gap-3">
				<TediAvatar tedi={tedi} />
				<PageHeading>
					<PageTitle>{tedi.displayName ?? tedi.name}</PageTitle>
					<PageDescription>
						{tedi.slug}
						{hint ? ` · ${hint}` : ""}
					</PageDescription>
					<PageMeta className="gap-x-5">
						<li>
							<TeamChip
								tone={
									localRuntimeUnavailable
										? "neutral"
										: tediStatusTone(tedi.status)
								}
							>
								{localRuntimeUnavailable
									? "Configured"
									: sentenceCase(tediStatusLabel(tedi.status))}
							</TeamChip>
						</li>
						<li>
							Runtime{" "}
							<strong>
								{localRuntimeUnavailable
									? "local execution unavailable"
									: tedi.runtimeStatus && tedi.runtimeStatus !== "unknown"
										? sentenceCase(tedi.runtimeStatus)
										: "no signal"}
							</strong>
						</li>
						{!localRuntimeUnavailable && seenAt && (
							<li>
								Active{" "}
								<strong>
									<time dateTime={seenAt} title={absoluteTime(seenAt)}>
										{relativeTime(seenAt)}
									</time>
								</strong>
							</li>
						)}
						{/* Only claim authority when the summary actually resolved. An
						    absent summary is not the same as no entrustments: the roster
						    read may still be in flight, or this tedi may be EXCLUDED from
						    the operations summaries (archived/paused/errored/
						    provisioning). Asserting "observe-only" there contradicts the
						    entrustment list rendered below it from the canonical
						    profile. */}
						{summary && (
							<li>
								Authority{" "}
								<strong>
									{entrustments ?? "observe-only — no entrustments"}
								</strong>
							</li>
						)}
						{pulse && (
							<li>
								Last 24h{" "}
								<strong>
									{formatCount(pulse.decisionsLast24h)}{" "}
									{pulse.decisionsLast24h === 1 ? "decision" : "decisions"} ·{" "}
									{formatCount(pulse.factsLearnedLast24h)}{" "}
									{pulse.factsLearnedLast24h === 1 ? "fact" : "facts"}
								</strong>
							</li>
						)}
					</PageMeta>
				</PageHeading>
			</div>
		</PageHeader>
	);
}

// ---------------------------------------------------------------------------
// Route component
// ---------------------------------------------------------------------------

/**
 * Exact-id identity header and navigation shell for lazy tedi-scoped sibling
 * routes. Each child owns its canonical reads and governed actions.
 */
const DETAIL_NAV = [
	{ path: "/team/$tediId", value: "overview", label: "Overview" },
	{ path: "/team/$tediId/authority", value: "authority", label: "Authority" },
	{
		path: "/team/$tediId/telemetry",
		value: "telemetry",
		label: "Tool telemetry",
	},
	{ path: "/team/$tediId/learning", value: "learning", label: "Learning" },
	{ path: "/team/$tediId/memory", value: "memory", label: "Memory" },
	{ path: "/team/$tediId/mailbox", value: "mailbox", label: "Mailbox" },
	{ path: "/team/$tediId/settings", value: "settings", label: "Settings" },
] as const;

export function TediDetailPage() {
	const { tediId } = useParams({
		from: "/_session/_tenant/team_/$tediId",
	});
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const activeTab =
		DETAIL_NAV.find(
			(item) =>
				item.value !== "overview" &&
				pathname.startsWith(item.path.replace("$tediId", tediId)),
		)?.value ?? "overview";

	// A detail route reads its exact id. It must not disappear merely because the
	// tedi is beyond the roster page's bounded first slice.
	const tediQuery = useQuery(tediDetailQueryOptions(tediId));
	const summaries = useQuery({
		...tediOperationsSummariesQueryOptions(),
		staleTime: 60_000,
	});

	const tedi = tediQuery.data;
	const summary = summaries.data?.data.find((row) => row.tediId === tediId);

	return (
		<Page width="lg">
			<PageBack render={<Link to="/team" />}>Team</PageBack>

			{tediQuery.isPending && <ListSkeleton rows={1} rowClassName="h-20" />}
			{tediQuery.isError && (
				<Alert variant="destructive">
					<AlertTitle>The tedi roster is unavailable</AlertTitle>
					<AlertDescription>{errorMessage(tediQuery.error)}</AlertDescription>
				</Alert>
			)}
			{tedi && <TediDetailHeader tedi={tedi} summary={summary} />}

			<Tabs value={activeTab}>
				<TabsList aria-label="Tedi detail sections" variant="line">
					{DETAIL_NAV.map((item) => (
						<TabsTrigger
							key={item.value}
							nativeButton={false}
							value={item.value}
							render={
								<Link to={item.path} params={{ tediId }} preload="intent" />
							}
						>
							{item.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>

			<Outlet />
		</Page>
	);
}

export function TediOverview({ tediId }: { tediId: string }) {
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<Alert>
				<AlertTitle>Operational identity</AlertTitle>
				<AlertDescription>
					The header is the canonical roster and runtime summary for this
					digital worker. Use the focused sections for authority, telemetry,
					learning, memory, mailbox, and governed settings.
				</AlertDescription>
			</Alert>
			<Alert>
				<AlertTitle>Canonical tedi id</AlertTitle>
				<AlertDescription className="break-all font-mono">
					{tediId}
				</AlertDescription>
			</Alert>
			<TediRecoveryDiagnostic tediId={tediId} />
		</div>
	);
}
