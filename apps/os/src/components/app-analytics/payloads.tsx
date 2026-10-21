import { useQuery } from "@tanstack/react-query";
import type { ToolCallPayload } from "@tedix/api-contract/schemas/analytics";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { CodeBlock } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { toolCallPayloadsQueryOptions } from "@/lib/os-query-options";
import { formatBytes, formatDuration, prettyJson } from "./format";

// =============================================================================
// Tool Call Payload Drill-Down
// =============================================================================

export function ToolCallPayloadRow({
	executionId,
	toolName,
	success,
	durationMs,
}: {
	executionId: string;
	toolName: string;
	success: boolean;
	durationMs: number;
}) {
	const [isExpanded, setIsExpanded] = useState(false);

	const { data, isPending, isError } = useQuery({
		...toolCallPayloadsQueryOptions(executionId, toolName),
		staleTime: 300_000,
		enabled: isExpanded,
	});

	const payloads = data?.payloads ?? [];

	return (
		<Collapsible
			className="space-y-1"
			onOpenChange={setIsExpanded}
			open={isExpanded}
		>
			<CollapsibleTrigger className="flex w-full min-w-0 items-center gap-3 text-left">
				{isExpanded ? (
					<CaretDown
						size={12}
						aria-hidden
						className="shrink-0 text-kumo-subtle"
					/>
				) : (
					<CaretRight
						size={12}
						aria-hidden
						className="shrink-0 text-kumo-subtle"
					/>
				)}
				<Text
					as="span"
					role="control"
					tone="mono"
					className="min-w-0 flex-1 truncate"
				>
					{toolName}
				</Text>
				<span
					className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
						success ? "bg-kumo-success" : "bg-kumo-danger"
					}`}
				/>
				<Text
					as="span"
					role="control"
					tone="secondary"
					className="shrink-0 tabular-nums"
				>
					{formatDuration(durationMs)}
				</Text>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="space-y-2 pl-6">
					{isPending && <Skeleton className="h-16" />}
					{isError && (
						<Alert variant="destructive">
							<AlertDescription>
								Payload details could not be loaded.
							</AlertDescription>
						</Alert>
					)}
					{!isPending && data && data.configured === false && (
						<Text as="p" role="label" tone="secondary" className="m-0">
							Payload capture is not enabled for this environment.
						</Text>
					)}
					{!isPending && data?.configured && payloads.length === 0 && (
						<Text as="p" role="label" tone="secondary" className="m-0">
							No payload captured for this call.
						</Text>
					)}
					{!isPending &&
						data?.configured &&
						payloads.map((payload, index) => (
							<ToolCallPayloadDetail
								key={`${payload.traceId}:${payload.toolName}:${payload.timestamp}:${index}`}
								payload={payload}
							/>
						))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function ToolCallPayloadDetail({ payload }: { payload: ToolCallPayload }) {
	const [showInput, setShowInput] = useState(false);
	const [showOutput, setShowOutput] = useState(false);

	return (
		<Surface className="space-y-1.5 px-3 py-2">
			<div className="flex flex-wrap items-center gap-2 text-tedix-caption">
				{payload.truncated ? (
					<Badge variant="secondary">Truncated</Badge>
				) : null}
				{payload.errorCode ? (
					<Badge variant="destructive">{payload.errorCode}</Badge>
				) : null}
				<Text
					as="span"
					role="caption"
					tone="secondary"
					className="tabular-nums"
				>
					in {formatBytes(payload.inputBytes)}
				</Text>
				<Text
					as="span"
					role="caption"
					tone="secondary"
					className="tabular-nums"
				>
					out {formatBytes(payload.outputBytes)}
				</Text>
			</div>
			<PayloadBlock
				label="Input"
				body={payload.inputArgs}
				isOpen={showInput}
				onToggle={() => setShowInput((value) => !value)}
			/>
			<PayloadBlock
				label="Output"
				body={payload.outputBody}
				isOpen={showOutput}
				onToggle={() => setShowOutput((value) => !value)}
			/>
		</Surface>
	);
}

function PayloadBlock({
	label,
	body,
	isOpen,
	onToggle,
}: {
	label: string;
	body: string;
	isOpen: boolean;
	onToggle: () => void;
}) {
	return (
		<Collapsible className="space-y-1" onOpenChange={onToggle} open={isOpen}>
			<CollapsibleTrigger className="px-0">
				{isOpen ? (
					<CaretDown size={12} aria-hidden />
				) : (
					<CaretRight size={12} aria-hidden />
				)}
				<Text as="span" role="control" weight="medium">
					{label}
				</Text>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<CodeBlock
					className="max-h-64 overflow-auto"
					code={prettyJson(body)}
					lang="json"
				/>
			</CollapsibleContent>
		</Collapsible>
	);
}
