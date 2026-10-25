import { ClockCounterClockwise } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ActivityItem } from "@tedix/api-contract/schemas/analytics";
import type { ApprovalRequest } from "@tedix/api-contract/contracts/tedi-approvals";
import { useState } from "react";
import { Badge } from "@/components/kumo/badge";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { appLabel, plainApprovalTitle } from "@/lib/approval-titles";
import {
	approvalHistoryQueryOptions,
	recentToolActivityQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

export type HistoryFilter = "all" | "approvals" | "actions" | "automatic";

type Tone = "success" | "secondary" | "error" | "warning" | "outline";

export type HistoryEntry = {
	key: string;
	filter: Exclude<HistoryFilter, "all">;
	status: { label: string; tone: Tone };
	title: string;
	/** Who asked or acted, in words. */
	who: string | null;
	/** The app the action touched. */
	where: string | null;
	/** How it was decided, when that is not obvious from the status. */
	how: string | null;
	at: string;
	href: { label: string; to: string } | null;
};

const HISTORY_FILTERS: readonly { value: HistoryFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "approvals", label: "Approvals" },
	{ value: "actions", label: "Actions" },
	{ value: "automatic", label: "Automatic" },
];

/** Resolved without a person: the org's autonomy policy or a saved rule. */
export function isAutomaticApproval(
	approval: Pick<ApprovalRequest, "status" | "resolvedBy" | "resolution">,
): boolean {
	return (
		approval.status === "approved" &&
		(approval.resolvedBy === "policy" ||
			/^auto-approved by rule\b/i.test(approval.resolution ?? ""))
	);
}

const APPROVAL_STATUS: Record<
	Exclude<ApprovalRequest["status"], "pending">,
	{ label: string; tone: Tone }
> = {
	approved: { label: "Approved", tone: "success" },
	rejected: { label: "Rejected", tone: "error" },
	expired: { label: "Expired", tone: "warning" },
	cancelled: { label: "Cancelled", tone: "secondary" },
};

function payloadString(
	payload: Record<string, unknown>,
	key: string,
): string | null {
	const value = payload[key];
	return typeof value === "string" && value.trim() ? value : null;
}

/** Decided, expired and cancelled requests as History rows (pending stays in Needs review). */
export function approvalHistoryEntries(
	approvals: readonly ApprovalRequest[],
	tediNames: Record<string, string>,
): HistoryEntry[] {
	return approvals.flatMap((approval): HistoryEntry[] => {
		if (approval.status === "pending") return [];
		const automatic = isAutomaticApproval(approval);
		const payload = approval.payload as Record<string, unknown>;
		const conversationId = payloadString(payload, "conversationId");
		const how = automatic
			? /^auto-approved by rule\b/i.test(approval.resolution ?? "")
				? "A saved rule approved it"
				: "Low risk, approved by your policy"
			: approval.status === "expired"
				? "No one answered in time, so it did not run"
				: approval.status === "approved" || approval.status === "rejected"
					? /^decide for me\b/i.test(approval.resolution ?? "")
						? "Decided by the suggestion a person accepted"
						: "Decided by a person"
					: null;
		return [
			{
				key: `approval:${approval.id}`,
				filter: automatic ? "automatic" : "approvals",
				status: automatic
					? { label: "Auto-approved", tone: "outline" }
					: APPROVAL_STATUS[approval.status],
				title: plainApprovalTitle(
					approval.review.summary || approval.description,
					payload,
				),
				who: tediNames[approval.tediId] ?? null,
				where: appLabel(payloadString(payload, "appSlug")),
				how,
				at: approval.resolvedAt ?? approval.createdAt,
				href: conversationId
					? {
							label: "Open conversation",
							to: `/chat?conversation=${encodeURIComponent(conversationId)}`,
						}
					: null,
			},
		];
	});
}

/** Tool calls an agent or person made, from the audit log. */
export function actionHistoryEntries(
	items: readonly ActivityItem[],
): HistoryEntry[] {
	return items.map((item, index) => {
		const denied = item.securityDecision.disposition === "denied";
		const tool = item.tool?.title ?? item.tool?.label ?? item.toolName;
		return {
			key: `action:${item.traceId ?? item.executionId ?? index}:${item.timestamp}:${index}`,
			filter: "actions",
			status: denied
				? { label: "Blocked", tone: "warning" }
				: item.success
					? { label: "Done", tone: "secondary" }
					: { label: "Failed", tone: "error" },
			title: tool
				? plainApprovalTitle(tool, { appSlug: item.tool?.appSlug })
				: plainApprovalTitle(item.action),
			who: (item.agent ?? item.subject ?? item.actor).label || null,
			where: item.app?.label ?? item.tool?.appLabel ?? null,
			how: denied
				? (item.securityDecision.denialReason ?? "Stopped before it ran")
				: item.success
					? null
					: item.errorCode
						? `It failed (${item.errorCode})`
						: "It failed",
			at: item.timestamp,
			href: item.app?.id
				? { label: "Open app", to: `/apps/${item.app.id}/analytics` }
				: null,
		};
	});
}

export function filterHistory(
	entries: readonly HistoryEntry[],
	filter: HistoryFilter,
): HistoryEntry[] {
	return entries
		.filter((entry) => filter === "all" || entry.filter === filter)
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const EMPTY_COPY: Record<HistoryFilter, { title: string; body: string }> = {
	all: {
		title: "No activity yet",
		body: "Every decision and every action an agent takes is recorded here.",
	},
	approvals: {
		title: "No decisions yet",
		body: "Requests you or a teammate approved, rejected or let expire appear here.",
	},
	actions: {
		title: "No actions recorded",
		body: "Tool calls agents make in your apps appear here once they run.",
	},
	automatic: {
		title: "Nothing ran automatically",
		body: "Low-risk changes your policy or a saved rule approved appear here.",
	},
};

export function ActivityHistory({
	tediNames,
	only,
}: {
	tediNames: Record<string, string>;
	/** Show one kind of entry and no filter control. */
	only?: Exclude<HistoryFilter, "all">;
}) {
	const [chosen, setFilter] = useState<HistoryFilter>("all");
	const filter = only ?? chosen;
	const approvals = useQuery(approvalHistoryQueryOptions());
	// Tool activity needs analytics access; without it History still shows
	// every decision.
	const actions = useQuery({
		...recentToolActivityQueryOptions(),
		retry: false,
	});
	const entries = filterHistory(
		[
			...approvalHistoryEntries(approvals.data?.data ?? [], tediNames),
			...actionHistoryEntries(actions.data?.items ?? []),
		],
		filter,
	);
	const loading =
		approvals.isPending || (filter === "actions" && actions.isPending);
	const actionsHidden = actions.isError && filter !== "approvals";
	return (
		<div className="grid min-w-0">
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
				{only ? null : (
					<SegmentedControl
						ariaLabel="Show in history"
						className="sm:w-fit"
						compact
						fill
						onValueChange={setFilter}
						options={HISTORY_FILTERS}
						value={filter}
					/>
				)}
				<Text
					as="span"
					className="shrink-0 tabular-nums"
					role="label"
					tone="secondary"
				>
					{loading ? "Loading…" : `${entries.length} shown`}
				</Text>
			</div>
			{approvals.isError && actions.isError ? (
				<Text className="m-0 px-4 py-6" role="label" tone="error">
					History could not be loaded. Close the panel and try again.
				</Text>
			) : loading ? (
				<Text className="m-0 px-4 py-6" role="label" tone="secondary">
					Loading history…
				</Text>
			) : entries.length === 0 ? (
				<Empty
					appearance="inline"
					className="px-4! py-6!"
					description={EMPTY_COPY[filter].body}
					icon={
						<ClockCounterClockwise
							aria-hidden
							className="text-kumo-subtle"
							size={24}
						/>
					}
					title={EMPTY_COPY[filter].title}
				/>
			) : (
				<ol aria-label="Activity history" className="m-0 grid list-none p-0">
					{entries.map((entry) => (
						<HistoryRow entry={entry} key={entry.key} />
					))}
				</ol>
			)}
			{actionsHidden ? (
				<Text className="m-0 px-4 pb-3" role="label" tone="secondary">
					Tool actions are hidden: your role cannot read app activity.
				</Text>
			) : null}
		</div>
	);
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
	const title = sanitizeUntrustedText(entry.title);
	const context = [entry.who, entry.where && `in ${entry.where}`]
		.filter(Boolean)
		.join(" ");
	return (
		<li className="grid min-w-0 gap-1 border-b border-kumo-hairline px-4 py-2.5 last:border-b-0">
			<div className="flex min-w-0 items-start gap-2">
				<span className="line-clamp-2 min-w-0 flex-1 font-medium text-kumo-default type-tedix-control">
					{title}
				</span>
				<Badge className="shrink-0" variant={entry.status.tone}>
					{entry.status.label}
				</Badge>
			</div>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-kumo-subtle type-tedix-label">
				{context ? (
					<span className="min-w-0 break-words">
						{sanitizeUntrustedText(context)}
					</span>
				) : null}
				<time dateTime={entry.at} title={absoluteTime(entry.at)}>
					{relativeTime(entry.at)}
				</time>
				{entry.href ? (
					<Link className="ml-auto" href={entry.href.to}>
						{entry.href.label}
					</Link>
				) : null}
			</div>
			{entry.how ? (
				<Text as="p" className="m-0 break-words" role="label" tone="secondary">
					{sanitizeUntrustedText(entry.how)}
				</Text>
			) : null}
		</li>
	);
}
