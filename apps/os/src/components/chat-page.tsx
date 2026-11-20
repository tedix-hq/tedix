import { ChatExecutionDetailsProvider } from "@/components/chat-execution-sheet";
import { FolderPlus } from "@phosphor-icons/react";
import type { HomeConversation } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import {
	holdWorkspaceFirstMessage,
	WORKSPACE_NAME_MAX_CHARS,
	workspaceNameFromQuestion,
} from "@/lib/workspace-first-message";
import { LoadingArea } from "@/components/loading-area";

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
 * The Chat surface: kernel Home conversations with tedis as the agents.
 *
 * Selection is the URL — `/chat?conversation=<id>` — so a thread is a
 * shareable, reloadable link (the embedded widget deep-links here) and
 * picking one from the list is a `replace`, never a history entry per click.
 * No param is the synthetic fresh-thread state: landing on `/chat` lands on a
 * new conversation, not on whichever thread happened to be most recent. A
 * new chat is a plain Home conversation: it creates no workspace. Outputs it
 * makes go to the default workspace until "Save as workspace" gives the chat
 * its own. "New workspace" in a fresh composer instead creates a workspace
 * named after the question and opens it, where the question is sent first.
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
	const selectionGeneration = useRef(0);
	const generation = selectionGeneration.current;
	const startWorkspace = async (question: string) => {
		const { workspace } = await osApi.osWorkspaces.workspaces.create({
			name: workspaceNameFromQuestion(question),
		});
		void queryClient.invalidateQueries({ queryKey: osQueryKeys.workspaces() });
		holdWorkspaceFirstMessage(workspace.id, question);
		await navigate({
			to: "/workspace/$workspaceId",
			params: { workspaceId: workspace.id },
			search: { pane: "chat" },
		});
	};
	// A chat with a picked tedi runs in the person's private workspace, over
	// that workspace's chat connection; Home chats stay on their own path.
	const tediChat = parseTediChatConversationId(activeConversationId);
	const [newTediChat, setNewTediChat] = useState<{
		tediId: string;
		draft: string;
	} | null>(null);
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
		newTediChat !== null && personal.isSuccess && !personalWorkspace;
	const ensure = ensurePersonal.mutate;
	const ensureIdle = ensurePersonal.isIdle;
	useEffect(() => {
		if (needsPersonal && ensureIdle) ensure();
	}, [needsPersonal, ensureIdle, ensure]);
	const showTediChat = tediChat !== null || newTediChat !== null;
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
		selectionGeneration.current += 1;
		setNewConversationKey((key) => key + 1);
		setSelection({ conversationId });
		setNewTediChat(null);
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
						extraConversations={tediRows}
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
					{showTediChat ? null : (
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
								key={newConversationKey}
								workspaceId={tediWorkspaceId}
								conversationId={tediChat?.conversationId ?? null}
								initialTediId={newTediChat?.tediId ?? null}
								initialDraft={newTediChat?.draft}
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
								onPickHome={() => selectConversation(null)}
							/>
						) : personal.isError || ensurePersonal.isError ? (
							<LoadError
								title="This chat couldn't be opened"
								error={personal.error ?? ensurePersonal.error}
								help="Your private workspace, where chats with a tedi run, is not available."
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
							recoverPendingSend={newConversationKey === 0}
							onStartWorkspace={startWorkspace}
							onPickTediForNewChat={(tediId, draft) =>
								setNewTediChat({ tediId, draft })
							}
							conversationId={activeConversationId}
							workspaceId={activeConversation?.workspaceId ?? undefined}
							onConversationCreated={(conversationId, workspaceId) => {
								queryClient.invalidateQueries({
									queryKey: CHAT_CONVERSATIONS_QUERY_KEY,
								});
								// A pending send may finish after the user has selected New.
								if (generation !== selectionGeneration.current) return;
								// Only a conversation that already belongs to a workspace opens
								// there. `pane` must not travel: it would pin an explicit pane.
								if (workspaceId) {
									void navigate({
										to: "/workspace/$workspaceId",
										params: { workspaceId },
										search: { conversation: conversationId },
									});
									return;
								}
								setSelection({ conversationId });
								void navigate({
									to: "/chat",
									search: { conversation: conversationId },
									replace: true,
								});
							}}
						/>
					)}
				</div>
			</Page>
		</ChatExecutionDetailsProvider>
	);
}
