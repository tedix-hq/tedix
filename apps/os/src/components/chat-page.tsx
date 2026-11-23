import { ChatExecutionDetailsProvider } from "@/components/chat-execution-sheet";
import { ArrowLeft, FolderPlus } from "@phosphor-icons/react";
import type { HomeConversation } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
	CHAT_CONVERSATIONS_QUERY_KEY,
	ChatConversationHeader,
	ChatSidebar,
	conversationListQueryOptions,
	conversationTitle,
} from "@/components/chat-sidebar";
import {
	ChatTediListFeed,
	ChatTediThread,
} from "@/components/chat-tedi-thread";
import { ChatThread } from "@/components/chat-thread";
import {
	parseTediChatConversationId,
	recentWorkspaceChatRows,
	tediChatConversationId,
	tediChatListRows,
} from "@/lib/chat-tedi-conversations";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";
import { useTediProfiles } from "@/lib/use-tedi-names";
import { useChatWebMcpTools } from "@/components/chat-webmcp-tools";
import { Button } from "@/components/kumo/button";
import { LoadError } from "@/components/kumo/alert";
import { Page } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import type { ChatSearch } from "@/lib/canvas-search";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";
import { LoadingArea } from "@/components/loading-area";

/** Workspace names are capped at 120 characters by the contract. */
const WORKSPACE_NAME_MAX_CHARS = 120;

/**
 * "Save as workspace" for a chat that has none: the conversation and the
 * outputs it made move into a new workspace, which then opens with it.
 */
function SaveAsWorkspaceButton({ conversationId }: { conversationId: string }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const conversations = useInfiniteQuery(
		conversationListQueryOptions(undefined, false),
	);
	const conversation =
		conversations.data?.pages
			.flatMap((page) => page.conversations ?? [])
			.find((candidate: HomeConversation) => candidate.id === conversationId) ??
		null;
	const save = useMutation({
		mutationFn: (input: { conversationId: string; name: string }) =>
			osApi.osWorkspaces.workspaces.createFromConversation(input),
		onSuccess: ({ workspace }) => {
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspaces(),
			});
			void queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
			void queryClient.invalidateQueries({
				queryKey: CHAT_CONVERSATIONS_QUERY_KEY,
			});
			void navigate({
				to: "/workspace/$workspaceId",
				params: { workspaceId: workspace.id },
				search: { conversation: conversationId },
			});
		},
	});
	// Only a chat the list knows to have no workspace can be saved as one.
	if (!conversation || conversation.workspaceId) return null;
	return (
		<div className="flex min-w-0 shrink-0 items-center justify-end gap-2">
			{save.isError ? (
				<Text as="span" role="caption" tone="error">
					{save.error instanceof Error
						? save.error.message
						: "The workspace could not be created."}
				</Text>
			) : null}
			<Button
				loading={save.isPending}
				disabled={save.isPending}
				onClick={() =>
					save.mutate({
						conversationId,
						name: conversationTitle(conversation).slice(
							0,
							WORKSPACE_NAME_MAX_CHARS,
						),
					})
				}
				size="sm"
				variant="ghost"
			>
				<FolderPlus size={14} />
				Save as workspace
			</Button>
		</div>
	);
}

const ignoreConversations = () => {};

/**
 * The Chat surface.
 *
 * Selection is the URL — `/chat?conversation=<id>` — so a thread is a
 * shareable, reloadable link (the embedded widget deep-links here) and
 * picking one from the list is a `replace`, never a history entry per click.
 * No param is the synthetic fresh-thread state: landing on `/chat` lands on a
 * new conversation, not on whichever thread happened to be most recent.
 *
 * A new chat runs in the person's private workspace, over that workspace's
 * chat connection, and its id is `ws:{workspaceId}:{conversationId}`. Older
 * Home conversations (any other id) stay on the Home path, readable and
 * continuable there.
 */
export function ChatPage() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const search: ChatSearch = useSearch({ from: "/_session/_tenant/chat" });
	const routeConversationId = search.conversation ?? null;
	const [selection, setSelection] = useState<{
		conversationId: string | null;
	} | null>(null);
	const activeConversationId = selection
		? selection.conversationId
		: routeConversationId;
	useEffect(() => setSelection(null), [routeConversationId]);
	useChatWebMcpTools();
	const [mobileListOpen, setMobileListOpen] = useState(false);
	const [newConversationKey, setNewConversationKey] = useState(0);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const tediChat = parseTediChatConversationId(activeConversationId);
	const showTediChat = activeConversationId === null || tediChat !== null;
	const personalInput = { input: { create: false } };
	const personal = useQuery({
		...osQuery.osWorkspaces.workspaces.personal.queryOptions(personalInput),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const personalWorkspace = personal.data?.workspace ?? null;
	const ensurePersonal = useMutation({
		mutationFn: () => osApi.osWorkspaces.workspaces.personal({ create: true }),
		onSuccess: (data) => {
			queryClient.setQueryData(
				osQuery.osWorkspaces.workspaces.personal.queryKey(personalInput),
				data,
			);
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspaces(),
			});
		},
	});
	const needsPersonal =
		activeConversationId === null && personal.isSuccess && !personalWorkspace;
	const ensure = ensurePersonal.mutate;
	const ensureIdle = ensurePersonal.isIdle;
	useEffect(() => {
		if (needsPersonal && ensureIdle) ensure();
	}, [needsPersonal, ensureIdle, ensure]);
	const tediWorkspaceId =
		tediChat?.workspaceId ?? personalWorkspace?.id ?? null;
	const [tediConversations, setTediConversations] = useState<
		readonly ConversationSummary[]
	>([]);
	const tediProfiles = useTediProfiles();
	const tediRows = useMemo(
		() =>
			personalWorkspace
				? tediChatListRows(
						personalWorkspace.id,
						personalWorkspace.organizationId,
						tediConversations,
						tediProfiles,
					)
				: [],
		[personalWorkspace, tediConversations, tediProfiles],
	);
	// Chats the person took part in inside their other workspaces.
	const recentWorkspaceChats = useQuery({
		...osQuery.workspaceUnread.recentChats.queryOptions({ input: {} }),
		refetchInterval: 30_000,
	});
	const listRows = useMemo(
		() => [
			...tediRows,
			...recentWorkspaceChatRows(
				recentWorkspaceChats.data?.chats ?? [],
				personalWorkspace?.organizationId ?? "",
				personalWorkspace?.id,
			),
		],
		[tediRows, recentWorkspaceChats.data, personalWorkspace],
	);
	const conversationLookup = useQuery({
		...osQuery.kernelRuntime.listConversations.queryOptions({
			input: {
				conversationId: activeConversationId ?? "",
				includeArchived: true,
				limit: 1,
			},
		}),
		enabled: activeConversationId !== null && tediChat === null,
	});
	const activeConversation = conversationLookup.data?.conversations.find(
		(conversation) => conversation.id === activeConversationId,
	);

	const selectConversation = (conversationId: string | null) => {
		setNewConversationKey((key) => key + 1);
		setSelection({ conversationId });
		setMobileListOpen(false);
		void navigate({
			to: "/chat",
			search: conversationId ? { conversation: conversationId } : {},
			replace: true,
		});
	};

	return (
		<ChatExecutionDetailsProvider
			runId={search.details}
			branchId={search.branch}
			onOpen={(runId) => {
				void navigate({
					to: "/chat",
					search: {
						conversation: activeConversationId ?? undefined,
						details: runId,
					},
					resetScroll: false,
				});
			}}
			onClose={() => {
				void navigate({
					to: "/chat",
					search: { conversation: activeConversationId ?? undefined },
					replace: true,
					resetScroll: false,
				});
			}}
		>
			<Page
				fullHeight
				width="bleed"
				className="flex min-h-0 flex-1 flex-col gap-0 md:flex-row md:gap-4"
			>
				<h1 className="sr-only">Chat</h1>
				<aside
					data-slot="chat-conversation-directory"
					data-focus-ring="inset"
					className={`${mobileListOpen ? "block" : "hidden"} min-h-0 flex-1 overflow-y-auto md:block md:max-h-none md:w-72 md:flex-none md:border-r md:border-kumo-line md:pr-3`}
				>
					<ChatSidebar
						activeConversationId={activeConversationId}
						onSelect={selectConversation}
						extraConversations={listRows}
						personalWorkspace={personalWorkspace ?? undefined}
					/>
					{personalWorkspace && !showTediChat ? (
						<ChatTediListFeed
							workspaceId={personalWorkspace.id}
							onConversations={setTediConversations}
						/>
					) : null}
				</aside>
				<div
					data-slot="chat-active-conversation"
					className={`${mobileListOpen ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 flex-col md:flex`}
				>
					{/* On desktop the list is beside the thread, so the header only
					    carries the open conversation's actions. */}
					{showTediChat ? (
						// The chat brings its own way back once it opens; until then,
						// a phone still needs one to reach the list.
						tediWorkspaceId ? null : (
							<div className="flex h-12 shrink-0 items-center border-kumo-line border-b md:hidden">
								<Button
									aria-label="All conversations"
									onClick={() => setMobileListOpen(true)}
									size="icon-sm"
									variant="ghost"
								>
									<ArrowLeft aria-hidden />
								</Button>
							</div>
						)
					) : (
						<div
							className={`flex h-12 shrink-0 items-center border-kumo-line border-b ${activeConversationId ? "" : "md:hidden"}`}
						>
							<ChatConversationHeader
								conversationId={activeConversationId}
								backClassName="md:hidden"
								detailsOpen={detailsOpen}
								onToggleDetails={() => setDetailsOpen((open) => !open)}
								onBack={() => setMobileListOpen(true)}
								onDeleted={() => {
									selectConversation(null);
									setMobileListOpen(true);
								}}
							/>
						</div>
					)}
					{showTediChat ? (
						tediWorkspaceId ? (
							<ChatTediThread
								key={`${newConversationKey}:${tediWorkspaceId}`}
								workspaceId={tediWorkspaceId}
								conversationId={tediChat?.conversationId ?? null}
								onOpenList={() => setMobileListOpen(true)}
								onSelectConversation={(conversationId) =>
									selectConversation(
										conversationId
											? tediChatConversationId(tediWorkspaceId, conversationId)
											: null,
									)
								}
								onConversationCreated={(conversationId) => {
									const id = tediChatConversationId(
										tediWorkspaceId,
										conversationId,
									);
									setSelection({ conversationId: id });
									void navigate({
										to: "/chat",
										search: { conversation: id },
										replace: true,
									});
								}}
								onConversations={
									tediWorkspaceId === personalWorkspace?.id
										? setTediConversations
										: ignoreConversations
								}
							/>
						) : personal.isError || ensurePersonal.isError ? (
							<LoadError
								title="This chat couldn't be opened"
								error={personal.error ?? ensurePersonal.error}
								help="The private workspace your new chats run in is not available."
								onRetry={() => {
									ensurePersonal.reset();
									void personal.refetch();
								}}
							/>
						) : (
							<LoadingArea className="flex-1" label="Opening the chat" />
						)
					) : activeConversationId && conversationLookup.isPending ? (
						<LoadingArea className="flex-1" label="Loading conversation" />
					) : activeConversationId &&
					  (conversationLookup.isError || !activeConversation) ? (
						<LoadError
							title="This conversation couldn't be loaded"
							error={conversationLookup.error}
							help="It may have been removed, or you may no longer have access."
							onRetry={() => conversationLookup.refetch()}
						/>
					) : (
						<ChatThread
							key={newConversationKey}
							detailsOpen={detailsOpen}
							detailsActions={
								activeConversationId ? (
									<SaveAsWorkspaceButton
										conversationId={activeConversationId}
									/>
								) : null
							}
							conversationId={activeConversationId}
							workspaceId={activeConversation?.workspaceId ?? undefined}
						/>
					)}
				</div>
			</Page>
		</ChatExecutionDetailsProvider>
	);
}
