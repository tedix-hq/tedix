import {
	embeddedApprovalLabel,
	embeddedConnectionLabel,
	embeddedConnectionMarkup,
	embeddedSessionFailureLabel,
	numericMountOption,
} from "./ui/index";
import { embeddedTediStyles } from "./ui/styles";
import {
	bindMarkdownCopyButtons,
	renderMarkdown as renderSharedMarkdown,
	safeMarkdownHref,
} from "@tedix/chat-transport/markdown";
import {
	createTranscriptState,
	reduceTranscript,
} from "@tedix/chat-transport/transcript-reducer";
import {
	resolveModelContextSource,
	webMcpError,
	webMcpResult,
} from "@tedix/webmcp-core/model-context";
import {
	registerWebMcpScope,
	webMcpRegistrationStatus,
} from "@tedix/webmcp-core/registry";
import {
	bindPortableToolArguments,
	executePortableTool,
	selectPortableRoute,
} from "@tedix/webmcp-core/portable-profile";
import { createEmbeddedClient } from "@tedix/chat-transport/embedded-client";
import {
	capacityRetryCopy,
	chatErrorRetryAfterSeconds,
	classifyChatError,
	startRetryCountdown,
	userFacingChatError,
} from "./chat-errors";
import {
	bindHostNavigation,
	compileHostRouteMap,
	parseHostRouteRules,
} from "./route-map";
import { fetchWidgetBranding, mergeWidgetBranding } from "./branding";
import { projectionEarnsFrame } from "./projection-frame";
import {
	activityRowKey,
	activityRowText,
	MAX_ACTIVITY_ROWS,
} from "./tool-summary";
import { buildTranslate } from "@tedix/widget-i18n";
import SOURCE_CATALOG from "@tedix/widget-i18n/en.json";
import {
	MCP_APP_ORIGIN,
	resolveWidgetFrameSource,
	WIDGET_FRAME_SANDBOX,
} from "./widget-frame";
import { createEmbeddedTurnMilestones } from "./turn-milestones";
import { shouldArmStallWatchdog, stallWatchdogDelayMs } from "./turn-stall";
import { waitForTurnPreparation } from "./turn-preparation";
import {
	isImeComposingKey,
	isNearBottom,
	observeScrollResize,
} from "@tedix/chat-transport/composer-semantics";
import { findMcpAppRenderProjections } from "@tedix/mcp-shared/result-identity";
import {
	appendVoiceTranscript,
	createRecordedVoiceComposerController,
	VOICE_WAVE_BAR_COUNT,
	voiceWaveBarHeight,
} from "@tedix/chat-transport/voice-composer";
import {
	escapeEmbeddedHtml,
	normalizeEmbeddedLocale,
	normalizeEmbeddedPageContext,
	resolveEmbeddedTranslation,
	safeEmbeddedAccent,
	safeEmbeddedHostRoute,
	safeEmbeddedImageUrl,
} from "./host-boundary";
import { replayLoaderCall } from "../loader-queue";
import { WIDGET_SDK_VERSION } from "../sdk-contract";
import { createWidgetIdentify } from "./identify";
import { createInFlightRequestCoalescer } from "./session-request";

(() => {
	const SDK_VERSION = WIDGET_SDK_VERSION;
	const SCRIPT_SELECTOR = "script[data-tedix-tenant]";
	const initialized = new WeakSet();
	const contextListeners = new Set();
	const widgetControllers = new Set();
	const sdkListeners = new Map();
	const queuedCalls = Array.isArray(window.Tedix?.q) ? [...window.Tedix.q] : [];
	// The loader already asked for branding so it could paint a correct launcher.
	// Its answer is this runtime's answer; asking again is a second round trip
	// for a result that is already in hand.
	const loaderBranding = window.Tedix?.branding ?? null;
	const now = () => globalThis.performance?.now?.() ?? Date.now();
	const loaderStartedAt = Number(window.Tedix?.startedAt) || now();
	const runtimeLoadedAt = now();
	const reliability = {
		runtimeMs: Math.max(0, Math.round(runtimeLoadedAt - loaderStartedAt)),
		readyMs: null,
		sessionAttempts: 0,
		lastSessionMs: null,
		lastSessionOutcome: "not_requested",
		turnAttempts: 0,
		lastTurnMs: null,
		lastTurnOutcome: "not_requested",
		lastFirstEventMs: null,
		lastFirstTextMs: null,
		lastReconnects: 0,
	};
	const reliabilitySnapshot = () => ({ ...reliability });
	/**
	 * Progress a person can read. The runtime's phase detail is a machine name,
	 * so it never reaches the panel; "looking things up" is the honest summary
	 * of every tool phase and it does not go stale when the tools change.
	 */
	const runtimePhaseLabel = (phase, product, t) => {
		const labels = {
			preparing_context: t("getting_ready"),
			planning: t("thinking"),
			generating: t("writing_the_answer"),
			using_tool: t("looking_in", { product: product }),
			delegating: t("asking_for_help"),
			finalizing: t("almost_done"),
		};
		return labels[phase] || t("working_on_it");
	};
	let sharedContext = null;
	let lastError = null;
	let sharedConsent = {
		functional: true,
		personalization: true,
		analytics: undefined,
	};
	const emit = (event, detail = {}) => {
		const payload = { sdkVersion: SDK_VERSION, ...detail };
		window.dispatchEvent(
			new CustomEvent(`tedix:${event}`, { detail: payload }),
		);
		for (const callback of sdkListeners.get(event) || []) {
			try {
				callback(payload);
			} catch {
				// Host callbacks never affect the widget runtime.
			}
		}
	};
	const normalizeConsent = (value = {}) => ({
		functional: value.functional !== false,
		personalization: value.personalization !== false,
		analytics:
			typeof value.analytics === "boolean" ? value.analytics : undefined,
	});
	const escapeHtml = escapeEmbeddedHtml;
	const safeAccent = safeEmbeddedAccent;
	const safeImageUrl = (value) => safeEmbeddedImageUrl(value, location.origin);
	// `fallbackMarkup` is runtime-authored markup, never tenant or host input:
	// both call sites pass one of this file's own icons.
	const brandImageMarkup = (lightUrl, darkUrl, fallbackMarkup) => {
		const light = safeImageUrl(lightUrl);
		const dark = safeImageUrl(darkUrl) || light;
		if (!light) return fallbackMarkup;
		return `<img class="tedix-brand-image" src="${escapeHtml(light)}" alt=""><img class="tedix-brand-image" data-theme-dark src="${escapeHtml(dark)}" alt="">`;
	};
	const normalizePageContext = (value = {}) =>
		normalizeEmbeddedPageContext(
			value,
			`${location.pathname}${location.search}`,
		);
	const hostPageContext = (current = {}) => {
		const sections = [...document.querySelectorAll("main h1, main h2, main h3")]
			.filter((node) => node.getClientRects().length > 0)
			.map((node) => node.textContent?.replace(/\s+/g, " ").trim())
			.filter(Boolean);
		return normalizePageContext({
			...current,
			pathname: `${location.pathname}${location.search}`,
			title: current.title || document.title,
			sections: current.sections?.length ? current.sections : sections,
		});
	};
	const safeHostRoute = (value) =>
		safeEmbeddedHostRoute(value, location.origin);
	const icon = (path, label = "") =>
		`<svg viewBox="0 0 24 24" aria-hidden="${label ? "false" : "true"}"${label ? ` aria-label="${label}"` : ""}><path d="${path}"/></svg>`;
	const ICONS = {
		chat: "M7 18.5 3.5 21v-5.2A8.5 8.5 0 1 1 7 18.5Z",
		close: "m6.5 6.5 11 11m0-11-11 11",
		expand: "M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5",
		newChat: "M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4M12 20h8",
		send: "M5 12h14m-6-6 6 6-6 6",
		stop: "M7 7h10v10H7z",
		microphone:
			"M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm-6-3a6 6 0 0 0 12 0M12 17v3m-3 0h6",
		check: "m5 12 4 4L19 6",
		tool: "M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-3 3-4-4 3-3Z",
		chevron: "m8 10 4 4 4-4",
		history: "M4 6h16M4 12h16M4 18h10",
		back: "m15 18-6-6 6-6",
	};

	function button(className, label, iconMarkup) {
		return `<button class="${className}" type="button" aria-label="${label}" title="${label}">${iconMarkup}</button>`;
	}

	function routeContext(productLabel, t) {
		return [
			productLabel,
			t("starter_attention"),
			t("starter_recent_activity"),
			t("starter_explain_page"),
		];
	}

	const identityMounts = new Map();
	let disposeRouteContext = () => {};
	/**
	 * A host that declares its routes gets page context for free: the runtime
	 * evaluates the rules on every SPA navigation instead of the host wiring a
	 * router effect. An explicit `context()` call still wins for anything the
	 * rules cannot express.
	 */
	function bindRouteContext(script, options) {
		const match = compileHostRouteMap(
			options.routes ?? parseHostRouteRules(script?.dataset.tedixRoutes),
		);
		if (!match) return;
		disposeRouteContext();
		const publish = (pathname) => api.context(match(pathname));
		publish(location.pathname);
		disposeRouteContext = bindHostNavigation(window, publish);
	}
	const BRANDING_ORIGIN = "https://api.tedix.dev";
	/**
	 * Published branding decides how the launcher and panel look, so it is
	 * resolved before the first paint. A host that configured nothing, or an
	 * endpoint that is slow or down, simply mounts with runtime defaults.
	 */
	async function resolveBranding(script, options) {
		const tenant = options.tenant || script.dataset.tedixTenant;
		if (!tenant || options.branding === false) return options;
		const locale = [
			options.locale,
			script.dataset.tedixLocale,
			document.documentElement.lang,
			navigator.language,
		]
			.map((candidate) => normalizeEmbeddedLocale(candidate, ""))
			.find(Boolean);
		// Only the loader's own read answers this mount: a different tenant or
		// locale is a different question.
		const reuse =
			loaderBranding?.tenant === tenant && loaderBranding?.locale === locale
				? loaderBranding.ready
				: null;
		const branding = reuse
			? await reuse.catch(() => null)
			: await fetchWidgetBranding({
					tenant,
					origin: script.dataset.tedixApiOrigin || BRANDING_ORIGIN,
					locale,
					fetch: globalThis.fetch.bind(globalThis),
				});
		return mergeWidgetBranding(options, script.dataset, branding);
	}
	async function mount(script, options = {}) {
		if (!script || initialized.has(script) || identityMounts.has(script))
			return;
		bindRouteContext(script, options);
		const branded = await resolveBranding(script, options);
		if (initialized.has(script) || identityMounts.has(script)) return;
		return mountWithIdentity(script, branded);
	}
	function mountWithIdentity(script, options) {
		const endpoint =
			options.identifyEndpoint || script.dataset.tedixIdentifyEndpoint;
		if (!endpoint) return mountReady(script, options);
		const identity = createWidgetIdentify({
			endpoint,
			origin: location.origin,
			fetch: globalThis.fetch.bind(globalThis),
			onIdentity: (_profile, changed) => {
				if (changed) {
					widgetControllers.forEach((controller) => controller.shutdown());
					sharedContext = null;
				}
				mountReady(script, options);
			},
		});
		identityMounts.set(script, identity);
		identity.ready = identity.identify();
		void identity.ready.catch(() => {
			lastError = "Identification failed";
			emit("error", { code: "identify_failed" });
		});
	}
	function mountReady(script, options = {}) {
		if (!script || initialized.has(script)) return;
		initialized.add(script);
		const tenant = options.tenant || script.dataset.tedixTenant;
		const endpoint =
			options.endpoint || script.dataset.tedixEndpoint || "/r/tedi/session";
		const configuredPreload = options.preload || script.dataset.tedixPreload;
		const preload = ["open", "idle", "eager"].includes(configuredPreload)
			? configuredPreload
			: "open";
		const sessionProvider = options.session;
		// Hosts may prepare a durable conversation reference at the first actual
		// send. The widget treats this as opaque context; only the host can decide
		// what it means, and the API signs it into the resulting capability.
		const prepareConversationContext = options.prepareConversationContext;
		const continueConversation = options.continueConversation;
		const historyProvider = options.history;
		const transcriptProvider = options.transcript;
		const deleteConversationProvider = options.deleteConversation;
		if (!tenant) throw new Error("Tedix embed requires a tenant");
		const configuredTitle =
			options.title || script.dataset.tedixTitle || "Tedi";
		// A required tenant slug always yields a name, so the last resort is the
		// assistant's own configured title rather than a sentence in one language.
		const productLabel =
			options.product ||
			script.dataset.tedixProduct ||
			tenant
				.split("-")
				.filter(Boolean)
				.map((part) => part[0]?.toUpperCase() + part.slice(1))
				.join(" ") ||
			configuredTitle;
		// Each candidate is host-supplied: the || chain only rejects FALSY input,
		// so `locale: 123` and `en_US` both survive it and throw downstream.
		const locale = normalizeEmbeddedLocale(
			[
				options.locale,
				script.dataset.tedixLocale,
				document.documentElement.lang,
				navigator.language,
			].find((candidate) => normalizeEmbeddedLocale(candidate, "") !== ""),
		);
		const translation = resolveEmbeddedTranslation(
			options.translations,
			locale,
		);
		// Copy is data. The published catalog for this locale arrives with the
		// tenant's configuration; English is the source every locale falls back
		// to, and a tenant's own overrides win over both.
		const t = buildTranslate(
			{ ...options.catalog, ...translation },
			SOURCE_CATALOG,
			// Every string may name the assistant, including the error copy no
			// call site remembered to pass it to.
			{ assistant: configuredTitle },
		);
		const title = translation.title || configuredTitle;
		// With nothing published for this language, the platform's own suggestions
		// keep the home usable instead of leaving it bare.
		const fallbackStarters = [
			t("starter_attention"),
			t("starter_recent_activity"),
			t("starter_explain_page"),
		];
		const conversationStarters = (
			Array.isArray(translation.conversationStarters)
				? translation.conversationStarters
				: Array.isArray(options.conversationStarters)
					? options.conversationStarters
					: Array.isArray(options.prompts)
						? options.prompts
						: []
		)
			.filter((prompt) => typeof prompt === "string" && prompt.trim())
			.map((prompt) => prompt.trim().slice(0, 240))
			.slice(0, 6);
		const starters = conversationStarters.length
			? conversationStarters
			: fallbackStarters;
		// Same-origin host routes stay navigable in-app; everything else follows
		// the shared https-only policy. Raw HTML never passes through.
		const renderMarkdown = (value) =>
			renderSharedMarkdown(value, {
				link: (href) => safeHostRoute(href) || safeMarkdownHref(href),
				copyLabel: t("copy_code"),
			});
		// People in a workshop do not know what a callable is, and a machine name
		// in the transcript reads as a malfunction. An activity says what the
		// assistant did in product language and nothing more.
		const activityLabel = () => t("checked", { product: productLabel });
		/**
		 * Wording for one worklog row. Everything here is a catalog string; the
		 * tenant's own per-tool labels reach the reducer as configuration and
		 * arrive on the activity already resolved.
		 */
		const activityCopy = {
			checked: activityLabel,
			checking: () => t("checking", { product: productLabel }),
			failed: () => t("could_not_be_reached", { product: productLabel }),
			results: (count) => t("results_found", { count }),
			times: (count) => t("repeated_times", { count }),
		};
		/**
		 * The tenant's published tool labels, keyed by tool id.
		 *
		 * A tool with no authored label gets no name in the transcript at all —
		 * the row falls back to the generic product sentence. There is no rescue
		 * path that prettifies a callable, because a name nobody wrote for a
		 * customer is not a name a customer should read.
		 */
		const toolLabels = (() => {
			const published = options.toolLabels;
			if (
				!published ||
				typeof published !== "object" ||
				Array.isArray(published)
			)
				return {};
			const labels = {};
			for (const [toolId, value] of Object.entries(published)) {
				if (!value || typeof value !== "object") continue;
				const invoking =
					typeof value.invoking === "string" ? value.invoking : undefined;
				const invoked =
					typeof value.invoked === "string" ? value.invoked : undefined;
				if (!invoking && !invoked) continue;
				labels[toolId] = { invoking, invoked };
			}
			return labels;
		})();
		const historyDateLabel = (timestamp) => {
			const date = new Date(timestamp);
			const today = new Date();
			const startOfToday = new Date(
				today.getFullYear(),
				today.getMonth(),
				today.getDate(),
			);
			const startOfDate = new Date(
				date.getFullYear(),
				date.getMonth(),
				date.getDate(),
			);
			const daysAgo = Math.round((startOfToday - startOfDate) / 86_400_000);
			if (daysAgo === 0) return t("today");
			if (daysAgo === 1) return t("yesterday");
			if (daysAgo > 1 && daysAgo < 7) return `${daysAgo}d`;
			return new Intl.DateTimeFormat(locale, {
				month: "short",
				day: "numeric",
				...(date.getFullYear() === today.getFullYear()
					? {}
					: { year: "numeric" }),
			}).format(date);
		};
		const subtitle =
			translation.subtitle ||
			options.subtitle ||
			script.dataset.tedixSubtitle ||
			t("your_assistant_for", { product: productLabel });
		const accent = safeAccent(
			options.accent || script.dataset.tedixAccent || "#2557d6",
		);
		const accentDark = safeAccent(options.accentDark || accent);
		const themeMode = ["host", "system", "light", "dark"].includes(
			options.themeMode,
		)
			? options.themeMode
			: "host";
		const launcherPosition =
			options.launcherPosition === "bottom-left"
				? "bottom-left"
				: "bottom-right";
		const horizontalOffset = numericMountOption(options.horizontalOffset, 22);
		const bottomOffset = numericMountOption(options.bottomOffset, 22);
		const zIndex = numericMountOption(options.zIndex, 2_147_483_000);
		const launcherMode = ["default", "hidden", "host"].includes(
			options.launcherMode,
		)
			? options.launcherMode
			: "default";
		const startMode =
			options.startMode === "conversation" ? "conversation" : "home";
		const homeModules = new Set(
			Array.isArray(options.homeModules)
				? options.homeModules
				: ["welcome", "recent"],
		);
		// A tenant that published no artwork gets the neutral chat mark, never the
		// platform's initial: "T" is Tedix branding sitting on someone else's
		// product. The loader reveals the same mark, so the handover from its
		// shell to this launcher is invisible.
		const launcherMark = brandImageMarkup(
			options.launcherIconUrl,
			options.launcherIconUrlDark,
			icon(ICONS.chat),
		);
		const assistantMark = brandImageMarkup(
			options.assistantLogoUrl,
			options.assistantLogoUrlDark,
			icon(ICONS.chat),
		);
		const welcomeHeading = escapeHtml(
			translation.welcomeHeading ||
				t("how_can_i_help_you_in", { product: productLabel }),
		);
		const welcomeBody = escapeHtml(
			translation.welcomeBody ||
				t("i_m_connected_to_your_workspace", { product: productLabel }),
		);
		const homeMarkup =
			() => `<div class="tedix-empty" data-start-mode="${startMode}">
			${startMode === "home" && homeModules.has("welcome") ? `<div class="tedix-empty-mark">${icon(ICONS.chat)}</div><h2>${welcomeHeading}</h2><p>${welcomeBody}</p>` : ""}
			${startMode === "home" && starters.length ? `<div class="tedix-prompts" role="group" aria-label="${t("suggested_prompts")}">${starters.map((prompt) => `<button class="tedix-prompt" type="button">${escapeHtml(prompt)}</button>`).join("")}</div>` : ""}
			${startMode === "home" && homeModules.has("recent") ? recentSessionsMarkup() : ""}
		</div>`;
		let pageContext = normalizePageContext(sharedContext || {});
		const context = routeContext(productLabel, t);
		const safeTitle = escapeHtml(title);
		const safeSubtitle = escapeHtml(subtitle);
		const safeContext = escapeHtml(context[0]);
		const recentSessionsMarkup =
			() => `<section class="tedix-recent" aria-label="${t("recent_chats")}" hidden>
			<h2>${t("recent_chats")}</h2>
			<div class="tedix-recent-list" role="list"></div>
			<button class="tedix-recent-more" type="button">${t("show_more")}</button>
		</section>`;

		const host = document.createElement("div");
		const readHostTheme = () => {
			const roots = [document.documentElement, document.body].filter(Boolean);
			for (const root of roots) {
				const declared = root.dataset?.theme;
				if (declared === "light" || declared === "dark") return declared;
				if (root.classList?.contains("dark")) return "dark";
				if (root.classList?.contains("light")) return "light";
			}
			const scheme = getComputedStyle(document.documentElement).colorScheme;
			if (scheme === "dark" || scheme === "light") return scheme;
			return null;
		};
		const syncHostTheme = () => {
			const theme =
				themeMode === "light" || themeMode === "dark"
					? themeMode
					: themeMode === "system"
						? matchMedia("(prefers-color-scheme: dark)").matches
							? "dark"
							: "light"
						: readHostTheme();
			if (theme) host.dataset.theme = theme;
			else delete host.dataset.theme;
			for (const iframe of host.shadowRoot?.querySelectorAll(
				"iframe[data-tedix-mcp-app]",
			) || []) {
				const url = new URL(iframe.src);
				if (theme) url.searchParams.set("theme", theme);
				else url.searchParams.delete("theme");
				if (url.href !== iframe.src) iframe.src = url.href;
			}
		};
		syncHostTheme();
		const themeObserver = new MutationObserver(syncHostTheme);
		const systemTheme = matchMedia("(prefers-color-scheme: dark)");
		if (themeMode === "system")
			systemTheme.addEventListener("change", syncHostTheme);
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-theme", "style"],
		});
		if (document.body) {
			themeObserver.observe(document.body, {
				attributes: true,
				attributeFilter: ["class", "data-theme", "style"],
			});
		}
		host.dataset.tedixWidget = tenant;
		document.body.append(host);
		// iOS keeps the layout viewport at its pre-keyboard height. The widget is
		// fixed to that viewport, so it must follow the visual rectangle itself or
		// its composer ends up beneath the keyboard (and, after a focus zoom, past
		// the right edge of the screen).
		const viewport = window.visualViewport;
		let viewportFrame = 0;
		const publishViewport = () => {
			viewportFrame = 0;
			const visible = viewport ?? window;
			const visibleHeight = visible.innerHeight ?? visible.height;
			host.style.setProperty("--tedix-viewport-height", `${visibleHeight}px`);
			host.style.setProperty(
				"--tedix-viewport-width",
				`${visible.innerWidth ?? visible.width}px`,
			);
			host.style.setProperty(
				"--tedix-viewport-top",
				`${visible.offsetTop ?? 0}px`,
			);
			// On iOS, innerHeight remains the layout viewport while visualViewport
			// shrinks above the software keyboard. Compact only the keyboard-open
			// composer so the normal footer remains visible when typing is finished.
			host.toggleAttribute(
				"data-keyboard-open",
				Boolean(viewport && window.innerHeight - visibleHeight > 120),
			);
		};
		const scheduleViewport = () => {
			if (!viewportFrame)
				viewportFrame = requestAnimationFrame(publishViewport);
		};
		publishViewport();
		viewport?.addEventListener("resize", scheduleViewport);
		viewport?.addEventListener("scroll", scheduleViewport);
		const root = host.attachShadow({ mode: "open" });
		root.innerHTML = `
			<style>${embeddedTediStyles(accent, { accentDark, position: launcherPosition, horizontalOffset, bottomOffset, zIndex })}</style>
			<button class="tedix-launcher" type="button" aria-label="${t("open_tedi")}" aria-expanded="false" aria-controls="tedix-panel" title="${t("open_tedi")}" ${launcherMode === "default" ? "" : "hidden"}><span class="tedix-launcher-mark" aria-hidden="true">${launcherMark}</span></button>
			<section id="tedix-panel" class="tedix-panel" role="dialog" aria-label="${t("chat_with")} ${safeTitle}" aria-modal="false">
				<header class="tedix-header">
					<div class="tedix-history-bar">
						${button("tedix-icon tedix-history-back", t("back_to_conversation"), icon(ICONS.back))}
						<strong>${t("history")}</strong>
					</div>
					<div class="tedix-avatar" aria-hidden="true">${assistantMark}<span class="tedix-presence"></span></div>
					<div class="tedix-heading"><h1 class="tedix-title">${safeTitle}</h1><select class="tedix-tedi-select" aria-label="${t("choose_tedi")}" hidden></select><p class="tedix-subtitle">${safeSubtitle}</p></div>
					<div class="tedix-actions">
						${button("tedix-icon tedix-history-open", t("conversation_history"), icon(ICONS.history))}
						${button("tedix-icon tedix-new", t("new_conversation"), icon(ICONS.newChat))}
						${button("tedix-icon tedix-expand", t("expand"), icon(ICONS.expand))}
						${button("tedix-icon tedix-close", t("close"), icon(ICONS.close))}
					</div>
				</header>
				<section class="tedix-history" aria-label="${t("conversation_history")}" hidden>
					<button class="tedix-history-new" type="button">${icon(ICONS.newChat)}<span>${t("new_conversation")}</span></button>
					<div class="tedix-history-list" role="list"></div>
				</section>
				<main class="tedix-thread" aria-live="polite">${homeMarkup()}</main>
				<footer class="tedix-composer-wrap">
				<div class="tedix-context"><span>${t("context")}</span><strong>${safeContext}</strong><select class="tedix-model-select" aria-label="${t("choose_model")}" hidden></select><select class="tedix-effort-select" aria-label="${t("choose_effort")}" hidden></select>${embeddedConnectionMarkup("idle", t)}</div>
				<div class="tedix-session-recovery" role="alert" hidden><span></span><button class="tedix-session-retry" type="button">${t("retry")}</button></div>
					<form class="tedix-form">
						<button class="tedix-voice-cancel" type="button" aria-label="${t("cancel_dictation")}" title="${t("cancel_dictation")}" hidden>${icon(ICONS.close)}</button>
						<textarea class="tedix-input" rows="1" maxlength="4000" aria-label="${t("message_for", { assistant: safeTitle })}" placeholder="${t("ask", { assistant: safeTitle })}"></textarea>
						<div class="tedix-voice-status" role="status" aria-live="polite" hidden><span class="tedix-voice-wave" aria-hidden="true">${"<i></i>".repeat(VOICE_WAVE_BAR_COUNT)}</span></div>
						<button class="tedix-voice" type="button" aria-label="${t("dictate_message")}" title="${t("dictate_message")}">${icon(ICONS.microphone)}</button>
						<button class="tedix-send" type="submit" aria-label="${t("send")}" disabled>${icon(ICONS.send)}</button>
					</form>
					<div class="tedix-voice-error" role="alert" hidden><span></span><button type="button">${t("try_again")}</button></div>
					<div class="tedix-footer">${t("tedi_can_make_mistakes_confirm_important")}</div>
				</footer>
			</section>`;

		const panel = root.querySelector(".tedix-panel");
		const tediSelect = root.querySelector(".tedix-tedi-select");
		let selectedTediId = null;
		let tediChoices = [];
		const renderTediSelection = () => {
			tediSelect.replaceChildren(
				...tediChoices.map((choice) => {
					const option = document.createElement("option");
					option.value = choice.id;
					option.textContent = choice.name;
					return option;
				}),
			);
			tediSelect.hidden = tediChoices.length === 0;
			tediSelect.value = selectedTediId ?? "";
			tediSelect.disabled =
				busy || voiceState !== "idle" || tediChoices.length < 2;
			// Both pickers share every state transition that disables the composer,
			// so driving one from the other keeps them from drifting apart.
			renderModelSelection();
		};
		const modelSelect = root.querySelector(".tedix-model-select");
		const effortSelect = root.querySelector(".tedix-effort-select");
		let modelChoices = [];
		let effortChoices = [];
		let defaultModelRef = "";
		// Hydrated from storage further down, where the key and its reader live.
		// These cannot read it here: the pickers are built with the rest of the
		// composer, above the storage helpers, and reaching forward to a `const`
		// threw at mount and took the whole widget with it.
		let selectedModelRef = "";
		let selectedEffort = "";
		/**
		 * The roster is advisory: the runtime edge re-validates every choice, so a
		 * ref that is no longer offered simply falls back to the surface default
		 * rather than failing the turn. Dropping it here keeps the control honest
		 * about what it can still deliver.
		 */
		const renderModelSelection = () => {
			if (
				selectedModelRef &&
				!modelChoices.some((m) => m.ref === selectedModelRef)
			)
				selectedModelRef = "";
			const automatic = document.createElement("option");
			automatic.value = "";
			// Name the model the default resolves to when the session states it.
			// "Automatic" alone is what let a substituted model go unnoticed.
			const fallback = modelChoices.find(
				(choice) => choice.ref === defaultModelRef,
			);
			automatic.textContent = fallback
				? t("model_automatic_named", { model: fallback.label })
				: t("model_automatic");
			modelSelect.replaceChildren(
				automatic,
				...modelChoices.map((choice) => {
					const option = document.createElement("option");
					option.value = choice.ref;
					option.textContent = choice.label;
					return option;
				}),
			);
			modelSelect.hidden = modelChoices.length === 0;
			modelSelect.value = selectedModelRef;
			modelSelect.disabled = busy || voiceState !== "idle";
			// Effort only means something on a model that can take one on the wire.
			// Offering it elsewhere would promise a control the runtime drops.
			const active = modelChoices.find((m) => m.ref === selectedModelRef);
			const supportsEffort =
				Boolean(active?.reasoning) && effortChoices.length > 0;
			if (!supportsEffort) selectedEffort = "";
			effortSelect.replaceChildren(
				...(supportsEffort
					? [
							(() => {
								const option = document.createElement("option");
								option.value = "";
								option.textContent = t("effort_default");
								return option;
							})(),
							...effortChoices.map((effort) => {
								const option = document.createElement("option");
								option.value = effort;
								option.textContent = t(`effort_${effort}`);
								return option;
							}),
						]
					: []),
			);
			effortSelect.hidden = !supportsEffort;
			effortSelect.value = selectedEffort;
			effortSelect.disabled = busy || voiceState !== "idle";
		};
		modelSelect.addEventListener("change", () => {
			selectedModelRef = modelSelect.value;
			persistModelChoice();
			renderModelSelection();
		});
		effortSelect.addEventListener("change", () => {
			selectedEffort = effortSelect.value;
			persistModelChoice();
			renderModelSelection();
		});
		const launcher = root.querySelector(".tedix-launcher");
		const thread = root.querySelector(".tedix-thread");
		const form = root.querySelector(".tedix-form");
		const input = root.querySelector(".tedix-input");
		const send = root.querySelector(".tedix-send");
		const sessionRecovery = root.querySelector(".tedix-session-recovery");
		const sessionRecoveryText = sessionRecovery.querySelector("span");
		const sessionRetry = root.querySelector(".tedix-session-retry");
		const voiceButton = root.querySelector(".tedix-voice");
		const voiceCancel = root.querySelector(".tedix-voice-cancel");
		const voiceStatus = root.querySelector(".tedix-voice-status");
		const voiceError = root.querySelector(".tedix-voice-error");
		const voiceErrorText = voiceError.querySelector("span");
		const voiceRetry = voiceError.querySelector("button");
		const voiceBars = [...root.querySelectorAll(".tedix-voice-wave i")];
		const history = root.querySelector(".tedix-history");
		const composerWrap = root.querySelector(".tedix-composer-wrap");
		let busy = false;
		// A quota refusal names when the hour rolls over. Until then the composer
		// stays closed and the failure line counts down, so the customer is not
		// invited to retry into the same refusal.
		let stopRetryCountdown = null;
		const retryLocked = () => stopRetryCountdown !== null;
		const applyRetryLock = () => {
			if (!retryLocked()) return;
			input.disabled = true;
			send.disabled = true;
		};
		const clearRetryLock = () => {
			stopRetryCountdown?.();
			stopRetryCountdown = null;
		};
		const armRetryLock = (seconds, line) => {
			clearRetryLock();
			stopRetryCountdown = startRetryCountdown(seconds, {
				onTick: (left) => {
					line.textContent = capacityRetryCopy(left, t);
				},
				onExpire: () => {
					stopRetryCountdown = null;
					line.textContent = capacityRetryCopy(0, t);
					if (destroyed) return;
					input.disabled = false;
					send.disabled = !input.value.trim();
					flushQueuedMessage();
				},
			});
		};
		/**
		 * Follow-ups typed while a turn is still answering.
		 *
		 * Pressing Enter mid-answer used to abort the running turn AND drop the
		 * typed text: the form handler read every submit as the Stop control. The
		 * message is queued instead and sent when the turn settles, in order.
		 */
		const queuedMessages = [];
		let activeRequest = null;
		let activeTurnMilestones = null;
		let reconnectPending = false;
		let embeddedSession = null;
		let portableRouteRevision = 0;
		let embeddedSessionRequests = createInFlightRequestCoalescer();
		let embeddedClient = null;
		let approvalProjectionWatcher = null;
		let destroyed = false;
		let voiceController = null;
		let voiceState = "idle";
		let suppressVoiceClick = false;
		let webMcpReadinessTimer = null;
		let conversationId = crypto.randomUUID();
		let activities = new Map();
		let approvals = new Map();
		let lastAssistantAnswer = "";
		let hostConversationContext = null;
		const MAX_CONVERSATIONS = 12;
		/** Upper bound on a transcript restore before its placeholders give way. */
		const TRANSCRIPT_RESTORE_TIMEOUT_MS = 20_000;
		const conversations = new Map();
		let activeConversation = {
			id: conversationId,
			tediId: selectedTediId,
			title: t("new_conversation"),
			updatedAt: Date.now(),
			fragment: document.createDocumentFragment(),
			embeddedSession: null,
			embeddedClient: null,
			activities,
			approvals,
			lastAssistantAnswer: "",
			hostConversationContext: null,
			workspaceId: null,
			hasMessages: false,
		};
		conversations.set(conversationId, activeConversation);
		let webMcpActive = false;
		let followLatest = true;
		const disposeScrollResize = observeScrollResize(thread, () => followLatest);
		const scrollLatest = () => {
			if (followLatest)
				requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
		};
		thread.addEventListener("scroll", () => {
			followLatest = isNearBottom(thread);
		});
		const setConnectionState = (state) => {
			const status = root.querySelector(".tedix-status");
			if (!status) return;
			const effective =
				webMcpActive && state === "connected" ? "webmcp" : state;
			status.dataset.state = effective;
			status.querySelector(".tedix-status-label").textContent =
				embeddedConnectionLabel(effective, t);
			sessionRecovery.hidden = effective !== "error";
			if (effective === "error")
				sessionRecoveryText.textContent = embeddedSessionFailureLabel(
					lastError,
					t,
				);
		};
		sessionRetry.addEventListener("click", async () => {
			sessionRetry.disabled = true;
			embeddedSession = null;
			setConnectionState("connecting");
			try {
				await getEmbeddedSession();
			} catch {
				// requestEmbeddedSession owns the localized recovery state.
			} finally {
				sessionRetry.disabled = false;
			}
		});
		const setOpen = (open) => {
			if (destroyed) return;
			panel.toggleAttribute("data-open", open);
			launcher.toggleAttribute("data-hidden", open);
			launcher.setAttribute("aria-expanded", String(open));
			if (open) {
				setTimeout(() => input.focus(), 0);
				void restoreActiveThread().then(() => {
					if (homeModules.has("recent")) void renderRecentSessions();
				});
			} else if (launcherMode === "default") launcher.focus();
			emit(open ? "opened" : "closed", { tenant });
		};
		const captureConversation = () => {
			activeConversation.tediId = selectedTediId;
			activeConversation.fragment.replaceChildren(...thread.childNodes);
			activeConversation.embeddedSession = embeddedSession;
			activeConversation.embeddedClient = embeddedClient;
			activeConversation.activities = activities;
			activeConversation.approvals = approvals;
			activeConversation.lastAssistantAnswer = lastAssistantAnswer;
			activeConversation.hostConversationContext = hostConversationContext;
		};
		// References are not authority. Never persist titles or message bodies:
		// a different host user in this tab must authorize a read before seeing them.
		const THREADS_KEY = `tedix:threads:v2:${tenant}`;
		const TEDI_BINDINGS_KEY = `tedix:thread-tedis:v1:${tenant}`;
		// The picker remembers the last choice, not a per-conversation binding:
		// a model preference is a property of the person, and carrying it into a
		// new conversation is what every chat surface does. It is a preference,
		// never authority — the roster and the edge decide what it may resolve to.
		const MODEL_CHOICE_KEY = `tedix:model-choice:v1:${tenant}`;
		const storedModelChoice = (() => {
			try {
				const parsed = JSON.parse(
					sessionStorage.getItem(MODEL_CHOICE_KEY) || "{}",
				);
				return {
					modelRef: typeof parsed?.modelRef === "string" ? parsed.modelRef : "",
					effort: typeof parsed?.effort === "string" ? parsed.effort : "",
				};
			} catch {
				return { modelRef: "", effort: "" };
			}
		})();
		selectedModelRef = storedModelChoice.modelRef;
		selectedEffort = storedModelChoice.effort;
		const persistModelChoice = () => {
			try {
				sessionStorage.setItem(
					MODEL_CHOICE_KEY,
					JSON.stringify({
						modelRef: selectedModelRef,
						effort: selectedEffort,
					}),
				);
			} catch {
				// Preference persistence is best effort.
			}
		};
		const readTediBindings = () => {
			try {
				const parsed = JSON.parse(
					sessionStorage.getItem(TEDI_BINDINGS_KEY) || "{}",
				);
				return parsed && typeof parsed === "object" && !Array.isArray(parsed)
					? parsed
					: {};
			} catch {
				return {};
			}
		};
		const ACTIVE_THREAD_KEY = `tedix:thread:v2:${tenant}`;
		const isConversationId = (id) =>
			typeof id === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				id,
			);
		const readStoredThreads = () => {
			try {
				const parsed = JSON.parse(sessionStorage.getItem(THREADS_KEY) || "[]");
				return Array.isArray(parsed)
					? [...new Set(parsed.filter(isConversationId))].slice(
							0,
							MAX_CONVERSATIONS,
						)
					: [];
			} catch {
				return [];
			}
		};
		const persistThreads = () => {
			try {
				const stored = sortedConversations()
					.filter((item) => item.hasMessages)
					.slice(0, MAX_CONVERSATIONS)
					.map(({ id }) => id)
					.filter(isConversationId);
				sessionStorage.setItem(THREADS_KEY, JSON.stringify(stored));
				sessionStorage.setItem(
					TEDI_BINDINGS_KEY,
					JSON.stringify(
						Object.fromEntries(
							sortedConversations()
								.filter((item) => stored.includes(item.id) && item.tediId)
								.map((item) => [item.id, item.tediId]),
						),
					),
				);
				if (activeConversation.hasMessages)
					sessionStorage.setItem(ACTIVE_THREAD_KEY, conversationId);
				else sessionStorage.removeItem(ACTIVE_THREAD_KEY);
			} catch {
				// Storage can be unavailable (private mode, quota); memory still works.
			}
		};
		{
			try {
				sessionStorage.removeItem(`tedix:threads:${tenant}`);
				sessionStorage.removeItem(`tedix:thread:${tenant}`);
			} catch {
				// Storage can be unavailable; in-memory conversations remain usable.
			}
		}
		const storedTediBindings = readTediBindings();
		for (const id of readStoredThreads()) {
			if (conversations.has(id)) continue;
			conversations.set(id, {
				id,
				tediId:
					typeof storedTediBindings[id] === "string"
						? storedTediBindings[id]
						: null,
				title: t("previous_conversation"),
				updatedAt: Date.now() - conversations.size,
				fragment: document.createDocumentFragment(),
				embeddedSession: null,
				embeddedClient: null,
				activities: new Map(),
				approvals: new Map(),
				lastAssistantAnswer: "",
				hydrated: false,
				hasMessages: true,
			});
		}
		let restoredAfterReload = false;
		let restoreRequest = null;
		let restoring = false;
		let hydrationVersion = 0;
		let hydrating = false;
		/** Resolves when the in-flight transcript hydration settles. */
		let hydrationSettled = null;
		const restoreActiveThread = () => {
			if (restoreRequest) return restoreRequest;
			if (restoredAfterReload || busy) return Promise.resolve();
			restoredAfterReload = true;
			restoring = true;
			restoreRequest = (async () => {
				const version = hydrationVersion;
				let storedId = null;
				try {
					storedId = sessionStorage.getItem(ACTIVE_THREAD_KEY);
				} catch {
					return;
				}
				await loadConversations();
				if (
					version !== hydrationVersion ||
					!storedId ||
					storedId === conversationId ||
					activeConversation.hasMessages
				)
					return;
				const target =
					conversations.get(storedId) ??
					sortedConversations().find((item) => item.hasMessages);
				if (target && target.id !== conversationId)
					await activateConversation(target.id);
			})().finally(() => {
				restoring = false;
			});
			return restoreRequest;
		};
		let historyRequest = null;
		let historyLoadedAt = 0;
		const loadConversations = async () => {
			if (historyRequest) return historyRequest;
			if (Date.now() - historyLoadedAt < 15_000) return;
			if (typeof historyProvider === "function") {
				historyRequest = (async () => {
					try {
						const recent = await historyProvider({ limit: MAX_CONVERSATIONS });
						for (const item of recent || []) {
							if (!item?.id) continue;
							const existing = conversations.get(item.id);
							if (existing) {
								existing.title = item.title || t("untitled_conversation");
								existing.updatedAt =
									Date.parse(item.updatedAt || "") || existing.updatedAt;
								existing.workspaceId =
									typeof item.workspaceId === "string"
										? item.workspaceId
										: existing.workspaceId;
								continue;
							}
							conversations.set(item.id, {
								id: item.id,
								title: item.title || t("untitled_conversation"),
								updatedAt: Date.parse(item.updatedAt || "") || Date.now(),
								fragment: document.createDocumentFragment(),
								embeddedSession: null,
								embeddedClient: null,
								activities: new Map(),
								approvals: new Map(),
								lastAssistantAnswer: "",
								hydrated: false,
								workspaceId:
									typeof item.workspaceId === "string"
										? item.workspaceId
										: null,
								hasMessages: true,
							});
						}
						historyLoadedAt = Date.now();
					} catch {
						// Locally created conversations remain available when history is offline.
					} finally {
						historyRequest = null;
					}
				})();
				return historyRequest;
			}
		};
		const sortedConversations = () =>
			[...conversations.values()].sort(
				(a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
			);
		const createConversationRow = (item, className) => {
			const listItem = document.createElement("div");
			listItem.setAttribute("role", "listitem");
			const row = document.createElement("button");
			row.type = "button";
			row.className = className;
			row.dataset.active = String(item.id === conversationId);
			row.innerHTML = `<span></span><time></time>`;
			row.querySelector("span").textContent = item.title;
			const time = row.querySelector("time");
			time.dateTime = new Date(item.updatedAt).toISOString();
			time.textContent = historyDateLabel(item.updatedAt);
			row.addEventListener("click", () => void activateConversation(item.id));
			listItem.append(row);
			return listItem;
		};
		/**
		 * Placeholder content for a region that is waiting on the network.
		 *
		 * An empty panel reads as "broken", not as "loading" — restoring a
		 * conversation used to blank the transcript entirely while the messages
		 * were fetched. These carry `aria-hidden` because the region that owns
		 * them announces its own busy state.
		 */
		const skeletons = (count, className, roles) =>
			Array.from({ length: count }, (_, index) => {
				const node = document.createElement("div");
				node.className = `tedix-skeleton ${className}`;
				node.setAttribute("aria-hidden", "true");
				if (roles?.[index]) node.dataset.role = roles[index];
				return node;
			});
		const renderHistory = async () => {
			const list = root.querySelector(".tedix-history-list");
			list.replaceChildren(...skeletons(4, "tedix-skeleton-row"));
			list.setAttribute("aria-busy", "true");
			await loadConversations();
			list.removeAttribute("aria-busy");
			// Replace, never append: the placeholders are the current children.
			list.replaceChildren(
				...sortedConversations().map((item) =>
					createConversationRow(item, "tedix-history-item"),
				),
			);
		};
		const renderRecentSessions = async () => {
			const section = thread.querySelector(".tedix-recent");
			const list = section?.querySelector(".tedix-recent-list");
			if (!section || !list) return;
			if (!list.childElementCount) {
				section.hidden = false;
				list.replaceChildren(...skeletons(2, "tedix-skeleton-row"));
				list.setAttribute("aria-busy", "true");
			}
			await loadConversations();
			list.removeAttribute("aria-busy");
			const recent = sortedConversations()
				.filter((item) => item.id !== conversationId)
				.slice(0, 3);
			list.replaceChildren(
				...recent.map((item) =>
					createConversationRow(item, "tedix-recent-item"),
				),
			);
			section.hidden = recent.length === 0;
		};
		const setHistoryOpen = (open) => {
			panel.toggleAttribute("data-history", open);
			history.hidden = !open;
			thread.hidden = open;
			composerWrap.hidden = open;
			if (open) void renderHistory();
			else input.focus();
		};
		const activateConversation = async (id) => {
			if (
				busy ||
				(id === conversationId &&
					(hydrating || activeConversation.hydrated !== false))
			) {
				setHistoryOpen(false);
				return;
			}
			const next = conversations.get(id);
			if (!next) return;
			const version = ++hydrationVersion;
			hydrating = false;
			input.disabled = next.hydrated === false;
			send.disabled = input.disabled || !input.value.trim();
			if (id !== conversationId) captureConversation();
			activeConversation = next;
			conversationId = next.id;
			selectedTediId = next.tediId ?? null;
			renderTediSelection();
			embeddedSession = next.embeddedSession;
			embeddedClient = next.embeddedClient;
			activities = next.activities;
			approvals = next.approvals;
			lastAssistantAnswer = next.lastAssistantAnswer;
			hostConversationContext = next.hostConversationContext ?? null;
			approvalProjectionWatcher?.dispose();
			approvalProjectionWatcher = null;
			thread.replaceChildren(...next.fragment.childNodes);
			if (next.hydrated === false) {
				hydrating = true;
				let releaseHydration = () => {};
				hydrationSettled = new Promise((resolve) => {
					releaseHydration = resolve;
				});
				input.disabled = true;
				send.disabled = true;
				// The placeholders are tracked so every exit of this block removes
				// exactly them, wherever they ended up. A conversation switch during
				// the fetch captures the thread's children — skeletons included — into
				// this conversation's fragment, and clearing the whole thread on
				// success would wipe a thread that no longer belongs to this
				// activation.
				const placeholders = skeletons(3, "tedix-skeleton-bubble", [
					"user",
					"assistant",
					"user",
				]);
				const removePlaceholders = () => {
					for (const node of placeholders) node.remove();
				};
				thread.replaceChildren(...placeholders);
				setHistoryOpen(false);
				thread.setAttribute("aria-busy", "true");
				let reader = null;
				let timeout = null;
				try {
					const read = async () => {
						if (typeof transcriptProvider === "function")
							return await transcriptProvider({ conversationId: id });
						reader = createEmbeddedClient(async () => {
							const session = await requestEmbeddedSession(id);
							return { streamUrl: session.streamUrl, token: session.token };
						});
						const { messages } = await reader.readTranscript();
						if (!messages.length) throw new Error("Conversation unavailable");
						return messages;
					};
					// A restore that never settled left the shimmer and the disabled
					// composer in place for the life of the page.
					const messages = await Promise.race([
						read(),
						new Promise((_, reject) => {
							timeout = setTimeout(
								() =>
									reject(
										Object.assign(
											new Error(
												`Transcript restore exceeded ${TRANSCRIPT_RESTORE_TIMEOUT_MS}ms`,
											),
											{ code: "transcript_timeout" },
										),
									),
								TRANSCRIPT_RESTORE_TIMEOUT_MS,
							);
						}),
					]);
					if (destroyed || version !== hydrationVersion) return;
					// Replace, never append below: the restored messages take the
					// placeholders' place. Appending after them left three grey bubbles
					// standing above every restored transcript.
					removePlaceholders();
					next.hasMessages = false;
					for (const message of messages || []) {
						if (
							(message.role === "user" || message.role === "assistant") &&
							(message.content ||
								(message.role === "assistant" && message.metadata))
						)
							addMessage(
								message.role,
								message.content || "",
								false,
								message.metadata,
							);
					}
					const firstUser = messages?.find(
						(message) => message.role === "user" && message.content,
					);
					if (firstUser) next.title = firstUser.content.slice(0, 72);
					next.hydrated = true;
				} catch (error) {
					console.error(
						`[tedix widget] conversation ${id}: transcript restore failed (${error?.code ?? "restore_failed"}): ${error?.message ?? error}`,
					);
					if (destroyed || version !== hydrationVersion) return;
					const recovery = document.createElement("div");
					recovery.className = "tedix-empty";
					recovery.setAttribute("role", "alert");
					recovery.textContent = t("i_couldn_t_load_this_conversation");
					const retry = document.createElement("button");
					retry.className = "tedix-prompt";
					retry.type = "button";
					retry.textContent = t("try_again");
					retry.addEventListener("click", () => void activateConversation(id));
					recovery.append(retry);
					const restart = document.createElement("button");
					restart.className = "tedix-prompt";
					restart.type = "button";
					restart.textContent = t("new_conversation");
					restart.addEventListener("click", reset);
					recovery.append(restart);
					thread.replaceChildren(recovery);
				} finally {
					if (timeout) clearTimeout(timeout);
					reader?.dispose();
					// Success, failure, timeout, or a newer activation/reset taking the
					// thread mid-fetch: a skeleton is never permanent.
					removePlaceholders();
					if (version === hydrationVersion) {
						hydrating = false;
						input.disabled = next.hydrated === false;
						send.disabled = input.disabled || !input.value.trim();
						thread.removeAttribute("aria-busy");
					}
					releaseHydration();
				}
			}
			if (destroyed || version !== hydrationVersion) return;
			followLatest = true;
			persistThreads();
			setHistoryOpen(false);
			scrollLatest();
			if (panel.hasAttribute("data-open")) {
				void getEmbeddedSession()
					.then(startApprovalProjection)
					.catch(() => setConnectionState("error"));
			}
		};
		const reset = (nextTediId = null) => {
			if (busy) return;
			++hydrationVersion;
			hydrating = false;
			restoring = false;
			restoredAfterReload = true;
			restoreRequest = null;
			input.disabled = false;
			send.disabled = !input.value.trim();
			thread.removeAttribute("aria-busy");
			captureConversation();
			selectedTediId = typeof nextTediId === "string" ? nextTediId : null;
			renderTediSelection();
			conversationId = crypto.randomUUID();
			embeddedClient = null;
			embeddedSession = null;
			approvalProjectionWatcher?.dispose();
			approvalProjectionWatcher = null;
			lastAssistantAnswer = "";
			hostConversationContext = null;
			activities = new Map();
			approvals = new Map();
			activeConversation = {
				id: conversationId,
				tediId: selectedTediId,
				title: t("new_conversation"),
				updatedAt: Date.now(),
				fragment: document.createDocumentFragment(),
				embeddedSession,
				embeddedClient,
				activities,
				approvals,
				lastAssistantAnswer,
				hostConversationContext,
				workspaceId: null,
				hasMessages: false,
			};
			conversations.set(conversationId, activeConversation);
			persistThreads();
			if (conversations.size > MAX_CONVERSATIONS) {
				const oldest = [...conversations.values()]
					.filter((item) => item.id !== conversationId)
					.sort((a, b) => a.updatedAt - b.updatedAt)[0];
				oldest?.embeddedClient?.dispose();
				if (oldest) conversations.delete(oldest.id);
			}
			followLatest = true;
			thread.innerHTML = homeMarkup();
			bindHome();
			void renderRecentSessions();
			setHistoryOpen(false);
		};
		tediSelect.addEventListener("change", () => {
			const next = tediSelect.value;
			if (
				busy ||
				voiceState !== "idle" ||
				queuedMessages.length ||
				!tediChoices.some((choice) => choice.id === next)
			) {
				renderTediSelection();
				return;
			}
			input.value = "";
			reset(next);
			void getEmbeddedSession().catch(() => {
				setConnectionState("error");
				sessionRecovery.hidden = false;
				sessionRecoveryText.textContent = t("tedi_selection_failed");
			});
		});
		const permanentlyDeleteConversation = async (id) => {
			if (busy)
				throw new Error(
					"Wait for the active response before deleting a conversation",
				);
			if (typeof deleteConversationProvider !== "function")
				throw new Error("Conversation deletion is not configured by this host");
			const target = conversations.get(id);
			await deleteConversationProvider({ conversationId: id });
			target?.embeddedClient?.dispose();
			conversations.delete(id);
			if (id === conversationId) reset();
			// The in-memory map is not the record that survives a reload —
			// sessionStorage is, and it still held the deleted thread. `reset()`
			// re-persists, but it only runs when the ACTIVE conversation was
			// deleted; deleting any other one left its id and title in
			// THREADS_KEY, and `readStoredThreads()` re-created it on the next
			// load. A conversation the customer permanently deleted came back in
			// their history panel.
			persistThreads();
			try {
				// `persistThreads` writes the active pointer only when the current
				// conversation has messages, so after a delete-then-reset it can
				// still name the id just removed.
				if (sessionStorage.getItem(ACTIVE_THREAD_KEY) === id)
					sessionStorage.removeItem(ACTIVE_THREAD_KEY);
			} catch {
				// Storage can be unavailable (private mode, quota); memory is correct.
			}
			if (!history.hidden) await renderHistory();
			emit("conversationDeleted", { tenant, conversationId: id });
			return { ok: true, conversationId: id };
		};
		const addMessage = (role, content, streaming = false, metadata = null) => {
			thread.querySelector(".tedix-empty")?.remove();
			activeConversation.hasMessages = true;
			const item = document.createElement("article");
			item.className = `tedix-message tedix-message-${role}`;
			item.dataset.role = role;
			// Reading order inside an assistant turn: tool activity first, then
			// the answer it produced, then any interactive projections.
			const activityList = document.createElement("div");
			activityList.className = "tedix-activities";
			const bubble = document.createElement("div");
			bubble.className = "tedix-bubble";
			if (streaming) {
				bubble.innerHTML = `<span class="tedix-thinking" role="status" aria-label="${escapeHtml(content)}"><span class="tedix-thinking-label">${t("thinking")}</span></span>`;
			} else if (role === "assistant")
				bubble.innerHTML = renderMarkdown(content);
			else bubble.textContent = content;
			if (role === "assistant") item.append(activityList);
			item.append(bubble);
			thread.append(item);
			if (role === "assistant" && metadata) {
				renderToolProjection(metadata, null, item);
			}
			scrollLatest();
			return { item, bubble, activities: activityList };
		};
		const setPendingStatus = (pending, label) => {
			const status = pending.bubble.querySelector(".tedix-thinking");
			if (!status) return;
			status.setAttribute("aria-label", label);
			status.querySelector(".tedix-thinking-label").textContent = label;
		};
		/**
		 * One quiet line per turn, not one card per tool.
		 *
		 * People read a transcript for the answer. What the assistant did on the
		 * way is worth one collapsed row — live progress while it runs, then how
		 * long it took — with the plain-language steps behind a disclosure for
		 * anyone who wants them.
		 */
		const ensureWorklog = (pending) => {
			const container = pending?.activities || thread;
			let worklog = container.querySelector(".tedix-worklog");
			if (worklog) return worklog;
			worklog = document.createElement("details");
			worklog.className = "tedix-worklog";
			// Open while the turn runs. The tool phase is the longest silence in an
			// answer, and the steps are the only thing happening during it.
			worklog.open = true;
			worklog.innerHTML = `<summary><span class="tedix-worklog-label"></span><span class="tedix-worklog-chevron">${icon(ICONS.chevron)}</span></summary><ul class="tedix-worklog-steps"></ul>`;
			container.append(worklog);
			return worklog;
		};
		/**
		 * The model's own reasoning, which the transcript reducer has always
		 * accumulated and the panel has always thrown away.
		 *
		 * With a reasoning model most of the wait is the reasoning, so dropping it
		 * left a shimmer standing still for twenty seconds. It lives inside the
		 * worklog disclosure, collapsed, because it is the assistant thinking out
		 * loud rather than part of the answer.
		 */
		const setWorklogThinking = (pending, reasoning) => {
			const worklog = pending?.activities?.querySelector(".tedix-worklog");
			if (!worklog) return;
			let node = worklog.querySelector(".tedix-worklog-thinking");
			if (!reasoning) {
				node?.remove();
				return;
			}
			if (!node) {
				node = document.createElement("p");
				node.className = "tedix-worklog-thinking";
				worklog.append(node);
			}
			// The tail is what is happening now; the whole transcript of thought is
			// neither useful nor kind to a panel this size.
			node.textContent = reasoning.slice(-600);
			node.scrollTop = node.scrollHeight;
		};
		const setWorklogLabel = (pending, label) => {
			const worklog = pending?.activities?.querySelector(".tedix-worklog");
			if (!worklog) return;
			worklog.querySelector(".tedix-worklog-label").textContent = label;
		};
		/** "Worked for 1m 53s" — the same shape a person sees in other assistants. */
		const workedForLabel = (elapsedMs) => {
			const seconds = Math.max(1, Math.round(elapsedMs / 1000));
			const spelled =
				seconds < 60
					? `${seconds}s`
					: `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
			return t("worked_for", { duration: spelled });
		};
		/**
		 * Row state per worklog, keyed by the map the caller owns for that turn.
		 *
		 * A row is not a tool call: repeated calls to the same tool share one row
		 * and one `<li>`, so the same question asked twice reads as one action
		 * done twice rather than as the identical sentence printed twice.
		 */
		const worklogRows = new WeakMap();
		/**
		 * Projects one reducer activity onto a step row inside the turn's worklog,
		 * creating the row on first sight.
		 *
		 * The row's identity is the tenant's own label, not the activity id, so
		 * the in-flight row and the settled row are the same element: the swap
		 * from "Checking orders…" to "✓ Checked orders" never remounts, and an
		 * expanded worklog stays where the reader left it.
		 */
		const upsertActivity = (
			activity,
			session,
			pending,
			turnActivities = activities,
		) => {
			if (!activity?.id) return;
			const worklog = ensureWorklog(pending);
			let rows = worklogRows.get(turnActivities);
			if (!rows) {
				rows = new Map();
				worklogRows.set(turnActivities, rows);
			}
			const key = activityRowKey(activity);
			let row = rows.get(key);
			let step = turnActivities.get(activity.id) || row?.step;
			if (!step) {
				step = document.createElement("li");
				step.className = "tedix-worklog-step";
				worklog.querySelector(".tedix-worklog-steps").append(step);
			}
			if (!row) {
				row = { step, calls: new Map() };
				rows.set(key, row);
			}
			row.step = step;
			turnActivities.set(activity.id, step);
			row.calls.set(activity.id, activity);
			const line = activityRowText([...row.calls.values()], activityCopy);
			step.dataset.status = line.status;
			step.dataset.streaming = line.streaming ? "true" : "false";
			step.textContent = line.text;
			// Past three distinct rows the list stops being a worklog and starts
			// being noise, so it degrades to a single count.
			const overflow = rows.size > MAX_ACTIVITY_ROWS;
			let total = 0;
			for (const candidate of rows.values()) {
				candidate.step.hidden = overflow;
				total += candidate.calls.size;
			}
			let summary = worklog.querySelector(".tedix-worklog-step[data-overflow]");
			if (overflow) {
				if (!summary) {
					summary = document.createElement("li");
					summary.className = "tedix-worklog-step";
					summary.dataset.overflow = "true";
					worklog.querySelector(".tedix-worklog-steps").append(summary);
				}
				summary.textContent = t("n_actions", { count: total });
			} else summary?.remove();
			if (
				activity.status !== "running" &&
				activity.result !== undefined &&
				!row.projected?.has(activity.id)
			) {
				(row.projected ??= new Set()).add(activity.id);
				renderToolProjection(activity.result, session, pending?.item || thread);
			}
		};
		const encodeWidgetPayload = (value) => {
			const bytes = new TextEncoder().encode(JSON.stringify(value));
			let binary = "";
			for (const byte of bytes) binary += String.fromCharCode(byte);
			return btoa(binary)
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replace(/=+$/, "");
		};
		const findApproval = (value, depth = 0) => {
			if (!value || typeof value !== "object" || depth > 6) return null;
			if (
				typeof value.approvalRequestId === "string" &&
				(value.status === "approval_requested" ||
					value.status === "paused" ||
					value.requiresApproval === true)
			) {
				return {
					id: value.approvalRequestId,
					description:
						value.description ||
						value.instruction ||
						`${configuredTitle} necesita tu confirmación antes de continuar.`,
				};
			}
			for (const child of Object.values(value)) {
				const found = findApproval(child, depth + 1);
				if (found) return found;
			}
			return null;
		};
		const addApproval = (approval, session) => {
			if (!session || approvals.has(approval.id)) return;
			const card = document.createElement("section");
			card.className = "tedix-approval";
			card.innerHTML = `<strong>${t("confirmation_required")}</strong><p></p><div><button type="button" data-decision="reject">${t("reject")}</button><button type="button" data-decision="approve">${t("approve")}</button></div><span aria-live="polite"></span>`;
			card.querySelector("p").textContent = approval.description;
			const status = card.querySelector("span");
			card.querySelectorAll("button").forEach((button) =>
				button.addEventListener("click", async () => {
					const approved = button.dataset.decision === "approve";
					card.querySelectorAll("button").forEach((item) => {
						item.disabled = true;
					});
					status.textContent = embeddedApprovalLabel("saving", t);
					try {
						await getEmbeddedClient().resolveApproval(approval.id, approved);
						approvalProjectionWatcher?.wake();
						card.dataset.resolved = approved ? "approved" : "rejected";
						status.textContent = embeddedApprovalLabel(
							approved ? "approved" : "rejected",
							t,
						);
					} catch {
						status.textContent = embeddedApprovalLabel("error", t);
						card.querySelectorAll("button").forEach((item) => {
							item.disabled = false;
						});
					}
				}),
			);
			approvals.set(approval.id, card);
			thread.append(card);
		};
		const applyApprovalProjection = (result, session) => {
			const pending = new Set(
				(result.data || []).map((approval) => approval.id),
			);
			for (const [id, card] of approvals) {
				if (pending.has(id)) continue;
				card.remove();
				approvals.delete(id);
			}
			for (const approval of result.data || []) {
				addApproval(
					{
						id: approval.id,
						description:
							approval.review?.operatorQuestion ||
							approval.description ||
							`${configuredTitle} necesita tu confirmación antes de continuar.`,
					},
					session,
				);
			}
		};
		const startApprovalProjection = async (session) => {
			approvalProjectionWatcher?.dispose();
			const watcher = getEmbeddedClient().watchApprovals(
				(result) => applyApprovalProjection(result, session),
				{ idleMs: 60_000 },
			);
			approvalProjectionWatcher = watcher;
		};
		const loadPendingApprovals = async (session) =>
			startApprovalProjection(session);
		const renderToolProjection = (output, session, container = thread) => {
			const approval = findApproval(output);
			if (approval) addApproval(approval, session);
			const projections = findMcpAppRenderProjections(output);
			for (const projection of projections) {
				// One representation per fact: a static view is already in the answer.
				if (!projectionEarnsFrame(projection)) continue;
				const url = new URL(
					`/${projection.appSlug}/r/${projection.layoutId}`,
					MCP_APP_ORIGIN,
				);
				if (projection.layoutSpec)
					url.searchParams.set(
						"spec",
						encodeWidgetPayload(projection.layoutSpec),
					);
				if (host.dataset.theme)
					url.searchParams.set("theme", host.dataset.theme);
				url.hash = `data=${encodeWidgetPayload(projection.toolResult)}`;
				addWidget(
					{
						kind: "mcp-app",
						url: url.href,
						title: t("result", { assistant: configuredTitle }),
					},
					container,
				);
			}
		};
		const requestEmbeddedSession = async (sessionConversationId) => {
			const requestedTediId =
				conversations.get(sessionConversationId)?.tediId ?? selectedTediId;
			const verifySelection = (result) => {
				const selection = result?.tediSelection;
				if (requestedTediId && selection?.selectedTediId !== requestedTediId)
					throw new Error(t("tedi_selection_failed"));
				if (
					selection &&
					(!Array.isArray(selection.tedis) ||
						!selection.tedis.some(
							(choice) => choice.id === selection.selectedTediId,
						))
				)
					throw new Error(t("tedi_selection_failed"));
				if (selection && conversationId === sessionConversationId) {
					selectedTediId = selection.selectedTediId;
					activeConversation.tediId = selectedTediId;
					tediChoices = selection.tedis;
					renderTediSelection();
					persistThreads();
				}
				const models = result?.modelSelection;
				if (models && conversationId === sessionConversationId) {
					modelChoices = Array.isArray(models.models) ? models.models : [];
					effortChoices = Array.isArray(models.efforts) ? models.efforts : [];
					defaultModelRef =
						typeof models.defaultRef === "string" ? models.defaultRef : "";
					renderModelSelection();
				}
				return result;
			};
			if (!sharedConsent.functional)
				throw new Error("Tedix functional access is disabled by host consent.");
			const sessionStartedAt = now();
			reliability.sessionAttempts += 1;
			const finishSessionAttempt = (outcome) => {
				reliability.lastSessionMs = Math.max(
					0,
					Math.round(now() - sessionStartedAt),
				);
				reliability.lastSessionOutcome = outcome;
				emit("performance", {
					phase: "session",
					outcome,
					durationMs: reliability.lastSessionMs,
				});
			};
			setConnectionState("connecting");
			if (typeof sessionProvider === "function") {
				try {
					const result = await sessionProvider({
						conversationId: sessionConversationId,
						...(requestedTediId ? { selectedTediId: requestedTediId } : {}),
						hostConversationContext,
						pathname: location.pathname,
					});
					verifySelection(result);
					lastError = null;
					setConnectionState("connected");
					finishSessionAttempt("succeeded");
					emit("session-refreshed", {
						tenant,
						expiresAt: result.expiresAt ?? null,
					});
					return result;
				} catch (error) {
					lastError = "session_provider_failed";
					setConnectionState("error");
					finishSessionAttempt("failed");
					emit("error", { tenant, code: lastError });
					throw error;
				}
			}
			let response;
			let result;
			try {
				response = await fetch(endpoint, {
					method: "POST",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						conversationId: sessionConversationId,
						...(requestedTediId ? { selectedTediId: requestedTediId } : {}),
						pathname: location.pathname,
					}),
				});
				result = await response.json();
			} catch (error) {
				lastError = "session_network_failed";
				setConnectionState("error");
				finishSessionAttempt("failed");
				emit("error", { tenant, code: lastError });
				throw error;
			}
			if (!response.ok) {
				lastError =
					typeof result?.code === "string"
						? result.code
						: `session_http_${response.status}`;
				setConnectionState("error");
				finishSessionAttempt("failed");
				emit("error", { tenant, code: lastError });
				throw new Error(
					result.error || `${configuredTitle} no está disponible.`,
				);
			}
			verifySelection(result);
			setConnectionState("connected");
			finishSessionAttempt("succeeded");
			lastError = null;
			emit("session-refreshed", {
				tenant,
				expiresAt: result.expiresAt ?? null,
			});
			return result;
		};
		let readyMeasurementSent = false;
		const getEmbeddedSession = async () => {
			if (embeddedSession && embeddedSession.expiresAt > Date.now() + 30_000)
				return embeddedSession;
			const requestedConversationId = conversationId;
			const requestedRouteRevision = portableRouteRevision;
			return embeddedSessionRequests.run(requestedConversationId, async () => {
				const session = await requestEmbeddedSession(requestedConversationId);
				if (
					conversationId === requestedConversationId &&
					portableRouteRevision === requestedRouteRevision
				) {
					embeddedSession = session;
					if (
						session.analyticsEnabled === true &&
						sharedConsent.analytics !== false &&
						!destroyed
					) {
						const events = [
							{
								eventId: crypto.randomUUID(),
								milestone: "session",
								durationMs: Math.min(300_000, reliability.lastSessionMs ?? 0),
								outcome: "succeeded",
							},
						];
						if (!readyMeasurementSent && reliability.readyMs !== null) {
							events.push({
								eventId: crypto.randomUUID(),
								milestone: "ready",
								durationMs: Math.min(300_000, reliability.readyMs),
								outcome: "succeeded",
							});
							readyMeasurementSent = true;
						}
						void getEmbeddedClient()
							.metrics({
								conversationId: requestedConversationId,
								clientRequestId: crypto.randomUUID(),
								events,
							})
							.catch(() => {});
					}
				}
				return session;
			});
		};
		const setVoiceState = (state) => {
			voiceState = state;
			renderTediSelection();
			form.dataset.voiceState = state;
			const active = state !== "idle";
			voiceCancel.hidden = !active;
			voiceStatus.hidden = !active;
			input.hidden = active;
			// Keep the primary control available while getUserMedia is pending. A
			// second click during that phase must cancel the attempt, never start a
			// competing recorder request.
			voiceButton.hidden = state === "transcribing";
			const voiceButtonLabel =
				state === "recording"
					? t("stop_and_transcribe")
					: state === "connecting"
						? t("cancel_dictation")
						: t("dictate_message");
			voiceButton.innerHTML = icon(
				state === "recording"
					? ICONS.stop
					: state === "connecting"
						? ICONS.close
						: ICONS.microphone,
			);
			voiceButton.setAttribute("aria-label", voiceButtonLabel);
			voiceButton.setAttribute("title", voiceButtonLabel);
			voiceStatus.setAttribute(
				"aria-label",
				state === "connecting"
					? t("connecting_microphone")
					: state === "transcribing"
						? t("transcribing")
						: t("listening"),
			);
			if (state === "idle") input.focus();
		};
		const setVoiceError = (message) => {
			voiceError.hidden = !message;
			voiceErrorText.textContent = message || "";
		};
		const getVoiceController = () => {
			if (voiceController) return voiceController;
			voiceController = createRecordedVoiceComposerController({
				onTranscript: (transcript) => {
					input.value = appendVoiceTranscript(input.value, transcript);
					input.dispatchEvent(new Event("input"));
				},
				onEvent: (event) => emit("voice", { tenant, ...event }),
				transcribeRecording: async (recording) => {
					const session = await getEmbeddedSession();
					const endpoint = new URL(session.streamUrl);
					// A browser embedded in an HTTPS host must never turn a ws://
					// session URL into mixed-content HTTP. The tedi production host
					// supports TLS, while localhost development remains HTTP.
					endpoint.protocol =
						window.location.protocol === "https:" ? "https:" : "http:";
					endpoint.pathname = "/voice/transcribe";
					endpoint.search = "";
					const body = new FormData();
					body.append("file", recording.blob, recording.fileName);
					body.append("language", navigator.language.split("-", 1)[0]);
					const response = await fetch(endpoint, {
						method: "POST",
						headers: { Authorization: `Bearer ${session.token}` },
						body,
					});
					if (!response.ok) throw new Error("Voice transcription failed");
					const payload = await response.json();
					if (typeof payload.text !== "string" || !payload.text.trim())
						throw new Error("No speech was detected");
					return payload.text;
				},
				transcriptionTimeoutMs: 30_000,
			});
			voiceController.subscribe((snapshot) => {
				setVoiceState(snapshot.phase);
				setVoiceError(snapshot.error);
				for (const [index, bar] of voiceBars.entries()) {
					bar.style.height = `${voiceWaveBarHeight(snapshot.audioHistory[index] ?? 0)}px`;
				}
			});
			return voiceController;
		};
		const beginDictation = () => getVoiceController().start();
		const finishDictation = () => {
			// A native recorder can take a turn to dispatch its final stop event.
			// Acknowledge the press before that work begins so Stop never appears
			// unresponsive, then let the controller own the actual recording lifecycle.
			setVoiceState("transcribing");
			getVoiceController().stop();
		};
		const cancelDictation = () => getVoiceController().cancel();
		const getEmbeddedClient = () => {
			embeddedClient ??= createEmbeddedClient(
				async () => {
					const session = await getEmbeddedSession();
					return { streamUrl: session.streamUrl, token: session.token };
				},
				undefined,
				{
					onConnect: () => {
						if (!reconnectPending) return;
						reconnectPending = false;
						activeTurnMilestones?.record("reconnect_recovered", {
							reconnectAttempt: reliability.lastReconnects,
						});
					},
					onRetry: ({ attempt, delayMs }) => {
						reliability.lastReconnects += 1;
						reconnectPending = true;
						activeTurnMilestones?.record("reconnect_started", {
							reconnectAttempt: attempt,
						});
						emit("performance", {
							phase: "turn-reconnect",
							attempt,
							delayMs,
						});
					},
				},
			);
			return embeddedClient;
		};
		const addWidget = (widget, container = thread) => {
			const src = resolveWidgetFrameSource(widget?.url || widget?.resourceUrl, {
				pageHref: location.href,
				pageOrigin: location.origin,
			});
			if (!src) return;
			const frame = document.createElement("div");
			frame.className = "tedix-widget-frame";
			const iframe = document.createElement("iframe");
			iframe.title = widget.title || `Resultado de ${configuredTitle}`;
			iframe.loading = "lazy";
			iframe.src = src;
			if (widget.kind === "mcp-app") iframe.dataset.tedixMcpApp = "true";
			iframe.setAttribute("sandbox", WIDGET_FRAME_SANDBOX);
			frame.append(iframe);
			container.append(frame);
		};
		/**
		 * A submit that cannot run right now is either a wait or a refusal, and
		 * the caller deserves to know which.
		 *
		 * This used to resolve with "" in every blocked case, so a host calling
		 * `Tedix.ask()` while the widget was restoring got silence: no message,
		 * no error, nothing to retry on. Every refusal now carries a code. The
		 * WAIT for a transient restore belongs to `controller.ask`, not here:
		 * this body must reach its composer acknowledgement before its first
		 * await, which is the ordering a reported "Enter does nothing" defect
		 * pinned in place.
		 */
		const submit = async (content, options = {}) => {
			if (!content) return "";
			if (busy)
				throw Object.assign(new Error("A turn is already running."), {
					code: "turn_in_progress",
				});
			if (restoring || hydrating)
				throw Object.assign(new Error("The conversation is still loading."), {
					code: "conversation_loading",
				});
			if (!restoredAfterReload) {
				const request = restoreActiveThread();
				return request.then(() => {
					// Resolving with "" here dropped the message in silence whenever a
					// newer restore superseded ours — the text stayed in the composer
					// with nothing sent and nothing said. What matters is whether the
					// thread is restored, not which request restored it.
					if (restoredAfterReload) return submit(content, options);
					throw Object.assign(new Error("The conversation is still loading."), {
						code: "conversation_loading",
					});
				});
			}
			if (activeConversation.hydrated === false)
				throw Object.assign(
					new Error("The conversation could not be loaded."),
					{ code: "conversation_unavailable" },
				);
			busy = true;
			renderTediSelection();
			activeRequest = new AbortController();
			const request = activeRequest;
			// Acknowledge the keypress before any awaited host round trip.
			// `continueConversation` and `prepareConversationContext` below are
			// network calls, and the input was only cleared after them — so a first
			// message or a workspace-linked turn left the typed text sitting in a
			// composer with no pending state, while `busy` swallowed a second
			// Enter. It read as "Enter does not submit", and was reported as
			// exactly that. Restored by `restoreComposer` on every path that
			// abandons the turn, so nothing the customer typed is lost.
			// Only the COMPOSER's own submit may clear the composer. `controller.ask()`
			// submits programmatically while the customer may be mid-sentence, and
			// clearing their draft under them would be a worse bug than the one this
			// fixes.
			const fromComposer = input.value.trim() === content;
			const submittedText = input.value;
			const restoreComposer = () => {
				if (!fromComposer) return;
				if (input.value === "") {
					input.value = submittedText;
					input.style.height = "auto";
				}
				send.innerHTML = icon(ICONS.send);
				send.setAttribute("aria-label", t("send"));
				send.disabled = !input.value.trim();
			};
			if (fromComposer) {
				input.value = "";
				input.style.height = "auto";
			}
			// The send control is the only affordance that exists this early — the
			// pending assistant bubble is not created until after the preflight.
			send.disabled = false;
			send.innerHTML = icon(ICONS.stop);
			send.setAttribute("aria-label", t("stop"));
			if (
				activeConversation.workspaceId &&
				typeof continueConversation === "function"
			) {
				try {
					const continued = await waitForTurnPreparation(
						continueConversation({
							conversationId,
							idempotencyKey: `widget:${conversationId}:${crypto.randomUUID()}`,
							text: content,
							workspaceId: activeConversation.workspaceId,
						}),
						request.signal,
					);
					const handoff =
						continued?.kind === "handoff" && typeof continued.url === "string"
							? safeHostRoute(continued.url)
							: null;
					if (!handoff)
						throw new Error("Host returned an invalid conversation handoff");
					location.href = handoff;
					return "";
				} catch (error) {
					busy = false;
					renderTediSelection();
					activeRequest = null;
					restoreComposer();
					throw error;
				}
			}
			if (
				!activeConversation.hasMessages &&
				!hostConversationContext &&
				typeof prepareConversationContext === "function"
			) {
				try {
					const prepared = await waitForTurnPreparation(
						prepareConversationContext({
							conversationId,
							pathname: location.pathname,
							text: content,
						}),
						request.signal,
					);
					if (prepared?.kind === "handoff") {
						if (typeof prepared.url !== "string")
							throw new Error("Host returned an invalid conversation handoff");
						const handoff = safeHostRoute(prepared.url);
						if (!handoff)
							throw new Error("Host returned an invalid conversation handoff");
						location.href = handoff;
						return "";
					}
					if (prepared?.kind === "context") {
						const context = prepared.context;
						if (
							!context ||
							typeof context.kind !== "string" ||
							!/^[a-z][a-z0-9_]{1,63}$/.test(context.kind) ||
							typeof context.reference !== "string" ||
							context.reference.length < 1 ||
							context.reference.length > 200 ||
							(context.label !== undefined &&
								(typeof context.label !== "string" ||
									context.label.length < 1 ||
									context.label.length > 300))
						)
							throw new Error("Host returned an invalid conversation context");
						hostConversationContext = context;
						activeConversation.hostConversationContext = context;
						// A launcher open may have obtained an unbound capability already.
						// Replace it before this first turn so the signed context is present.
						embeddedClient?.dispose();
						embeddedClient = null;
						embeddedSession = null;
					} else if (prepared != null) {
						throw new Error("Host returned an unsupported conversation result");
					}
				} catch (error) {
					busy = false;
					renderTediSelection();
					activeRequest = null;
					restoreComposer();
					throw error;
				}
			}
			let submittedAnswer = "";
			if (activeConversation.title === t("new_conversation"))
				activeConversation.title = content.slice(0, 72);
			activeConversation.updatedAt = Date.now();
			followLatest = true;
			root.querySelector(".tedix-new").disabled = true;
			if (!options.queued) addMessage("user", content);
			persistThreads();
			send.disabled = false;
			send.innerHTML = icon(ICONS.stop);
			send.setAttribute("aria-label", t("stop"));
			const pending = addMessage(
				"assistant",
				t("is_thinking", { assistant: configuredTitle }),
				true,
			);
			const turnStartedAt = now();
			const clientRequestId = crypto.randomUUID();
			activeRequest.clientRequestId = clientRequestId;
			const turnMilestones = createEmbeddedTurnMilestones({
				conversationId,
				clientRequestId,
				enabled: () =>
					embeddedSession?.analyticsEnabled === true &&
					sharedConsent.analytics !== false &&
					!destroyed,
				now,
				send: (batch) => getEmbeddedClient().metrics(batch),
			});
			activeTurnMilestones = turnMilestones;
			reconnectPending = false;

			emit("message-submitted", {});
			reliability.turnAttempts += 1;
			reliability.lastTurnOutcome = "running";
			reliability.lastFirstEventMs = null;
			reliability.lastFirstTextMs = null;
			reliability.lastReconnects = 0;
			// DOM-derived headings belong to this turn, not the host's route snapshot.
			const turnPageContext = hostPageContext(pageContext);
			let progressLabel = t("thinking");
			// One owner for the waiting label. The per-second timer and the render
			// frame both write it, and when the render frame composed its own
			// string without the elapsed suffix the counter visibly vanished for
			// whichever phase rendered last — "Pensando · 1s" became a bare
			// "Preparando todo" until the next tick put the seconds back.
			const elapsedSeconds = () =>
				Math.max(1, Math.round((now() - turnStartedAt) / 1000));
			const waitingLabel = (label = progressLabel) =>
				`${label} · ${elapsedSeconds()}s`;
			// The per-second tick re-renders whichever surface owns the label. Until
			// the transcript exists that is the bubble's thinking line; once the
			// render frame exists the tick runs it, so the worklog header's
			// "· 8s" keeps counting through a tool phase, when no reducer event
			// arrives for seconds at a time. The header used to freeze there:
			// the timer wrote only the bubble line, and after the turn had
			// activities that node was gone, so nothing re-rendered the duration.
			let progressTick = () => setPendingStatus(pending, waitingLabel());
			const progressTimer = setInterval(() => progressTick(), 1000);
			let locallyFinalized = false;
			let answer = "";
			try {
				const session = await waitForTurnPreparation(
					getEmbeddedSession(),
					request.signal,
				);
				turnMilestones.record("submitted");
				const turnActivities = new Map();
				// The shared reducer owns turn state; the DOM below is a projection.
				let transcript = reduceTranscript(
					createTranscriptState(conversationId, toolLabels),
					{ type: "assistant_start", id: clientRequestId },
				);
				const currentTurn = () => transcript.turns[transcript.turns.length - 1];
				let renderedAnswer = null;
				let renderFrame = 0;
				const renderTurn = () => {
					renderFrame = 0;
					const turn = currentTurn();
					for (const activity of turn.activities)
						upsertActivity(activity, session, pending, turnActivities);
					// A turn with no tool call still has a worklog row: the wait is the
					// thing that needs reporting, and a static panel reads as frozen.
					if (turn.activities.length || !turn.text) {
						if (turn.finalized) {
							const done = pending?.activities?.querySelector(".tedix-worklog");
							if (done) done.open = false;
						}
						setWorklogLabel(
							pending,
							turn.finalized
								? workedForLabel(now() - turnStartedAt)
								: waitingLabel(
										turn.activities.some(
											(activity) => activity.status === "running",
										)
											? t("looking_in", { product: productLabel })
											: progressLabel,
									),
						);
						setWorklogThinking(pending, turn.finalized ? "" : turn.reasoning);
					}
					if (turn.text && turn.text !== renderedAnswer) {
						renderedAnswer = turn.text;
						pending.bubble.innerHTML = renderMarkdown(turn.text);
					} else if (!turn.text && turn.finalized) {
						pending.bubble.innerHTML = renderMarkdown(
							turn.error
								? userFacingChatError(new Error(turn.error), t)
								: t("ready"),
						);
					} else if (!turn.text) {
						// The worklog header already says what is happening. Repeating it
						// in the thinking bubble reads as two things happening at once.
						// The bubble's status line is REMOVED, not hidden: `.tedix-thinking`
						// sets its own `display`, which beats the `[hidden]` rule, and the
						// per-second timer kept writing the phase into the hidden node —
						// so the "looking in {product}" line rendered twice for the whole tool
						// phase. With the node gone, the timer's write finds nothing.
						if (turn.activities.length > 0)
							pending.bubble.querySelector(".tedix-thinking")?.remove();
						else setPendingStatus(pending, waitingLabel());
					}
					scrollLatest();
				};
				const scheduleRender = () => {
					if (renderFrame) return;
					renderFrame = requestAnimationFrame(renderTurn);
				};
				progressTick = renderTurn;
				let idleTimer = null;
				let resolveLocalFinal = () => {};
				const localFinal = new Promise((resolve) => {
					resolveLocalFinal = resolve;
				});
				const finalizeLocally = () => {
					idleTimer = null;
					if (currentTurn().finalized) return;
					locallyFinalized = true;
					answer = currentTurn().text;
					transcript = reduceTranscript(transcript, {
						type: "fail",
						message: "Subscription ended before completion",
					});
					console.warn(
						`[tedix widget] conversation ${conversationId}: no terminal frame within the phase timeout; failed locally`,
					);
					if (renderFrame) cancelAnimationFrame(renderFrame);
					renderTurn();
					resolveLocalFinal();
				};
				const armIdleWatchdog = () => {
					if (idleTimer) clearTimeout(idleTimer);
					idleTimer = shouldArmStallWatchdog(currentTurn())
						? setTimeout(finalizeLocally, stallWatchdogDelayMs(currentTurn()))
						: null;
				};
				armIdleWatchdog();
				const streamRun = getEmbeddedClient()
					.stream(
						{
							clientRequestId,
							text: content,
							pageContext: turnPageContext,
							...(selectedModelRef ? { modelRef: selectedModelRef } : {}),
							...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
						},
						(frame) => {
							if (locallyFinalized) return;
							const event = frame.event;
							turnMilestones.record("acknowledged");
							if (reliability.lastFirstEventMs === null)
								reliability.lastFirstEventMs = Math.round(
									now() - turnStartedAt,
								);
							transcript = reduceTranscript(transcript, {
								type: "frame",
								event,
							});
							const turn = currentTurn();
							if (turn.phase && !turn.text)
								progressLabel = runtimePhaseLabel(turn.phase, productLabel, t);
							if (turn.phase)
								turnMilestones.record("first_phase", { phase: turn.phase });
							if (
								reliability.lastFirstTextMs === null &&
								turn.text.length > 0
							) {
								reliability.lastFirstTextMs = Math.round(now() - turnStartedAt);
								emit("first-token", {
									durationMs: reliability.lastFirstTextMs,
								});
								turnMilestones.record("first_text");
							}
							answer = turn.text;
							if (event.kind === "done") {
								turnMilestones.record("terminal_received", {
									outcome: "succeeded",
								});
								if (idleTimer) clearTimeout(idleTimer);
								idleTimer = null;
								if (renderFrame) cancelAnimationFrame(renderFrame);
								renderTurn();
								turnMilestones.record("rendered", { outcome: "succeeded" });
								return;
							}
							armIdleWatchdog();
							scheduleRender();
						},
						activeRequest.signal,
					)
					.catch((error) => {
						if (locallyFinalized) return;
						throw error;
					});
				try {
					await Promise.race([streamRun, localFinal]);
				} finally {
					if (idleTimer) clearTimeout(idleTimer);
					if (renderFrame) cancelAnimationFrame(renderFrame);
				}
				if (locallyFinalized) {
					const request = activeRequest;
					request?.abort();
					getEmbeddedClient()
						.cancel(clientRequestId)
						.catch(() => undefined);
					throw new Error("Subscription ended before completion");
				}
				answer = currentTurn().text;
				submittedAnswer = answer;
				lastAssistantAnswer = submittedAnswer;
				reliability.lastTurnOutcome = "succeeded";
				emit("answer-completed", {
					durationMs: Math.max(0, Math.round(now() - turnStartedAt)),
				});
			} catch (error) {
				const cancelled =
					error instanceof DOMException && error.name === "AbortError";
				// The transport already reconnects by exact request ID and cursor.
				// Transcript text cannot prove this turn completed: identical
				// questions can have different answers on different turns.
				reliability.lastTurnOutcome = cancelled ? "cancelled" : "failed";
				turnMilestones.record("failed", {
					outcome: reliability.lastTurnOutcome,
					errorCode: classifyChatError(error),
				});
				const partialAnswer = answer;
				restoreComposer();
				pending.bubble.innerHTML = partialAnswer
					? renderMarkdown(partialAnswer)
					: "";
				const failure = document.createElement("p");
				failure.textContent = userFacingChatError(error, t);
				pending.bubble.append(failure);
				const retryAfterSeconds = chatErrorRetryAfterSeconds(error);
				if (retryAfterSeconds) armRetryLock(retryAfterSeconds, failure);
				emit(
					reliability.lastTurnOutcome === "cancelled"
						? "answer-cancelled"
						: "answer-failed",
					{
						durationMs: Math.max(0, Math.round(now() - turnStartedAt)),
						code: classifyChatError(error),
						conversationId,
						eventId: activeRequest?.clientRequestId,
					},
				);
			} finally {
				clearInterval(progressTimer);
				reliability.lastTurnMs = Math.max(0, Math.round(now() - turnStartedAt));
				emit("performance", {
					phase: "turn",
					outcome: reliability.lastTurnOutcome,
					durationMs: reliability.lastTurnMs,
					firstEventMs: reliability.lastFirstEventMs,
					firstTextMs: reliability.lastFirstTextMs,
					reconnects: reliability.lastReconnects,
				});
				activeRequest = null;
				if (activeTurnMilestones === turnMilestones)
					activeTurnMilestones = null;
				reconnectPending = false;
				busy = false;
				renderTediSelection();
				root.querySelector(".tedix-new").disabled = false;
				send.innerHTML = icon(ICONS.send);
				send.setAttribute("aria-label", t("send"));
				send.disabled = !input.value.trim();
				applyRetryLock();
				scrollLatest();
				if (!retryLocked()) input.focus();
				// `busy` is false again, so a queued follow-up can run now. Its bubble
				// is already on screen from when it was queued.
				flushQueuedMessage();
			}
			return submittedAnswer;
		};
		/** Send the next follow-up that was typed while a turn was answering. */
		function flushQueuedMessage() {
			if (destroyed || busy || retryLocked()) return;
			const next = queuedMessages.shift();
			if (!next) return;
			void submit(next, { queued: true }).catch((error) => {
				addMessage("assistant", userFacingChatError(error, t));
			});
		}
		function bindHome() {
			thread
				.querySelector(".tedix-recent-more")
				?.addEventListener("click", () => setHistoryOpen(true));
			for (const chip of thread.querySelectorAll(".tedix-prompt")) {
				chip.addEventListener("click", () => {
					if (busy) return;
					void submit(chip.textContent.trim());
				});
			}
		}
		const updateContext = (next) => {
			// context() and track() publish complete normalized snapshots.
			// Merging would retain an entity or event omitted on the next route.
			const previousRoute = JSON.stringify([
				pageContext.pathname,
				pageContext.routeKey,
				pageContext.params,
				pageContext.entity?.type,
				pageContext.entity?.id,
			]);
			pageContext = normalizePageContext(next);
			const currentRoute = JSON.stringify([
				pageContext.pathname,
				pageContext.routeKey,
				pageContext.params,
				pageContext.entity?.type,
				pageContext.entity?.id,
			]);
			if (
				previousRoute !== currentRoute &&
				typeof portableRouteRevision === "number"
			) {
				portableRouteRevision += 1;
				embeddedSessionRequests = createInFlightRequestCoalescer();
			}
			if (
				previousRoute !== currentRoute &&
				typeof embeddedSession !== "undefined" &&
				embeddedSession?.portableRoute
			) {
				embeddedSession = null;
				embeddedClient = null;
			}
			const label =
				pageContext.entity?.label || routeContext(productLabel, t)[0];
			root.querySelector(".tedix-context strong").textContent = label;
			void registerPortableWebMcp();
		};
		contextListeners.add(updateContext);

		let disposeWebMcp = () => {};
		let disposePortableWebMcp = () => {};
		let portableProjectionGeneration = 0;
		let webMcpReadinessAttempts = 0;
		const callPortableTool = (input) => {
			if (options.requireSignedPortableRoute) {
				const route = embeddedSession?.portableRoute;
				if (!route || !embeddedSession?.token)
					throw new Error("Signed page route is unavailable");
				if (window.location.pathname !== route.pathname)
					throw new Error("Signed page route is stale");
				return options.portableTool({
					...input,
					routeCapability: { token: embeddedSession.token, routeId: route.id },
				});
			}
			return typeof options.portableTool === "function"
				? options.portableTool(input)
				: getEmbeddedClient().callPortableTool(input);
		};
		const registerPortableWebMcp = async () => {
			const generation = ++portableProjectionGeneration;
			disposePortableWebMcp();
			disposePortableWebMcp = () => {};
			if (destroyed || !resolveModelContextSource()) return;
			try {
				const session = await getEmbeddedSession();
				if (destroyed || generation !== portableProjectionGeneration) return;
				const selected = selectPortableRoute(
					session.webMcpProfile,
					pageContext,
				);
				if (!selected) return;
				const signedRoute = session.portableRoute;
				if (options.requireSignedPortableRoute && !signedRoute) return;
				if (
					signedRoute &&
					(signedRoute.id !== selected.route.id ||
						signedRoute.pathname !== pageContext.pathname.split("?")[0] ||
						signedRoute.routeKey !== pageContext.routeKey ||
						Object.keys(signedRoute.params ?? {}).length !==
							Object.keys(pageContext.params ?? {}).length ||
						Object.entries(signedRoute.params ?? {}).some(
							([key, value]) => pageContext.params?.[key] !== value,
						) ||
						signedRoute.entity?.type !== pageContext.entity?.type ||
						signedRoute.entity?.id !== pageContext.entity?.id)
				)
					return;
				const routeTools = selected.route.tools;
				disposePortableWebMcp = registerWebMcpScope(
					`tedi-widget-portable:${tenant}:${selected.route.id}`,
					[
						...routeTools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
							annotations: tool.annotations,
							execute: async (args, executionOptions) => {
								try {
									if (
										typeof generation !== "undefined" &&
										generation !== portableProjectionGeneration
									)
										return webMcpError("Page tool scope changed");
									const boundArgs = bindPortableToolArguments({
										args,
										bindings: tool.bind,
										context: pageContext,
										routeParams: selected.routeParams,
									});
									const outcome = await executePortableTool({
										tool,
										args: boundArgs,
										signal: executionOptions?.signal,
										call: (callable, args) =>
											callPortableTool({ callable, args }),
										confirm: async (preview) => {
											setOpen(true);
											const confirmation = await import(
												new URL("/confirm.js", script.src).href
											);
											return confirmation.confirmPortableWrite(
												root,
												tool,
												preview,
												executionOptions?.signal,
											);
										},
									});
									if (outcome.status === "cancelled")
										return webMcpResult(outcome);
									window.dispatchEvent(
										new CustomEvent("tedix:tool-completed", {
											detail: {
												callable: tool.callable,
												name: tool.name,
												routeId: selected.route.id,
											},
										}),
									);
									return webMcpResult(
										outcome.status === "read" ? outcome.result : outcome,
									);
								} catch (error) {
									return webMcpError(
										error instanceof Error
											? error.message
											: "Portable tool failed",
									);
								}
							},
						})),
						...(routeTools.length >= 2 &&
						!routeTools.some((tool) => tool.name === "find_tedi_widget_tool")
							? [
									{
										name: "find_tedi_widget_tool",
										description:
											"Find which currently available page tool fits a task. Returns advice only; it does not run a tool or authorize an action.",
										inputSchema: {
											type: "object",
											properties: {
												query: {
													type: "string",
													minLength: 3,
													maxLength: 2000,
												},
											},
											required: ["query"],
											additionalProperties: false,
										},
										annotations: {
											readOnlyHint: true,
											untrustedContentHint: true,
										},
										execute: async (args, executionOptions) => {
											if (executionOptions?.signal?.aborted)
												return webMcpError("Discovery cancelled");
											if (
												typeof args.query !== "string" ||
												args.query.trim().length < 3 ||
												args.query.length > 2000
											)
												return webMcpError("query must be 3–2000 characters");
											const unique = [
												...new Set(routeTools.map((tool) => tool.callable)),
											];
											let ranking = null;
											if (unique.length >= 2 && unique.length <= 12) {
												try {
													ranking = await getEmbeddedClient().rankPortableTools(
														{
															query: args.query.trim(),
															callables: unique,
														},
													);
												} catch {
													// Discovery is advisory; keep the signed route's stable order.
												}
											}
											if (
												destroyed ||
												generation !== portableProjectionGeneration ||
												executionOptions?.signal?.aborted
											)
												return webMcpError("Page tool scope changed");
											const toolsByCallable = new Map(
												routeTools.map((tool) => [tool.callable, tool]),
											);
											const ranked = ranking?.rankedIds;
											const ordered =
												ranked?.length === unique.length &&
												new Set(ranked).size === unique.length &&
												ranked.every((name) => toolsByCallable.has(name))
													? ranked
													: unique;
											return webMcpResult({
												advisory: true,
												rankingReceipt: ranking?.receipt
													? {
															ref: `jev-execution:${ranking.receipt.executionId}`,
															usagePersistence:
																ranking.receipt.usagePersistence,
														}
													: null,
												tools: ordered.map((name) => ({
													name: toolsByCallable.get(name).name,
													description: toolsByCallable.get(name).description,
												})),
											});
										},
									},
								]
							: []),
					],
				);
			} catch {
				// Session failures remain visible through the normal widget state.
			}
		};
		const registerWidgetWebMcp = () => {
			if (destroyed) return;
			if (!resolveModelContextSource()) {
				if (webMcpReadinessAttempts++ < 20) {
					webMcpReadinessTimer = setTimeout(registerWidgetWebMcp, 250);
				}
				return;
			}
			disposeWebMcp();
			disposeWebMcp = registerWebMcpScope(`tedi-widget:${tenant}`, [
				{
					name: "get_tedi_widget_context",
					description:
						"Read the current host page context and Tedi widget connection state without opening or changing the page.",
					inputSchema: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
					annotations: { readOnlyHint: true, untrustedContentHint: true },
					execute: async () =>
						webMcpResult({
							tenant,
							pageContext,
							open: panel.hasAttribute("data-open"),
							connected: Boolean(embeddedSession),
						}),
				},
				{
					name: "open_tedi_widget",
					description:
						"Open the visible personal Tedi panel for the user. Optionally place a suggested prompt in the composer; this never sends it automatically.",
					inputSchema: {
						type: "object",
						properties: {
							suggestedPrompt: { type: "string", maxLength: 4000 },
						},
						additionalProperties: false,
					},
					annotations: { readOnlyHint: false, untrustedContentHint: false },
					execute: async (args) => {
						setOpen(true);
						if (typeof args.suggestedPrompt === "string") {
							input.value = args.suggestedPrompt.slice(0, 4000);
							input.dispatchEvent(new Event("input"));
						}
						return webMcpResult({ open: true, promptSent: false });
					},
				},
				{
					name: "ask_tedi",
					description:
						"Ask the user's personal Tedi a question in the visible widget using the current signed host session and page context.",
					inputSchema: {
						type: "object",
						properties: {
							message: { type: "string", minLength: 1, maxLength: 4000 },
						},
						required: ["message"],
						additionalProperties: false,
					},
					annotations: { readOnlyHint: false, untrustedContentHint: true },
					execute: async (args) => {
						try {
							if (typeof args.message !== "string" || !args.message.trim())
								return webMcpError("message is required");
							setOpen(true);
							const answer = await submit(args.message.trim());
							return answer
								? webMcpResult({ status: "completed", answer, pageContext })
								: webMcpError("Tedi no pudo completar la solicitud.");
						} catch (error) {
							return webMcpError(userFacingChatError(error, t));
						}
					},
				},
				{
					name: "request_tedi_approval",
					description:
						"Create a visible, deny-by-default Tedi approval card for an explicitly described action. This only requests confirmation; it never performs the action.",
					inputSchema: {
						type: "object",
						properties: {
							description: { type: "string", minLength: 1, maxLength: 2000 },
						},
						required: ["description"],
						additionalProperties: false,
					},
					annotations: { readOnlyHint: false, untrustedContentHint: false },
					execute: async (args) => {
						try {
							if (
								typeof args.description !== "string" ||
								!args.description.trim()
							)
								return webMcpError("description is required");
							setOpen(true);
							const session = await getEmbeddedSession();
							const approval = await getEmbeddedClient().requestApproval(
								args.description.trim(),
							);
							addApproval(
								{ id: approval.id, description: approval.description },
								session,
							);
							approvalProjectionWatcher?.wake();
							return webMcpResult({
								status: "approval_requested",
								approvalRequestId: approval.id,
							});
						} catch (error) {
							return webMcpError(
								error instanceof Error
									? error.message
									: "Approval request failed.",
							);
						}
					},
				},
			]);
			webMcpActive = true;
			setConnectionState("webmcp");
			void registerPortableWebMcp();
		};
		registerWidgetWebMcp();

		const syncNavigationContext = () =>
			updateContext({ pathname: `${location.pathname}${location.search}` });
		window.addEventListener("popstate", syncNavigationContext);
		window.addEventListener("hashchange", syncNavigationContext);
		window.navigation?.addEventListener?.(
			"currententrychange",
			syncNavigationContext,
		);

		launcher.addEventListener("click", () => {
			setOpen(true);
			void getEmbeddedSession()
				.then(loadPendingApprovals)
				.catch(() => setConnectionState("error"));
		});
		const hostLauncherClick = (event) => {
			if (
				launcherMode !== "host" ||
				!event.target?.closest?.("[data-tedix-launcher]")
			)
				return;
			setOpen(true);
		};
		const hostOpen = () => setOpen(true);
		document.addEventListener("click", hostLauncherClick);
		window.addEventListener("tedix:open", hostOpen);
		root
			.querySelector(".tedix-close")
			.addEventListener("click", () => setOpen(false));
		root.querySelector(".tedix-new").addEventListener("click", () => {
			reset();
			void getEmbeddedSession().catch(() => setConnectionState("error"));
		});
		root
			.querySelector(".tedix-history-open")
			.addEventListener("click", () => setHistoryOpen(true));
		root
			.querySelector(".tedix-history-back")
			.addEventListener("click", () => setHistoryOpen(false));
		root.querySelector(".tedix-history-new").addEventListener("click", () => {
			reset();
			void getEmbeddedSession().catch(() => setConnectionState("error"));
		});
		const expandButton = root.querySelector(".tedix-expand");
		const setExpanded = (expanded) => {
			panel.toggleAttribute("data-expanded", expanded);
			expandButton.setAttribute("aria-expanded", String(expanded));
			const label = expanded ? t("collapse") : t("expand");
			expandButton.setAttribute("aria-label", label);
			expandButton.title = label;
		};
		expandButton.setAttribute("aria-expanded", "false");
		// Expand grows the panel in place on every host, Tedix OS included; it
		// never navigates the host page away from the conversation.
		expandButton.addEventListener("click", () => {
			setExpanded(!panel.hasAttribute("data-expanded"));
		});
		input.addEventListener("input", () => {
			input.style.height = "auto";
			input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
			send.disabled = !busy && !input.value.trim();
		});
		voiceButton.addEventListener("pointerdown", (event) => {
			if (voiceState !== "recording") return;
			// Stop on the physical press, before the composer can claim focus.
			event.preventDefault();
			suppressVoiceClick = true;
			finishDictation();
		});
		voiceButton.addEventListener("click", () => {
			if (suppressVoiceClick) {
				suppressVoiceClick = false;
				return;
			}
			if (voiceState === "recording") {
				finishDictation();
				return;
			}
			if (voiceState === "connecting" || voiceState === "transcribing") {
				cancelDictation();
				return;
			}
			void beginDictation().catch(() => setVoiceState("idle"));
		});
		voiceCancel.addEventListener("click", cancelDictation);
		voiceRetry.addEventListener("click", () => {
			void beginDictation().catch(() => undefined);
		});
		input.addEventListener("keydown", (event) => {
			if (
				event.key === "Enter" &&
				!event.shiftKey &&
				!isImeComposingKey(event)
			) {
				event.preventDefault();
				form.requestSubmit();
			}
		});
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const typed = input.value.trim();
			// While a turn runs the send control is the Stop control, so a press on
			// it means stop. Enter is not that control: it used to abort the running
			// answer and silently discard whatever had been typed, which is the one
			// outcome nobody wants from asking a follow-up.
			const pressedStop = event.submitter === send;
			if (busy && (pressedStop || !typed)) {
				const request = activeRequest;
				request?.abort();
				if (request?.clientRequestId) {
					getEmbeddedClient()
						.cancel(request.clientRequestId)
						.catch(() => undefined);
				}
			} else if (busy) {
				// Show it immediately — a follow-up that vanishes from the composer
				// with nothing on screen reads as lost.
				queuedMessages.push(typed);
				addMessage("user", typed);
				input.value = "";
				input.style.height = "auto";
				send.disabled = false;
				scrollLatest();
			} else {
				try {
					await submit(input.value.trim());
				} catch (error) {
					addMessage("assistant", userFacingChatError(error, t));
				}
			}
		});
		root.addEventListener("keydown", (event) => {
			if (event.key === "Escape") setOpen(false);
		});
		bindHome();
		const disposeCopyButtons = bindMarkdownCopyButtons(thread, {
			copiedLabel: t("copied"),
		});
		const controller = {
			open: () => setOpen(true),
			close: () => setOpen(false),
			// A programmatic ask can arrive mid-restore; wait that out rather than
			// refuse something the widget is about to be ready for.
			ask: async (message) => {
				if (restoring || hydrating)
					await Promise.allSettled([restoreRequest, hydrationSettled]);
				return submit(message);
			},
			deleteConversation: permanentlyDeleteConversation,
			capabilities: () => getEmbeddedClient().listConversationCapabilities(),
			attachCapability: (capabilityId, replayName) =>
				getEmbeddedClient().attachConversationCapability({
					capabilityId,
					replayName,
				}),
			detachCapability: (referenceId) =>
				getEmbeddedClient().detachConversationCapability(referenceId),
			artifactPins: () => getEmbeddedClient().listConversationArtifactPins(),
			pinArtifactRevision: (artifactId, replayName) =>
				getEmbeddedClient().attachConversationArtifactPin({
					artifactId,
					replayName,
				}),
			detachArtifactPin: (pinId) =>
				getEmbeddedClient().detachConversationArtifactPin(pinId),
			update: (next = {}) => {
				if (next.context) updateContext(next.context);
				if (next.consent) sharedConsent = normalizeConsent(next.consent);
			},
			diagnose: async () => {
				const checks = {
					runtime: "passed",
					tenant: tenant ? "passed" : "failed",
					endpoint:
						endpoint.startsWith("/") || endpoint.startsWith(location.origin)
							? "passed"
							: "failed",
					webmcp: resolveModelContextSource() ? "passed" : "unavailable",
					session: "not_checked",
					transport: "capn-web",
				};
				if (sharedConsent.functional) {
					try {
						await getEmbeddedSession();
						checks.session = "passed";
					} catch {
						checks.session = "failed";
					}
				}
				return {
					ok: !Object.values(checks).includes("failed"),
					checks,
					status: controller.status(),
				};
			},
			shutdown: () => {
				if (destroyed) return;
				destroyed = true;
				clearRetryLock();
				disposeScrollResize();
				activeRequest?.abort();
				voiceController?.dispose();
				voiceController = null;
				embeddedClient?.dispose();
				for (const conversation of conversations.values()) {
					if (conversation.embeddedClient !== embeddedClient)
						conversation.embeddedClient?.dispose();
				}
				conversations.clear();
				approvalProjectionWatcher?.dispose();
				embeddedClient = null;
				approvalProjectionWatcher = null;
				embeddedSession = null;
				disposeWebMcp();
				disposePortableWebMcp();
				if (webMcpReadinessTimer) clearTimeout(webMcpReadinessTimer);
				if (viewportFrame) cancelAnimationFrame(viewportFrame);
				viewport?.removeEventListener("resize", scheduleViewport);
				viewport?.removeEventListener("scroll", scheduleViewport);
				contextListeners.delete(updateContext);
				themeObserver.disconnect();
				systemTheme.removeEventListener("change", syncHostTheme);
				document.removeEventListener("click", hostLauncherClick);
				window.removeEventListener("tedix:open", hostOpen);
				window.removeEventListener("popstate", syncNavigationContext);
				window.removeEventListener("hashchange", syncNavigationContext);
				window.navigation?.removeEventListener?.(
					"currententrychange",
					syncNavigationContext,
				);
				disposeCopyButtons();
				for (const key of [THREADS_KEY, ACTIVE_THREAD_KEY])
					sessionStorage.removeItem(key);
				host.remove();
				initialized.delete(script);
				widgetControllers.delete(controller);
				emit("shutdown", { tenant });
			},
			status: () => ({
				state: destroyed ? "shutdown" : "ready",
				mounted: !destroyed,
				sdkVersion: SDK_VERSION,
				tenant,
				pageContext,
				open: panel.hasAttribute("data-open"),
				connected: Boolean(embeddedSession),
				session: embeddedSession ? "valid" : "not_requested",
				expiresAt: embeddedSession?.expiresAt ?? null,
				transport: "capn-web",
				preload,
				consent: { ...sharedConsent },
				lastError,
				webmcp: webMcpRegistrationStatus(),
				reliability: reliabilitySnapshot(),
			}),
		};
		widgetControllers.add(controller);
		const preloadSession = () => {
			if (!destroyed) void getEmbeddedSession().catch(() => {});
		};
		if (preload === "eager") {
			queueMicrotask(preloadSession);
		} else if (preload === "idle") {
			if (typeof requestIdleCallback === "function")
				requestIdleCallback(preloadSession, { timeout: 3000 });
			else setTimeout(preloadSession, 1500);
		}
		reliability.readyMs = Math.max(0, Math.round(now() - loaderStartedAt));
		globalThis.performance?.mark?.("tedix:ready");
		emit("performance", {
			phase: "ready",
			outcome: "succeeded",
			durationMs: reliability.readyMs,
			runtimeMs: reliability.runtimeMs,
		});
		emit("ready", { tenant, preload });
	}

	const api = {
		runtimeLoaded: true,
		sdkVersion: SDK_VERSION,
		boot(options = {}) {
			return this.init(options);
		},
		init(options = {}) {
			if (options.consent) sharedConsent = normalizeConsent(options.consent);
			mount(
				options.script ||
					document.currentScript ||
					document.querySelector(SCRIPT_SELECTOR),
				options,
			);
			return this;
		},
		async identify() {
			const identity = identityMounts.values().next().value;
			if (!identity)
				throw new Error("Configure identifyEndpoint before identifying");
			try {
				await identity.ready.catch(() => {});
				identity.ready = identity.identify();
				return await identity.ready;
			} catch (error) {
				if (
					error?.code !== "identify_superseded" &&
					error?.name !== "AbortError"
				)
					widgetControllers.forEach((controller) => controller.shutdown());
				throw error;
			}
		},
		update(value = {}) {
			if (value.context) this.context(value.context);
			if (value.consent) this.consent(value.consent);
			widgetControllers.forEach((controller) => controller.update(value));
			return this;
		},
		context(value = {}) {
			sharedContext = normalizePageContext(value);
			contextListeners.forEach((listener) => listener(sharedContext));
		},
		track(name, metadata = {}) {
			if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(String(name))) return;
			const next = normalizePageContext({
				...sharedContext,
				event: { name, metadata },
			});
			sharedContext = next;
			contextListeners.forEach((listener) => listener(next));
		},
		consent(value = {}) {
			sharedConsent = normalizeConsent(value);
			widgetControllers.forEach((controller) =>
				controller.update({ consent: sharedConsent }),
			);
			emit("consent", { consent: { ...sharedConsent } });
			return this;
		},
		async open() {
			await identityMounts.values().next().value?.ready;
			widgetControllers.values().next().value?.open();
		},
		close() {
			widgetControllers.forEach((controller) => controller.close());
		},
		async ask(message) {
			await identityMounts.values().next().value?.ready;
			return widgetControllers
				.values()
				.next()
				.value?.ask(String(message || ""));
		},
		async deleteConversation(conversationId) {
			await identityMounts.values().next().value?.ready;
			return widgetControllers
				.values()
				.next()
				.value?.deleteConversation(String(conversationId || ""));
		},
		async capabilities() {
			await identityMounts.values().next().value?.ready;
			return widgetControllers.values().next().value?.capabilities();
		},
		async attachCapability(capabilityId, replayName) {
			await identityMounts.values().next().value?.ready;
			return widgetControllers
				.values()
				.next()
				.value?.attachCapability(
					String(capabilityId || ""),
					String(replayName || ""),
				);
		},
		async detachCapability(referenceId) {
			await identityMounts.values().next().value?.ready;
			return widgetControllers
				.values()
				.next()
				.value?.detachCapability(String(referenceId || ""));
		},
		async artifactPins() {
			await identityMounts.values().next().value?.ready;
			return widgetControllers.values().next().value?.artifactPins();
		},
		async pinArtifactRevision(artifactId, replayName) {
			await identityMounts.values().next().value?.ready;
			return widgetControllers
				.values()
				.next()
				.value?.pinArtifactRevision(
					String(artifactId || ""),
					String(replayName || ""),
				);
		},
		async detachArtifactPin(pinId) {
			await identityMounts.values().next().value?.ready;
			return widgetControllers
				.values()
				.next()
				.value?.detachArtifactPin(String(pinId || ""));
		},
		status() {
			return (
				widgetControllers.values().next().value?.status() ?? {
					state: "idle",
					mounted: false,
					sdkVersion: SDK_VERSION,
					transport: "capn-web",
					consent: { ...sharedConsent },
					lastError,
					webmcp: webMcpRegistrationStatus(),
					reliability: reliabilitySnapshot(),
				}
			);
		},
		diagnose() {
			const controller = widgetControllers.values().next().value;
			return controller
				? controller.diagnose()
				: Promise.resolve({
						ok: false,
						checks: { runtime: "passed", mount: "failed" },
						status: this.status(),
					});
		},
		shutdown() {
			disposeRouteContext();
			disposeRouteContext = () => {};
			identityMounts.forEach((identity) => identity.shutdown());
			identityMounts.clear();
			widgetControllers.forEach((controller) => controller.shutdown());
			sharedContext = null;
		},
		on(event, callback) {
			if (typeof event !== "string" || typeof callback !== "function")
				return () => {};
			const listeners = sdkListeners.get(event) || new Set();
			listeners.add(callback);
			sdkListeners.set(event, listeners);
			if (event === "ready" && widgetControllers.size > 0)
				queueMicrotask(() => callback(this.status()));
			if (event === "loaded") queueMicrotask(() => callback(this.status()));
			return () => listeners.delete(callback);
		},
		off(event, callback) {
			sdkListeners.get(event)?.delete(callback);
		},
	};
	window.Tedix = Object.freeze(api);
	const script = document.currentScript;
	if (script?.dataset.tedixTenant) {
		const start = () => mount(script);
		if (document.body) start();
		else document.addEventListener("DOMContentLoaded", start, { once: true });
	}
	for (const entry of queuedCalls) void replayLoaderCall(entry, api);
	globalThis.performance?.mark?.("tedix:loaded");
	emit("loaded");
})();
