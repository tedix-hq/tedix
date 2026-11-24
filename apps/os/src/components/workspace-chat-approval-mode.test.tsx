import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ApprovalModePicker } from "./workspace-chat-approval-mode";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});

async function open(onRaise?: (mode: string) => void) {
	const onChange = vi.fn();
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
	await act(async () =>
		root.render(
			<ApprovalModePicker
				state={{ mode: "ask_every_time", highest: "ask_for_changes" }}
				onChange={onChange}
				onRaise={onRaise}
			/>,
		),
	);
	await act(async () =>
		document
			.querySelector<HTMLButtonElement>('[data-kumo-part="trigger"]')
			?.click(),
	);
	const option = (label: string) =>
		[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
			(item) => item.textContent?.startsWith(label),
		);
	await vi.waitFor(() => expect(option("Auto")).toBeDefined());
	return { onChange, option };
}

it("raises the workspace's limit when a mode above it is picked", async () => {
	const onRaise = vi.fn();
	const { onChange, option } = await open(onRaise);
	await act(async () => option("Auto")?.click());
	expect(onRaise).toHaveBeenCalledWith("auto");
	expect(onChange).not.toHaveBeenCalled();
});

it("keeps a mode above the limit unavailable when it cannot be raised here", async () => {
	const { option } = await open();
	expect(option("Auto")?.getAttribute("aria-disabled")).toBe("true");
	expect(option("Auto")?.textContent).toContain(
		"This workspace allows up to Ask for changes",
	);
});
