import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { FeedCard } from "./focus-feed-card";

vi.mock("./feed-outcome-preview", () => ({ FeedOutcomePreview: () => null }));
vi.mock("@/lib/api", () => ({ osApi: {} }));

const items = ["event:a", "eventa"].map((id, index) => ({
	...ActivityFeedItemSchema.parse({
		id,
		actor: "Cedar",
		sentence: `Update ${index + 1}`,
		source: `/work/${index}`,
		projectId: null,
		workItemId: null,
		tediId: null,
		kind: "signal",
		classId: "update",
		importance: "normal",
		at: "2026-10-21T12:00:00Z",
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: false,
		explanation: `Exact receipt ${index + 1}`,
		reactions: [],
	}),
	score: 1,
	unseen: true,
	deadline: false,
	factors: {},
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});
async function mount(onReact = vi.fn().mockResolvedValue(true)) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<>
				{items.map((item) => (
					<FeedCard
						key={item.id}
						item={item}
						actor="Cedar"
						busy={false}
						onReact={onReact}
						onWork={vi.fn()}
					/>
				))}
			</>,
		),
	);
	return onReact;
}
const button = (row: Element, label: string) =>
	row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const namedButton = (row: Element, label: string) =>
	[...row.querySelectorAll("button")].find(
		(node) => node.textContent === label,
	)!;
const region = (trigger: Element) =>
	document.getElementById(trigger.getAttribute("aria-controls")!)!;
async function click(node: HTMLElement) {
	await act(async () => {
		node.focus();
		node.click();
	});
}
async function type(node: HTMLTextAreaElement, value: string) {
	await act(async () => {
		node.focus();
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!.call(node, value);
		node.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

it("keeps stable, distinct row disclosure targets and receipt content behind More without following a story", async () => {
	const onReact = await mount();
	const rows = [...host.querySelectorAll("article")];
	const triggers = rows.flatMap((row) => [
		namedButton(row, "More"),
		button(row, "Comment"),
	]);
	const ids = triggers.map((trigger) => trigger.getAttribute("aria-controls"));
	expect(new Set(ids).size).toBe(4);
	for (const trigger of triggers) {
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(region(trigger).hidden).toBe(true);
	}
	expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
	const story = vi.fn();
	rows[0]!.querySelector(".ft-post-link")!.addEventListener("click", story);
	await click(triggers[0]!);
	expect(region(triggers[0]!).textContent).toContain(items[0]!.explanation);
	expect(region(triggers[0]!).hidden).toBe(false);
	expect(region(triggers[2]!).hidden).toBe(true);
	expect(onReact).toHaveBeenCalledExactlyOnceWith(items[0], "why");
	await click(triggers[0]!);
	expect(region(triggers[0]!).hidden).toBe(true);
	expect(onReact).toHaveBeenCalledTimes(1);
	expect(
		triggers.map((trigger) => trigger.getAttribute("aria-controls")),
	).toEqual(ids);
	expect(story).not.toHaveBeenCalled();
});

it("retains failed note text and focus, then returns successful save focus to its live trigger", async () => {
	const onReact = vi
		.fn()
		.mockResolvedValueOnce(false)
		.mockResolvedValueOnce(true);
	await mount(onReact);
	const rows = [...host.querySelectorAll("article")];
	const comment = button(rows[1]!, "Comment");
	await click(comment);
	expect(document.activeElement).toBe(comment);
	const field = rows[1]!.querySelector("textarea")!;
	await type(field, "  Keep this exact note  ");
	const save = namedButton(rows[1]!, "Save note");
	await click(save);
	expect(field.value).toBe("  Keep this exact note  ");
	expect(document.activeElement).toBe(save);
	expect(region(comment).hidden).toBe(false);
	expect(rows[0]!.querySelector("textarea")).toBeNull();
	await click(save);
	expect(onReact.mock.calls).toEqual([
		[items[1], "comment", "Keep this exact note"],
		[items[1], "comment", "Keep this exact note"],
	]);
	expect(region(comment).hidden).toBe(true);
	expect(document.activeElement).toBe(comment);
	expect(document.activeElement?.isConnected).toBe(true);
	await click(comment);
	expect(rows[1]!.querySelector("textarea")!.value).toBe("");
});

it("closes explicitly without losing an unsaved note and restores trigger focus", async () => {
	const onReact = await mount();
	const row = host.querySelector("article")!;
	const comment = button(row, "Comment");
	await click(comment);
	await type(row.querySelector("textarea")!, "Unsent note");
	await click(namedButton(row, "Close note"));
	expect(document.activeElement).toBe(comment);
	expect(region(comment).hidden).toBe(true);
	await click(comment);
	expect(row.querySelector("textarea")!.value).toBe("Unsent note");
	expect(onReact).not.toHaveBeenCalled();
});

async function mountOne(item: (typeof items)[number]) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<FeedCard
				item={item}
				actor="Cedar"
				busy={false}
				onReact={vi.fn()}
				onWork={vi.fn()}
			/>,
		),
	);
}

it("points a pending decision at its Decisions card without repeating the card", async () => {
	await mountOne({
		...items[0]!,
		id: "decision:fictional-booth",
		kind: "decision",
		needsAction: true,
		sentence: "Staff the booth on Friday? The plan needs two people.",
		explanation: "A long request body that belongs on the card.",
	});
	const deck = "/work?view=deck#card=fictional-booth";
	const chip = [...host.querySelectorAll("a")].find(
		(a) => a.textContent === "Needs you",
	);
	expect(chip?.getAttribute("href")).toBe(deck);
	expect(host.querySelector(".ft-post-link")?.getAttribute("href")).toBe(deck);
	expect(host.textContent).not.toContain("belongs on the card");
	expect(namedButton(host, "More")).toBeUndefined();
});

it("shows a finished result as a green chip with one body line", async () => {
	await mountOne({
		...items[0]!,
		kind: "result",
		done: true,
		sentence: "The release notes are ready. Two sections changed.",
	});
	expect(host.querySelector(".ft-sentence")?.textContent).toBe(
		"The release notes are ready.",
	);
	expect(
		[...host.querySelectorAll(".ft-detail")].map((n) => n.textContent),
	).toEqual(["Two sections changed."]);
	expect(host.textContent).toContain("Finished");
});
