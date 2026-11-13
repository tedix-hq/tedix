import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRuntimeFrame } from "./app-runtime-frame";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

describe("runtime app frame", () => {
	it("notifies scoped revision changes without replacing the running guest", async () => {
		vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(
			() => {},
		);
		const node = document.createElement("div");
		document.body.append(node);
		const root = createRoot(node);
		const render = async (revision: number) =>
			act(async () =>
				root.render(
					<AppRuntimeFrame
						html="<p>Doc</p>"
						title="Doc"
						onCall={async () => ({ ok: true, value: null })}
						outputRevisions={[
							{
								slot: "document",
								outputId: "output",
								revisionId: `r${revision}`,
								revision,
							},
						]}
					/>,
				),
			);
		await render(1);
		const frame = node.querySelector("iframe")!;
		const post = vi
			.spyOn(frame.contentWindow!, "postMessage")
			.mockImplementation(() => {});
		const ready = (source: MessageEventSource | null, origin: string) =>
			window.dispatchEvent(
				new MessageEvent("message", {
					source,
					origin,
					data: {
						jsonrpc: "2.0",
						method: "ui/notifications/sandbox-proxy-ready",
					},
				}),
			);
		await act(async () => {
			ready(window, window.location.origin);
			ready(frame.contentWindow, "https://untrusted.example");
		});
		expect(post).not.toHaveBeenCalled();
		await act(async () => {
			ready(frame.contentWindow, window.location.origin);
		});
		const injections = post.mock.calls.filter(
			([message]) =>
				message.method === "ui/notifications/sandbox-resource-ready",
		).length;
		await render(2);
		expect(node.querySelector("iframe")).toBe(frame);
		expect(
			post.mock.calls.filter(
				([message]) =>
					message.method === "ui/notifications/sandbox-resource-ready",
			),
		).toHaveLength(injections);
		expect(post).toHaveBeenCalledWith(
			{
				jsonrpc: "2.0",
				method: "tedix/outputs-changed",
				params: {
					outputs: [
						{
							slot: "document",
							outputId: "output",
							revisionId: "r2",
							revision: 2,
						},
					],
				},
			},
			window.location.origin,
		);
		await act(async () => root.unmount());
		node.remove();
	});

	it("restarts a silent app twice before saying it did not start", async () => {
		vi.useFakeTimers();
		vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(
			() => {},
		);
		const node = document.createElement("div");
		document.body.append(node);
		const root = createRoot(node);
		await act(async () => {
			root.render(
				<AppRuntimeFrame
					html="<p>app</p>"
					title="Fictional app"
					onCall={async () => ({ ok: true, value: null }) as never}
				/>,
			);
		});
		const state = () =>
			node
				.querySelector("[data-app-runtime-frame]")
				?.getAttribute("data-state");
		const frames = new Set([node.querySelector("iframe")]);
		for (let restart = 0; restart < 2; restart += 1) {
			await act(async () => vi.advanceTimersByTime(15_000));
			expect(state()).toBe("loading");
			frames.add(node.querySelector("iframe"));
		}
		expect(frames.size).toBe(3);
		await act(async () => vi.advanceTimersByTime(15_000));
		expect(state()).toBe("failed");
		expect(node.textContent).toContain("Fictional app did not start");
		await act(async () => root.unmount());
		node.remove();
		vi.useRealTimers();
	});

	it("lets the app copy and translate and nothing more", async () => {
		let src = "";
		vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(
			(value: string) => {
				src = value;
			},
		);
		const node = document.createElement("div");
		document.body.append(node);
		const root = createRoot(node);
		await act(async () => {
			root.render(
				<AppRuntimeFrame
					html="<p>app</p>"
					title="Fictional app"
					onCall={async () => ({ ok: true, value: null }) as never}
				/>,
			);
		});
		const frame = node.querySelector("iframe");
		expect(frame?.getAttribute("allow")).toBe(
			"clipboard-write; translator; language-detector",
		);
		expect(
			JSON.parse(new URL(src).searchParams.get("permissions") ?? "{}"),
		).toEqual({ clipboardWrite: {}, translator: {}, languageDetector: {} });
		await act(async () => root.unmount());
		node.remove();
	});
});
