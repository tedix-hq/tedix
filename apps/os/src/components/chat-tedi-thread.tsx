import "./chat-tedi-thread.css";
import { useCallback, useEffect, useState } from "react";
import { chatComposerPlaceholder } from "@/components/chat-composer-options";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { WorkspaceChat } from "@/components/workspace-chat";
import { usePickableTedis, useTediName } from "@/lib/use-tedi-names";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";

/**
 * A /chat conversation on the workspace path: the workspace chat of the
 * person's private workspace, so the reply streams over one open connection
 * with its steps, approvals, queued messages, stop and run cards. A picked
 * tedi answers every message; with none picked the workspace's own answerer
 * replies.
 */
export function ChatTediThread({
	workspaceId,
	conversationId,
	onOpenList,
	onSelectConversation,
	onConversationCreated,
	onConversations,
}: {
	workspaceId: string;
	/** The workspace's own conversation id; null before the first message. */
	conversationId: string | null;
	onOpenList: () => void;
	onSelectConversation: (conversationId: string | null) => void;
	onConversationCreated: (conversationId: string) => void;
	onConversations: (conversations: readonly ConversationSummary[]) => void;
}) {
	const tedis = usePickableTedis();
	// What the person picked here; until then an opened chat keeps the tedi
	// that answered it last, as its list row says.
	const [picked, setPicked] = useState<{ tediId: string | null } | null>(null);
	const [answeredLast, setAnsweredLast] = useState<string | null>(null);
	const tediId = picked ? picked.tediId : answeredLast;
	const reportConversations = useCallback(
		(conversations: readonly ConversationSummary[]) => {
			setAnsweredLast(
				conversations.find((row) => row.id === conversationId)?.tediId ?? null,
			);
			onConversations(conversations);
		},
		[conversationId, onConversations],
	);
	// A tedi answers: never label it as the workspace agent, also while its
	// name is still being read.
	const name = useTediName(tediId) ?? (tediId ? "Tedi" : undefined);
	return (
		<div className="chat-tedi-thread" data-testid="chat-tedi-thread">
			<WorkspaceChat
				workspaceId={workspaceId}
				conversationId={conversationId}
				listOpen={false}
				onOpenList={onOpenList}
				onSelectConversation={onSelectConversation}
				onConversationCreated={onConversationCreated}
				onConversations={reportConversations}
				autoFocusComposer
				embedded
				tediId={tediId}
				// The person's own private workspace: their chat default model.
				modelDefault="personChat"
				placeholder={chatComposerPlaceholder(conversationId !== null)}
				emptyText="Ask a question, or ask for a doc, sheet or deck."
				// With no tedi pinned, the workspace chat offers its own choice of
				// who replies to each message.
				composerSlot={
					tediId ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										type="button"
										size="sm"
										variant="ghost"
										className="chat-composer-picker"
										aria-label={`Send to ${name ?? "the workspace agent"}`}
									>
										<span className="truncate">
											{name ?? "Workspace agent"}
										</span>
									</Button>
								}
							/>
							<DropdownMenuContent>
								<DropdownMenuItem onClick={() => setPicked({ tediId: null })}>
									Workspace agent
								</DropdownMenuItem>
								{tedis.map((tedi) => (
									<DropdownMenuItem
										key={tedi.id}
										onClick={() => setPicked({ tediId: tedi.id })}
									>
										{tedi.name}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					) : undefined
				}
			/>
		</div>
	);
}

/**
 * Keeps the /chat list's rows for these chats current while none of them is
 * open: one quiet connection that follows no conversation.
 */
export function ChatTediListFeed({
	workspaceId,
	onConversations,
}: {
	workspaceId: string;
	onConversations: (conversations: readonly ConversationSummary[]) => void;
}) {
	const { conversations } = useWorkspaceChat(workspaceId, null).snapshot.state;
	useEffect(() => {
		onConversations(conversations);
	}, [onConversations, conversations]);
	return null;
}
