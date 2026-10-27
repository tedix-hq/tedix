import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import * as z from "zod";
import { LoadError } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { gadgetExecutionsQueryOptions } from "@/lib/os-query-options";
import { cn } from "@/lib/utils";

const traceSchema = z.object({
	callId: z.string(),
	events: z.array(
		z.object({
			timestamp: z.number().nullable().optional(),
			truncated: z.boolean().optional(),
			sequence: z.number().optional(),
			live: z.boolean().optional(),
			logs: z
				.array(
					z.object({
						level: z.string(),
						message: z.string(),
						timestamp: z.number().optional(),
					}),
				)
				.default([]),
			exceptions: z
				.array(z.object({ name: z.string(), message: z.string() }))
				.default([]),
		}),
	),
});

const LEVELS = ["all", "debug", "log", "info", "warn", "error"] as const;
const LEVEL_LABELS: Record<(typeof LEVELS)[number], string> = {
	all: "All levels",
	debug: "Debug",
	log: "Log",
	info: "Info",
	warn: "Warnings",
	error: "Errors",
};

function clockTime(timestamp: number | null | undefined): string {
	if (timestamp == null) return "";
	return new Date(timestamp).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** The console lines one app run wrote, streamed while its details are open. */
export function AppCallLogs({
	workspaceId,
	gadgetId,
	callId,
	finished = false,
}: {
	workspaceId: string;
	gadgetId: string;
	callId: string;
	/** The run has settled, so an empty pane means it wrote nothing. */
	finished?: boolean;
}) {
	const [live, setLive] = useState(true);
	const [level, setLevel] = useState<(typeof LEVELS)[number]>("all");
	const pane = useRef<HTMLDivElement>(null);
	const traces = useQuery({
		...gadgetExecutionsQueryOptions(workspaceId, gadgetId, 200, { callId }),
		refetchInterval: live ? 2_500 : false,
		enabled: live,
	});
	const finalized = traces.data?.items.some((receipt) => {
		const parsed = traceSchema.safeParse(receipt.output);
		return (
			parsed.success &&
			parsed.data.callId === callId &&
			parsed.data.events.some((event) => !event.live)
		);
	});
	const lines = (traces.data?.items ?? [])
		.slice()
		.reverse()
		.flatMap((receipt) => {
			const parsed = traceSchema.safeParse(receipt.output);
			if (!parsed.success || parsed.data.callId !== callId) return [];
			return parsed.data.events
				.filter((event) => !finalized || !event.live)
				.flatMap((event, eventIndex) => [
					...event.logs.map((log, index) => ({
						...log,
						sequence: event.sequence ?? 0,
						timestamp: log.timestamp ?? event.timestamp,
						key: `${receipt.id}:${eventIndex}:log:${index}`,
					})),
					...event.exceptions.map((exception, index) => ({
						level: "error",
						sequence: event.sequence ?? 0,
						message: `${exception.name}: ${exception.message}`,
						timestamp: event.timestamp,
						key: `${receipt.id}:${eventIndex}:exception:${index}`,
					})),
				]);
		})
		.filter((line) => level === "all" || line.level === level)
		.sort(
			(a, b) =>
				(a.timestamp ?? 0) - (b.timestamp ?? 0) || a.sequence - b.sequence,
		);
	const lastLine = lines.at(-1)?.key;
	const clipped = traces.data?.items.some((receipt) => {
		const parsed = traceSchema.safeParse(receipt.output);
		return (
			parsed.success && parsed.data.events.some((event) => event.truncated)
		);
	});
	useEffect(() => {
		if (live && pane.current)
			pane.current.scrollTop = pane.current.scrollHeight;
	}, [live, lastLine, level]);
	const emptyMessage = traces.isPending
		? "Loading logs…"
		: level !== "all"
			? "No lines at this level."
			: !live
				? "Paused. Resume to see new lines."
				: finished
					? "This run wrote no logs."
					: "Waiting for output…";
	return (
		<section className="grid min-w-0 gap-2" aria-label="Logs">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<Text as="h4" role="label" weight="medium">
					Logs
				</Text>
				<Button
					size="xs"
					variant="ghost"
					aria-pressed={live}
					aria-label={live ? "Pause live logs" : "Resume live logs"}
					onClick={() => setLive(!live)}
				>
					<span
						aria-hidden
						className={cn(
							"size-1.5 rounded-full",
							live
								? "bg-kumo-success motion-safe:animate-pulse"
								: "bg-kumo-line",
						)}
					/>
					{live ? "Live" : "Paused"}
				</Button>
				<Select
					items={LEVELS.map((value) => ({ value, label: LEVEL_LABELS[value] }))}
					value={level}
					onValueChange={(value) => {
						if (value) setLevel(value as (typeof LEVELS)[number]);
					}}
				>
					<SelectTrigger
						aria-label="Log level"
						className="ml-auto h-7 min-w-28 type-tedix-caption"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{LEVELS.map((value) => (
							<SelectItem key={value} value={value}>
								{LEVEL_LABELS[value]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{traces.isError && (
				<LoadError
					title="Logs are unavailable"
					error={traces.error}
					onRetry={() => {
						void traces.refetch();
					}}
					retrying={traces.isFetching}
				/>
			)}
			<Surface
				ref={pane}
				role="log"
				aria-label="Logs for this run"
				aria-live={live ? "polite" : "off"}
				className="max-h-72 min-h-14 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs"
			>
				{lines.map((line) => (
					<div key={line.key}>
						<span className="text-kumo-subtle">
							{clockTime(line.timestamp)}{" "}
						</span>
						<span
							className={
								line.level === "error"
									? "text-kumo-danger"
									: line.level === "warn"
										? "text-kumo-warning"
										: "text-kumo-subtle"
							}
						>
							{line.level}{" "}
						</span>
						{line.message}
					</div>
				))}
				{!traces.isError && lines.length === 0 && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="font-sans"
					>
						{emptyMessage}
					</Text>
				)}
			</Surface>
			{(clipped || traces.data?.truncated) && (
				<Text role="caption" tone="secondary">
					{clipped
						? "Some lines were cut short by the runtime."
						: "Showing the latest lines only."}
				</Text>
			)}
		</section>
	);
}
