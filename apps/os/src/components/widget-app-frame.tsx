import {
	PostMessageTransport,
	type AppBridge,
	type AppBridgeEventMap,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
	McpUiHostContext,
	McpUiResourceCsp,
} from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/kumo/button";

export interface WidgetAppFrameProps {
	html: string;
	sandbox: { url: URL; permissions: string; csp?: McpUiResourceCsp };
	createBridge: (context: McpUiHostContext) => AppBridge;
	hostContext: McpUiHostContext;
	toolInput?: Record<string, unknown>;
	toolResult?: Parameters<AppBridge["sendToolResult"]>[0];
	onError: (error: Error) => void;
}

/** One bridge, transport and iframe per effect, including StrictMode replay. */
export function WidgetAppFrame(props: WidgetAppFrameProps) {
	const dialog = useRef<HTMLDialogElement>(null);
	const modeRef = useRef<"inline" | "fullscreen">("inline");
	const [displayMode, setDisplayMode] = useState<"inline" | "fullscreen">(
		"inline",
	);
	const changeMode = useCallback((mode: string) => {
		const element = dialog.current;
		if (
			!element ||
			(mode !== "inline" && mode !== "fullscreen") ||
			mode === modeRef.current
		)
			return modeRef.current;
		// Promote the existing dialog to the top layer: never move the iframe.
		element.close();
		if (mode === "fullscreen") element.showModal();
		else element.show();
		modeRef.current = mode;
		setDisplayMode(mode);
		return mode;
	}, []);
	const container = useRef<HTMLDivElement>(null);
	const latest = useRef(props);
	latest.current = props;
	const activeBridge = useRef<AppBridge | null>(null);
	const [readyBridge, setReadyBridge] = useState<AppBridge | null>(null);
	const { createBridge, sandbox } = props;
	useEffect(() => {
		const bridge = createBridge({
			...latest.current.hostContext,
			displayMode: modeRef.current,
			availableDisplayModes: ["inline", "fullscreen"],
		});
		bridge.onrequestdisplaymode = async ({ mode }) => ({
			mode: changeMode(mode),
		});
		activeBridge.current = bridge;
		const iframe = document.createElement("iframe");
		iframe.title = "Interactive widget";
		iframe.setAttribute("sandbox", sandbox.permissions);
		iframe.style.cssText =
			"width:100%;height:600px;flex:1;min-height:0;border:0;background:transparent";
		let alive = true;
		let injected = false;
		setReadyBridge(null);
		const fail = (error: unknown) => {
			if (alive)
				latest.current.onError(
					error instanceof Error ? error : new Error(String(error)),
				);
		};
		const timer = setTimeout(
			() => fail(new Error("Widget initialization timed out.")),
			15_000,
		);
		const onSandboxReady = () => {
			if (!alive || injected) return;
			injected = true;
			void bridge
				.sendSandboxResourceReady({
					html: latest.current.html,
					csp: sandbox.csp,
				})
				.catch(fail);
		};
		const onInitialized = () => {
			if (!alive) return;
			clearTimeout(timer);
			setReadyBridge(bridge);
		};
		const onSizeChange = ({ height }: AppBridgeEventMap["sizechange"]) => {
			if (
				alive &&
				height !== undefined &&
				Number.isFinite(height) &&
				height > 0
			)
				iframe.style.height = `${height}px`;
		};
		bridge.addEventListener("sandboxready", onSandboxReady);
		bridge.addEventListener("initialized", onInitialized);
		bridge.addEventListener("sizechange", onSizeChange);
		iframe.addEventListener("error", fail);
		// Install the source-checked transport before navigating the opaque proxy.
		container.current?.appendChild(iframe);
		const guest = iframe.contentWindow;
		if (guest) {
			void bridge
				.connect(new PostMessageTransport(guest, guest))
				.then(() => {
					if (alive) iframe.src = sandbox.url.href;
				})
				.catch(fail);
		} else fail(new Error("Widget sandbox window is unavailable."));
		return () => {
			alive = false;
			activeBridge.current = null;
			clearTimeout(timer);
			bridge.removeEventListener("sandboxready", onSandboxReady);
			bridge.removeEventListener("initialized", onInitialized);
			bridge.removeEventListener("sizechange", onSizeChange);
			iframe.removeEventListener("error", fail);
			iframe.remove();
			void bridge
				.close()
				.catch((error: unknown) =>
					console.error("Widget bridge close failed:", error),
				);
		};
	}, [createBridge, sandbox, props.html, changeMode]);
	useEffect(() => {
		if (readyBridge && readyBridge === activeBridge.current)
			readyBridge.setHostContext({
				...props.hostContext,
				displayMode,
				availableDisplayModes: ["inline", "fullscreen"],
			});
	}, [readyBridge, props.hostContext, displayMode]);
	useEffect(() => {
		if (!readyBridge || readyBridge !== activeBridge.current) return;
		void (async () => {
			await readyBridge.sendToolInput({ arguments: props.toolInput ?? {} });
			if (readyBridge === activeBridge.current && props.toolResult)
				await readyBridge.sendToolResult(props.toolResult);
		})().catch((error: unknown) => {
			if (readyBridge === activeBridge.current)
				latest.current.onError(
					error instanceof Error ? error : new Error(String(error)),
				);
		});
	}, [readyBridge, props.toolInput, props.toolResult]);
	return (
		<dialog
			ref={dialog}
			open
			aria-label="Interactive widget"
			onCancel={(event) => {
				event.preventDefault();
				changeMode("inline");
			}}
			className="bg-kumo-base text-kumo-default"
			style={{
				position: displayMode === "fullscreen" ? "fixed" : "relative",
				inset: 0,
				margin: 0,
				padding: 0,
				border: 0,
				width: displayMode === "fullscreen" ? "100dvw" : "100%",
				maxWidth: "none",
				height: displayMode === "fullscreen" ? "100dvh" : "auto",
				maxHeight: "none",
				display: "flex",
				flexDirection: "column",
			}}
		>
			<div className="flex shrink-0 justify-end p-1">
				<Button
					variant="ghost"
					size="xs"
					disabled={!readyBridge}
					onClick={() =>
						changeMode(displayMode === "fullscreen" ? "inline" : "fullscreen")
					}
				>
					{displayMode === "fullscreen" ? "Exit fullscreen" : "Expand widget"}
				</Button>
			</div>
			<div ref={container} className="flex min-h-0 min-w-0 flex-1 flex-col" />
		</dialog>
	);
}
