import "./chat-tedi-thread.css";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { chatDraftKey } from "@/components/chat-transcript";
import { WorkspaceChat } from "@/components/workspace-chat";
import { useActiveTedis } from "@/lib/use-tedi-names";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import { createWorkspaceChatClient } from "@/lib/workspace-chat-client";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";

/**
 * A chat with a picked tedi, in /chat. It is the workspace chat of the
 * person's private workspace with that tedi answering every message, so the
 * reply streams over one open connection with its steps, approvals, queued
 * messages, stop and run cards, instead of waiting in the Home queue.
 *
 * The workspace chat has no way yet to be told who answers, so this wraps its
 * connection: every message goes out with the tedi picked here, and the
 * picker is placed in the composer where the workspace's own choice was.
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
	const tedis = useActiveTedis();
	// What was typed for Home becomes this chat's unsent message, before the
	// message box first reads it.
	useState(() => {
		if (conversationId === null && initialDraft)
			writeStored("sessionStorage", newChatDraftKey(workspaceId), initialDraft);
	});
	const [picked, setPicked] = useState(initialTediId);
	// The tedi that answered last, read from the replayed conversation.
	const [answeredLast, setAnsweredLast] = useState<string | null>(null);
	const tediId = picked ?? answeredLast;
	const sendAs = useRef(tediId);
	sendAs.current = tediId;
	const createClient = useCallback<typeof createWorkspaceChatClient>(
		(options) => {
			const client = createWorkspaceChatClient(options);
			client.subscribe(() =>
				setAnsweredLast(
					client
						.getSnapshot()
						.state.turns.findLast((turn) => turn.respondingTediId)
						?.respondingTediId ?? null,
				),
			);
			return {
				...client,
				sendTurn: (input) =>
					client.sendTurn({
						...input,
						...(input.tediId || !sendAs.current
							? {}
							: { tediId: sendAs.current }),
					}),
			};
		},
		[],
	);

	const root = useRef<HTMLDivElement | null>(null);
	const [slot, setSlot] = useState<Element | null>(null);
	useLayoutEffect(() => {
		setSlot(root.current?.querySelector(".workspace-chat-model") ?? null);
	});
	const name = tedis.find((tedi) => tedi.id === tediId)?.name;
	return (
		<div className="chat-tedi-thread" data-testid="chat-tedi-thread" ref={root}>
			<WorkspaceChat
				workspaceId={workspaceId}
				conversationId={conversationId}
				listOpen={false}
				onOpenList={onOpenList}
				onSelectConversation={onSelectConversation}
				onConversationCreated={onConversationCreated}
				onConversations={onConversations}
				createClient={createClient}
				autoFocusComposer
			/>
			{slot
				? createPortal(
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										type="button"
										size="sm"
										variant="ghost"
										className="chat-composer-picker chat-tedi-picker"
										aria-label={`Send to ${name ?? "the workspace agent"}`}
									>
										<span className="truncate">
											{name ?? "Workspace agent"}
										</span>
									</Button>
								}
							/>
							<DropdownMenuContent>
								{conversationId === null ? (
									<DropdownMenuItem
										onClick={() => {
											// What is typed goes back to the Home composer.
											const draft =
												root.current?.querySelector("textarea")?.value ?? "";
											writeStored("localStorage", chatDraftKey(null), draft);
											writeStored(
												"sessionStorage",
												newChatDraftKey(workspaceId),
												"",
											);
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
						</DropdownMenu>,
						slot,
					)
				: null}
		</div>
	);
}

/**
 * Where the workspace chat keeps the unsent message of a new conversation.
 * It offers no way to set it from outside, so this repeats its key; if that
 * key changes, a draft simply stops moving between the two composers.
 */
function newChatDraftKey(workspaceId: string): string {
	return `tedix.workspace-chat.draft.${workspaceId}.new`;
}

function writeStored(
	kind: "localStorage" | "sessionStorage",
	key: string,
	text: string,
) {
	try {
		const storage = window[kind];
		if (text) storage.setItem(key, text);
		else storage.removeItem(key);
	} catch {
		// Storage can be unavailable; only the draft is lost.
	}
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
