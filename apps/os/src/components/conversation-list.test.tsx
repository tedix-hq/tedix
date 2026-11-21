import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	type ConversationListRow,
	ConversationListView,
	groupConversationRows,
} from "./conversation-list";

// Wednesday 18 November 2026, 15:00 local time.
const NOW = new Date(2026, 10, 18, 15, 0, 0);
const daysAgo = (days: number, hour = 10) =>
	new Date(2026, 10, 18 - days, hour, 0, 0).toISOString();
const row = (
	id: string,
	at: string,
	more: Partial<ConversationListRow> = {},
): ConversationListRow => ({ id, title: `Conversation ${id}`, at, ...more });

describe("groupConversationRows", () => {
	it("puts pinned rows first, then files the rest by the day they were last used", () => {
		const groups = groupConversationRows(
			[
				row("older", daysAgo(9)),
				row("week", daysAgo(3)),
				row("yesterday", daysAgo(1)),
				row("morning", daysAgo(0, 8)),
				row("now", daysAgo(0, 14)),
				row("pinned", daysAgo(30), { pinned: true }),
				row("broken", "not-a-date"),
			],
			NOW,
		);
		expect(
			groups.map((group) => [group.label, group.rows.map((item) => item.id)]),
		).toEqual([
			["Pinned", ["pinned"]],
			["Today", ["now", "morning"]],
			["Yesterday", ["yesterday"]],
			["Previous 7 days", ["week"]],
			["Older", ["older", "broken"]],
		]);
	});
});

describe("ConversationListView", () => {
	const render = (
		rows: ConversationListRow[],
		props: Partial<Parameters<typeof ConversationListView>[0]> = {},
	) =>
		new DOMParser().parseFromString(
			renderToStaticMarkup(
				<ConversationListView
					activeId={null}
					now={NOW}
					onSelect={() => {}}
					rows={rows}
					{...props}
				/>,
			),
			"text/html",
		);

	it("shows who answers, a working step, a waiting request and the open row on one line", () => {
		const doc = render(
			[
				row("a", daysAgo(0), { answeredBy: "Ada" }),
				row("b", daysAgo(0, 9), {
					answeredBy: "Ada",
					working: true,
					step: "Reading the budget",
				}),
				row("c", daysAgo(0, 8), { working: true, needsYou: true }),
			],
			{ activeId: "a" },
		);
		const item = (id: string) =>
			doc.querySelector(`[data-conversation-id="${id}"]`);
		const detail = (id: string) =>
			item(id)?.querySelector('[data-slot="conversation-detail"]')?.textContent;
		expect(item("a")?.getAttribute("data-active")).toBe("true");
		expect(
			item("a")?.querySelector('[aria-current="true"]')?.textContent,
		).toContain("Conversation a");
		expect(detail("a")).toBe("Ada");
		// The current step stands in for the name while the turn works.
		expect(detail("b")).toBe("Reading the budget");
		expect(item("c")?.querySelector('[aria-label="Working"]')).not.toBeNull();
		expect(item("c")?.textContent).toContain("Needs you");
		expect(item("a")?.textContent).not.toContain("Needs you");
	});

	it("marks a pinned row and a change the server has not confirmed", () => {
		const doc = render([
			row("p", daysAgo(0), { pinned: true, pending: true }),
			row("q", daysAgo(0)),
		]);
		const pinned = doc.querySelector('[data-conversation-id="p"]');
		expect(pinned?.querySelector('[aria-label="Pinned"]')).not.toBeNull();
		expect(pinned?.getAttribute("aria-busy")).toBe("true");
		expect(
			doc
				.querySelector('[data-conversation-id="q"]')
				?.hasAttribute("aria-busy"),
		).toBe(false);
	});

	it("offers a menu only on rows with something to change", () => {
		const doc = render(
			[row("a", daysAgo(0)), row("b", daysAgo(0), { renamable: false })],
			{ onRename: () => {} },
		);
		expect(
			doc.querySelector('[aria-label="Actions for Conversation a"]'),
		).not.toBeNull();
		expect(
			doc.querySelector('[aria-label="Actions for Conversation b"]'),
		).toBeNull();
	});

	it("says there is nothing yet, or nothing matches the search", () => {
		const empty = render([]);
		expect(empty.body.textContent).toContain("No conversations yet");
		expect(empty.querySelector('[data-appearance="quiet"]')).not.toBeNull();
		const searched = render([], {
			query: "launch prep",
			onQueryChange: () => {},
		});
		expect(searched.body.textContent).toContain("No conversations found");
		expect(searched.body.textContent).toContain("launch prep");
		expect(searched.body.textContent).toContain("Clear search");
	});
});
