import "./workspace-chat-conversations.css";
import {
	Archive,
	ArrowCounterClockwise,
	ArrowLeft,
	Bell,
	BellSlash,
	Trash,
} from "@phosphor-icons/react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
	type ConversationListRow,
	ConversationListView,
	ConversationsEmpty,
	RenameField,
} from "@/components/conversation-list";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import type { ConversationChange } from "@/lib/workspace-chat-client";
import { agentConversations, ownConversations } from "@/lib/workspace-agents";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";

const UNTITLED = "Untitled conversation";
/** The object keeps at most this many characters of a name. */
const TITLE_LIMIT = 80;

/** When someone last wrote in the conversation; a rename does not move it. */
function lastActiveAt(conversation: ConversationSummary): string {
	return conversation.lastTurnAt ?? conversation.updatedAt;
}

/**
 * The open conversation's name in the thread header. Someone who may change
 * the conversation clicks it to rename; `onRename` is null while they may not.
 */
export function ConversationTitle({
	title,
	fallback,
	onRename,
}: {
	title: string | null;
	fallback: string;
	onRename: ((title: string) => void) | null;
}) {
	const [editing, setEditing] = useState(false);
	if (editing && onRename)
		return (
			<RenameField
				maxLength={TITLE_LIMIT}
				title={title}
				onCancel={() => setEditing(false)}
				onSave={(next) => {
					onRename(next);
					setEditing(false);
				}}
			/>
		);
	if (!onRename)
		return (
			<Text as="strong" role="label" className="truncate">
				{title ?? fallback}
			</Text>
		);
	return (
		<button
			className="workspace-chat-title"
			onClick={() => setEditing(true)}
			title="Rename conversation"
			type="button"
		>
			<Text as="strong" role="label" className="truncate">
				{title ?? fallback}
			</Text>
		</button>
	);
}

/**
 * Which conversations notify the signed-in person. A conversation starts
 * notifying when they first post or are mentioned in it; `set` is their own
 * choice for one conversation and stays until they change it.
 */
export type ConversationNotifications = {
	on: ReadonlySet<string>;
	set: (conversationId: string, on: boolean) => void;
};

/** The workspace chat's conversations in the shared list. */
export function ConversationList({
	conversations: all,
	onOpenAgents,
	activeId,
	activeRunning,
	activePendingApprovals,
	onSelect,
	onChange,
	unread,
	notifications,
}: {
	/** Every conversation the object named, the archived ones included. */
	conversations: ConversationSummary[];
	/**
	 * Set where an Agents view lists the conversations an agent started; they
	 * are then left out here. The list has no link to it: the Files rail
	 * opens Agents.
	 */
	onOpenAgents?: () => void;
	activeId: string | null;
	/** The open conversation's own turn is working, as this tab sees it. */
	activeRunning: boolean;
	/** Changes waiting in the open conversation, as this tab sees it. */
	activePendingApprovals: number;
	onSelect: (conversationId: string | null) => void;
	/** Null while the chat is not connected: nothing can be changed. */
	onChange: ((change: ConversationChange) => void) | null;
	unread?: ReadonlyMap<string, number>;
	/** Left out while it is not known; the menu then has no notification item. */
	notifications?: ConversationNotifications;
}) {
	const agentsListedElsewhere = !!onOpenAgents;
	const conversations = agentsListedElsewhere ? ownConversations(all) : all;
	const agentRuns = agentsListedElsewhere ? agentConversations(all) : [];
	const [showArchived, setShowArchived] = useState(false);
	const [query, setQuery] = useState("");
	const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
	const archivedCount = conversations.filter((row) => row.archivedAt).length;
	const viewingArchived = showArchived && archivedCount > 0;
	const searched = query.trim().toLowerCase();
	const row = (conversation: ConversationSummary): ConversationListRow => {
		const active = conversation.id === activeId;
		const working = (active && activeRunning) || conversation.running === true;
		const notifying = notifications?.on.has(conversation.id) ?? false;
		return {
			id: conversation.id,
			title: conversation.title ?? UNTITLED,
			at: lastActiveAt(conversation),
			working,
			needsYou: active
				? activePendingApprovals > 0
				: (conversation.pendingApprovals ?? 0) > 0,
			unread: unread?.get(conversation.id) ?? 0,
			actions: [
				{
					label: conversation.archivedAt ? "Restore" : "Archive",
					icon: conversation.archivedAt ? (
						<ArrowCounterClockwise aria-hidden size={14} />
					) : (
						<Archive aria-hidden size={14} />
					),
					onSelect: () =>
						onChange?.({
							type: "archive_conversation",
							conversationId: conversation.id,
							archived: !conversation.archivedAt,
						}),
				},
				...(notifications
					? [
							{
								label: notifying
									? "Turn off notifications"
									: "Turn on notifications",
								icon: notifying ? (
									<BellSlash aria-hidden size={14} />
								) : (
									<Bell aria-hidden size={14} />
								),
								title: notifying
									? "Stop notifications for this conversation. Approval requests still notify you."
									: "Get notified about new messages and agent results here.",
								onSelect: () => notifications.set(conversation.id, !notifying),
							},
						]
					: []),
				{
					label: "Delete",
					icon: <Trash aria-hidden size={14} />,
					destructive: true,
					disabled: working,
					title: working ? "Stop the reply first" : undefined,
					onSelect: () => setDeleting(conversation),
				},
			],
		};
	};
	const rows = conversations
		.filter(
			(conversation) =>
				!!conversation.archivedAt === viewingArchived &&
				(!searched ||
					(conversation.title ?? UNTITLED).toLowerCase().includes(searched)),
		)
		.map(row);
	const toolbar = viewingArchived ? (
		<div className="flex items-center justify-between gap-2">
			<Button onClick={() => setShowArchived(false)} size="sm" variant="ghost">
				<ArrowLeft aria-hidden />
				Conversations
			</Button>
			<Text as="strong" role="label">
				Archived
			</Text>
		</div>
	) : (
		<div className="flex items-center justify-between gap-2">
			<Button onClick={() => onSelect(null)} size="sm" variant="secondary">
				New conversation
			</Button>
			{archivedCount > 0 ? (
				<Button onClick={() => setShowArchived(true)} size="sm" variant="ghost">
					Archived ({archivedCount})
				</Button>
			) : null}
		</div>
	);
	return (
		<ConversationListView
			activeId={activeId}
			className="workspace-chat-list"
			empty={
				agentRuns.length > 0 ? (
					// Not an empty workspace: every conversation in it is an agent's run.
					<ConversationsEmpty
						description="The ones agents started are under Agents."
						title="No conversations of your own here"
					/>
				) : (
					<ConversationsEmpty
						description="Send a message to start one."
						title="No conversations in this workspace yet"
					/>
				)
			}
			footer={
				<ConfirmDialog
					confirmLabel="Delete"
					description={
						deleting
							? `“${deleting.title ?? UNTITLED}” and its messages are deleted for everyone in this workspace. Files it saved stay. This cannot be undone.`
							: null
					}
					destructive
					isPending={false}
					onConfirm={() => {
						if (deleting)
							onChange?.({
								type: "delete_conversation",
								conversationId: deleting.id,
							});
						setDeleting(null);
					}}
					onOpenChange={(open) => {
						if (!open) setDeleting(null);
					}}
					open={deleting !== null}
					pendingLabel="Deleting…"
					title="Delete conversation"
				/>
			}
			maxTitleLength={TITLE_LIMIT}
			menusDisabled={!onChange}
			onQueryChange={setQuery}
			onRename={
				onChange
					? (conversationId, title) =>
							onChange({
								type: "rename_conversation",
								conversationId,
								title,
							})
					: null
			}
			onSelect={onSelect}
			query={query}
			rows={rows}
			toolbar={toolbar}
		/>
	);
}
