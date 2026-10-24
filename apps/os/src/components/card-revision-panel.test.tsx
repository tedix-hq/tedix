import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { CardRevisionPanel } from "./card-revision-panel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("focuses committed feedback and preserves its return target across selection updates", async () => {
	const host = document.createElement("section");
	host.tabIndex = 0;
	document.body.append(host);
	const root = createRoot(host);
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	const runFrames = () => {
		const pending = [...frames.values()];
		frames.clear();
		for (const callback of pending) callback(performance.now());
	};
	const client = new QueryClient({
		defaultOptions: { queries: { enabled: false } },
	});
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<div data-card-feedback-content tabIndex={-1}>
						Hi Morgan,
					</div>
					<CardRevisionPanel target={{ requestId: "draft", version: 1 }} />
				</QueryClientProvider>,
			),
		);
		runFrames();
		host.focus();
		await act(async () => {
			host.dispatchEvent(
				new KeyboardEvent("keydown", { key: "c", bubbles: true }),
			);
			runFrames();
		});
		runFrames();
		expect(document.activeElement).toBe(
			host.querySelector('[aria-label="What should change?"]'),
		);
		const content = host.querySelector<HTMLElement>(
			"[data-card-feedback-content]",
		)!;
		content.focus();
		const range = document.createRange();
		range.selectNodeContents(content);
		window.getSelection()!.removeAllRanges();
		window.getSelection()!.addRange(range);
		window.getSelection()!.getRangeAt(0).getBoundingClientRect = () =>
			new DOMRect(0, 0, 100, 20);
		const select = async () => {
			await act(async () =>
				content.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true })),
			);
			runFrames();
		};
		await select();
		const dialog = document.querySelector<HTMLElement>(
			'[aria-label="Comment on selected text"]',
		)!;
		expect(document.activeElement).toBe(dialog);
		await select();
		await act(async () =>
			dialog.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
		);
		runFrames();
		expect(document.activeElement).toBe(content);
	} finally {
		act(() => root.unmount());
		client.clear();
		host.remove();
		vi.unstubAllGlobals();
	}
});
