import { useCallback, useEffect, useState } from "react";
import { WorkspaceChat } from "@/components/workspace-chat";
import { persistCanvasPhonePane } from "@/lib/canvas-phone-pane";

export function PhoneWorkspaceChat({
	workspaceId,
	conversationId,
	onConversationChange,
	onOpenWorkspace,
}: {
	workspaceId: string;
	conversationId: string | null;
	onConversationChange: (conversationId: string | null) => void;
	onOpenWorkspace: () => void;
}) {
	const [listOpen, setListOpen] = useState(false);
	const sendQueuedMessage = useCallback(
		(send: (content: string) => void) => {
			const key = `tedix.workspace-chat.pending.${workspaceId}`;
			try {
				const value = window.sessionStorage.getItem(key);
				if (!value) return;
				const pending = JSON.parse(value) as {
					conversation?: unknown;
					text?: unknown;
				};
				const expected = conversationId ?? "new";
				if (
					pending.conversation !== expected ||
					typeof pending.text !== "string" ||
					!pending.text.trim()
				)
					return;
				window.sessionStorage.removeItem(key);
				send(pending.text);
			} catch {
				window.sessionStorage.removeItem(key);
			}
		},
		[conversationId, workspaceId],
	);
	useEffect(() => {
		persistCanvasPhonePane(window.localStorage, workspaceId, "chat");
	}, [workspaceId]);
	return (
		<div className="flex h-(--viewport-tedix-height) min-h-0 flex-col bg-kumo-base">
			<WorkspaceChat
				autoFocusComposer
				conversationId={conversationId}
				listOpen={listOpen}
				onBrowseResources={onOpenWorkspace}
				onSendMessageReady={sendQueuedMessage}
				onConversationCreated={(next) => {
					setListOpen(false);
					onConversationChange(next);
				}}
				onOpenList={() => setListOpen(true)}
				onSelectConversation={(next) => {
					setListOpen(false);
					onConversationChange(next);
				}}
				workspaceId={workspaceId}
			/>
		</div>
	);
}
