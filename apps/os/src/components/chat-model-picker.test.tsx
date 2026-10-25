import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ChatModelPicker } from "@/components/chat-model-picker";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fast = { ref: "fast", label: "Fast" };
const deep = { ref: "deep", label: "Deep" };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});

async function render(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(node));
	return host.querySelector<HTMLButtonElement>("button")!;
}

it("reads Auto and opens no menu when nothing is selectable", async () => {
	const button = await render(
		<ChatModelPicker
			models={[]}
			choices={[]}
			selectedRef={null}
			onSelect={vi.fn()}
		/>,
	);
	expect(button.textContent).toBe("Auto");
	expect(button.disabled).toBe(true);
	await act(async () => button.click());
	expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("names the selected model and marks it in the menu", async () => {
	const onSelect = vi.fn();
	const button = await render(
		<ChatModelPicker
			models={[fast, deep]}
			choices={[fast, deep]}
			selectedRef="deep"
			onSelect={onSelect}
		/>,
	);
	expect(button.textContent).toBe("Deep");
	await act(async () => button.click());
	const items = [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	];
	expect(items.map((item) => item.textContent)).toEqual(["Fast", "Deep"]);
	expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([
		null,
		"true",
	]);
	expect(items[1]!.querySelector("svg")).not.toBeNull();
	await act(async () => items[0]!.click());
	expect(onSelect).toHaveBeenCalledExactlyOnceWith("fast");
});
