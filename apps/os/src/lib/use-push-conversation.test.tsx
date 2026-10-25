import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { usePushConversation } from "./use-push-conversation";

const publish = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("./api", () => ({ osApi: { webPush: { setVisibility: publish } } }));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.unstubAllGlobals();
	publish.mockClear();
});

function Probe() {
	const ref = usePushConversation("chat-a");
	return <div ref={ref}>Conversation</div>;
}
describe("visible push conversation", () => {
	it("publishes only an intersecting chat and answers only its matching worker probe", async () => {
		let intersect: IntersectionObserverCallback;
		let message: (event: MessageEvent) => void;
		const disconnect = vi.fn();
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(callback: IntersectionObserverCallback) {
					intersect = callback;
				}
				observe() {}
				disconnect = disconnect;
			},
		);
		vi.stubGlobal("Notification", { permission: "granted" });
		const original = Object.getOwnPropertyDescriptor(
			navigator,
			"serviceWorker",
		);
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: {
				addEventListener: (
					_name: string,
					listener: (event: MessageEvent) => void,
				) => {
					message = listener;
				},
				removeEventListener: vi.fn(),
			},
		});
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		cleanups.push(() => {
			act(() => root.unmount());
			host.remove();
			if (original) Object.defineProperty(navigator, "serviceWorker", original);
			else Reflect.deleteProperty(navigator, "serviceWorker");
		});
		await act(async () => {
			root.render(<Probe />);
		});
		await vi.waitFor(() =>
			expect(publish).toHaveBeenLastCalledWith(
				expect.objectContaining({ conversationId: null }),
			),
		);
		await act(async () => {
			intersect!(
				[{ isIntersecting: true }] as IntersectionObserverEntry[],
				{} as IntersectionObserver,
			);
		});
		await vi.waitFor(() =>
			expect(publish).toHaveBeenLastCalledWith(
				expect.objectContaining({ conversationId: "chat-a" }),
			),
		);
		const reply = vi.fn();
		message!({
			data: { type: "tedix-push-visible", conversationId: "chat-b" },
			ports: [{ postMessage: reply }],
		} as unknown as MessageEvent);
		expect(reply).not.toHaveBeenCalled();
		message!({
			data: { type: "tedix-push-visible", conversationId: "chat-a" },
			ports: [{ postMessage: reply }],
		} as unknown as MessageEvent);
		expect(reply).toHaveBeenCalledWith({ conversationId: "chat-a" });
		await act(async () => {
			intersect!(
				[{ isIntersecting: false }] as IntersectionObserverEntry[],
				{} as IntersectionObserver,
			);
		});
		await vi.waitFor(() =>
			expect(publish).toHaveBeenLastCalledWith(
				expect.objectContaining({ conversationId: null }),
			),
		);
	});
});
