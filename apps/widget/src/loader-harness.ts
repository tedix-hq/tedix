/**
 * Test harness for the embed loader (`loader.mjs`): loads the real loader into
 * a happy-dom page as if its `<script>` tag were executing, and exposes what a
 * host page can observe — the `window.Tedix` stub, the launcher shell, and the
 * runtime script it appends.
 */
import { vi } from "vite-plus/test";

type Stub = Record<string, any>;

export type LoaderOptions = {
	/** `data-*` attributes on the loader script. */
	dataset?: Record<string, string>;
	/** Branding the API answers with; `null` answers 404. */
	branding?: Record<string, unknown> | null;
	/** Never answer the branding request. */
	pendingFetch?: boolean;
	/** Runs after the page is reset, before the loader executes. */
	before?: () => void;
	/** Keep the page from a previous run (a second loader on one page). */
	keepPage?: boolean;
};

function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key) => items.get(key) ?? null,
		key: (index) => [...items.keys()][index] ?? null,
		removeItem: (key) => void items.delete(key),
		setItem: (key, value) => void items.set(key, String(value)),
	};
}

export async function runLoader(options: LoaderOptions = {}) {
	const settings = (
		window as unknown as { happyDOM?: { settings: Record<string, unknown> } }
	).happyDOM?.settings;
	if (settings) {
		settings.disableJavaScriptFileLoading = true;
		settings.handleDisabledFileLoadingAsSuccess = true;
	}
	vi.resetModules();
	// Node's own experimental `localStorage` global shadows the page's and is
	// undefined without a backing file, so the page gets an in-memory one.
	if (!options.keepPage)
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: memoryStorage(),
		});
	if (!options.keepPage) {
		document.head.innerHTML = "";
		document.body.innerHTML = "";
		localStorage.clear();
		delete (window as unknown as { Tedix?: unknown }).Tedix;
		document.documentElement.lang = "es-MX";
	}
	const fetch = vi.fn(async (_url: unknown, _init?: unknown) => {
		if (options.pendingFetch) await new Promise(() => {});
		return new Response(
			JSON.stringify({ branding: options.branding ?? null }),
			{
				status: options.branding === null ? 404 : 200,
			},
		);
	});
	globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
	const script = document.createElement("script");
	script.type = "text/plain";
	script.src = "https://widget.tedix.dev/loader.js";
	for (const [key, value] of Object.entries(options.dataset ?? {}))
		script.dataset[key] = value;
	document.head.append(script);
	options.before?.();
	Object.defineProperty(document, "currentScript", {
		configurable: true,
		get: () => script,
	});
	try {
		await import("./loader.mjs");
	} finally {
		delete (document as { currentScript?: unknown }).currentScript;
	}
	const shell = () =>
		document.querySelector<HTMLElement>("[data-tedix-loader-shell]");
	return {
		script,
		fetch,
		Tedix: (window as unknown as { Tedix: Stub }).Tedix,
		shell,
		launcher: () => shell()?.querySelector<HTMLButtonElement>("button") ?? null,
		/** The runtime `<script>` the loader appended, if any. */
		runtime: () =>
			[...document.querySelectorAll<HTMLScriptElement>("script")].find(
				(element) => element !== script,
			) ?? null,
	};
}
