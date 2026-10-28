import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription, LoadError } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Text } from "@/components/kumo/text";
import { osQuery } from "@/lib/os-query-options";
import { outputSample } from "@/lib/run-timeline";
import { readableField, readableStepResult } from "@/lib/run-step-content";

export function RunStepResult({
	value,
	depth = 0,
}: {
	value: unknown;
	depth?: number;
}) {
	const result = readableStepResult(value);
	if (result == null)
		return (
			<Text as="p" tone="secondary">
				Not recorded
			</Text>
		);
	if (typeof result !== "object" || depth >= 4)
		return (
			<Text as="p" className="m-0 whitespace-pre-wrap wrap-anywhere">
				{outputSample(result)}
			</Text>
		);
	if (Array.isArray(result))
		return (
			<div className="grid gap-3">
				{result.slice(0, 50).map((item, index) => (
					<Collapsible key={index}>
						<CollapsibleTrigger>Item {index + 1}</CollapsibleTrigger>
						<CollapsibleContent>
							<RunStepResult value={item} depth={depth + 1} />
						</CollapsibleContent>
					</Collapsible>
				))}
				{result.length > 50 && (
					<Text as="p" tone="secondary">
						Showing the first 50 items. The technical record contains the full
						saved result.
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
							<RunStepResult value={entry} depth={depth + 1} />
						</dd>
					</div>
				))}
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
						The saved request, replies and tool messages. This opens history
						only; it does not send a message.
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
