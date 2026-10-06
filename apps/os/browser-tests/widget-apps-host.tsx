import { createRoot } from "react-dom/client";
import { createWidgetAppBridge } from "../src/components/widget-app-bridge";
import { WidgetAppFrame } from "../src/components/widget-app-frame";

declare global {
	interface Window {
		__MCP_APP_GUEST_BUNDLE__: string;
		__MCP_APP_CALLS__: Array<unknown>;
		__MCP_APP_EVENTS__: Array<{ event: string; value: unknown }>;
		__MCP_APP_UNMOUNT__: () => void;
		__MCP_APP_BRIDGE_CLOSES__: number;
	}
}

const guestHtml = `<!doctype html><html><body>
	<div id="status" data-testid="guest-status" data-state="{}">connecting</div>
	<button id="call-tool">Call host tool</button>
	<script>${window.__MCP_APP_GUEST_BUNDLE__}</script>
</body></html>`;
const calls: Array<unknown> = [];
const events: Array<{ event: string; value: unknown }> = [];
window.__MCP_APP_CALLS__ = calls;
window.__MCP_APP_EVENTS__ = events;
window.__MCP_APP_BRIDGE_CLOSES__ = 0;
const rootElement = document.querySelector<HTMLElement>("#root")!;
const fill = new URLSearchParams(location.search).get("layout") === "fill";
if (fill)
	rootElement.style.cssText =
		"display:flex;flex-direction:column;height:calc(100dvh - 64px);min-height:0";
const root = createRoot(rootElement);
window.__MCP_APP_UNMOUNT__ = () => root.unmount();
root.render(
	<WidgetAppFrame
		html={guestHtml}
		sandbox={{
			url: new URL(
				"/sandbox_proxy.html?permissions=%7B%22camera%22%3A%7B%7D%7D",
				window.location.origin,
			),
			permissions: "allow-scripts allow-forms",
		}}
		createBridge={(context) => {
			const bridge = createWidgetAppBridge(
				async (params) => {
					calls.push(params);
					return {
						content: [{ type: "text", text: "echoed" }],
						structuredContent: { echoed: params.arguments?.value },
					};
				},
				async (params) => {
					if (
						params.structuredContent &&
						typeof params.structuredContent === "object"
					) {
						const event = params.structuredContent as {
							event?: unknown;
							value?: unknown;
						};
						if (typeof event.event === "string")
							events.push({ event: event.event, value: event.value });
					}
					return {};
				},
				context,
				{ camera: {} },
			);
			const close = bridge.close.bind(bridge);
			bridge.close = async () => {
				window.__MCP_APP_BRIDGE_CLOSES__ += 1;
				await close();
			};
			return bridge;
		}}
		hostContext={{ theme: "dark", locale: "en-US" }}
		layout={fill ? "fill" : "content"}
		toolInput={{ value: "host input" }}
		toolResult={{
			content: [{ type: "text", text: "host result" }],
			structuredContent: { answer: 42 },
		}}
		onError={(error) => {
			console.error(error);
			(document.body.dataset as DOMStringMap).error = error.message;
		}}
	/>,
);
