import { useQuery } from "@tanstack/react-query";
import type { ActivityItem } from "@tedix/api-contract/schemas/analytics";
import { Info, Users } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Collection } from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { traceActivityQueryOptions } from "@/lib/os-query-options";
import { PrincipalName } from "./activity-review";
import { coverageTitle, formatActivityTime, formatDuration } from "./format";

export const RECENT_ACTIVITY_PREVIEW_ROWS = 12;

export function RecentActivitySection({ items }: { items: ActivityItem[] }) {
	const [expanded, setExpanded] = useState(false);
	const activityId = useId();
	const visibleItems = expanded
		? items
		: items.slice(0, RECENT_ACTIVITY_PREVIEW_ROWS);
	const remaining = items.length - RECENT_ACTIVITY_PREVIEW_ROWS;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Users size={16} aria-hidden />
					Recent Activity
					<Badge variant="outline" className="ml-1 font-normal">
						who · audit
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="px-0">
				<Collection
					id={activityId}
					appearance="inline"
					aria-label="Recent audit activity"
				>
					{visibleItems.map((item, index) => (
						<li
							key={`${item.timestamp}-${item.actorId}-${item.toolName ?? item.action}-${index}`}
						>
							<ActivityRow item={item} />
						</li>
					))}
				</Collection>
				{remaining > 0 ? (
					<div className="flex justify-center border-kumo-line border-t p-2">
						<Button
							aria-controls={activityId}
							aria-expanded={expanded}
							onClick={() => setExpanded((value) => !value)}
							size="sm"
							variant="ghost"
						>
							{expanded
								? `Show latest ${RECENT_ACTIVITY_PREVIEW_ROWS} only`
								: `Show ${remaining} more ${remaining === 1 ? "event" : "events"}`}
						</Button>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

function ActivityRow({ item }: { item: ActivityItem }) {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs">
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="shrink-0 tabular-nums"
				>
					{formatActivityTime(item.timestamp)}
				</Text>
				<Badge
					variant={item.success ? "success" : "destructive"}
					className="shrink-0"
				>
					{item.success ? "OK" : (item.errorCode ?? "Error")}
				</Badge>
				<span
					className="truncate"
					title={item.tool?.toolName ?? item.toolName ?? item.action}
				>
					{item.tool?.label ?? item.toolName ?? item.action}
				</span>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="ml-auto shrink-0"
					title={`${item.actorType}:${item.actorId}`}
				>
					<PrincipalName principal={item.subject ?? item.actor} muted />
				</Text>
				{item.agent && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="shrink-0"
						title={item.agent.id}
					>
						via {item.agent.label}
					</Text>
				)}
				{item.identityCoverage.warnings.length > 0 && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="shrink-0"
						title={coverageTitle(item.identityCoverage)}
					>
						<Info size={12} aria-hidden />
					</Text>
				)}
				{item.durationMs != null && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="shrink-0 tabular-nums"
					>
						{formatDuration(item.durationMs)}
					</Text>
				)}
				{item.traceId && (
					<CollapsibleTrigger className="shrink-0">
						{open ? "hide" : "trace"}
					</CollapsibleTrigger>
				)}
			</div>
			{item.traceId && (
				<CollapsibleContent>
					<TraceActivityPanel traceId={item.traceId} />
				</CollapsibleContent>
			)}
		</Collapsible>
	);
}

function TraceActivityPanel({ traceId }: { traceId: string }) {
	const { data, isPending, isError } = useQuery({
		...traceActivityQueryOptions(traceId),
		staleTime: 300_000,
	});

	if (isPending) {
		return (
			<div className="px-6 py-2">
				<Skeleton className="h-12" />
			</div>
		);
	}

	if (isError) {
		return (
			<Alert variant="destructive" className="mx-6 my-2 w-auto">
				<AlertDescription>Trace activity could not be loaded.</AlertDescription>
			</Alert>
		);
	}

	return (
		<div className="space-y-1 border-kumo-line border-l-2 bg-kumo-fill px-6 py-2 text-tedix-caption">
			<div className="text-kumo-subtle">
				<Text as="span" role="caption" tone="mono">
					trace {traceId}
				</Text>{" "}
				· {data.events.length} events ·{" "}
				{data.payloadsConfigured
					? `${data.payloads.length} payload(s)`
					: "payloads off"}
			</div>
			{data.events.map((event, index) => (
				<div
					key={`${event.timestamp}-${event.toolName ?? event.action}-${index}`}
					className="flex items-center gap-2"
				>
					<Badge variant={event.success ? "success" : "destructive"}>
						{event.success ? "OK" : (event.errorCode ?? "Err")}
					</Badge>
					<span
						className="truncate"
						title={event.tool?.toolName ?? event.toolName ?? event.action}
					>
						{event.tool?.label ?? event.toolName ?? event.action}
					</span>
					<Text
						as="span"
						role="caption"
						tone="secondary"
						title={`${event.actorType}:${event.actorId}`}
					>
						{event.actor.label}
					</Text>
					{event.durationMs != null && (
						<Text
							as="span"
							role="caption"
							tone="secondary"
							className="ml-auto tabular-nums"
						>
							{formatDuration(event.durationMs)}
						</Text>
					)}
				</div>
			))}
		</div>
	);
}
