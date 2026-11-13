import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	APP_RUNTIME_CALL_METHOD,
	APP_RUNTIME_OUTPUTS_CHANGED_METHOD,
	type AppRuntimeOutputRevision,
	APP_RUNTIME_LANGUAGE_METHOD,
	APP_RUNTIME_TRANSLATE_TEXT_METHOD,
	APP_RUNTIME_TRANSLATION_METHOD,
	type AppRuntimeHostResult,
} from "@/lib/app-runtime-host";
import type { AppRuntimeTranslationChannel } from "@/lib/app-runtime-translation";
import { widgetSandboxUrl } from "@/components/widget-frame";
import {
	APP_RUNTIME_THEME_METHOD,
	appRuntimeThemeCss,
	readAppRuntimeTheme,
	watchAppRuntimeTheme,
	withAppRuntimeTheme,
} from "@/lib/app-runtime-theme";

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
	/** The host's Translate, wired to the app document once it is ready. */
	translation?: AppRuntimeTranslationChannel;
	outputRevisions?: readonly AppRuntimeOutputRevision[];
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

/** How long one start may take before the frame is rebuilt. */
const START_TIMEOUT_MS = 15_000;
/** Quiet restarts before the person is told the app did not start. */
const AUTO_RETRIES = 2;

/** The last height each app asked for, so reopening it does not jump. */
const lastHeights = new Map<string, number>();

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
	translation,
	outputRevisions = [],
}: AppRuntimeFrameProps) {
	const container = useRef<HTMLDivElement>(null);
	const latest = useRef({ html, onCall, translation, outputRevisions });
	latest.current = { html, onCall, translation, outputRevisions };
	const outputRevisionKey = JSON.stringify(outputRevisions);
	const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
	const [attempt, setAttempt] = useState(0);
	const autoRetries = useRef(0);

	useEffect(() => {
		const host = container.current;
		if (!host) return;
		const iframe = document.createElement("iframe");
		iframe.title = title;
		// The proxy is our own static document on the OS origin; it is the one
		// that sandboxes the guest (opaque origin, scripts and forms only). Keeping
		// the proxy same-origin is what makes both origin checks exact.
		iframe.setAttribute("referrerpolicy", "no-referrer");
		// Copy buttons need the clipboard and the host's Translate needs the
		// browser's on-device translator and language detector; the proxy passes
		// the grants to the guest.
		iframe.setAttribute(
			"allow",
			"clipboard-write; translator; language-detector",
		);
		iframe.style.cssText = "width:100%;border:0;background:transparent";
		// A filled pane keeps a usable floor on a phone, where the panel scrolls
		// instead of bounding its height.
		iframe.style.height =
			layout === "fill" ? "100%" : `${lastHeights.get(title) ?? 240}px`;
		iframe.style.minHeight = layout === "fill" ? "320px" : "0";
		iframe.style.flex = layout === "fill" ? "1 1 0px" : "0 0 auto";
		let alive = true;
		setState("loading");
		const timer = setTimeout(() => {
			if (!alive) return;
			if (autoRetries.current < AUTO_RETRIES) {
				autoRetries.current += 1;
				setAttempt((n) => n + 1);
			} else setState("failed");
		}, START_TIMEOUT_MS);
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
					params: {
						html: withAppRuntimeTheme(
							latest.current.html,
							readAppRuntimeTheme(),
						),
						csp: APP_CSP,
					},
				});
				latest.current.translation?.attach(post);
				clearTimeout(timer);
				autoRetries.current = 0;
				if (alive) setState("ready");
				return;
			}
			if (
				data.method === APP_RUNTIME_TRANSLATION_METHOD ||
				data.method === APP_RUNTIME_LANGUAGE_METHOD
			) {
				latest.current.translation?.receive(data.method, data.params);
				return;
			}
			if (
				data.method === APP_RUNTIME_TRANSLATE_TEXT_METHOD &&
				data.id !== undefined
			) {
				const text = (data.params as { text?: unknown } | null)?.text;
				const translation = latest.current.translation;
				void (
					typeof text === "string" && translation
						? translation.translateText(text)
						: Promise.reject(new Error("No translation"))
				).then(
					(result) => {
						if (alive) post({ jsonrpc: "2.0", id: data.id, result });
					},
					() => {
						if (alive)
							post({
								jsonrpc: "2.0",
								id: data.id,
								error: {
									code: "translation_failed",
									message: "translation_failed",
								},
							});
					},
				);
				return;
			}
			if (data.method === "tedix/resize" && layout !== "fill") {
				const height =
					typeof data.params === "object" && data.params !== null
						? (data.params as { height?: unknown }).height
						: undefined;
				if (
					typeof height === "number" &&
					Number.isFinite(height) &&
					height > 0
				) {
					const next = Math.min(Math.ceil(height) + 2, 4000);
					lastHeights.set(title, next);
					iframe.style.height = `${next}px`;
				}
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
		iframe.src = widgetSandboxUrl({
			clipboardWrite: {},
			translator: {},
			languageDetector: {},
		}).href;
		return () => {
			alive = false;
			latest.current.translation?.attach(null);
			clearTimeout(timer);
			window.removeEventListener("message", onMessage);
			iframe.remove();
		};
		// The document is re-sent through the ref when it changes; the iframe is
		// re-created only when the app identity (title) or layout changes.
	}, [title, layout, attempt]);

	// A kept-alive app can be shown again by a new panel with a new Translate
	// channel; hand the running document to whichever channel is current.
	useEffect(() => {
		if (state !== "ready") return;
		translation?.attach((data) =>
			container.current
				?.querySelector("iframe")
				?.contentWindow?.postMessage(data, window.location.origin),
		);
	}, [translation, state]);

	useEffect(() => {
		if (state !== "ready") return;
		container.current?.querySelector("iframe")?.contentWindow?.postMessage(
			{
				jsonrpc: "2.0",
				method: APP_RUNTIME_OUTPUTS_CHANGED_METHOD,
				params: { outputs: latest.current.outputRevisions },
			},
			window.location.origin,
		);
	}, [outputRevisionKey, state]);

	// A change of light/dark, organization colors or the motion setting
	// restyles the running app without reloading it.
	useEffect(() => {
		if (state !== "ready") return;
		return watchAppRuntimeTheme(() =>
			container.current?.querySelector("iframe")?.contentWindow?.postMessage(
				{
					jsonrpc: "2.0",
					method: APP_RUNTIME_THEME_METHOD,
					params: { css: appRuntimeThemeCss(readAppRuntimeTheme()) },
				},
				window.location.origin,
			),
		);
	}, [state]);

	// A new revision replaces the running document in place.
	useEffect(() => {
		const iframe = container.current?.querySelector("iframe");
		if (!iframe || state !== "ready") return;
		iframe.contentWindow?.postMessage(
			{
				jsonrpc: "2.0",
				method: RESOURCE_READY,
				params: {
					html: withAppRuntimeTheme(html, readAppRuntimeTheme()),
					csp: APP_CSP,
				},
			},
			window.location.origin,
		);
		// The new document starts in its original language.
		latest.current.translation?.attach((data) =>
			iframe.contentWindow?.postMessage(data, window.location.origin),
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
				<Skeleton
					className="w-full"
					style={{
						height:
							layout === "fill" ? "100%" : (lastHeights.get(title) ?? 240),
						minHeight: 96,
					}}
					aria-label="Loading app"
				/>
			)}
			{state === "failed" && (
				<Alert variant="warning">
					<AlertTitle>{title} did not start</AlertTitle>
					<AlertDescription>
						The app did not answer in time. Your saved work is not affected.
					</AlertDescription>
					<Button
						size="sm"
						variant="secondary"
						onClick={() => {
							autoRetries.current = 0;
							setAttempt((n) => n + 1);
						}}
					>
						Try again
					</Button>
				</Alert>
			)}
			{/* The frame loads behind the placeholder, then takes its place. */}
			<div
				ref={container}
				className="flex min-h-0 min-w-0 flex-col"
				style={{
					...(layout === "fill" ? { flex: "1 1 0px" } : {}),
					...(state === "ready" ? {} : { display: "none" }),
				}}
			/>
		</div>
	);
}
