import { useQuery } from "@tanstack/react-query";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { ActivityRunningNow } from "./activity-running-now";
import { Card, CardContent, CardHeader, CardTitle } from "./kumo/card";
import { Link } from "./kumo/link";
import { Text } from "./kumo/text";
import { WorkListSkeleton, WorkReadFailure } from "./work-surface-primitives";
import {
	isOpenRequestForYou,
	isPendingRuntimeApproval,
} from "./work-needs-you-count";
import { osQuery, pendingApprovalsQueryOptions } from "@/lib/os-query-options";
import { isDecidableWorkApproval } from "@/lib/work-counts";
import { officeAsk } from "@/lib/work-interaction-display";
import { workRefreshOptions } from "@/lib/work-refresh";
import { absoluteDate } from "@/lib/time";
import { workHomeMattersThrough } from "@/lib/work-home-overview";
import { useState, type ReactNode } from "react";

const ORGANIZATION_ACTIVITY_CONFIG = ActivityFeedConfigSchema.parse({
	version: 1,
	scope: "organization",
	projects: [],
});

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Card aria-label={title} className="min-w-0">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent className="grid min-w-0 gap-3">{children}</CardContent>
		</Card>
	);
}

function Rows({ children, label }: { children: ReactNode; label: string }) {
	return (
		<ul aria-label={label} className="grid min-w-0 gap-3">
			{children}
		</ul>
	);
}

function Row({
	href,
	label,
	detail,
}: {
	href: string;
	label: string;
	detail: ReactNode;
}) {
	return (
		<li className="grid min-w-0 gap-1 border-t border-kumo-line pt-3">
			<Link variant="record" href={href}>
				{label}
			</Link>
			<Text tone="secondary">{detail}</Text>
		</li>
	);
}

/** Each section stays a glance; its link opens the full list. */
const SECTION_ROWS = 5;

const recoveryReason: Record<string, string> = {
	dependencies_blocked: "A dependency is not finished",
	latest_attempt_failed: "The latest Attempt failed",
	latest_attempt_expired: "The latest Attempt expired",
	attempt_lease_elapsed: "The running Attempt stopped reporting",
};

export function WorkHomeOverview() {
	const [now] = useState(() => new Date());
	const mattersThrough = workHomeMattersThrough(now);
	const readiness = useQuery({
		...osQuery.workItems.listReadinessProjection.queryOptions({
			input: { limit: 50 },
		}),
		...workRefreshOptions,
	});
	const recovery = useQuery({
		...osQuery.workItems.listRecoveryProjection.queryOptions({
			input: { limit: 100 },
		}),
		...workRefreshOptions,
	});
	const interactions = useQuery({
		...osQuery.workInteractions.listInbox.queryOptions({
			input: { limit: 50, states: ["open"] },
		}),
		...workRefreshOptions,
	});
	const workApprovals = useQuery({
		...osQuery.workApprovals.listInbox.queryOptions({
			input: { limit: 50, statuses: ["pending"] },
		}),
		...workRefreshOptions,
	});
	const runtimeApprovals = useQuery({
		...pendingApprovalsQueryOptions(),
		...workRefreshOptions,
	});
	const matters = useQuery({
		...osQuery.workItems.list.queryOptions({
			input: {
				disposition: "accepted",
				mattersThrough,
				limit: 50,
			},
		}),
		...workRefreshOptions,
	});

	const stuck = new Map<
		string,
		{ id: string; title: string; reason: string }
	>();
	for (const row of readiness.data?.data ?? []) {
		if (row.readiness.ready || row.readiness.state === "already_running")
			continue;
		stuck.set(row.workItem.id, {
			id: row.workItem.id,
			title: row.workItem.title,
			reason:
				row.readiness.reasons[0]?.detail ??
				"Readiness could not be established",
		});
	}
	for (const row of recovery.data?.data ?? []) {
		if (stuck.has(row.id)) continue;
		stuck.set(row.id, {
			id: row.id,
			title: row.title,
			reason: row.signals.map((signal) => recoveryReason[signal]).join(" · "),
		});
	}
	const needsYou = [
		...(runtimeApprovals.data?.data ?? [])
			.filter(isPendingRuntimeApproval)
			.map((row) => ({
				key: `runtime-approval:${row.id}`,
				kind: "Approval",
				label: row.description,
				href: "/work/approvals",
				askedBy: "A tedi",
			})),
		...(workApprovals.data?.data ?? [])
			.filter(isDecidableWorkApproval)
			.map((row) => ({
				key: `work-approval:${row.proposal.id}`,
				kind: "Approval",
				label: row.workItem.title,
				href: `/work/items/${encodeURIComponent(row.workItem.id)}`,
				askedBy: "Tedix",
			})),
		...(interactions.data?.data ?? [])
			.filter(isOpenRequestForYou)
			.map((row) => ({
				key: `request:${row.request.id}`,
				kind: "Request",
				label: officeAsk(row.request),
				href: `/work/interactions/${encodeURIComponent(row.request.id)}`,
				askedBy: row.askedBy,
			})),
	];
	const stuckFailed = readiness.isError || recovery.isError;
	const needsFailed =
		interactions.isError || workApprovals.isError || runtimeApprovals.isError;

	return (
		<section
			aria-label="Work overview"
			className="mx-auto grid w-full max-w-6xl gap-4 pb-6"
		>
			<ActivityRunningNow config={ORGANIZATION_ACTIVITY_CONFIG} />
			<div className="grid gap-4 lg:grid-cols-3">
				<Section title="Stuck">
					<Text tone="secondary">Accepted Work that cannot start yet.</Text>
					{stuckFailed && (
						<WorkReadFailure
							title="Stuck Work unavailable"
							error={readiness.error ?? recovery.error}
						/>
					)}
					{stuck.size ? (
						<Rows label="Stuck Work">
							{[...stuck.values()].slice(0, SECTION_ROWS).map((row) => (
								<Row
									key={row.id}
									href={`/work/items/${encodeURIComponent(row.id)}`}
									label={row.title}
									detail={row.reason}
								/>
							))}
						</Rows>
					) : readiness.isPending || recovery.isPending ? (
						<WorkListSkeleton label="Checking stuck Work" />
					) : (
						<Text tone="secondary">No accepted Work is currently stuck.</Text>
					)}
					{(stuck.size > SECTION_ROWS ||
						readiness.data?.hasMore ||
						recovery.data?.hasMore) && (
						<Link href="/work?view=feed&filter=stalled">More stuck Work</Link>
					)}
				</Section>

				<Section title="Needs you">
					<Text tone="secondary">
						Open Requests and approvals waiting for you.
					</Text>
					{needsFailed && (
						<WorkReadFailure
							title="Requests and approvals unavailable"
							error={
								interactions.error ??
								workApprovals.error ??
								runtimeApprovals.error
							}
						/>
					)}
					{needsYou.length ? (
						<Rows label="Requests and approvals">
							{needsYou.slice(0, SECTION_ROWS).map((item) => (
								<Row
									key={item.key}
									href={item.href}
									label={item.label}
									detail={`${item.kind}${item.askedBy ? ` · ${item.askedBy}` : ""}`}
								/>
							))}
						</Rows>
					) : interactions.isPending ||
					  workApprovals.isPending ||
					  runtimeApprovals.isPending ? (
						<WorkListSkeleton label="Checking Requests and approvals" />
					) : (
						<Text tone="secondary">No open Requests or approvals.</Text>
					)}
					{(needsYou.length > SECTION_ROWS ||
						interactions.data?.hasMore ||
						workApprovals.data?.hasMore) && (
						<Link href="/work?view=deck">All Decisions</Link>
					)}
				</Section>

				<Section title="This week">
					<Text tone="secondary">
						Accepted Work due within seven days, or marked high or critical
						priority.
					</Text>
					{matters.isError && (
						<WorkReadFailure
							title="This week's Work unavailable"
							error={matters.error}
						/>
					)}
					{matters.data?.data.length ? (
						<Rows label="This week's Work">
							{matters.data.data.slice(0, SECTION_ROWS).map((row) => {
								const dueAt = row.deadline ?? row.dueDate;
								const reason = [
									row.priority === "critical"
										? "Critical priority"
										: row.priority === "high"
											? "High priority"
											: null,
									dueAt ? `Due ${absoluteDate(dueAt)}` : null,
								]
									.filter(Boolean)
									.join(" · ");
								return (
									<Row
										key={row.id}
										href={`/work/items/${encodeURIComponent(row.id)}`}
										label={row.title}
										detail={reason}
									/>
								);
							})}
						</Rows>
					) : matters.isPending ? (
						<WorkListSkeleton label="Checking this week's Work" />
					) : (
						<Text tone="secondary">
							Nothing is due within seven days or marked high or critical
							priority.
						</Text>
					)}
					{((matters.data?.data.length ?? 0) > SECTION_ROWS ||
						matters.data?.pagination.hasMore) && (
						<Link href="/work?view=items&status=accepted">
							All accepted Work
						</Link>
					)}
				</Section>
			</div>
		</section>
	);
}
