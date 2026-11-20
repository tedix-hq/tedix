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
import { chatDraftKey } from "@/components/chat-transcript";
import { WorkspaceChat } from "@/components/workspace-chat";
import { usePickableTedis, useTediNames } from "@/lib/use-tedi-names";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import {
	readWorkspaceChatDraft,
	writeWorkspaceChatDraft,
} from "@/lib/workspace-chat-draft";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";

/**
 * A chat with a picked tedi, in /chat. It is the workspace chat of the
 * person's private workspace with that tedi answering every message, so the
 * reply streams over one open connection with its steps, approvals, queued
 * messages, stop and run cards, instead of waiting in the Home queue.
 */
export function ChatTediThread({
	workspaceId,
	conversationId,
	initialTediId,
	initialDraft,
	onOpenList,
	onSelectConversation,
	onConversationCreated,
	onConversations,
	onPickHome,
}: {
	workspaceId: string;
	/** The workspace's own conversation id; null before the first message. */
	conversationId: string | null;
	/** The tedi picked for a new chat. An opened chat keeps its last one. */
	initialTediId: string | null;
	/** What was typed before the tedi was picked. */
	initialDraft?: string;
	onOpenList: () => void;
	onSelectConversation: (conversationId: string | null) => void;
	onConversationCreated: (conversationId: string) => void;
	onConversations: (conversations: readonly ConversationSummary[]) => void;
	/** Home was picked before the first message. */
	onPickHome: () => void;
}) {
	const tedis = usePickableTedis();
	const tediNames = useTediNames();
	// What was typed for Home becomes this chat's unsent message, before the
	// message box first reads it.
	useState(() => {
		if (conversationId === null && initialDraft)
			writeWorkspaceChatDraft(workspaceId, null, initialDraft);
	});
	const [picked, setPicked] = useState(initialTediId);
	// The tedi that answered this conversation last, as its list row says.
	const [answeredLast, setAnsweredLast] = useState<string | null>(null);
	const tediId = picked ?? answeredLast;
	const reportConversations = useCallback(
		(conversations: readonly ConversationSummary[]) => {
			setAnsweredLast(
				conversations.find((row) => row.id === conversationId)?.tediId ?? null,
			);
			onConversations(conversations);
		},
		[conversationId, onConversations],
	);
	const name = tediId ? tediNames[tediId] : undefined;
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
				placeholder={chatComposerPlaceholder(conversationId !== null)}
				emptyText="Ask a question, or ask for a doc, sheet or deck."
				composerSlot={
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
									<span className="truncate">{name ?? "Workspace agent"}</span>
								</Button>
							}
						/>
						<DropdownMenuContent>
							{conversationId === null ? (
								<DropdownMenuItem
									onClick={() => {
										// What is typed goes back to the Home composer.
										const draft = readWorkspaceChatDraft(workspaceId, null);
										try {
											if (draft)
												window.localStorage.setItem(chatDraftKey(null), draft);
											else window.localStorage.removeItem(chatDraftKey(null));
										} catch {
											// Storage can be unavailable; only the draft is lost.
										}
										writeWorkspaceChatDraft(workspaceId, null, "");
										onPickHome();
									}}
								>
									Home (picks for you)
								</DropdownMenuItem>
							) : null}
							{tedis.map((tedi) => (
								<DropdownMenuItem
									key={tedi.id}
									onClick={() => setPicked(tedi.id)}
								>
									{tedi.name}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
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
