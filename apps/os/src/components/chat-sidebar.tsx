import {
	Archive,
	ArrowCounterClockwise,
	CaretLeft,
	ChatCircle,
	Check,
	DotsThree,
	PencilSimple,
	Plus,
	PushPin,
	PushPinSlash,
	Trash,
	X,
} from "@phosphor-icons/react";
import type {
	HomeConversation,
	ListHomeConversationsInput,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { QueryClient } from "@tanstack/react-query";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Text } from "@/components/kumo/text";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { SearchInput } from "@/components/kumo/search-input";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { ListSkeleton } from "@/components/list-skeleton";
import { osApi } from "@/lib/api";
import { absoluteTime, relativeTime } from "@/lib/time";
import { homeConversationsQueryKey } from "@/lib/os-query-options";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Query key shared by every conversations read + mutation invalidation. */
export const CHAT_CONVERSATIONS_QUERY_KEY = homeConversationsQueryKey();

/** The org's durable operator thread — implicit, undeletable (contract §6). */
export const MAIN_HOME_CONVERSATION_ID = "home:main";

export const CONVERSATION_TITLE_FALLBACK = "New conversation";

const renameConversationSchema = z.object({
	title: z.string().trim().min(1, "Enter a conversation title.").max(200),
});

/**
 * Untitled conversations surface their own id as `title` (contract:
 * `title === id` is the "no title" signal), so both a missing title and the
 * id-echo fall back to the placeholder.
 */
export function conversationTitle(conversation: HomeConversation): string {
	const title = conversation.title?.trim();
	if (!title || title === conversation.id) return CONVERSATION_TITLE_FALLBACK;
	return title;
}

export function isPinned(conversation: HomeConversation): boolean {
	return typeof conversation.pinnedAt === "string";
}

/** Most recent activity instant, used for ordering and the row timestamp. */
export function conversationActivityAt(conversation: HomeConversation): string {
	return (
		conversation.updatedAt ??
		conversation.lastMessageAt ??
		conversation.createdAt
	);
}

/**
 * Pinned-first ordering is client-side by contract (the server never sorts by
 * `pinnedAt`); each group orders by most recent activity, newest first.
 */
export function sortConversations(
	conversations: readonly HomeConversation[],
): HomeConversation[] {
	return [...conversations].sort((a, b) => {
		const pinDelta = Number(isPinned(b)) - Number(isPinned(a));
		if (pinDelta !== 0) return pinDelta;
		return (
			Date.parse(conversationActivityAt(b)) -
			Date.parse(conversationActivityAt(a))
		);
	});
}

export type ConversationGroupKey =
	| "pinned"
	| "today"
	| "yesterday"
	| "thisWeek"
	| "earlier";

export type ConversationGroup = {
	key: ConversationGroupKey;
	label: string;
	conversations: HomeConversation[];
};

const CONVERSATION_GROUP_LABELS: Record<ConversationGroupKey, string> = {
	pinned: "Pinned",
	today: "Today",
	yesterday: "Yesterday",
	thisWeek: "Earlier this week",
	earlier: "Earlier",
};

const CONVERSATION_GROUP_ORDER: ConversationGroupKey[] = [
	"pinned",
	"today",
	"yesterday",
	"thisWeek",
	"earlier",
];

function startOfLocalDay(value: Date): Date {
	const result = new Date(value);
	result.setHours(0, 0, 0, 0);
	return result;
}

/**
 * Group an already-sorted conversation list without weakening pinned-first
 * ordering. Calendar-day buckets make a long history scannable while each row
 * retains its precise relative/absolute timestamp.
 */
export function groupConversationsByRecency(
	conversations: readonly HomeConversation[],
	now = new Date(),
): ConversationGroup[] {
	const groups = new Map<ConversationGroupKey, HomeConversation[]>();
	const today = startOfLocalDay(now).getTime();

	for (const conversation of conversations) {
		let key: ConversationGroupKey;
		if (isPinned(conversation)) {
			key = "pinned";
		} else {
			const activity = new Date(conversationActivityAt(conversation));
			const activityDay = startOfLocalDay(activity).getTime();
			const dayDelta = Number.isFinite(activityDay)
				? Math.round((today - activityDay) / 86_400_000)
				: Number.POSITIVE_INFINITY;
			key =
				dayDelta <= 0
					? "today"
					: dayDelta === 1
						? "yesterday"
						: dayDelta < 7
							? "thisWeek"
							: "earlier";
		}
		const group = groups.get(key) ?? [];
		group.push(conversation);
		groups.set(key, group);
	}

	return CONVERSATION_GROUP_ORDER.flatMap((key) => {
		const groupedConversations = groups.get(key);
		return groupedConversations
			? [
					{
						key,
						label: CONVERSATION_GROUP_LABELS[key],
						conversations: groupedConversations,
					},
				]
			: [];
	});
}

/**
 * Which overflow actions a conversation offers. `home:main` cannot be deleted
 * (the API refuses with BAD_REQUEST), so its menu hides Delete entirely.
 */
export function conversationMenuActions(conversation: HomeConversation): {
	rename: true;
	pin: "pin" | "unpin";
	archive: "archive" | "restore" | null;
	delete: boolean;
} {
	return {
		rename: true,
		pin: isPinned(conversation) ? "unpin" : "pin",
		archive:
			conversation.id === MAIN_HOME_CONVERSATION_ID
				? null
				: conversation.status === "archived"
					? "restore"
					: "archive",
		delete: conversation.id !== MAIN_HOME_CONVERSATION_ID,
	};
}

// ---------------------------------------------------------------------------
// Optimistic patching (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * The paged shape `useInfiniteQuery` holds for this key. Declared locally and
 * narrowly: the patch only ever rewrites conversation rows, so it must not
 * depend on (or accidentally rebuild) the cursor plumbing around them.
 */
export type ConversationPages = {
	pages: Array<{
		conversations: HomeConversation[];
		nextCursor?: string | null;
	}>;
	pageParams: unknown[];
};

/**
 * Rewrite ONE conversation across every loaded page.
 *
 * Returns the SAME reference when the id is not loaded, which is what makes the
 * optimistic write a no-op rather than a fabricated row: a conversation the
 * cache has never seen cannot be synthesized here (the row carries timestamps,
 * origin and metadata this call site does not have), so the mutation falls back
 * to the invalidate it already did.
 */
export function patchConversationPages(
	data: ConversationPages | undefined,
	conversationId: string,
	patch: (conversation: HomeConversation) => HomeConversation,
): ConversationPages | undefined {
	if (data === undefined) return data;
	let changed = false;
	const pages = data.pages.map((page) => {
		const index = page.conversations.findIndex(
			(conversation) => conversation.id === conversationId,
		);
		if (index < 0) return page;
		changed = true;
		const conversations = page.conversations.map((conversation, at) =>
			at === index ? patch(conversation) : conversation,
		);
		return { ...page, conversations };
	});
	return changed ? { ...data, pages } : data;
}

/**
 * Optimistic pin/unpin. `pinnedAt` is the contract's pinned marker (`isPinned`
 * tests for a string), so unpinning writes null rather than deleting the key —
 * an absent field and an explicit null must read identically here and in the
 * server's echo.
 */
export function pinnedConversationPatch(
	pinned: boolean,
	at: string,
): (conversation: HomeConversation) => HomeConversation {
	return (conversation) => ({ ...conversation, pinnedAt: pinned ? at : null });
}

/** What `onMutate` hands `onError` so a rejection can be undone exactly. */
export type OptimisticConversationContext = {
	previous: ConversationPages | undefined;
	queryKey: ReturnType<typeof homeConversationsQueryKey>;
};

/**
 * Apply a reversible conversation edit locally, returning the snapshot that
 * undoes it.
 *
 * Cancelling first is load-bearing: an in-flight list refetch would land AFTER
 * the local write and overwrite it with the pre-mutation server state, so the
 * optimistic value would flicker away while the mutation was still succeeding.
 */
export async function beginOptimisticConversationPatch(
	queryClient: QueryClient,
	conversationId: string,
	patch: (conversation: HomeConversation) => HomeConversation,
	workspaceId?: string,
	includeArchived = false,
	search?: string,
): Promise<OptimisticConversationContext> {
	const queryKey = homeConversationsQueryKey(
		workspaceId,
		includeArchived,
		search,
	);
	await queryClient.cancelQueries({ queryKey });
	const previous = queryClient.getQueryData<ConversationPages>(queryKey);
	queryClient.setQueryData<ConversationPages>(queryKey, (current) =>
		patchConversationPages(current, conversationId, patch),
	);
	return { previous, queryKey };
}

/**
 * Undo by SNAPSHOT restore, not by inverse patch: an inverse would silently
 * drop any concurrent write that landed between `onMutate` and `onError`.
 */
export function rollbackOptimisticConversationPatch(
	queryClient: QueryClient,
	context: OptimisticConversationContext,
): void {
	if (context.previous === undefined) return;
	queryClient.setQueryData(context.queryKey, context.previous);
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

export function ConversationRow({
	conversation,
	active = false,
	optimistic = false,
	now,
	menu,
	onSelect,
}: {
	conversation: HomeConversation;
	active?: boolean;
	/**
	 * The row is showing a locally-applied value the server has not confirmed
	 * (a rename or a pin in flight). Rendered as `aria-busy` so assistive tech
	 * hears "this is not settled yet" rather than reading the optimistic value
	 * as fact, and as `data-optimistic` so the state is assertable.
	 */
	optimistic?: boolean;
	/** Injectable clock so static-markup tests are deterministic. */
	now?: Date;
	/** Overflow-menu slot; the pure row stays free of popup machinery. */
	menu?: ReactNode;
	onSelect?: (conversationId: string) => void;
}) {
	const pinned = isPinned(conversation);
	const archived = conversation.status === "archived";
	return (
		<li
			data-conversation-id={conversation.id}
			data-active={active || undefined}
			data-pinned={pinned || undefined}
			data-optimistic={optimistic || undefined}
			aria-busy={optimistic || undefined}
			className={`group/row flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors ${
				active ? "bg-kumo-fill" : "hover:bg-kumo-tint"
			}`}
		>
			<Button
				aria-current={active ? "true" : undefined}
				className="min-w-0 flex-1 flex-col items-stretch gap-0 px-2.5 py-1.5 text-left coarse:min-h-11"
				multiline
				onClick={() => onSelect?.(conversation.id)}
				variant="ghost"
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{pinned ? (
						<PushPin
							size={12}
							weight="fill"
							aria-label="Pinned"
							data-pin-indicator="true"
							className="shrink-0 text-kumo-subtle"
						/>
					) : null}
					<Text
						as="span"
						role="body"
						tone={active ? "strong" : "default"}
						weight={active ? "medium" : "normal"}
						truncate
					>
						{conversationTitle(conversation)}
					</Text>
					{archived ? (
						<Text as="span" role="label" tone="secondary" className="shrink-0">
							Archived
						</Text>
					) : null}
				</span>
				<time
					dateTime={conversationActivityAt(conversation)}
					title={absoluteTime(conversationActivityAt(conversation))}
					className="text-kumo-subtle text-xs"
				>
					{relativeTime(conversationActivityAt(conversation), now)}
				</time>
			</Button>
			{menu}
		</li>
	);
}

export function ConversationsEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ChatCircle size={20} />
				</EmptyMedia>
				<EmptyTitle>No conversations yet</EmptyTitle>
				<EmptyDescription>
					Send your first message to start a conversation.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function ConversationSearchEmpty({
	query,
	onClear,
}: {
	query: string;
	onClear?: () => void;
}) {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ChatCircle size={20} />
				</EmptyMedia>
				<EmptyTitle>No conversations found</EmptyTitle>
				<EmptyDescription>No conversations match “{query}”.</EmptyDescription>
			</EmptyHeader>
			{onClear ? (
				<Button size="sm" variant="secondary" onClick={onClear}>
					Clear search
				</Button>
			) : null}
		</Empty>
	);
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const CONVERSATIONS_PAGE_LIMIT = 50;

export function conversationListInput({
	workspaceId,
	includeArchived = false,
	search,
	pageParam,
}: {
	workspaceId?: string;
	includeArchived?: boolean;
	search?: string;
	pageParam?: string;
}): ListHomeConversationsInput {
	return {
		limit: CONVERSATIONS_PAGE_LIMIT,
		...(pageParam ? { cursor: pageParam } : {}),
		workspaceId,
		includeArchived,
		search: search?.trim() || undefined,
	};
}

/**
 * One cache contract for every conversation-list reader. TanStack Query does
 * not permit a finite query and an infinite query to share a key: the former
 * stores one page while the latter reads `{ pages, pageParams }`. Keeping the
 * options together makes the workspace header -> list transition cache-safe.
 */
export function conversationListQueryOptions(
	workspaceId?: string,
	includeArchived = false,
	search?: string,
) {
	const normalizedSearch = search?.trim() || undefined;
	return {
		queryKey: homeConversationsQueryKey(
			workspaceId,
			includeArchived,
			normalizedSearch,
		),
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			osApi.kernelRuntime.listConversations(
				conversationListInput({
					pageParam,
					workspaceId,
					includeArchived,
					search: normalizedSearch,
				}),
			),
		initialPageParam: undefined as string | undefined,
		// The composite keyset cursor is opaque to the UI; pass it back verbatim.
		getNextPageParam: (lastPage: { nextCursor?: string | null }) =>
			lastPage.nextCursor ?? undefined,
	};
}

export function ChatSidebar({
	activeConversationId,
	onSelect,
	workspaceId,
}: {
	/** `null` means the synthetic "new conversation" state (no thread yet). */
	activeConversationId: string | null;
	onSelect: (conversationId: string | null) => void;
	/** When present, list only conversations durably associated with this Workspace. */
	workspaceId?: string;
}) {
	const queryClient = useQueryClient();
	const [renameTarget, setRenameTarget] = useState<HomeConversation | null>(
		null,
	);
	const [deleteTarget, setDeleteTarget] = useState<HomeConversation | null>(
		null,
	);
	const [showArchived, setShowArchived] = useState(false);
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const normalizedSearch = debouncedSearch.trim() || undefined;
	const groupHeadingPrefix = useId();
	useEffect(() => {
		const timeout = window.setTimeout(() => setDebouncedSearch(search), 250);
		return () => window.clearTimeout(timeout);
	}, [search]);

	const conversations = useInfiniteQuery(
		conversationListQueryOptions(workspaceId, showArchived, normalizedSearch),
	);

	const sorted = useMemo(() => {
		const byId = new Map<string, HomeConversation>();
		for (const page of conversations.data?.pages ?? []) {
			for (const conversation of page.conversations) {
				byId.set(conversation.id, conversation);
			}
		}
		return sortConversations([...byId.values()]);
	}, [conversations.data]);
	const grouped = useMemo(() => groupConversationsByRecency(sorted), [sorted]);

	const invalidate = () =>
		Promise.all([
			queryClient.invalidateQueries({
				queryKey: homeConversationsQueryKey(workspaceId, false),
			}),
			queryClient.invalidateQueries({
				queryKey: homeConversationsQueryKey(workspaceId, true),
			}),
		]);

	/**
	 * The ONE optimistic write in this app, and it is scoped deliberately.
	 *
	 * Rename and pin are the only mutations here that are REVERSIBLE and
	 * IDEMPOTENT: both are event-sourced display overlays (a title, a pinned
	 * marker) whose inverse call restores the previous state exactly, and
	 * neither dispatches a run, spends budget, resolves an approval, publishes
	 * anything, or deletes anything. `CHAT_CONVERSATIONS_QUERY_KEY` is also NOT
	 * in `REALTIME_PATCHED_EVENT_KINDS`' cache set, so no durable frame can race
	 * this write and no optimistic row can survive a frame that contradicts it.
	 *
	 * Delete stays authoritative-only right below: it is destructive, and a row
	 * that vanishes before the server agreed is a lie the operator acts on.
	 *
	 * Rollback is a SNAPSHOT restore, not an inverse patch: an inverse would
	 * lose a concurrent write that landed between `onMutate` and `onError`.
	 */
	const beginOptimistic = (
		conversationId: string,
		patch: (conversation: HomeConversation) => HomeConversation,
	) =>
		beginOptimisticConversationPatch(
			queryClient,
			conversationId,
			patch,
			workspaceId,
			showArchived,
			normalizedSearch,
		);

	const rollbackOptimistic = (context: OptimisticConversationContext) =>
		rollbackOptimisticConversationPatch(queryClient, context);

	const rename = useMutation({
		mutationFn: (input: { conversationId: string; title: string }) =>
			osApi.kernelRuntime.renameConversation(input),
		onMutate: (input) =>
			beginOptimistic(input.conversationId, (conversation) => ({
				...conversation,
				title: input.title,
			})),
		onError: (_error, _input, context) => {
			if (context) rollbackOptimistic(context);
		},
		onSuccess: () => setRenameTarget(null),
		// The server's echo is synthetic, so the refetch — not the response — is
		// what confirms the optimistic value.
		onSettled: invalidate,
	});
	const renameForm = useZodForm({
		schema: renameConversationSchema,
		defaultValues: { title: "" },
		onSubmit: ({ value }) => {
			if (renameTarget)
				rename.mutate({ conversationId: renameTarget.id, title: value.title });
		},
	});

	const pin = useMutation({
		mutationFn: (input: { conversationId: string; pinned: boolean }) =>
			osApi.kernelRuntime.pinConversation(input),
		onMutate: (input) =>
			beginOptimistic(
				input.conversationId,
				pinnedConversationPatch(input.pinned, new Date().toISOString()),
			),
		onError: (_error, _input, context) => {
			if (context) rollbackOptimistic(context);
		},
		onSettled: invalidate,
	});

	const remove = useMutation({
		mutationFn: (input: { conversationId: string }) =>
			osApi.kernelRuntime.deleteConversation(input),
		onSuccess: (_output, variables) => {
			setDeleteTarget(null);
			if (variables.conversationId === activeConversationId) onSelect(null);
		},
		onSettled: invalidate,
	});

	const archive = useMutation({
		mutationFn: (input: { conversationId: string; archived: boolean }) =>
			osApi.kernelRuntime.archiveConversation(input),
		onSuccess: (_output, variables) => {
			if (
				variables.archived &&
				variables.conversationId === activeConversationId
			) {
				onSelect(null);
			}
		},
		onSettled: invalidate,
	});

	const renderMenu = (conversation: HomeConversation) => {
		const actions = conversationMenuActions(conversation);
		return (
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={`Actions for ${conversationTitle(conversation)}`}
							size="icon-sm"
							variant="ghost"
							className="shrink-0 text-kumo-subtle opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 data-[popup-open]:opacity-100"
						/>
					}
				>
					<DotsThree size={16} weight="bold" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem
						onClick={() => {
							setRenameTarget(conversation);
							renameForm.reset({
								title:
									conversationTitle(conversation) ===
									CONVERSATION_TITLE_FALLBACK
										? ""
										: conversationTitle(conversation),
							});
						}}
					>
						<PencilSimple size={14} />
						Rename
					</DropdownMenuItem>
					{actions.archive ? (
						<DropdownMenuItem
							onClick={() =>
								archive.mutate({
									conversationId: conversation.id,
									archived: actions.archive === "archive",
								})
							}
						>
							{actions.archive === "archive" ? (
								<Archive size={14} />
							) : (
								<ArrowCounterClockwise size={14} />
							)}
							{actions.archive === "archive" ? "Archive" : "Restore"}
						</DropdownMenuItem>
					) : null}
					<DropdownMenuItem
						onClick={() =>
							pin.mutate({
								conversationId: conversation.id,
								pinned: actions.pin === "pin",
							})
						}
					>
						{actions.pin === "pin" ? (
							<PushPin size={14} />
						) : (
							<PushPinSlash size={14} />
						)}
						{actions.pin === "pin" ? "Pin" : "Unpin"}
					</DropdownMenuItem>
					{actions.delete ? (
						<DropdownMenuItem
							variant="destructive"
							onClick={() => setDeleteTarget(conversation)}
						>
							<Trash size={14} />
							Delete
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		);
	};

	return (
		<nav
			aria-label="Conversations"
			className="flex min-w-0 flex-col gap-4"
			data-active-conversation={activeConversationId ?? "new"}
		>
			<div className="sticky top-0 z-10 grid gap-3 rounded-xl bg-kumo-base px-3 pt-3 pb-4">
				<div className="flex items-center justify-between gap-2">
					{/* The rail is 275px and the actions are wider when archived is shown
					    ("Hide archived" is the longer label), so the heading is the part
					    that has to yield. Without min-w-0 nothing shrinks and the row
					    overflows the rail. */}
					<h2 className="m-0 min-w-0 truncate font-medium text-kumo-default type-tedix-label">
						Conversations
					</h2>
					{/* Conversations have no create verb — a thread exists once its first
					    message is enqueued, so New is a synthetic unselected state. */}
					<div className="flex shrink-0 items-center gap-2">
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										size="icon-sm"
										variant="ghost"
										aria-label="Conversation list options"
										icon={<DotsThree size={16} />}
									/>
								}
							/>
							<DropdownMenuContent>
								<DropdownMenuItem
									onClick={() => setShowArchived((value) => !value)}
								>
									{showArchived ? "Hide archived" : "Show archived"}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<Button
							size="sm"
							variant="ghost"
							icon={<Plus size={14} />}
							onClick={() => onSelect(null)}
						>
							New
						</Button>
					</div>
				</div>
				<SearchInput
					aria-busy={
						search !== debouncedSearch ||
						(conversations.isFetching && !conversations.isFetchingNextPage)
					}
					aria-label="Search conversations"
					onChange={(event) => setSearch(event.target.value)}
					placeholder="Search conversations…"
					value={search}
				/>
			</div>

			{conversations.isPending && <ListSkeleton rows={5} rowClassName="h-12" />}
			{conversations.isError && (
				<Alert variant="destructive">
					<AlertTitle>Conversations are unavailable</AlertTitle>
					<AlertDescription>
						{(conversations.error as Error).message}
					</AlertDescription>
				</Alert>
			)}
			{conversations.data &&
				sorted.length === 0 &&
				(normalizedSearch ? (
					<ConversationSearchEmpty
						query={normalizedSearch}
						onClear={() => setSearch("")}
					/>
				) : (
					<ConversationsEmpty />
				))}
			{sorted.length > 0 && (
				<div className="grid gap-4">
					{grouped.map((group) => {
						const headingId = `${groupHeadingPrefix}-${group.key}`;
						return (
							<section key={group.key} aria-labelledby={headingId}>
								<h3
									id={headingId}
									className="m-0 mb-1 px-2 font-medium text-kumo-inactive uppercase tracking-[0.08em] type-tedix-label"
								>
									{group.label}
								</h3>
								<ul className="m-0 grid list-none gap-0.5 p-0">
									{group.conversations.map((conversation) => (
										<ConversationRow
											key={conversation.id}
											conversation={conversation}
											active={conversation.id === activeConversationId}
											optimistic={
												(pin.isPending &&
													pin.variables?.conversationId === conversation.id) ||
												(rename.isPending &&
													rename.variables?.conversationId === conversation.id)
											}
											onSelect={(id) => onSelect(id)}
											menu={renderMenu(conversation)}
										/>
									))}
								</ul>
							</section>
						);
					})}
				</div>
			)}
			{conversations.hasNextPage && (
				<Button
					size="sm"
					variant="ghost"
					className="w-fit text-kumo-subtle"
					loading={conversations.isFetchingNextPage}
					onClick={() => conversations.fetchNextPage()}
				>
					{normalizedSearch
						? "Search older conversations"
						: "Show older conversations"}
				</Button>
			)}
			{pin.isError && (
				<p className="text-kumo-danger text-sm" role="alert">
					Could not update the pin: {(pin.error as Error).message}
				</p>
			)}

			<Dialog
				open={renameTarget !== null}
				onOpenChange={(open) => {
					if (!open) {
						setRenameTarget(null);
						rename.reset();
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Rename conversation</DialogTitle>
						<DialogDescription>
							A rename overrides the auto-generated title permanently.
						</DialogDescription>
					</DialogHeader>
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							void renameForm.handleSubmit();
						}}
					>
						<FormField
							form={renameForm}
							name="title"
							label="Conversation title"
						>
							{(field, meta) => (
								<FormInput
									field={field}
									{...meta}
									autoFocus
									disabled={rename.isPending}
									maxLength={200}
									placeholder="Conversation title"
								/>
							)}
						</FormField>
						{rename.isError && (
							<p className="m-0 text-kumo-danger text-sm" role="alert">
								Could not rename: {(rename.error as Error).message}
							</p>
						)}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={rename.isPending}
								onClick={() => setRenameTarget(null)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								loading={rename.isPending}
								disabled={rename.isPending}
							>
								Rename
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={deleteTarget !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDeleteTarget(null);
						remove.reset();
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete conversation</DialogTitle>
						<DialogDescription>
							{deleteTarget
								? `“${conversationTitle(deleteTarget)}” and its messages and run records will be permanently deleted. Active runs and delegations are stopped first. Accepted Work and external outcomes remain. You can’t undo this.`
								: null}
						</DialogDescription>
					</DialogHeader>
					{/* AUTHORITATIVE-ONLY. Delete is destructive: the row stays exactly
					    where it is until the server confirms, and the wait is stated
					    rather than implied by a spinner alone. */}
					{remove.isPending && (
						<p
							className="m-0 text-kumo-subtle text-sm"
							role="status"
							data-slot="delete-pending"
						>
							Waiting for the server to confirm the delete…
						</p>
					)}
					{remove.isError && (
						<p className="m-0 text-kumo-danger text-sm" role="alert">
							Could not delete: {(remove.error as Error).message}
						</p>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={remove.isPending}
							onClick={() => setDeleteTarget(null)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="destructive"
							loading={remove.isPending}
							onClick={() => {
								if (deleteTarget) {
									remove.mutate({ conversationId: deleteTarget.id });
								}
							}}
						>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</nav>
	);
}

/**
 * The selected-conversation sub-header, modeled directly on the Cloudflare
 * Workshop chat: a back chevron to the conversation list, the title inline-
 * editable behind a pencil, and a delete control with confirmation
 * (`ChatInterface.tsx`, "Chat sub-header"). Rename is optimistic like the
 * list's own rename; delete is the same permanent-delete contract the list menu performs.
 */
export function ChatConversationHeader({
	conversationId,
	workspaceId,
	onBack,
	onDeleted,
}: {
	conversationId: string | null;
	workspaceId?: string;
	onBack: () => void;
	onDeleted: () => void;
}) {
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState(false);
	const [titleInput, setTitleInput] = useState("");
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	// The list query is the title's source of truth, so a rename made from the
	// list is reflected here without a second fetch.
	const conversations = useInfiniteQuery({
		...conversationListQueryOptions(workspaceId, false),
		enabled: conversationId !== null,
	});
	// `?? []`, not a deeper optional chain: the fixtures lane answers this
	// endpoint with a stub that has no `conversations` at all, and the header
	// crashed the whole route boundary on `.find` of undefined.
	const conversation =
		conversationId === null
			? null
			: (conversations.data?.pages
					.flatMap((page) => page.conversations ?? [])
					.find(
						(candidate: HomeConversation) => candidate.id === conversationId,
					) ?? null);
	const title = conversation
		? conversationTitle(conversation)
		: CONVERSATION_TITLE_FALLBACK;

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: CHAT_CONVERSATIONS_QUERY_KEY });

	const rename = useMutation({
		mutationFn: (input: { conversationId: string; title: string }) =>
			osApi.kernelRuntime.renameConversation(input),
		onSuccess: () => setEditing(false),
		onSettled: invalidate,
	});
	const remove = useMutation({
		mutationFn: (input: { conversationId: string }) =>
			osApi.kernelRuntime.deleteConversation(input),
		onSuccess: () => {
			setConfirmingDelete(false);
			onDeleted();
		},
		onSettled: invalidate,
	});

	const saveTitle = () => {
		const next = titleInput.trim();
		if (!conversationId || !next || next === title) {
			setEditing(false);
			return;
		}
		rename.mutate({ conversationId, title: next });
	};

	return (
		<div className="canvas-chat-conversation-header flex min-w-0 flex-1 items-center gap-1">
			<Button
				aria-label="Back to conversations"
				onClick={onBack}
				size="icon-sm"
				variant="ghost"
			>
				<CaretLeft size={14} />
			</Button>
			{editing ? (
				<>
					<Input
						aria-label="Conversation title"
						autoFocus
						className="h-7 min-w-0 flex-1"
						onChange={(event) => setTitleInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") saveTitle();
							if (event.key === "Escape") setEditing(false);
						}}
						value={titleInput}
					/>
					<Button
						aria-label="Save conversation title"
						disabled={!titleInput.trim() || rename.isPending}
						onClick={saveTitle}
						size="icon-sm"
						variant="ghost"
					>
						<Check size={13} />
					</Button>
					<Button
						aria-label="Cancel title edit"
						onClick={() => setEditing(false)}
						size="icon-sm"
						variant="ghost"
					>
						<X size={13} />
					</Button>
				</>
			) : (
				<>
					<Text
						as="strong"
						role="control"
						weight="medium"
						truncate
						className="flex-1"
					>
						{title}
					</Text>
					<Button
						aria-label="Rename conversation"
						disabled={conversationId === null}
						onClick={() => {
							setTitleInput(title);
							setEditing(true);
						}}
						size="icon-sm"
						variant="ghost"
					>
						<PencilSimple size={12} />
					</Button>
				</>
			)}
			<Button
				aria-label="Delete conversation"
				className="text-kumo-danger"
				disabled={conversationId === null}
				onClick={() => setConfirmingDelete(true)}
				size="icon-sm"
				variant="ghost"
			>
				<Trash size={13} />
			</Button>
			<Dialog
				onOpenChange={(open) => !open && setConfirmingDelete(false)}
				open={confirmingDelete}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete this conversation?</DialogTitle>
						<DialogDescription>
							"{title}" and its messages and run records are permanently
							deleted. Active runs and delegations stop first. You can’t undo
							this.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							onClick={() => setConfirmingDelete(false)}
							variant="secondary"
						>
							Cancel
						</Button>
						<Button
							disabled={remove.isPending || conversationId === null}
							onClick={() =>
								conversationId && remove.mutate({ conversationId })
							}
							variant="destructive"
						>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
