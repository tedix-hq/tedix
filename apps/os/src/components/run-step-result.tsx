import { useQuery } from "@tanstack/react-query";
import { safeMarkdownHref } from "@tedix/chat-transport/markdown";
import { useState } from "react";
import { Alert, AlertDescription, LoadError } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { CodeBlock } from "@/components/kumo/code";
import { Link } from "@/components/kumo/link";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Text } from "@/components/kumo/text";
import { osQuery } from "@/lib/os-query-options";
import { outputSample } from "@/lib/run-timeline";
import {
	readableField,
	readableStepResult,
	stepRecord,
	stepTimestamp,
} from "@/lib/run-step-content";
import { absoluteTime } from "@/lib/time";

export function RunStepResult({
	value,
	depth = 0,
	field,
}: {
	value: unknown;
	depth?: number;
	field?: string;
}) {
	const result = readableStepResult(value);
	if (result == null)
		return (
			<Text as="p" tone="secondary">
				Not recorded
			</Text>
		);
	if (result === "")
		return (
			<Text as="p" tone="secondary">
				Empty text
			</Text>
		);
	const timestamp = stepTimestamp(result, field);
	if (timestamp)
		return <time dateTime={timestamp}>{absoluteTime(timestamp)}</time>;
	if (typeof result === "string") {
		const href = safeMarkdownHref(result);
		if (href)
			return (
				<Link
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					className="wrap-anywhere"
				>
					{result}
					<Link.ExternalIcon />
				</Link>
			);
		const fence = /^```([\w-]*)\n([\s\S]*?)\n```\s*$/.exec(result.trim());
		if (fence)
			return (
				<CodeBlock
					code={fence[2]!}
					lang={fence[1] || "text"}
					className="min-w-0 max-w-full"
				/>
			);
	}
	if (typeof result === "object" && depth >= 6)
		return (
			<CodeBlock
				code={outputSample(result) ?? ""}
				lang="json"
				className="min-w-0 max-w-full"
			/>
		);
	if (typeof result !== "object")
		return (
			<Text as="p" className="m-0 whitespace-pre-wrap wrap-anywhere">
				{typeof result === "boolean"
					? result
						? "Yes"
						: "No"
					: outputSample(result)}
			</Text>
		);
	if (Array.isArray(result))
		return (
			<div className="grid gap-3">
				{result.slice(0, 50).map((item, index) => (
					<Collapsible key={index} className="min-w-0">
						<CollapsibleDefaultTrigger className="w-full justify-between">
							<span className="min-w-0 wrap-anywhere">
								{typeof stepRecord(item).title === "string"
									? String(stepRecord(item).title)
									: `Item ${index + 1}`}
							</span>
						</CollapsibleDefaultTrigger>
						<CollapsibleDefaultContent>
							<RunStepResult value={item} depth={depth + 1} />
						</CollapsibleDefaultContent>
					</Collapsible>
				))}
				{result.length > 50 && (
					<Text as="p" tone="secondary">
						Showing the first 50 items. Technical details includes a sample of
						the original response.
					</Text>
				)}
			</div>
		);
	return (
		<dl className="m-0 grid min-w-0 gap-4">
			{Object.entries(result)
				.slice(0, 30)
				.map(([key, entry]) => (
					<div
						key={key}
						className="min-w-0 border-b border-kumo-line pb-3 last:border-0"
					>
						<Text as="dt" role="label" weight="medium">
							{readableField(key)}
						</Text>
						<dd className="m-0 mt-1">
							<RunStepResult value={entry} depth={depth + 1} field={key} />
						</dd>
					</div>
				))}
			{Object.keys(result).length > 30 && (
				<div>
					<Text as="dt" role="label">
						More fields
					</Text>
					<dd className="m-0">Showing the first 30 fields.</dd>
				</div>
			)}
		</dl>
	);
}

export function RunStepConversation({
	reference,
}: {
	reference: { tediId: string; conversationId: string };
}) {
	const [open, setOpen] = useState(false);
	const [cursor, setCursor] = useState<string | undefined>();
	const conversation = useQuery({
		...osQuery.cognitiveRuntime.readMessages.queryOptions({
			input: { ...reference, limit: 30, cursor },
		}),
		enabled: open,
	});
	return (
		<section className="grid gap-3">
			<Button
				variant="outline"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
			>
				{open ? "Hide conversation" : "Read saved conversation"}
			</Button>
			{open && (
				<>
					<Text as="p" tone="secondary">
						Conversation history · may include other turns
					</Text>
					{conversation.isPending && <Text as="p">Loading conversation…</Text>}
					{conversation.isError && (
						<LoadError
							title="Conversation unavailable"
							error={conversation.error}
							onRetry={() => conversation.refetch()}
							retrying={conversation.isFetching}
						/>
					)}
					{conversation.data?.messages.length === 0 && (
						<Alert>
							<AlertDescription>
								{cursor
									? "No earlier messages were found."
									: "No conversation messages were saved for this step. The step result above may still contain its reply."}
							</AlertDescription>
						</Alert>
					)}
					{conversation.data?.compaction && (
						<Alert>
							<AlertDescription>
								Some earlier messages were replaced by a saved summary.
							</AlertDescription>
						</Alert>
					)}
					{conversation.data?.messages.map((message) => (
						<article
							key={message.id}
							className="grid min-w-0 gap-3 rounded-lg border border-kumo-line p-4"
						>
							<Text as="h3" role="label" weight="medium">
								{message.role === "user"
									? "Request"
									: message.role === "assistant"
										? "Assistant reply"
										: "Saved tool activity"}
							</Text>
							<RunStepResult value={message.content} />
						</article>
					))}
					{conversation.data?.nextCursor && (
						<Button
							variant="ghost"
							onClick={() =>
								setCursor(conversation.data!.nextCursor ?? undefined)
							}
						>
							Earlier messages
						</Button>
					)}
				</>
			)}
		</section>
	);
}
