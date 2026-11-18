import { useEffect, useRef } from "react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Text } from "@/components/kumo/text";
import type { ChatQueuedMessage } from "@/lib/workspace-chat-state";

function Bubble({ message }: { message: ChatQueuedMessage }) {
	return (
		<div className="max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg bg-kumo-fill px-4 py-2.5">
			<ChatMarkdown content={message.text} preserveLineBreaks />
		</div>
	);
}

/**
 * Messages sent while the agent was working that it has not read yet. They
 * are dimmed until it picks them up at its next step.
 */
export function QueuedMessages({
	messages,
}: {
	messages: readonly ChatQueuedMessage[];
}) {
	if (messages.length === 0) return null;
	return (
		<ul aria-label="Messages not read yet" className="workspace-chat-queued">
			{messages.map((message) => (
				<li data-testid="workspace-chat-queued-message" key={message.messageId}>
					<div className="workspace-chat-queued-text">
						<Bubble message={message} />
					</div>
					<Text as="span" role="caption" tone="secondary">
						Not read yet
					</Text>
				</li>
			))}
		</ul>
	);
}

/** Messages the agent read while it worked on a turn, under the turn's first one. */
export function AddedMessages({
	messages,
}: {
	messages: readonly ChatQueuedMessage[] | undefined;
}) {
	if (!messages?.length) return null;
	return (
		<>
			{messages.map((message) => (
				<div
					className="workspace-chat-user"
					data-testid="workspace-chat-added-message"
					key={message.messageId}
				>
					<Bubble message={message} />
				</div>
			))}
		</>
	);
}

/**
 * Stop hands back the messages the agent had not read. The tab that sent
 * one, or pressed Stop on its turn, gets them through `restore`, once each.
 * Messages handed back earlier, or in another tab, stay out of the composer.
 */
export function useReturnedMessages(
	returned: readonly ChatQueuedMessage[],
	restore: (messages: ChatQueuedMessage[]) => void,
): { sent(messageId: string): void; stopped(turnId: string): void } {
	const sent = useRef(new Set<string>());
	const stopped = useRef(new Set<string>());
	const handled = useRef(new Set<string>());
	const latestRestore = useRef(restore);
	latestRestore.current = restore;
	useEffect(() => {
		const fresh = returned.filter(
			(message) => !handled.current.has(message.messageId),
		);
		for (const message of fresh) handled.current.add(message.messageId);
		const mine = fresh.filter(
			(message) =>
				sent.current.has(message.messageId) ||
				stopped.current.has(message.turnId),
		);
		if (mine.length) latestRestore.current(mine);
	}, [returned]);
	return useRef({
		sent: (messageId: string) => void sent.current.add(messageId),
		stopped: (turnId: string) => void stopped.current.add(turnId),
	}).current;
}
