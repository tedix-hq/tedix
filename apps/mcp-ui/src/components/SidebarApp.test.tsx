// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import asset from "@tedix/api-contract/assets/attention-app-views.v2.json";
import SidebarApp from "./SidebarApp";

const mocks = vi.hoisted(() => ({
	call: vi.fn(),
	info: { output: null as unknown, isError: false },
}));
vi.mock("../lib/widget-host-hooks", () => ({
	callHostTool: mocks.call,
	useWidgetToolInfo: () => mocks.info,
}));
vi.mock("./WidgetWrapper", () => ({
	WidgetWrapper: ({ children }: { children: unknown }) => children,
}));
vi.mock("../json-render/TedixRenderer", () => ({
	TedixRenderer: ({
		data,
		spec,
	}: {
		data: Record<string, unknown>;
		spec: Record<string, unknown>;
	}) => <div data-view={JSON.stringify(spec)}>{String(data.notice)}</div>,
}));

let root: Root;
let node: HTMLDivElement;
const tabs = [
	{
		id: "deck",
		label: "Deck",
		tool: "show_deck",
	},
	{
		id: "feed",
		label: "Feed",
		tool: "show_feed",
	},
];
const orgs = [
	{ id: "maple", label: "Maple" },
	{ id: "orchard", label: "Orchard" },
];
function manifest(organizations = orgs.slice(0, 1)) {
	return {
		sidebarApp: { title: "Tedix", tabs, accountId: "member", organizations },
	};
}
const result = (data: unknown) => ({ structuredContent: { result: data } });
async function click(label: string) {
	const button = [...node.querySelectorAll("button")].find(
		(button) => button.textContent === label,
	)!;
	await act(async () => {
		button.click();
	});
}
async function select(id: string) {
	await act(async () => {
		const select = node.querySelector("select")!;
		select.value = id;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
beforeEach(() => {
	node = document.createElement("div");
	document.body.appendChild(node);
	root = createRoot(node);
	mocks.info.output = manifest();
	mocks.info.isError = false;
	mocks.call.mockReset().mockImplementation(async (_name, args) => {
		const code = args.code as string;
		if (code.includes("discover.search")) {
			const query = JSON.parse(code.slice(code.indexOf("({") + 1, -1));
			return result({
				results: [
					{
						tool: query.query,
						organization: query.organization,
						authorized: true,
						annotations: { readOnlyHint: true },
						callable: `${query.organization}.${query.query}`,
					},
				],
			});
		}
		return result({
			layoutSpec: code.includes("show_feed")
				? asset.views["attention/showFeed"].layoutSpec
				: asset.views["attention/showDeck"].layoutSpec,
			notice: code.includes("show_feed") ? "Feed loaded" : "Deck loaded",
		});
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	node.remove();
});

describe("sidebar tabs", () => {
	it("opens with the existing Deck view and switches to the existing Feed view", async () => {
		await act(async () => root.render(<SidebarApp />));
		expect(node.textContent).toContain("Deck loaded");
		expect(node.querySelector("[data-view]")?.getAttribute("data-view")).toBe(
			JSON.stringify(asset.views["attention/showDeck"].layoutSpec),
		);
		await click("Feed");
		expect(node.textContent).toContain("Feed loaded");
		expect(node.querySelector("[data-view]")?.getAttribute("data-view")).toBe(
			JSON.stringify(asset.views["attention/showFeed"].layoutSpec),
		);
	});
	it("requires an explicit choice among organizations and clears the previous view on switching", async () => {
		mocks.info.output = manifest(orgs);
		await act(async () => root.render(<SidebarApp />));
		expect(mocks.call).not.toHaveBeenCalled();
		await select("maple");
		expect(node.textContent).toContain("Deck loaded");
		mocks.call.mockImplementation(() => new Promise(() => {}));
		await select("orchard");
		expect(node.textContent).not.toContain("Deck loaded");
		expect(node.textContent).toContain("Loading Deck");
	});
	it("shows a failed read and Refresh retries it", async () => {
		mocks.call.mockRejectedValueOnce(new Error("Connection unavailable"));
		await act(async () => root.render(<SidebarApp />));
		expect(node.querySelector('[role="alert"]')?.textContent).toContain(
			"Connection unavailable",
		);
		await click("Refresh");
		expect(node.textContent).toContain("Deck loaded");
	});
	it("supports arrow-key navigation between tabs", async () => {
		await act(async () => root.render(<SidebarApp />));
		await act(async () => {
			node
				.querySelector('[role="tab"]')!
				.dispatchEvent(
					new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
				);
		});
		expect(
			node.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
		).toBe("Feed");
		expect(document.activeElement?.textContent).toBe("Feed");
	});
	it("ignores an old tab's late response after switching", async () => {
		let finish: (value: unknown) => void = () => {};
		const original = mocks.call.getMockImplementation()!;
		mocks.call.mockImplementation((name, args) =>
			args.code.includes("maple.show_deck")
				? new Promise((resolve) => {
						finish = resolve;
					})
				: original(name, args),
		);
		await act(async () => root.render(<SidebarApp />));
		await click("Feed");
		await act(async () => finish(result({ notice: "Old Deck" })));
		expect(node.textContent).toContain("Feed loaded");
		expect(node.textContent).not.toContain("Old Deck");
	});
});
