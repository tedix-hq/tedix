import {
	ChatCircle,
	DotsThree,
	PencilSimple,
	PushPin,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { Loader } from "@/components/kumo/loader";
import { SearchInput } from "@/components/kumo/search-input";
import { Text } from "@/components/kumo/text";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { UnreadBadge } from "@/components/unread-badge";
import { cn } from "@/lib/utils";

/**
 * The one conversation list: the workspace chat and /chat both render it.
 * Each parent maps its own conversations into rows and keeps its own
 * changes; this component owns the search field, the time groups, the row
 * menu and renaming in place.
 */

export type ConversationAction = {
	label: string;
	icon: ReactNode;
	onSelect: () => void;
	destructive?: boolean;
	disabled?: boolean;
	title?: string;
};

export type ConversationListRow = {
	id: string;
	title: string;
	/** When someone last wrote in it; it files the row under a day. */
	at: string;
	pinned?: boolean;
	archived?: boolean;
	/** Shown before the title: a workspace or tedi picture. */
	leading?: ReactNode;
	/** The tedi that answers in it, when one does. */
	answeredBy?: string | null;
	working?: boolean;
	/** What the working turn is doing now, when known. */
	step?: string | null;
	/** The words of a reply a search found in it. */
	match?: string;
	/** A request in it waits for the person. */
	needsYou?: boolean;
	unread?: number;
	/** Shows a change the server has not confirmed yet. */
	pending?: boolean;
	/** False leaves Rename out of this row's menu. */
	renamable?: boolean;
	/** Menu entries after Rename. None and not renamable: no menu. */
	actions?: ConversationAction[];
};

export type ConversationGroupLabel =
	| "Pinned"
	| "Today"
	| "Yesterday"
	| "Previous 7 days"
	| "Older";

const DAY_MS = 86_400_000;

/**
 * Rows under Pinned, then by the calendar day they were last used, in the
 * reader's own time zone, newest first. An empty group is left out.
 */
export function groupConversationRows<
	T extends Pick<ConversationListRow, "at" | "pinned">,
>(
	rows: readonly T[],
	now: Date,
): Array<{ label: ConversationGroupLabel; rows: T[] }> {
	const today = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
	).getTime();
	const groups: Record<ConversationGroupLabel, T[]> = {
		Pinned: [],
		Today: [],
		Yesterday: [],
		"Previous 7 days": [],
		Older: [],
	};
	for (const row of rows.toSorted(
		(a, b) => Date.parse(b.at) - Date.parse(a.at),
	)) {
		const at = new Date(row.at);
		const day = new Date(
			at.getFullYear(),
			at.getMonth(),
			at.getDate(),
		).getTime();
		const days = Number.isFinite(day)
			? Math.round((today - day) / DAY_MS)
			: Number.POSITIVE_INFINITY;
		groups[
			row.pinned
				? "Pinned"
				: days <= 0
					? "Today"
					: days === 1
						? "Yesterday"
						: days < 7
							? "Previous 7 days"
							: "Older"
		].push(row);
	}
	return (Object.keys(groups) as ConversationGroupLabel[])
		.filter((label) => groups[label].length > 0)
		.map((label) => ({ label, rows: groups[label] }));
}

/** A name field that saves on Enter or when focus leaves, and gives up on Escape. */
export function RenameField({
	title,
	maxLength,
	onSave,
	onCancel,
}: {
	title: string | null;
	maxLength: number;
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
			className="flex min-w-0 flex-1"
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				finish();
			}}
		>
			<Input
				aria-label="Conversation name"
				autoFocus
				className="min-w-0 flex-1"
				maxLength={maxLength}
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

function ConversationRowView({
	row,
	active,
	disabled,
	renaming,
	maxLength,
	onSelect,
	onStartRename,
	onRename,
	onCancelRename,
}: {
	row: ConversationListRow;
	active: boolean;
	disabled: boolean;
	renaming: boolean;
	maxLength: number;
	onSelect: () => void;
	onStartRename: (() => void) | null;
	onRename: (title: string) => void;
	onCancelRename: () => void;
}) {
	const actions = row.actions ?? [];
	const hasMenu = !!onStartRename || actions.length > 0;
	const detail = row.working && row.step ? row.step : row.answeredBy;
	return (
		<li
			aria-busy={row.pending || undefined}
			className="group/row relative min-w-0 rounded-lg transition-colors hover:bg-kumo-tint data-[active=true]:bg-kumo-control motion-reduce:transition-none"
			data-active={active || undefined}
			data-conversation-id={row.id}
			data-pending={row.pending || undefined}
		>
			{renaming ? (
				<div className="flex min-w-0 px-1 py-1">
					<RenameField
						maxLength={maxLength}
						onCancel={onCancelRename}
						onSave={onRename}
						title={row.title}
					/>
				</div>
			) : (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-current={active ? "true" : undefined}
								className={cn(
									"min-h-11 w-full min-w-0 justify-start gap-2 rounded-lg bg-transparent px-3 text-left hover:bg-transparent focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:ring-inset",
									hasMenu && "pr-10",
									row.match && "flex-col items-stretch gap-1 py-2",
								)}
								multiline={!!row.match}
								onClick={onSelect}
								variant="ghost"
							/>
						}
					>
						<span className="flex w-full min-w-0 items-center gap-2">
							{row.leading}
							{row.pinned ? (
								<PushPin
									aria-label="Pinned"
									className="shrink-0 text-kumo-subtle"
									size={12}
									weight="fill"
								/>
							) : null}
							<Text
								as="span"
								className="min-w-0 flex-1"
								data-slot="conversation-title"
								role="body"
								tone={active ? "strong" : "default"}
								truncate
								weight={active ? "medium" : "normal"}
							>
								{row.title}
							</Text>
							{detail ? (
								<Text
									as="span"
									className="min-w-0 max-w-[45%] shrink"
									data-slot="conversation-detail"
									role="label"
									tone="secondary"
									truncate
								>
									{detail}
								</Text>
							) : null}
							{row.archived ? (
								<Text
									as="span"
									className="shrink-0"
									role="label"
									tone="secondary"
								>
									Archived
								</Text>
							) : null}
							{row.needsYou ? (
								<Badge className="shrink-0" variant="warning">
									Needs you
								</Badge>
							) : null}
							{row.working ? (
								<span
									aria-label="Working"
									className="inline-flex shrink-0 text-kumo-subtle"
									role="img"
									title="Working"
								>
									<Loader aria-hidden size={12} />
								</span>
							) : null}
							<UnreadBadge count={row.unread ?? 0} label="unread" />
						</span>
						{row.match ? (
							<Text
								as="span"
								className="line-clamp-3 whitespace-normal"
								data-slot="conversation-match"
								role="label"
								tone="secondary"
							>
								{row.match}
							</Text>
						) : null}
					</TooltipTrigger>
					<TooltipContent role="tooltip" side="right">
						{row.title}
					</TooltipContent>
				</Tooltip>
			)}
			{hasMenu && !renaming ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label={`Actions for ${row.title}`}
								className="absolute top-1/2 right-1 -translate-y-1/2 bg-transparent text-kumo-subtle opacity-0 transition-opacity hover:bg-kumo-tint group-focus-within/row:opacity-100 group-hover/row:opacity-100 group-data-[active=true]/row:opacity-100 data-[popup-open]:opacity-100 max-sm:opacity-100 coarse:opacity-100"
								disabled={disabled}
								size="icon-sm"
								title={`Actions for ${row.title}`}
								variant="ghost"
							/>
						}
					>
						<DotsThree aria-hidden size={16} weight="bold" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{onStartRename ? (
							<DropdownMenuItem onClick={onStartRename}>
								<PencilSimple aria-hidden size={14} />
								Rename
							</DropdownMenuItem>
						) : null}
						{actions.map((action) => (
							<DropdownMenuItem
								disabled={action.disabled}
								key={action.label}
								onClick={action.onSelect}
								title={action.title}
								variant={action.destructive ? "destructive" : undefined}
							>
								{action.icon}
								{action.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</li>
	);
}

export function ConversationsEmpty({
	title = "No conversations yet",
	description = "Send your first message to start a conversation.",
	children,
}: {
	title?: string;
	description?: string;
	children?: ReactNode;
}) {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ChatCircle size={20} />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			{children}
		</Empty>
	);
}

export function ConversationListView({
	rows,
	activeId,
	onSelect,
	onRename,
	maxTitleLength = 80,
	query,
	onQueryChange,
	searching = false,
	toolbar,
	empty,
	placeholder,
	footer,
	now = new Date(),
	menusDisabled = false,
	className,
}: {
	rows: readonly ConversationListRow[];
	activeId: string | null;
	onSelect: (conversationId: string) => void;
	/** Null or absent: no row can be renamed. */
	onRename?: ((conversationId: string, title: string) => void) | null;
	maxTitleLength?: number;
	/** With `onQueryChange`, a search field sits above the list. */
	query?: string;
	onQueryChange?: (query: string) => void;
	/** The search is still loading. */
	searching?: boolean;
	/** Buttons above the search field: New, Archived, Agents. */
	toolbar?: ReactNode;
	/** Shown when there are no rows and no search. */
	empty?: ReactNode;
	/** Shown instead of an empty list while the rows load. */
	placeholder?: ReactNode;
	/** Below the list: Show older, errors, dialogs. */
	footer?: ReactNode;
	now?: Date;
	/** Row menus show but cannot open: nothing can be changed now. */
	menusDisabled?: boolean;
	className?: string;
}) {
	const [renaming, setRenaming] = useState<string | null>(null);
	const headingPrefix = useId();
	const groups = groupConversationRows(rows, now);
	const searched = query?.trim();
	return (
		<nav
			aria-label="Conversations"
			className={cn("flex min-w-0 flex-col gap-4", className)}
			data-active-conversation={activeId ?? "new"}
		>
			{toolbar}
			{onQueryChange ? (
				<SearchInput
					aria-busy={searching}
					aria-label="Search conversations"
					maxLength={200}
					onChange={(event) => onQueryChange(event.target.value)}
					placeholder="Search conversations…"
					value={query ?? ""}
				/>
			) : null}
			{rows.length === 0 && placeholder ? (
				placeholder
			) : rows.length === 0 ? (
				searched ? (
					<ConversationsEmpty
						description={`No conversations match “${searched}”.`}
						title="No conversations found"
					>
						{onQueryChange ? (
							<Button
								onClick={() => onQueryChange("")}
								size="sm"
								variant="secondary"
							>
								Clear search
							</Button>
						) : null}
					</ConversationsEmpty>
				) : (
					(empty ?? <ConversationsEmpty />)
				)
			) : (
				<div className="grid gap-4">
					{groups.map((group) => {
						const headingId = `${headingPrefix}-${group.label}`;
						return (
							<section aria-labelledby={headingId} key={group.label}>
								<Text
									as="h3"
									className="m-0 mb-1 px-3"
									id={headingId}
									role="label"
									tone="secondary"
									weight="medium"
								>
									{group.label}
								</Text>
								<ul className="m-0 grid list-none gap-0.5 p-0">
									{group.rows.map((row) => (
										<ConversationRowView
											active={row.id === activeId}
											disabled={menusDisabled}
											key={row.id}
											maxLength={maxTitleLength}
											onCancelRename={() => setRenaming(null)}
											onRename={(title) => {
												onRename?.(row.id, title);
												setRenaming(null);
											}}
											onSelect={() => onSelect(row.id)}
											onStartRename={
												onRename && row.renamable !== false
													? () => setRenaming(row.id)
													: null
											}
											renaming={renaming === row.id && !!onRename}
											row={row}
										/>
									))}
								</ul>
							</section>
						);
					})}
				</div>
			)}
			{footer}
		</nav>
	);
}
