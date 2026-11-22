import { useEffect, useRef } from "react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Text } from "@/components/kumo/text";
import type { ChatQueuedMessage } from "@/lib/workspace-chat-state";
import { WorkspaceChatAuthor } from "./workspace-chat-author";

function Bubble({ message }: { message: ChatQueuedMessage }) {
	return (
		<div className="chat-user-bubble bg-kumo-fill">
			<ChatMarkdown content={message.text} preserveLineBreaks />
		</div>
	);
}

function ownMessage(message: ChatQueuedMessage, viewerId: string | null) {
	return (
		message.authorKind === "person" &&
		(message.authorId === "" || message.authorId === viewerId)
	);
}

/**
 * Messages sent while the agent was working that it has not read yet. They
 * are dimmed until it picks them up at its next step.
 */
export function QueuedMessages({
	messages,
	tediNames,
	viewerId = null,
}: {
	messages: readonly ChatQueuedMessage[];
	tediNames: Record<string, string>;
	/** The person reading; their own messages carry no name. */
	viewerId?: string | null;
}) {
	if (messages.length === 0) return null;
	return (
		<ul aria-label="Messages not read yet" className="workspace-chat-queued">
			{messages.map((message) => (
				<li data-testid="workspace-chat-queued-message" key={message.messageId}>
					{ownMessage(message, viewerId) ? null : (
						<WorkspaceChatAuthor
							id={message.authorId}
							kind={message.authorKind}
							tediNames={tediNames}
						/>
					)}
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
	tediNames,
	viewerId = null,
}: {
	messages: readonly ChatQueuedMessage[] | undefined;
	tediNames: Record<string, string>;
	viewerId?: string | null;
}) {
	if (!messages?.length) return null;
	return (
		<>
			{messages.map((message) => (
				<div key={message.messageId} data-testid="workspace-chat-added-message">
					{ownMessage(message, viewerId) ? null : (
						<WorkspaceChatAuthor
							id={message.authorId}
							kind={message.authorKind}
							tediNames={tediNames}
						/>
					)}
					<div className="workspace-chat-user">
						<Bubble message={message} />
					</div>
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
