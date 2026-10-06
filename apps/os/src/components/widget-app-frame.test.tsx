import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/ext-apps";
import { WidgetAppFrame, type WidgetAppFrameProps } from "./widget-app-frame";
import { createWidgetAppBridge } from "./widget-app-bridge";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

describe("official bridge frame lifecycle", () => {
	it("replays StrictMode safely, initializes theme/permissions, orders data and cleans up", async () => {
		// happy-dom replaces Window objects on navigation; browsers retain WindowProxy.
		vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(
			() => {},
		);
		const node = document.createElement("div");
		document.body.append(node);
		const root = createRoot(node);
		const bridges: ReturnType<typeof createWidgetAppBridge>[] = [];
		const props: WidgetAppFrameProps = {
			html: "<html>widget</html>",
			sandbox: {
				url: new URL("/sandbox_proxy.html", window.location.href),
				permissions: "allow-scripts allow-forms",
				csp: { connectDomains: [] },
			},
			createBridge: (context) => {
				const b = createWidgetAppBridge(
					async () => ({ content: [] }),
					async () => ({}),
					context,
					{ camera: {} },
				);
				bridges.push(b);
				return b;
			},
			hostContext: { theme: "light" },
			toolResult: { content: [], structuredContent: [1, 2] },
			onError: vi.fn(),
		};
		try {
			await act(async () =>
				root.render(
					<StrictMode>
						<WidgetAppFrame {...props} />
					</StrictMode>,
				),
			);
			expect(bridges).toHaveLength(2);
			expect(node.querySelectorAll("iframe")).toHaveLength(1);
			const frame = node.querySelector("iframe")!;
			expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
			const post = vi
				.spyOn(frame.contentWindow!, "postMessage")
				.mockImplementation(() => {});
			const send = async (data: unknown, source = frame.contentWindow) => {
				await act(async () =>
					window.dispatchEvent(new MessageEvent("message", { source, data })),
				);
			};
			await send(
				{ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" },
				window,
			);
			expect(post).not.toHaveBeenCalled();
			await send({
				jsonrpc: "2.0",
				method: "ui/notifications/sandbox-proxy-ready",
			});
			expect(post.mock.calls[0]?.[0]).toMatchObject({
				method: "ui/notifications/sandbox-resource-ready",
				params: { html: props.html, csp: props.sandbox.csp },
			});
			await send({
				jsonrpc: "2.0",
				id: 1,
				method: "ui/initialize",
				params: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					appInfo: { name: "test", version: "1" },
					appCapabilities: {},
				},
			});
			expect(post.mock.calls.map((c) => c[0])).toContainEqual(
				expect.objectContaining({
					id: 1,
					result: expect.objectContaining({
						hostContext: {
							theme: "light",
							displayMode: "inline",
							availableDisplayModes: ["inline", "fullscreen"],
						},
						hostCapabilities: expect.objectContaining({
							sandbox: { permissions: { camera: {} } },
						}),
					}),
				}),
			);
			expect(post.mock.calls.map((c) => c[0])).not.toContainEqual(
				expect.objectContaining({ method: "ui/notifications/tool-result" }),
			);
			await send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
			const methods = post.mock.calls.map(
				(c) => (c[0] as { method?: string }).method,
			);
			expect(methods.indexOf("ui/notifications/tool-input")).toBeLessThan(
				methods.indexOf("ui/notifications/tool-result"),
			);
			expect(post.mock.calls.map((c) => c[0])).toContainEqual(
				expect.objectContaining({
					method: "ui/notifications/tool-result",
					params: { content: [], structuredContent: [1, 2] },
				}),
			);
			await act(async () =>
				root.render(
					<StrictMode>
						<WidgetAppFrame {...props} hostContext={{ theme: "dark" }} />
					</StrictMode>,
				),
			);
			expect(post.mock.calls.map((c) => c[0])).toContainEqual(
				expect.objectContaining({
					method: "ui/notifications/host-context-changed",
					params: { theme: "dark" },
				}),
			);
			expect(bridges).toHaveLength(2);
			const dialog = node.querySelector("dialog")!;
			const promote = vi.spyOn(dialog, "showModal");
			await send({
				jsonrpc: "2.0",
				id: 2,
				method: "ui/request-display-mode",
				params: { mode: "fullscreen" },
			});
			expect(promote).toHaveBeenCalledOnce();
			expect(post.mock.calls.map((c) => c[0])).toContainEqual(
				expect.objectContaining({ id: 2, result: { mode: "fullscreen" } }),
			);
			expect(node.querySelector("iframe")).toBe(frame);
			expect(dialog.style.position).toBe("fixed");
			await send({
				jsonrpc: "2.0",
				id: 3,
				method: "ui/request-display-mode",
				params: { mode: "pip" },
			});
			expect(post.mock.calls.map((c) => c[0])).toContainEqual(
				expect.objectContaining({ id: 3, result: { mode: "fullscreen" } }),
			);
			await act(async () => {
				dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
			});
			expect(dialog.style.position).toBe("relative");
			expect(node.querySelector("iframe")).toBe(frame);
			expect(bridges).toHaveLength(2);
			const close = vi.spyOn(bridges[1]!, "close");
			await act(async () => root.unmount());
			expect(close).toHaveBeenCalledOnce();
			expect(node.querySelector("iframe")).toBeNull();
			expect(props.onError).not.toHaveBeenCalled();
		} finally {
			node.remove();
		}
	});
});
