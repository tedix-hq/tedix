import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import * as z from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Text } from "@/components/kumo/text";
import { gadgetExecutionsQueryOptions } from "@/lib/os-query-options";

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

export function AppCallLogs({
	workspaceId,
	gadgetId,
	callId,
}: {
	workspaceId: string;
	gadgetId: string;
	callId: string;
}) {
	const [live, setLive] = useState(true);
	const [level, setLevel] = useState("all");
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
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>Console logs</CardTitle>
				<div className="flex flex-wrap gap-1" aria-label="Log controls">
					<Button
						size="xs"
						variant="outline"
						aria-pressed={live}
						onClick={() => setLive(!live)}
					>
						{live ? "Pause live logs" : "Resume live logs"}
					</Button>
					{["all", "debug", "log", "info", "warn", "error"].map((value) => (
						<Button
							key={value}
							size="xs"
							variant={level === value ? "secondary" : "ghost"}
							aria-pressed={level === value}
							onClick={() => setLevel(value)}
						>
							{value === "all" ? "All levels" : value}
						</Button>
					))}
				</div>
			</CardHeader>
			<CardContent className="grid gap-2">
				<Text role="label" tone="secondary">
					Call {callId} · {live ? "Live" : "Paused"}
				</Text>
				{traces.isError && (
					<Alert variant="destructive">
						<AlertTitle>Console logs are unavailable</AlertTitle>
						<AlertDescription>{traces.error.message}</AlertDescription>
					</Alert>
				)}
				{clipped && (
					<Text role="label" tone="secondary">
						Some console lines were truncated by the runtime.
					</Text>
				)}
				{traces.data?.truncated && (
					<Text role="label" tone="secondary">
						Showing the latest 200 trace receipts.
					</Text>
				)}
				<div
					ref={pane}
					role="log"
					aria-label={`Console logs for call ${callId}`}
					aria-live={live ? "polite" : "off"}
					className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs"
				>
					{lines.map((line) => (
						<div key={line.key}>
							<span className="text-kumo-subtle">
								{line.timestamp == null
									? ""
									: new Date(line.timestamp).toISOString()}{" "}
								[{line.level}]{" "}
							</span>
							{line.message}
						</div>
					))}
				</div>
				{!traces.isError && lines.length === 0 && (
					<Text role="label" tone="secondary">
						{traces.isPending
							? "Loading console logs…"
							: level === "all"
								? "Waiting for console lines…"
								: "No console lines at this level."}
					</Text>
				)}
			</CardContent>
		</Card>
	);
}
