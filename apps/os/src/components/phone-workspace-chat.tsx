import { useCallback, useEffect, useState } from "react";
import { WorkspaceChat } from "@/components/workspace-chat";
import { persistCanvasPhonePane } from "@/lib/canvas-phone-pane";
import { takeWorkspaceFirstMessage } from "@/lib/workspace-first-message";
import { useWorkspaceViewOnly } from "@/lib/workspace-view-only";

export function PhoneWorkspaceChat({
	workspaceId,
	conversationId,
	onConversationChange,
	onOpenWorkspace,
	onOpenAgents,
}: {
	workspaceId: string;
	conversationId: string | null;
	onConversationChange: (conversationId: string | null) => void;
	onOpenWorkspace: () => void;
	/** Opens the workspace's Agents view, which lists the runs agents started. */
	onOpenAgents: () => void;
}) {
	const [listOpen, setListOpen] = useState(false);
	const viewOnly = useWorkspaceViewOnly(workspaceId);
	const sendQueuedMessage = useCallback(
		(send: (content: string) => void) => {
			const text = takeWorkspaceFirstMessage(workspaceId, conversationId);
			if (text) send(text);
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
				onOpenAgents={onOpenAgents}
				onOpenList={() => setListOpen(true)}
				onSelectConversation={(next) => {
					setListOpen(false);
					onConversationChange(next);
				}}
				viewOnly={viewOnly}
				workspaceId={workspaceId}
			/>
		</div>
	);
}
