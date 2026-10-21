import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { cardSourceOptions } from "@/lib/card-source-filter";
import { CardSourceFilter } from "./card-source-filter";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = "11111111-1111-4111-8111-111111111111";
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = undefined;
});

async function mount(value: string, onValueChange = vi.fn()) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const options = cardSourceOptions(
		[
			{ label: "Inbox", workspaceId: HOME },
			{ label: "Social", workspaceId: HOME },
		],
		() => "Home",
	);
	await act(async () =>
		root!.render(
			<CardSourceFilter
				value={value}
				options={options}
				onValueChange={onValueChange}
			/>,
		),
	);
	return onValueChange;
}

const trigger = () =>
	host!.querySelector<HTMLElement>('[aria-label="Card source"]');

it("renders nothing when no factory feeds the view", async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<CardSourceFilter value="all" options={[]} onValueChange={vi.fn()} />,
		),
	);
	expect(host.textContent).toBe("");
});

it("names the chip Source until a source is chosen, then the source", async () => {
	await mount("all");
	expect(trigger()?.textContent).toContain("Source");
	act(() => root!.unmount());
	host!.remove();
	await mount("factory:Social");
	expect(trigger()?.textContent).toContain("Social");
});

it("offers Work, each factory and the workspace, and reports the choice", async () => {
	const onValueChange = await mount("all");
	await act(async () => trigger()!.click());
	await vi.waitFor(() =>
		expect(document.querySelectorAll('[role="option"]').length).toBe(5),
	);
	expect(
		[...document.querySelectorAll('[role="option"]')].map(
			(option) => option.textContent,
		),
	).toEqual(["All sources", "Work", "Inbox", "Social", "In Home"]);
	await act(async () =>
		[...document.querySelectorAll<HTMLElement>('[role="option"]')]
			.find((option) => option.textContent === "Inbox")!
			.click(),
	);
	expect(onValueChange).toHaveBeenCalledWith("factory:Inbox");
});
