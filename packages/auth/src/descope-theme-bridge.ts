export type DescopeThemeMode = "light" | "dark";

export interface DescopeThemeBridgeOptions {
	cssText: string;
	getTheme?: () => DescopeThemeMode;
	selector?: string;
}

const BRIDGE_STYLE_ID = "tedix-descope-theme-bridge";
const DEFAULT_SELECTOR = [
	"descope-wc",
	"descope-user-management-widget",
	"descope-role-management-widget",
	"descope-access-key-management-widget",
	"descope-audit-management-widget",
	"descope-user-profile-widget",
	"descope-applications-portal-widget",
	"descope-tenant-profile-widget",
	"descope-outbound-applications-widget",
].join(",");

export const TEDIX_DESCOPE_THEME_CSS = `
#root[data-theme] {
	--tedix-descope-action: var(--primary);
	--tedix-descope-action-contrast: var(--primary-foreground);
	--descope-colors-surface-main: var(--card);
	--descope-colors-surface-dark: var(--muted-foreground);
	--descope-colors-surface-light: var(--muted);
	--descope-colors-surface-highlight: var(--accent);
	--descope-colors-surface-contrast: var(--foreground);
	--descope-colors-primary-main: var(--tedix-descope-action);
	--descope-colors-primary-dark: color-mix(in srgb, var(--tedix-descope-action) 82%, var(--foreground));
	--descope-colors-primary-light: color-mix(in srgb, var(--tedix-descope-action) 62%, var(--background));
	--descope-colors-primary-highlight: color-mix(in srgb, var(--tedix-descope-action) 12%, transparent);
	--descope-colors-primary-contrast: var(--tedix-descope-action-contrast);
	--descope-colors-secondary-main: var(--foreground);
	--descope-colors-secondary-dark: color-mix(in srgb, var(--foreground) 84%, var(--background));
	--descope-colors-secondary-light: color-mix(in srgb, var(--foreground) 18%, var(--background));
	--descope-colors-secondary-highlight: var(--muted);
	--descope-colors-secondary-contrast: var(--background);
	--descope-colors-success-main: var(--accent-forest, #42c366);
	--descope-colors-success-dark: color-mix(in srgb, var(--accent-forest, #42c366) 78%, var(--foreground));
	--descope-colors-success-light: color-mix(in srgb, var(--accent-forest, #42c366) 62%, var(--background));
	--descope-colors-success-highlight: color-mix(in srgb, var(--accent-forest, #42c366) 12%, transparent);
	--descope-colors-success-contrast: var(--background);
	--descope-colors-error-main: var(--destructive);
	--descope-colors-error-dark: color-mix(in srgb, var(--destructive) 78%, var(--foreground));
	--descope-colors-error-light: color-mix(in srgb, var(--destructive) 62%, var(--background));
	--descope-colors-error-highlight: color-mix(in srgb, var(--destructive) 12%, transparent);
	--descope-colors-error-contrast: var(--primary-foreground);
	--descope-colors-warning-main: var(--accent-honey, #ecb730);
	--descope-colors-warning-dark: color-mix(in srgb, var(--accent-honey, #ecb730) 78%, var(--foreground));
	--descope-colors-warning-light: color-mix(in srgb, var(--accent-honey, #ecb730) 62%, var(--background));
	--descope-colors-warning-highlight: color-mix(in srgb, var(--accent-honey, #ecb730) 14%, transparent);
	--descope-colors-warning-contrast: var(--background);
	--descope-fonts-font1-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
	--descope-fonts-font2-family: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
	--descope-radius-xs: var(--radius-sm);
	--descope-radius-sm: var(--radius-md);
	--descope-radius-md: var(--radius-md);
	--descope-radius-lg: var(--radius-lg);
	--descope-radius-xl: var(--radius-xl);
	--descope-shadow-wide-sm: 0 1px 2px rgb(0 0 0 / 0.08);
	--descope-shadow-wide-md: 0 8px 22px rgb(0 0 0 / 0.12);
	--descope-shadow-wide-lg: 0 16px 38px rgb(0 0 0 / 0.16);
	--descope-shadow-wide-xl: 0 24px 56px rgb(0 0 0 / 0.18);
	--descope-shadow-wide-2xl: 0 32px 80px rgb(0 0 0 / 0.22);
	--descope-input-wrapper-background-color: color-mix(in srgb, var(--background) 94%, var(--foreground) 6%);
	--descope-input-wrapper-border-color: var(--border);
	--descope-input-wrapper-border-radius: var(--radius-md);
	--descope-input-wrapper-helper-text-color: var(--muted-foreground);
	--descope-input-wrapper-placeholder-text-color: var(--muted-foreground);
	--descope-input-wrapper-value-text-color: var(--foreground);
	--descope-button-border-radius: var(--radius-md);
	--descope-button-font-weight: 500;
	/*
	 * Descope management widgets render their grids and controls with Vaadin's
	 * Lumo tokens inside nested shadow roots. Project the Tedix palette onto
	 * those inherited tokens so dark mode does not retain Lumo's light defaults.
	 */
	--lumo-base-color: var(--card);
	--lumo-contrast: var(--foreground);
	--lumo-body-text-color: var(--foreground);
	--lumo-header-text-color: var(--foreground);
	--lumo-secondary-text-color: var(--muted-foreground);
	--lumo-tertiary-text-color: color-mix(in srgb, var(--muted-foreground) 78%, transparent);
	--lumo-primary-color: var(--primary);
	--lumo-primary-text-color: var(--primary);
	--lumo-primary-contrast-color: var(--primary-foreground);
}

#root,
#content-root {
	background: transparent !important;
	color: var(--foreground) !important;
}

descope-container#ROOT {
	--descope-container-gap: 0.875rem;
	--descope-container-vertical-padding: 1.25rem;
}

descope-email-field,
descope-input-wrapper,
descope-password,
descope-text-field {
	--descope-input-wrapper-background-color: color-mix(in srgb, var(--background) 92%, var(--foreground) 8%);
	--descope-input-wrapper-border-color: color-mix(in srgb, var(--foreground) 18%, var(--background));
	--descope-input-wrapper-helper-text-color: var(--muted-foreground);
	--descope-input-wrapper-placeholder-text-color: color-mix(in srgb, var(--foreground) 58%, var(--background));
	--descope-input-wrapper-value-text-color: var(--foreground);
}

descope-button[mode="primary"][variant="outline"] {
	--descope-button-main: color-mix(in srgb, var(--tedix-descope-action) 70%, var(--foreground));
	--descope-button-dark: color-mix(in srgb, var(--tedix-descope-action) 58%, var(--foreground));
	--descope-button-light: color-mix(in srgb, var(--tedix-descope-action) 72%, var(--background));
}

#root[data-theme="dark"] descope-button[data-descope-provider="apple"] descope-icon {
	filter: invert(1);
}
`;

export function syncDescopeThemeBridge(
	root: Document | HTMLElement,
	options: DescopeThemeBridgeOptions,
): () => void {
	const selector = options.selector ?? DEFAULT_SELECTOR;
	const bridged = new WeakSet<HTMLElement>();
	const controller = new AbortController();
	const timeoutIds = new Set<number>();
	let disposed = false;
	let frame = 0;

	const schedule = () => {
		if (disposed || frame) return;
		frame = requestAnimationFrame(apply);
	};

	apply();

	const rootObserver = new MutationObserver(schedule);
	rootObserver.observe(rootNode(root), {
		attributes: true,
		childList: true,
		subtree: true,
		attributeFilter: ["class", "data-theme", "theme", "style"],
	});

	const documentElement =
		typeof document === "undefined" ? null : document.documentElement;
	const documentObserver =
		documentElement && rootNode(root) !== documentElement
			? new MutationObserver(schedule)
			: null;
	if (documentElement && documentObserver) {
		documentObserver.observe(documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-app-theme-mode", "style"],
		});
	}

	return () => {
		disposed = true;
		if (frame) cancelAnimationFrame(frame);
		controller.abort();
		for (const timeoutId of timeoutIds) {
			clearTimeout(timeoutId);
		}
		rootObserver.disconnect();
		documentObserver?.disconnect();
	};

	function bridge(element: HTMLElement): void {
		bridgeElement(
			element,
			options,
			selector,
			bridged,
			controller.signal,
			timeoutIds,
			schedule,
		);
	}

	function apply() {
		frame = 0;
		if (disposed) return;
		for (const element of findDescopeElements(root, selector)) {
			bridge(element);
		}
	}
}

function bridgeElement(
	element: HTMLElement,
	options: DescopeThemeBridgeOptions,
	selector: string,
	bridged: WeakSet<HTMLElement>,
	signal: AbortSignal,
	timeoutIds: Set<number>,
	rescan: () => void,
): void {
	const theme = options.getTheme?.();
	if (theme && element.getAttribute("theme") !== theme) {
		element.setAttribute("theme", theme);
	}

	const shadowRoot = element.shadowRoot;
	if (shadowRoot) {
		let style = shadowRoot.getElementById(BRIDGE_STYLE_ID);
		if (!style) {
			style = document.createElement("style");
			style.id = BRIDGE_STYLE_ID;
			shadowRoot.append(style);
		}
		if (style.textContent !== options.cssText) {
			style.textContent = options.cssText;
		}
		for (const nested of findDescopeElements(shadowRoot, selector)) {
			bridgeElement(
				nested,
				options,
				selector,
				bridged,
				signal,
				timeoutIds,
				rescan,
			);
		}
	}

	if (bridged.has(element)) return;
	bridged.add(element);
	for (const eventName of ["ready", "page-updated", "screen-updated"]) {
		element.addEventListener(eventName, rescan, { signal });
	}
	for (const delay of [0, 50, 200, 800]) {
		const timeoutId = window.setTimeout(() => {
			timeoutIds.delete(timeoutId);
			if (signal.aborted) return;
			rescan();
		}, delay);
		timeoutIds.add(timeoutId);
	}
}

function findDescopeElements(
	root: Document | HTMLElement | ShadowRoot,
	selector: string,
): HTMLElement[] {
	const results: HTMLElement[] = [];
	if (root instanceof HTMLElement && root.matches(selector)) {
		results.push(root);
	}
	results.push(...Array.from(root.querySelectorAll<HTMLElement>(selector)));
	return results;
}

function rootNode(root: Document | HTMLElement): Node {
	return root instanceof Document ? (root.documentElement ?? root) : root;
}
