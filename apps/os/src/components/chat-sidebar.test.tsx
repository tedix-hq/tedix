import type { HomeConversation } from "@tedix/api-contract/schemas/kernel-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { relativeTime } from "@/lib/time";
import { homeConversationsQueryKey } from "@/lib/os-query-options";
import {
	ChatConversationHeader,
	ChatSidebar,
	beginOptimisticConversationPatch,
	CHAT_CONVERSATIONS_QUERY_KEY,
	conversationListInput,
	conversationListQueryOptions,
	ConversationSearchEmpty,
	type ConversationPages,
	patchConversationPages,
	pinnedConversationPatch,
	rollbackOptimisticConversationPatch,
	CONVERSATION_TITLE_FALLBACK,
	conversationActivityAt,
	conversationMenuActions,
	ConversationRow,
	ConversationsEmpty,
	conversationTitle,
	groupConversationsByRecency,
	isPinned,
	MAIN_HOME_CONVERSATION_ID,
	sortConversations,
} from "./chat-sidebar";

const NOW = new Date("2026-08-13T12:00:00.000Z");

function conversation(
	overrides: Partial<HomeConversation> & { id: string },
): HomeConversation {
	return {
		organizationId: "33333333-3333-4333-8333-333333333333",
		title: null,
		status: "active",
		channel: "home",
		lastMessageAt: null,
		messageCount: 0,
		createdAt: "2026-08-10T09:00:00.000Z",
		updatedAt: "2026-08-12T09:00:00.000Z",
		pinnedAt: null,
		origin: "human",
		...overrides,
	};
}

describe("conversationTitle", () => {
	it("uses the real title when set", () => {
		expect(
			conversationTitle(
				conversation({ id: "home:main", title: "Launch prep" }),
			),
		).toBe("Launch prep");
	});

	it("falls back on a missing title", () => {
		expect(conversationTitle(conversation({ id: "home:os:abc" }))).toBe(
			CONVERSATION_TITLE_FALLBACK,
		);
	});

	it("treats title === id as untitled, per the contract signal", () => {
		expect(
			conversationTitle(
				conversation({ id: "home:os:abc", title: "home:os:abc" }),
			),
		).toBe(CONVERSATION_TITLE_FALLBACK);
	});

	it("treats a whitespace-only title as untitled", () => {
		expect(
			conversationTitle(conversation({ id: "home:os:abc", title: "   " })),
		).toBe(CONVERSATION_TITLE_FALLBACK);
	});
});

describe("sortConversations", () => {
	it("orders pinned first, then by most recent activity", () => {
		const stale = conversation({
			id: "home:os:stale",
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
		const fresh = conversation({
			id: "home:os:fresh",
			updatedAt: "2026-08-13T00:00:00.000Z",
		});
		const pinnedOld = conversation({
			id: "home:os:pinned-old",
			updatedAt: "2026-07-01T00:00:00.000Z",
			pinnedAt: "2026-07-02T00:00:00.000Z",
		});
		const sorted = sortConversations([stale, fresh, pinnedOld]);
		expect(sorted.map((c) => c.id)).toEqual([
			"home:os:pinned-old",
			"home:os:fresh",
			"home:os:stale",
		]);
	});

	it("falls back to lastMessageAt then createdAt for activity", () => {
		const c = conversation({
			id: "home:os:x",
			updatedAt: null,
			lastMessageAt: "2026-08-11T00:00:00.000Z",
		});
		expect(conversationActivityAt(c)).toBe("2026-08-11T00:00:00.000Z");
		expect(
			conversationActivityAt(
				conversation({ id: "home:os:y", updatedAt: null }),
			),
		).toBe("2026-08-10T09:00:00.000Z");
	});

	it("does not mutate its input", () => {
		const input = [
			conversation({ id: "a", updatedAt: "2026-08-01T00:00:00.000Z" }),
			conversation({
				id: "b",
				pinnedAt: "2026-08-01T00:00:00.000Z",
			}),
		];
		sortConversations(input);
		expect(input.map((c) => c.id)).toEqual(["a", "b"]);
	});
});

describe("groupConversationsByRecency", () => {
	const localDate = (daysBefore: number) => {
		const value = new Date(2026, 7, 13 - daysBefore, 12, 0, 0, 0);
		return value.toISOString();
	};

	it("keeps pinned conversations first and buckets the remaining history", () => {
		const now = new Date(2026, 7, 13, 15, 0, 0, 0);
		const grouped = groupConversationsByRecency(
			sortConversations([
				conversation({ id: "earlier", updatedAt: localDate(10) }),
				conversation({ id: "today", updatedAt: localDate(0) }),
				conversation({ id: "week", updatedAt: localDate(3) }),
				conversation({ id: "yesterday", updatedAt: localDate(1) }),
				conversation({
					id: "pinned",
					updatedAt: localDate(20),
					pinnedAt: localDate(2),
				}),
			]),
			now,
		);

		expect(grouped.map((group) => group.label)).toEqual([
			"Pinned",
			"Today",
			"Yesterday",
			"Earlier this week",
			"Earlier",
		]);
		expect(grouped[0]?.conversations.map((row) => row.id)).toEqual(["pinned"]);
	});

	it("puts invalid activity timestamps in Earlier instead of dropping rows", () => {
		const grouped = groupConversationsByRecency(
			[conversation({ id: "invalid", updatedAt: "not-a-date" })],
			new Date(2026, 7, 13, 15, 0, 0, 0),
		);
		expect(grouped).toHaveLength(1);
		expect(grouped[0]?.key).toBe("earlier");
	});
});

describe("conversation list discovery contract", () => {
	it("trims search and forwards it with the opaque pagination cursor", () => {
		expect(
			conversationListInput({
				workspaceId: "workspace-1",
				includeArchived: true,
				search: "  launch prep  ",
				pageParam: "cursor-2",
			}),
		).toEqual({
			limit: 50,
			cursor: "cursor-2",
			workspaceId: "workspace-1",
			includeArchived: true,
			search: "launch prep",
		});
	});

	it("gives filtered and unfiltered infinite lists separate cache identities", () => {
		const unfiltered = conversationListQueryOptions(undefined, false).queryKey;
		const filtered = conversationListQueryOptions(
			undefined,
			false,
			"launch",
		).queryKey;
		expect(filtered).not.toEqual(unfiltered);
		expect(filtered.at(-1)).toMatchObject({ search: "launch" });
	});

	it("lets base invalidation reach every search-specific cache entry", async () => {
		const queryClient = new QueryClient();
		const filteredKey = homeConversationsQueryKey(undefined, false, "launch");
		queryClient.setQueryData(
			filteredKey,
			pages(conversation({ id: "launch" })),
		);
		await queryClient.invalidateQueries({
			queryKey: homeConversationsQueryKey(undefined, false),
		});
		expect(queryClient.getQueryState(filteredKey)?.isInvalidated).toBe(true);
	});
});

describe("conversationMenuActions", () => {
	it("hides Delete for the undeletable main Home thread", () => {
		expect(
			conversationMenuActions(conversation({ id: MAIN_HOME_CONVERSATION_ID }))
				.delete,
		).toBe(false);
		expect(
			conversationMenuActions(conversation({ id: "home:os:abc" })).delete,
		).toBe(true);
	});

	it("flips between pin and unpin from pinnedAt", () => {
		expect(conversationMenuActions(conversation({ id: "a" })).pin).toBe("pin");
		expect(
			conversationMenuActions(
				conversation({ id: "a", pinnedAt: "2026-08-12T00:00:00.000Z" }),
			).pin,
		).toBe("unpin");
	});

	it("always offers rename", () => {
		expect(
			conversationMenuActions(conversation({ id: MAIN_HOME_CONVERSATION_ID }))
				.rename,
		).toBe(true);
	});

	it("archives topical conversations, restores archived ones, and protects Home", () => {
		expect(conversationMenuActions(conversation({ id: "topic" })).archive).toBe(
			"archive",
		);
		expect(
			conversationMenuActions(conversation({ id: "topic", status: "archived" }))
				.archive,
		).toBe("restore");
		expect(
			conversationMenuActions(conversation({ id: MAIN_HOME_CONVERSATION_ID }))
				.archive,
		).toBeNull();
	});
});

describe("relativeTime", () => {
	it("buckets by recency", () => {
		expect(relativeTime("2026-08-13T11:59:50.000Z", NOW)).toBe("just now");
		expect(relativeTime("2026-08-13T11:55:00.000Z", NOW)).toBe("5m ago");
		expect(relativeTime("2026-08-13T09:00:00.000Z", NOW)).toBe("3h ago");
		expect(relativeTime("2026-08-11T12:00:00.000Z", NOW)).toBe("2d ago");
	});

	it("falls back to a month-day date past a week, and to empty on garbage", () => {
		// Midday UTC keeps the rendered local date stable across timezones.
		expect(relativeTime("2026-07-01T12:00:00.000Z", NOW)).toBe("Jul 1");
		expect(relativeTime("not-a-date", NOW)).toBe("");
	});
});

describe("ConversationRow", () => {
	it("renders the title fallback and the relative time", () => {
		const html = renderToStaticMarkup(
			<ConversationRow
				conversation={conversation({ id: "home:os:abc" })}
				now={NOW}
			/>,
		);
		expect(html).toContain(CONVERSATION_TITLE_FALLBACK);
		expect(html).toContain("1d ago");
		expect(html).toContain('data-conversation-id="home:os:abc"');
		expect(html).not.toContain("data-pinned");
	});

	it("marks pinned conversations with the pin indicator", () => {
		const pinned = conversation({
			id: "home:main",
			title: "Main",
			pinnedAt: "2026-08-12T00:00:00.000Z",
		});
		expect(isPinned(pinned)).toBe(true);
		const html = renderToStaticMarkup(
			<ConversationRow conversation={pinned} now={NOW} />,
		);
		expect(html).toContain('data-pinned="true"');
		expect(html).toContain('data-pin-indicator="true"');
		expect(html).toContain('aria-label="Pinned"');
	});

	it("marks the active row", () => {
		const html = renderToStaticMarkup(
			<ConversationRow
				conversation={conversation({ id: "home:main", title: "Main" })}
				active
				now={NOW}
			/>,
		);
		expect(html).toContain('data-active="true"');
		expect(html).toContain('aria-current="true"');
	});

	it("renders the injected overflow-menu slot", () => {
		const html = renderToStaticMarkup(
			<ConversationRow
				conversation={conversation({ id: "home:os:abc" })}
				now={NOW}
				menu={<span data-testid="menu-slot">menu</span>}
			/>,
		);
		expect(html).toContain('data-testid="menu-slot"');
	});
});

describe("ConversationsEmpty", () => {
	it("offers a simple first-message action", () => {
		const html = renderToStaticMarkup(<ConversationsEmpty />);
		expect(html).toContain('data-appearance="quiet"');
		expect(html).toContain("No conversations yet");
		expect(html).toContain("first message");
		expect(html).not.toContain("Home thread");
	});
});

describe("ConversationSearchEmpty", () => {
	it("names the query and offers a clear action", () => {
		const html = renderToStaticMarkup(
			<ConversationSearchEmpty query="launch prep" onClear={() => {}} />,
		);
		expect(html).toContain("No conversations found");
		expect(html).toContain("launch prep");
		expect(html).toContain("Clear search");
	});
});

// ---------------------------------------------------------------------------
// Optimistic pin/rename — the ONE reversible-write path in this surface
// ---------------------------------------------------------------------------

function pages(...conversations: HomeConversation[]): ConversationPages {
	return {
		pages: [{ conversations, nextCursor: null }],
		pageParams: [undefined],
	};
}

describe("patchConversationPages", () => {
	it("rewrites the named conversation across the loaded pages", () => {
		const data = pages(
			conversation({ id: "home:main" }),
			conversation({ id: "home:os:abc" }),
		);
		const next = patchConversationPages(data, "home:os:abc", (row) => ({
			...row,
			title: "Renamed",
		}));
		expect(next?.pages[0]?.conversations[1]?.title).toBe("Renamed");
		// The untouched row keeps its identity, so React skips re-rendering it.
		expect(next?.pages[0]?.conversations[0]).toBe(
			data.pages[0]?.conversations[0],
		);
	});

	it("returns the SAME reference when the id is not loaded", () => {
		// A conversation this cache has never seen cannot be synthesized here —
		// the row carries timestamps, origin and metadata the mutation lacks — so
		// the optimistic write is a no-op and the invalidate owns the outcome.
		const data = pages(conversation({ id: "home:main" }));
		expect(patchConversationPages(data, "home:os:missing", (row) => row)).toBe(
			data,
		);
	});

	it("no-ops on an unloaded cache", () => {
		expect(
			patchConversationPages(undefined, "home:main", (row) => row),
		).toBeUndefined();
	});
});

describe("pinnedConversationPatch", () => {
	it("writes the pin marker as a string and clears it as null", () => {
		const row = conversation({ id: "home:main" });
		const pinned = pinnedConversationPatch(
			true,
			"2026-08-16T10:00:00.000Z",
		)(row);
		expect(isPinned(pinned)).toBe(true);
		expect(isPinned(pinnedConversationPatch(false, "x")(pinned))).toBe(false);
	});
});

describe("optimistic patch + rollback", () => {
	function client() {
		return new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
	}

	it("applies the pin locally and restores the exact snapshot on rejection", async () => {
		const queryClient = client();
		const seeded = pages(conversation({ id: "home:os:abc" }));
		queryClient.setQueryData(CHAT_CONVERSATIONS_QUERY_KEY, seeded);

		const context = await beginOptimisticConversationPatch(
			queryClient,
			"home:os:abc",
			pinnedConversationPatch(true, "2026-08-16T10:00:00.000Z"),
		);
		const optimistic = queryClient.getQueryData<ConversationPages>(
			CHAT_CONVERSATIONS_QUERY_KEY,
		);
		expect(
			isPinned(optimistic?.pages[0]?.conversations[0] as HomeConversation),
		).toBe(true);

		rollbackOptimisticConversationPatch(queryClient, context);
		// The pre-mutation cache, restored wholesale rather than by inverse patch:
		// an inverse would drop anything that landed in between.
		expect(
			queryClient.getQueryData(CHAT_CONVERSATIONS_QUERY_KEY),
		).toStrictEqual(seeded);
		const restored = queryClient.getQueryData<ConversationPages>(
			CHAT_CONVERSATIONS_QUERY_KEY,
		);
		expect(
			isPinned(restored?.pages[0]?.conversations[0] as HomeConversation),
		).toBe(false);
	});

	it("has nothing to roll back when the list was never loaded", async () => {
		const queryClient = client();
		const context = await beginOptimisticConversationPatch(
			queryClient,
			"home:os:abc",
			pinnedConversationPatch(true, "2026-08-16T10:00:00.000Z"),
		);
		expect(context.previous).toBeUndefined();
		rollbackOptimisticConversationPatch(queryClient, context);
		expect(
			queryClient.getQueryData(CHAT_CONVERSATIONS_QUERY_KEY),
		).toBeUndefined();
	});
});

describe("ConversationRow pending state", () => {
	it("marks an unconfirmed row busy so it is not read as settled", () => {
		const html = renderToStaticMarkup(
			<ConversationRow
				conversation={conversation({ id: "home:os:abc", title: "Renamed" })}
				optimistic
				now={NOW}
			/>,
		);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('data-optimistic="true"');
	});

	it("carries neither attribute once the value is confirmed", () => {
		const html = renderToStaticMarkup(
			<ConversationRow
				conversation={conversation({ id: "home:os:abc", title: "Renamed" })}
				now={NOW}
			/>,
		);
		expect(html).not.toContain("aria-busy");
		expect(html).not.toContain("data-optimistic");
	});
});

/*
 * The conversations rail is 275px, and the header actions are wider when
 * archived rows are shown ("Hide archived" is the longer label). Something has
 * to yield, and it has to be the heading. happy-dom resolves no real widths,
 * so the contract is the rendered class list.
 */
describe("conversations rail header", () => {
	const doc = new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: { queries: { retry: false, enabled: false } },
					})
				}
			>
				<ChatSidebar activeConversationId={null} onSelect={() => {}} />
			</QueryClientProvider>,
		),
		"text/html",
	);
	const heading = [...doc.querySelectorAll("h2")].find(
		(element) => element.textContent?.trim() === "Conversations",
	);

	it("lets the heading shrink and truncate", () => {
		expect(heading?.classList.contains("min-w-0")).toBe(true);
		expect(heading?.classList.contains("truncate")).toBe(true);
	});

	it("keeps the actions at their intrinsic width", () => {
		expect(heading?.nextElementSibling?.classList.contains("shrink-0")).toBe(
			true,
		);
	});

	it("gives the heading a semantic type role, not a raw size", () => {
		expect(heading?.classList.contains("type-tedix-label")).toBe(true);
		expect(heading?.classList.contains("text-xs")).toBe(false);
	});
});

describe("ChatConversationHeader", () => {
	const renderHeader = (conversationId: string | null) =>
		renderToStaticMarkup(
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: { queries: { retry: false, enabled: false } },
					})
				}
			>
				<ChatConversationHeader
					conversationId={conversationId}
					onBack={() => {}}
					onDeleted={() => {}}
				/>
			</QueryClientProvider>,
		);

	it("shows the Cloudflare-style sub-header controls", () => {
		// Back chevron to the list, inline-editable title behind a pencil, and a
		// delete control -- the Workshop chat sub-header, not a surface label.
		const html = renderHeader("home:os:abc");
		expect(html).toContain('aria-label="Back to conversations"');
		expect(html).toContain('aria-label="Rename conversation"');
		expect(html).toContain('aria-label="Delete conversation"');
		expect(html).toContain(CONVERSATION_TITLE_FALLBACK);
		expect(html).not.toContain("Kernel/Home conversation");
	});

	it("keeps back available but disables mutation controls for a fresh thread", () => {
		const html = renderHeader(null);
		// A conversation that does not exist yet cannot be renamed or deleted,
		// but the reader can always go back to the list.
		expect(html).toContain('aria-label="Back to conversations"');
		// Match the WHOLE opening tag: `disabled` serializes before the label.
		expect(
			html.match(/<button[^>]*aria-label="Rename conversation"[^>]*>/)?.[0],
		).toContain("disabled");
		expect(
			html.match(/<button[^>]*aria-label="Delete conversation"[^>]*>/)?.[0],
		).toContain("disabled");
	});
});
