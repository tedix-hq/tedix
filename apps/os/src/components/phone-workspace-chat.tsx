import { useEffect, useState } from "react";
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
