import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	APP_RUNTIME_CALL_METHOD,
	type AppRuntimeHostResult,
} from "@/lib/app-runtime-host";
import { widgetSandboxUrl } from "@/components/widget-frame";

/**
 * Mounts a runtime app's client document in the OS sandbox: the same
 * same-origin proxy page and opaque-origin guest the MCP widgets use, so the
 * app cannot read cookies, storage or the OS DOM. The only way out is
 * `tedix.call`, which arrives here as JSON-RPC and is answered by `onCall`,
 * where the role matrix decides.
 */
export interface AppRuntimeFrameProps {
	html: string;
	title: string;
	onCall: (method: unknown, args: unknown) => Promise<AppRuntimeHostResult>;
	/** Fill the pane; otherwise follow the app's reported content height. */
	layout?: "content" | "fill";
}

const PROXY_READY = "ui/notifications/sandbox-proxy-ready";
const RESOURCE_READY = "ui/notifications/sandbox-resource-ready";
/** No network, no nested frames: the proxy turns this into a strict CSP. */
const APP_CSP = {
	connectDomains: [],
	resourceDomains: [],
	frameDomains: [],
	baseUriDomains: [],
};

type JsonRpcMessage = {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
};

export function AppRuntimeFrame({
	html,
	title,
	onCall,
	layout = "content",
}: AppRuntimeFrameProps) {
	const container = useRef<HTMLDivElement>(null);
	const latest = useRef({ html, onCall });
	latest.current = { html, onCall };
	const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

	useEffect(() => {
		const host = container.current;
		if (!host) return;
		const iframe = document.createElement("iframe");
		iframe.title = title;
		// The proxy is our own static document on the OS origin; it is the one
		// that sandboxes the guest (opaque origin, scripts and forms only). Keeping
		// the proxy same-origin is what makes both origin checks exact.
		iframe.setAttribute("referrerpolicy", "no-referrer");
		iframe.style.cssText = "width:100%;border:0;background:transparent";
		// A filled pane keeps a usable floor on a phone, where the panel scrolls
		// instead of bounding its height.
		iframe.style.height = layout === "fill" ? "100%" : "240px";
		iframe.style.minHeight = layout === "fill" ? "320px" : "0";
		iframe.style.flex = layout === "fill" ? "1 1 0px" : "0 0 auto";
		let alive = true;
		setState("loading");
		const timer = setTimeout(() => {
			if (alive) setState("failed");
		}, 15_000);
		const post = (data: unknown) =>
			iframe.contentWindow?.postMessage(data, window.location.origin);
		const onMessage = (event: MessageEvent) => {
			// Only the proxy document we created may speak to this frame.
			if (event.source !== iframe.contentWindow) return;
			if (event.origin !== window.location.origin) return;
			const data = event.data as JsonRpcMessage | null;
			if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") return;
			if (data.method === PROXY_READY) {
				post({
					jsonrpc: "2.0",
					method: RESOURCE_READY,
					params: { html: latest.current.html, csp: APP_CSP },
				});
				clearTimeout(timer);
				if (alive) setState("ready");
				return;
			}
			if (data.method === "tedix/resize" && layout !== "fill") {
				const height =
					typeof data.params === "object" && data.params !== null
						? (data.params as { height?: unknown }).height
						: undefined;
				if (typeof height === "number" && Number.isFinite(height) && height > 0)
					iframe.style.height = `${Math.min(Math.ceil(height) + 2, 4000)}px`;
				return;
			}
			if (data.method !== APP_RUNTIME_CALL_METHOD || data.id === undefined)
				return;
			const params =
				typeof data.params === "object" && data.params !== null
					? (data.params as { method?: unknown; args?: unknown })
					: {};
			void latest.current
				.onCall(params.method, params.args)
				.then((result) => {
					if (!alive) return;
					if (result.ok)
						post({ jsonrpc: "2.0", id: data.id, result: result.value });
					else
						post({
							jsonrpc: "2.0",
							id: data.id,
							error: {
								code: result.error,
								message: result.detail ?? result.error,
								data: result.detail,
							},
						});
				})
				.catch((error: unknown) => {
					if (!alive) return;
					post({
						jsonrpc: "2.0",
						id: data.id,
						error: {
							code: "host_error",
							message: error instanceof Error ? error.message : String(error),
						},
					});
				});
		};
		window.addEventListener("message", onMessage);
		host.appendChild(iframe);
		iframe.src = widgetSandboxUrl().href;
		return () => {
			alive = false;
			clearTimeout(timer);
			window.removeEventListener("message", onMessage);
			iframe.remove();
		};
		// The document is re-sent through the ref when it changes; the iframe is
		// re-created only when the app identity (title) or layout changes.
	}, [title, layout]);

	// A new revision replaces the running document in place.
	useEffect(() => {
		const iframe = container.current?.querySelector("iframe");
		if (!iframe || state !== "ready") return;
		iframe.contentWindow?.postMessage(
			{
				jsonrpc: "2.0",
				method: RESOURCE_READY,
				params: { html, csp: APP_CSP },
			},
			window.location.origin,
		);
	}, [html, state]);

	return (
		<div
			className="flex min-h-0 min-w-0 flex-col"
			data-app-runtime-frame
			data-state={state}
			style={layout === "fill" ? { flex: "1 1 0px" } : undefined}
		>
			{state === "loading" && (
				<Skeleton className="h-24 w-full" aria-label="Loading app" />
			)}
			{state === "failed" && (
				<Alert variant="warning">
					<AlertTitle>{title} did not start</AlertTitle>
					<AlertDescription>
						The app sandbox did not answer. Reload the page to try again.
					</AlertDescription>
				</Alert>
			)}
			<div
				ref={container}
				className="flex min-h-0 min-w-0 flex-col"
				style={layout === "fill" ? { flex: "1 1 0px" } : undefined}
			/>
		</div>
	);
}
