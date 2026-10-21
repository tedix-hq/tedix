import "./tedis.css";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { TediSetupChecklist } from "./tedi-setup";
import { TediRecoveryDiagnostic } from "./tedi-recovery-diagnostic";
import { useQuery } from "@tanstack/react-query";
import type { TediSetup } from "@tedix/api-contract/contracts/tedis";
import { Button } from "@/components/kumo/button";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import { renderTediWiring } from "@/lib/tedi-wiring";
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
import { KumoTabs } from "@/components/kumo/tabs";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	type EntrustmentEffectiveStatus,
	entrustmentSummary,
	roleHint,
	TediAvatar,
	tediStatusLabel,
	tediStatusTone,
} from "@/components/team-page";
import {
	useOsFormattingPreferences,
	formatCount,
	sentenceCase,
} from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";
import { isLocalSession } from "@/lib/local-inference";
import {
	tediDetailQueryOptions,
	tediOperationsSummariesQueryOptions,
	tediSetupQueryOptions,
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
	useOsFormattingPreferences();
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
					<PageTitle className="break-words">
						{tedi.displayName ?? tedi.name}
					</PageTitle>
					<PageDescription className="break-words">
						{hint ?? tedi.slug}
					</PageDescription>
					<PageMeta className="tedi-header-meta gap-x-2">
						<li>
							<span
								data-tone={
									localRuntimeUnavailable
										? "neutral"
										: tediStatusTone(tedi.status)
								}
							>
								{localRuntimeUnavailable
									? "Configured"
									: sentenceCase(tediStatusLabel(tedi.status))}
							</span>
						</li>
						<li>
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
								<strong>
									<time dateTime={seenAt} title={absoluteTime(seenAt)}>
										{relativeTime(seenAt)}
									</time>
								</strong>
							</li>
						)}
					</PageMeta>
					{summary && (
						<Collapsible>
							<CollapsibleTrigger className="-ml-2">
								Activity and authority
							</CollapsibleTrigger>
							<CollapsibleContent keepMounted className="p-1 -m-1">
								<PageMeta className="mt-0 gap-x-3">
									<li>
										Authority{" "}
										<strong>
											{entrustments ?? "observe-only — no entrustments"}
										</strong>
									</li>
									{pulse && (
										<li>
											Last 24h{" "}
											<strong>
												{formatCount(pulse.decisionsLast24h)}{" "}
												{pulse.decisionsLast24h === 1
													? "decision"
													: "decisions"}{" "}
												· {formatCount(pulse.factsLearnedLast24h)}{" "}
												{pulse.factsLearnedLast24h === 1 ? "fact" : "facts"}
											</strong>
										</li>
									)}
								</PageMeta>
							</CollapsibleContent>
						</Collapsible>
					)}
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
		<Page width="lg" className="tedis-page">
			<PageBack render={<Link to="/team" />}>Team</PageBack>

			{tediQuery.isPending && <ListSkeleton rows={1} rowClassName="h-20" />}
			{tediQuery.isError && (
				<Alert variant="destructive">
					<AlertTitle>The tedi roster is unavailable</AlertTitle>
					<AlertDescription>{errorMessage(tediQuery.error)}</AlertDescription>
				</Alert>
			)}
			<div className="grid min-w-0 gap-4">
				{tedi && <TediDetailHeader tedi={tedi} summary={summary} />}

				<KumoTabs
					aria-label="Tedi detail sections"
					variant="underline"
					value={activeTab}
					tabs={DETAIL_NAV.map((item) => ({
						value: item.value,
						label: item.label,
						nativeButton: false,
						render: (
							<Link to={item.path} params={{ tediId }} preload="intent" />
						),
					}))}
				/>
			</div>

			<Outlet />
		</Page>
	);
}

/** Readable "what is this tedi wired to" document, generated from its config. */
export function TediWiringView({
	tedi,
	setup,
}: {
	tedi: TediType;
	setup?: TediSetup;
}) {
	const wiring = renderTediWiring(tedi, setup);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(wiring.markdown);
			toast.success("Copied as Markdown");
		} catch {
			toast.warning("Copy it by hand; the clipboard is blocked");
		}
	};
	return (
		<PageSection id="wiring" className="md:col-span-2 scroll-mt-6">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Wiring</SectionTitle>
					<SectionDescription>
						What this tedi is connected to, written from its current
						configuration.
					</SectionDescription>
				</SectionHeading>
				<Button variant="outline" size="sm" onClick={() => void copy()}>
					Copy as Markdown
				</Button>
			</SectionHeader>
			<div className="grid gap-4 md:grid-cols-2">
				{wiring.sections.map((section) => (
					<div key={section.id} className="grid content-start gap-1">
						<Text role="body" weight="semibold">
							{section.title}
						</Text>
						<ul className="grid gap-0.5">
							{section.lines.map((line) => (
								<li key={line}>
									<Text role="label" tone="secondary">
										{line.replace(/^ {2}- /, "· ")}
									</Text>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>
		</PageSection>
	);
}

function TediWiringSection({ tediId }: { tediId: string }) {
	const tediQuery = useQuery(tediDetailQueryOptions(tediId));
	const setupQuery = useQuery(tediSetupQueryOptions(tediId));
	if (!tediQuery.data) return null;
	return <TediWiringView tedi={tediQuery.data} setup={setupQuery.data} />;
}

export function TediOverview({ tediId }: { tediId: string }) {
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<TediSetupChecklist tediId={tediId} />
			<TediWiringSection tediId={tediId} />
			<Collapsible className="md:col-span-2">
				<CollapsibleTrigger>Technical details</CollapsibleTrigger>
				<CollapsibleContent className="grid gap-4 p-1 -m-1">
					<Text role="label" tone="secondary" className="break-all">
						Tedi ID: {tediId}
					</Text>
					<TediRecoveryDiagnostic tediId={tediId} />
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
