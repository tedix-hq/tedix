/**
 * The look an app inherits from Tedix OS. The app runs in a sandboxed frame
 * that cannot read the OS stylesheet, so the host resolves a fixed list of
 * tokens to plain values and hands them in as CSS variables: once inside the
 * document it sends, and again whenever the person changes light/dark, the
 * organization theme or the motion setting.
 */
export const APP_RUNTIME_THEME_METHOD = "tedix/theme";

/** Where the app document keeps the theme; the host fills and replaces it. */
export const APP_RUNTIME_THEME_STYLE_ID = "tedix-theme";
export const APP_RUNTIME_THEME_PLACEHOLDER = `<style id="${APP_RUNTIME_THEME_STYLE_ID}"></style>`;

/** App-facing variable, and the OS variable it is read from. */
const COLOR_TOKENS = [
	["--tedix-bg", "--background"],
	["--tedix-fg", "--foreground"],
	["--tedix-surface", "--card"],
	["--tedix-muted", "--muted"],
	["--tedix-muted-fg", "--muted-foreground"],
	["--tedix-border", "--border"],
	["--tedix-primary", "--primary"],
	["--tedix-on-primary", "--primary-foreground"],
	["--tedix-danger", "--tedix-status-danger"],
	["--tedix-warning", "--tedix-status-warning"],
	["--tedix-success", "--tedix-status-success"],
] as const;

const TEXT_TOKENS = [
	["--tedix-font", "--font-sans"],
	["--tedix-font-mono", "--font-mono"],
	["--tedix-radius", "--radius"],
] as const;

export interface AppRuntimeTheme {
	mode: "light" | "dark";
	reducedMotion: boolean;
	tokens: Record<string, string>;
}

/** Keep a value inside its declaration: no block, rule or tag can start. */
function safeValue(value: string): string {
	return value.replace(/[;{}<>\\]/g, "").trim();
}

/** Read the current OS look from the page. */
export function readAppRuntimeTheme(
	root: HTMLElement = document.documentElement,
): AppRuntimeTheme {
	const style = getComputedStyle(root);
	const tokens: Record<string, string> = {};
	// A probe resolves var(), color-mix() and light-dark() to one plain color.
	const probe = document.createElement("span");
	probe.style.display = "none";
	root.append(probe);
	for (const [name, source] of COLOR_TOKENS) {
		if (!style.getPropertyValue(source).trim()) continue;
		probe.style.color = "";
		probe.style.color = `var(${source})`;
		const color = safeValue(getComputedStyle(probe).color);
		if (color) tokens[name] = color;
	}
	probe.remove();
	for (const [name, source] of TEXT_TOKENS) {
		const value = safeValue(style.getPropertyValue(source));
		if (value) tokens[name] = value;
	}
	return {
		mode:
			root.dataset.mode === "dark" || root.classList.contains("dark")
				? "dark"
				: "light",
		reducedMotion: root.dataset.motion === "reduced",
		tokens,
	};
}

/** The stylesheet text the app document carries for a theme. */
export function appRuntimeThemeCss(theme: AppRuntimeTheme): string {
	const variables = Object.entries(theme.tokens)
		.map(([name, value]) => `${name}:${safeValue(value)}`)
		.join(";");
	return (
		`:root{color-scheme:${theme.mode};${variables}}` +
		(theme.reducedMotion
			? "*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}"
			: "")
	);
}

/** Put the theme into an app document before it is sent to the frame. */
export function withAppRuntimeTheme(
	html: string,
	theme: AppRuntimeTheme,
): string {
	return html.replace(
		APP_RUNTIME_THEME_PLACEHOLDER,
		`<style id="${APP_RUNTIME_THEME_STYLE_ID}">${appRuntimeThemeCss(theme)}</style>`,
	);
}

/**
 * Call `listener` when the OS look changes. Theme, organization colors and
 * the motion setting are all written to the root element, so one observer
 * covers them; a device light/dark switch is applied the same way.
 */
export function watchAppRuntimeTheme(listener: () => void): () => void {
	let frame = 0;
	const observer = new MutationObserver(() => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(listener);
	});
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: [
			"class",
			"style",
			"data-mode",
			"data-theme",
			"data-motion",
		],
	});
	return () => {
		cancelAnimationFrame(frame);
		observer.disconnect();
	};
}
