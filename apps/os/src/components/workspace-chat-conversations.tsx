import "./workspace-chat-conversations.css";
import {
	Archive,
	ArrowCounterClockwise,
	ArrowLeft,
	DotsThree,
	PencilSimple,
	Trash,
} from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Input } from "@/components/kumo/input";
import { Text } from "@/components/kumo/text";
import { UnreadBadge } from "@/components/unread-badge";
import type { ConversationChange } from "@/lib/workspace-chat-client";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";

const UNTITLED = "Untitled conversation";
/** The object keeps at most this many characters of a name. */
const TITLE_LIMIT = 80;
const DAY_MS = 86_400_000;

export type ConversationGroupLabel =
	| "Today"
	| "Yesterday"
	| "Earlier this week"
	| "Earlier";

/** When someone last wrote in the conversation; a rename does not move it. */
function lastActiveAt(conversation: ConversationSummary): string {
	return conversation.lastTurnAt ?? conversation.updatedAt;
}

/**
 * The list in sections by the day of the last message, newest first. The week
 * starts on Monday, in the reader's own time zone; a section with nothing in
 * it is left out.
 */
export function groupConversations(
	conversations: readonly ConversationSummary[],
	now: Date,
): Array<{
	label: ConversationGroupLabel;
	conversations: ConversationSummary[];
}> {
	const today = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
	).getTime();
	const yesterday = today - DAY_MS;
	const week = today - ((now.getDay() + 6) % 7) * DAY_MS;
	const groups: Record<ConversationGroupLabel, ConversationSummary[]> = {
		Today: [],
		Yesterday: [],
		"Earlier this week": [],
		Earlier: [],
	};
	for (const conversation of conversations.toSorted((a, b) =>
		lastActiveAt(b).localeCompare(lastActiveAt(a)),
	)) {
		const at = Date.parse(lastActiveAt(conversation));
		groups[
			at >= today
				? "Today"
				: at >= yesterday
					? "Yesterday"
					: at >= week
						? "Earlier this week"
						: "Earlier"
		].push(conversation);
	}
	return (Object.keys(groups) as ConversationGroupLabel[])
		.filter((label) => groups[label].length > 0)
		.map((label) => ({ label, conversations: groups[label] }));
}

function relativeTime(iso: string, now: number): string {
	const ms = now - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 60_000) return "just now";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} d ago`;
}

/** A name field that saves on Enter or when focus leaves, and gives up on Escape. */
function RenameField({
	title,
	onSave,
	onCancel,
}: {
	title: string | null;
	onSave: (title: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(title ?? "");
	const finish = () => {
		const next = value.replace(/\s+/g, " ").trim();
		if (next && next !== title) onSave(next);
		else onCancel();
	};
	return (
		<form
			className="workspace-chat-rename"
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				finish();
			}}
		>
			<Input
				aria-label="Conversation name"
				autoFocus
				maxLength={TITLE_LIMIT}
				onBlur={finish}
				onChange={(event) => setValue(event.target.value)}
				onFocus={(event) => event.target.select()}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					onCancel();
				}}
				size="sm"
				value={value}
			/>
		</form>
	);
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

export function ConversationList({
	conversations,
	activeId,
	activeRunning,
	activePendingApprovals,
	onSelect,
	onChange,
	unread,
}: {
	/** Every conversation the object named, the archived ones included. */
	conversations: ConversationSummary[];
	activeId: string | null;
	/** The open conversation's own turn is working, as this tab sees it. */
	activeRunning: boolean;
	/** Changes waiting in the open conversation, as this tab sees it. */
	activePendingApprovals: number;
	onSelect: (conversationId: string | null) => void;
	/** Null while the chat is not connected: nothing can be changed. */
	onChange: ((change: ConversationChange) => void) | null;
	unread?: ReadonlyMap<string, number>;
}) {
	const now = Date.now();
	const [showArchived, setShowArchived] = useState(false);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
	const archivedCount = conversations.filter((row) => row.archivedAt).length;
	const viewingArchived = showArchived && archivedCount > 0;
	const groups = groupConversations(
		conversations.filter((row) => !!row.archivedAt === viewingArchived),
		new Date(now),
	);
	const row = (conversation: ConversationSummary) => {
		const title = conversation.title ?? UNTITLED;
		const active = conversation.id === activeId;
		const working = (active && activeRunning) || conversation.running === true;
		const needsApproval = active
			? activePendingApprovals > 0
			: (conversation.pendingApprovals ?? 0) > 0;
		return (
			<li className="workspace-chat-list-item" key={conversation.id}>
				{renaming === conversation.id && onChange ? (
					<RenameField
						title={conversation.title}
						onCancel={() => setRenaming(null)}
						onSave={(next) => {
							onChange({
								type: "rename_conversation",
								conversationId: conversation.id,
								title: next,
							});
							setRenaming(null);
						}}
					/>
				) : (
					<button
						aria-current={active ? "true" : undefined}
						className="workspace-chat-list-row"
						onClick={() => onSelect(conversation.id)}
						type="button"
					>
						<Text as="span" role="body" className="truncate">
							{title}
						</Text>
						{needsApproval ? (
							<Badge className="shrink-0" variant="warning">
								Needs approval
							</Badge>
						) : null}
						{working ? (
							<span
								className="workspace-chat-list-working"
								role="img"
								aria-label="Working"
								title="Working"
							/>
						) : null}
						<UnreadBadge
							count={unread?.get(conversation.id) ?? 0}
							label="unread"
						/>
						<Text
							as="span"
							role="caption"
							tone="secondary"
							className="shrink-0 whitespace-nowrap"
						>
							{relativeTime(lastActiveAt(conversation), now)}
						</Text>
					</button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label={`Actions for ${title}`}
								disabled={!onChange}
								size="icon-sm"
								title={`Actions for ${title}`}
								variant="ghost"
							/>
						}
					>
						<DotsThree aria-hidden size={16} weight="bold" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={() => setRenaming(conversation.id)}>
							<PencilSimple aria-hidden size={14} />
							Rename
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() =>
								onChange?.({
									type: "archive_conversation",
									conversationId: conversation.id,
									archived: !conversation.archivedAt,
								})
							}
						>
							{conversation.archivedAt ? (
								<ArrowCounterClockwise aria-hidden size={14} />
							) : (
								<Archive aria-hidden size={14} />
							)}
							{conversation.archivedAt ? "Restore" : "Archive"}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={working}
							onClick={() => setDeleting(conversation)}
							title={working ? "Stop the reply first" : undefined}
							variant="destructive"
						>
							<Trash aria-hidden size={14} />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</li>
		);
	};
	return (
		<div className="workspace-chat-list">
			{viewingArchived ? (
				<div className="workspace-chat-list-bar">
					<Button
						onClick={() => setShowArchived(false)}
						size="sm"
						variant="ghost"
					>
						<ArrowLeft aria-hidden />
						Conversations
					</Button>
					<Text as="strong" role="label">
						Archived
					</Text>
				</div>
			) : (
				<div className="workspace-chat-list-bar">
					<Button onClick={() => onSelect(null)} size="sm" variant="secondary">
						New conversation
					</Button>
					{archivedCount > 0 ? (
						<Button
							onClick={() => setShowArchived(true)}
							size="sm"
							variant="ghost"
						>
							Archived ({archivedCount})
						</Button>
					) : null}
				</div>
			)}
			{groups.length === 0 ? (
				<Text role="body" tone="secondary">
					No conversations in this workspace yet.
				</Text>
			) : (
				groups.map((group) => (
					<section
						aria-label={group.label}
						className="workspace-chat-list-group"
						key={group.label}
					>
						<Text as="h3" role="caption" tone="secondary">
							{group.label}
						</Text>
						<ul>{group.conversations.map(row)}</ul>
					</section>
				))
			)}
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
		</div>
	);
}
