import { rejectDeferredLoaderCalls } from "./loader-queue";
import { fetchWidgetBranding, mergeWidgetBranding } from "./embed/branding";
import {
	readBrandingSnapshot,
	writeBrandingSnapshot,
} from "./embed/branding-snapshot";
import {
	normalizeEmbeddedLocale,
	safeEmbeddedImageUrl,
} from "./embed/host-boundary";
import { WIDGET_SDK_VERSION } from "./sdk-contract";

(() => {
	const current = document.currentScript;
	const existing = window.Tedix;
	if (existing?.runtimeLoaded) {
		if (current?.dataset.tedixTenant) existing.boot({ script: current });
		return;
	}
	if (existing?.loaderInvoked) {
		console.warn("Tedix loader already loaded.");
		return;
	}

	const queue = Array.isArray(existing?.q) ? existing.q : [];
	const startedAt = globalThis.performance?.now?.() ?? Date.now();
	const runtimePath = "__TEDIX_RUNTIME_PATH__";
	let runtimeRequested = false;
	let runtimeWanted = false;
	let configured = false;
	const deferredActions = [];
	let runtimeScript;
	let shell;
	let launcher;
	let revealed = false;
	let revealTimer;
	let appliedIconUrl = "";
	let iconPending = false;

	const BRANDING_ORIGIN = "https://api.tedix.dev";
	// How long an unbranded launcher stays invisible. The launcher must never
	// carry the platform's mark on a provider's page, but an assistant nobody
	// can open is an outage — so a slow, blocked or failed branding read reveals
	// a neutral mark instead of waiting forever.
	//
	// It sits just under the branding request's own 2s timeout, so a read that
	// is merely slow still wins the launcher rather than losing it to a mark
	// that gets swapped a moment later. Against a cold apps/api a much shorter
	// deadline loses that race; a snapshot or a warm cache beats either number
	// by an order of magnitude, so this only matters on a first visit.
	const REVEAL_DEADLINE_MS = 1800;
	const NEUTRAL_MARK =
		'<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18.5 3.5 21v-5.2A8.5 8.5 0 1 1 7 18.5Z"/></svg>';
	const prefersDark = () =>
		Boolean(globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches);
	/**
	 * Start the give-up clock, but never while nobody is looking.
	 *
	 * A hidden tab defers image decoding indefinitely, so a background load
	 * would run the deadline out, reveal the neutral mark, and then swap in the
	 * decoded logo at the exact moment the visitor switches to the tab — the
	 * flicker, just relocated. The branding read still resolves while hidden;
	 * only the fallback waits for someone to be there to see it.
	 */
	const armRevealDeadline = () => {
		if (document.visibilityState === "hidden") {
			document.addEventListener("visibilitychange", armRevealDeadline, {
				once: true,
			});
			return;
		}
		revealTimer = setTimeout(reveal, REVEAL_DEADLINE_MS);
	};
	/** Reveal once, and only with a mark the launcher can keep. */
	const reveal = () => {
		if (revealed || !shell) return;
		revealed = true;
		clearTimeout(revealTimer);
		if (!launcher.hasChildNodes()) launcher.innerHTML = NEUTRAL_MARK;
		shell.style.visibility = "visible";
		shell.style.opacity = "1";
		globalThis.performance?.mark?.("tedix:shell-ready");
	};
	// Paint the tenant's icon, then reveal. Decoding first is what keeps the
	// reveal atomic: revealing on `src` alone shows an empty circle for however
	// many frames the decode takes — the same flicker in a quieter costume.
	const applyLauncherIcon = (url) => {
		const safe = safeEmbeddedImageUrl(url, location.href);
		if (!safe || !launcher || safe === appliedIconUrl) return;
		appliedIconUrl = safe;
		iconPending = true;
		const icon = document.createElement("img");
		icon.alt = "";
		icon.src = safe;
		icon.style.cssText = "width:28px;height:28px;object-fit:contain";
		const paint = () => {
			if (appliedIconUrl !== safe) return;
			iconPending = false;
			launcher.replaceChildren(icon);
			reveal();
		};
		// A logo that cannot be decoded is not a reason to withhold the assistant.
		const giveUp = () => {
			if (appliedIconUrl !== safe) return;
			iconPending = false;
			reveal();
		};
		icon.decode().then(paint, giveUp);
	};

	const removeShell = () => shell?.remove();
	const applyShellOptions = (options = {}) => {
		if (!launcher || !shell) return;
		shell.hidden =
			options.launcherMode === "hidden" || options.launcherMode === "host";
		if (options.launcherPosition === "bottom-left") {
			shell.style.left = `${options.horizontalOffset ?? 24}px`;
			shell.style.right = "auto";
		} else {
			shell.style.right = `${options.horizontalOffset ?? 24}px`;
			shell.style.left = "auto";
		}
		shell.style.bottom = `${options.bottomOffset ?? 24}px`;
		shell.style.zIndex = String(options.zIndex ?? 2147483000);
		// Palette and artwork both carry a dark variant, and the launcher sits on
		// the host's page — so it follows the host's scheme unless pinned.
		const dark =
			options.themeMode === "dark" ||
			(options.themeMode !== "light" && prefersDark());
		const accent = (dark && options.accentDark) || options.accent;
		const iconUrl =
			(dark && options.launcherIconUrlDark) || options.launcherIconUrl;
		if (accent) launcher.style.background = accent;
		applyLauncherIcon(iconUrl);
	};
	const mountShell = () => {
		if (!document.body || shell) return;
		shell = document.createElement("div");
		shell.dataset.tedixLoaderShell = "";
		// Invisible, and inert while invisible: a launcher that has not resolved
		// its branding is not one the visitor should see or hit.
		shell.style.cssText =
			"position:fixed;right:24px;bottom:24px;z-index:2147483000;font-family:ui-sans-serif,system-ui,sans-serif;visibility:hidden;opacity:0;transition:opacity .18s ease";
		launcher = document.createElement("button");
		launcher.type = "button";
		launcher.dataset.tedixLoaderLauncher = "";
		launcher.setAttribute("aria-label", "Open chat");
		launcher.style.cssText =
			"width:56px;height:56px;border:0;border-radius:999px;background:#171717;color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.25);cursor:pointer;display:grid;place-items:center;font:600 21px/1 ui-sans-serif,system-ui,sans-serif";
		launcher.addEventListener("click", () => {
			launcher.disabled = true;
			launcher.setAttribute("aria-busy", "true");
			runtimeWanted = true;
			(configured ? queue : deferredActions).push(["open"]);
			if (configured) loadRuntime();
		});
		shell.append(launcher);
		document.body.append(shell);
		armRevealDeadline();
	};
	/**
	 * Resolve published branding before anything is visible.
	 *
	 * This belonged to the runtime, an async script and an uncacheable round
	 * trip away, so every tenant on published branding watched this loader's
	 * placeholder for seconds and then saw it swapped. Resolving it here is one
	 * launcher that was always correct: a stored snapshot paints in the first
	 * frame, revalidation runs alongside the runtime download, and the runtime
	 * reuses this answer instead of asking again.
	 */
	const resolveLoaderBranding = (options = {}) => {
		const tenant = options.tenant || current?.dataset.tedixTenant || "";
		if (!tenant || options.branding === false) return;
		const dataset = current?.dataset ?? {};
		const locale = [
			options.locale,
			dataset.tedixLocale,
			document.documentElement?.lang,
			globalThis.navigator?.language,
		]
			.map((candidate) => normalizeEmbeddedLocale(candidate, ""))
			.find(Boolean);
		const snapshot = readBrandingSnapshot(tenant, locale);
		if (snapshot)
			applyShellOptions(mergeWidgetBranding(options, dataset, snapshot));
		const ready = fetchWidgetBranding({
			tenant,
			origin: dataset.tedixApiOrigin || BRANDING_ORIGIN,
			locale,
			fetch: globalThis.fetch.bind(globalThis),
		})
			.then((branding) => {
				writeBrandingSnapshot(tenant, locale, branding);
				if (branding)
					applyShellOptions(mergeWidgetBranding(options, dataset, branding));
				// A tenant that published no icon, or an endpoint that could not
				// answer, has given its final answer: stop hiding the assistant.
				// One that published an icon reveals when that icon is decoded —
				// revealing here would paint the neutral mark first and swap it,
				// which is the flicker this whole path exists to remove.
				if (!iconPending) reveal();
				return branding;
			})
			.catch(() => {
				reveal();
				return null;
			});
		// Handed to the runtime so the same read is never paid for twice.
		stub.branding = { tenant, locale, ready };
	};

	const loadRuntime = () => {
		if (runtimeRequested) return;
		runtimeRequested = true;
		globalThis.performance?.mark?.("tedix:runtime-requested");
		const runtime = document.createElement("script");
		runtimeScript = runtime;
		runtime.async = true;
		runtime.crossOrigin = "anonymous";
		runtime.src =
			current?.dataset.tedixRuntime ||
			(runtimePath.startsWith("/")
				? new URL(runtimePath, current?.src || location.href).href
				: new URL("./embed.js", current?.src || location.href).href);
		runtime.addEventListener("error", () => {
			const failedAt = globalThis.performance?.now?.() ?? Date.now();
			runtimeRequested = false;
			runtimeScript = undefined;
			const error = Object.assign(new Error("Runtime load failed."), {
				code: "runtime_load_failed",
			});
			rejectDeferredLoaderCalls([queue, deferredActions], error);
			if (launcher) {
				launcher.disabled = false;
				launcher.removeAttribute("aria-busy");
			}
			window.dispatchEvent(
				new CustomEvent("tedix:error", {
					detail: {
						code: "runtime_load_failed",
						phase: "runtime",
						durationMs: Math.max(0, Math.round(failedAt - startedAt)),
					},
				}),
			);
		});
		current?.after(runtime);
	};

	const stub = {
		q: queue,
		loaderInvoked: true,
		/** `{ tenant, locale, ready }` once a boot has started the read. */
		branding: null,
		snippetVersion: WIDGET_SDK_VERSION,
		startedAt,
	};
	for (const method of [
		"boot",
		"init",
		"update",
		"context",
		"consent",
		"track",
		"open",
		"close",
		"off",
	]) {
		stub[method] = (...args) => {
			if (method === "init" || method === "boot") {
				queue.push([method, ...args]);
				configured = true;
				mountShell();
				applyShellOptions(args[0]);
				resolveLoaderBranding(args[0] || {});
				queue.push(...deferredActions.splice(0));
				// Every preload mode needs the runtime; "open"-only left the rest inert.
				if (current?.dataset.tedixPreload) runtimeWanted = true;
				if (runtimeWanted) loadRuntime();
			} else if (method === "open") {
				runtimeWanted = true;
				(configured ? queue : deferredActions).push([method, ...args]);
				if (configured) loadRuntime();
			} else queue.push([method, ...args]);
			return stub;
		};
	}
	for (const method of [
		"identify",
		"ask",
		"deleteConversation",
		"capabilities",
		"attachCapability",
		"detachCapability",
		"artifactPins",
		"pinArtifactRevision",
		"detachArtifactPin",
	]) {
		stub[method] = (...args) => {
			runtimeWanted = true;
			const pending = new Promise((resolve, reject) =>
				(configured ? queue : deferredActions).push({
					method,
					args,
					resolve,
					reject,
				}),
			);
			if (configured) loadRuntime();
			return pending;
		};
	}
	stub.shutdown = () => {
		const error = Object.assign(new Error("Widget shut down."), {
			code: "widget_shutdown",
		});
		rejectDeferredLoaderCalls([queue, deferredActions], error, false);
		runtimeScript?.remove();
		runtimeScript = undefined;
		runtimeRequested = false;
		runtimeWanted = false;
		configured = false;
		clearTimeout(revealTimer);
		revealed = false;
		appliedIconUrl = "";
		iconPending = false;
		stub.branding = null;
		removeShell();
		shell = undefined;
		launcher = undefined;
		if (window.Tedix === stub) delete window.Tedix;
		return stub;
	};
	stub.on = (event, callback) => {
		queue.push(["on", event, callback]);
		return () => queue.push(["off", event, callback]);
	};
	stub.status = () => ({
		state: runtimeRequested ? "loading" : "idle",
		mounted: false,
		sdkVersion: stub.snippetVersion,
		queuedCalls: queue.length,
	});
	stub.diagnose = () =>
		Promise.resolve({
			ok: true,
			checks: {
				loader: "passed",
				runtime: runtimeRequested ? "loading" : "idle",
			},
			status: stub.status(),
		});
	window.Tedix = stub;
	window.addEventListener("tedix:ready", removeShell, { once: true });
	if (current?.dataset.tedixTenant) stub.boot({ script: current });
})();
