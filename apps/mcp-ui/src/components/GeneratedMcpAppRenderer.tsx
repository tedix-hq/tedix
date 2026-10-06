import { useEffect, useMemo, useState } from "react";
import { resolveStandaloneTheme, WidgetWrapper } from "./WidgetWrapper";
import { readEmbeddedData } from "../lib/read-embedded-spec";
import { useWidgetLayout, useWidgetToolInfo } from "../lib/widget-host-hooks";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const GENERATED_APP_CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"img-src data:",
	"font-src data:",
	"connect-src 'none'",
	"frame-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

type GeneratedMcpAppPayload = {
	html: string;
	renderMode: "sandboxed-html-css";
};

type GeneratedMcpAppTheme = "light" | "dark";

export function resolveGeneratedMcpAppTheme(
	search: string,
	hostTheme: "light" | "dark" | undefined,
): GeneratedMcpAppTheme {
	return resolveStandaloneTheme(
		search,
		hostTheme === "dark" ? "dark" : "light",
	);
}

const GENERATED_APP_THEME_CSS = `<style>
:root{
	color-scheme:light;
	--background:oklch(1 0 0);
	--foreground:oklch(.145 0 0);
	--surface:oklch(1 0 0);
	--surface-secondary:oklch(.98 0 0);
	--surface-tertiary:oklch(.96 0 0);
	--card:oklch(1 0 0);
	--card-foreground:oklch(.145 0 0);
	--muted:oklch(.96 0 0);
	--muted-foreground:oklch(.45 0 0);
	--accent:oklch(.935 0 0);
	--accent-foreground:oklch(.205 0 0);
	--border:oklch(.87 0 0);
}
:root[data-theme="dark"]{
	color-scheme:dark;
	--background:oklch(.22 0 0);
	--foreground:oklch(.985 0 0);
	--surface:oklch(.22 0 0);
	--surface-secondary:oklch(.18 0 0);
	--surface-tertiary:oklch(.145 0 0);
	--card:oklch(.28 0 0);
	--card-foreground:oklch(.985 0 0);
	--muted:oklch(.32 0 0);
	--muted-foreground:oklch(.65 0 0);
	--accent:oklch(.32 0 0);
	--accent-foreground:oklch(.985 0 0);
	--border:oklch(.38 0 0);
}
html,body{
	margin:0;
	min-height:100%;
	background:var(--background);
	color:var(--foreground);
	font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}
</style>`;

export function generatedMcpAppPayloadFrom(
	value: unknown,
	depth = 0,
): GeneratedMcpAppPayload | null {
	if (depth > 6) return null;
	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = generatedMcpAppPayloadFrom(item, depth + 1);
			if (nested) return nested;
		}
		return null;
	}
	if (!isRecord(value)) return null;
	const candidate = value.generatedMcpApp;
	if (isRecord(candidate) && typeof candidate.html === "string") {
		return {
			html: candidate.html,
			renderMode: "sandboxed-html-css",
		};
	}
	for (const nested of Object.values(value)) {
		const payload = generatedMcpAppPayloadFrom(nested, depth + 1);
		if (payload) return payload;
	}
	return null;
}

/**
 * Wrap model-authored markup in a second, capability-free browser sandbox.
 * The outer frame is the MCP App resource and owns the host bridge. The inner
 * frame gets no sandbox tokens, so scripts, forms, navigation, popups, and
 * downloads cannot run; this CSP additionally prevents remote subresources.
 */
export function generatedMcpAppDocument(
	html: string,
	theme: GeneratedMcpAppTheme = "light",
): string {
	const policy = `<meta http-equiv="Content-Security-Policy" content="${GENERATED_APP_CSP}">`;
	const viewport =
		'<meta name="viewport" content="width=device-width, initial-scale=1">';
	return `<!doctype html><html data-theme="${theme}"${theme === "dark" ? ' class="dark"' : ""}><head>${policy}${viewport}${GENERATED_APP_THEME_CSS}</head><body>${html}</body></html>`;
}

function GeneratedMcpAppContent() {
	const toolInfo = useWidgetToolInfo();
	const { theme } = useWidgetLayout();
	const resolvedTheme = resolveGeneratedMcpAppTheme(
		typeof window === "undefined" ? "" : window.location.search,
		theme,
	);
	const [embeddedData] = useState<unknown>(() => readEmbeddedData());
	const payload = useMemo(
		() =>
			generatedMcpAppPayloadFrom(embeddedData) ??
			generatedMcpAppPayloadFrom(toolInfo.output),
		[embeddedData, toolInfo.output],
	);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		if (!loaded) return;
		document.body?.setAttribute("data-render-complete", "true");
		return () => {
			document.body?.removeAttribute("data-render-complete");
		};
	}, [loaded]);

	if (!payload) {
		return (
			<main
				data-render-complete="true"
				className="m-4 rounded-xl border border-border bg-card p-5 text-card-foreground"
			>
				<h1 className="text-base font-semibold">Generated UI unavailable</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					The structured result is still available in the conversation.
				</p>
			</main>
		);
	}

	return (
		<main data-widget-container="true" className="min-h-[420px] w-full p-2">
			<iframe
				title="Generated MCP App"
				sandbox=""
				srcDoc={generatedMcpAppDocument(payload.html, resolvedTheme)}
				onLoad={() => setLoaded(true)}
				className="h-[420px] w-full rounded-xl border border-border bg-background"
			/>
		</main>
	);
}

export default function GeneratedMcpAppRenderer() {
	return (
		<WidgetWrapper>
			<GeneratedMcpAppContent />
		</WidgetWrapper>
	);
}
