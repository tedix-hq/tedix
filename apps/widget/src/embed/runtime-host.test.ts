// @vitest-environment happy-dom
/**
 * The embed runtime as a host page meets it: mounting, branding, the signed
 * session, the SDK lifecycle, WebMCP, theming, voice, and reliability.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import esCatalog from "@tedix/widget-i18n/es.json";
import {
	ACTIVE_THREAD_KEY,
	bootWidget,
	modelContextHost,
	sessionResult,
	settle,
	teardown,
	THREADS_KEY,
	tick,
	transport,
	type Widget,
} from "./runtime-harness";

const hoisted = vi.hoisted(() => ({
	branding: vi.fn(async (_input: Record<string, unknown>) => null as unknown),
	voice: [] as Array<Record<string, any>>,
	confirm: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock("@tedix/chat-transport/embedded-client", async () => ({
	createEmbeddedClient: (await import("./runtime-harness"))
		.createFakeEmbeddedClient,
}));
vi.mock("./branding", async (importOriginal) => ({
	...(await importOriginal<typeof import("./branding")>()),
	fetchWidgetBranding: hoisted.branding,
}));
vi.mock("@tedix/chat-transport/voice-composer", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@tedix/chat-transport/voice-composer")
		>();
	return {
		...actual,
		createRecordedVoiceComposerController: (options: Record<string, any>) => {
			const listeners = new Set<(snapshot: unknown) => void>();
			const controller = {
				options,
				start: vi.fn(async () => {}),
				stop: vi.fn(),
				cancel: vi.fn(),
				dispose: vi.fn(),
				subscribe: (listener: (snapshot: unknown) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				publish: (phase: string, error: string | null = null) => {
					for (const listener of listeners)
						listener({
							phase,
							error,
							audioHistory: Array(actual.VOICE_WAVE_BAR_COUNT).fill(0.5),
						});
				},
			};
			hoisted.voice.push(controller);
			return controller;
		},
	};
});
vi.mock("https://widget.tedix.dev/confirm.js", () => ({
	confirmPortableWrite: hoisted.confirm,
}));

afterEach(() => {
	teardown();
	vi.useRealTimers();
	vi.restoreAllMocks();
	hoisted.branding.mockReset();
	hoisted.branding.mockResolvedValue(null);
	hoisted.voice.length = 0;
	hoisted.confirm.mockReset();
	delete (navigator as { modelContext?: unknown }).modelContext;
});

describe("mounting", () => {
	it("auto-mounts from an Intercom-style tenant script attribute into an open Shadow DOM", async () => {
		const w = await bootWidget({
			mount: false,
			before: () =>
				Object.defineProperty(document, "currentScript", {
					configurable: true,
					get: () => document.querySelector("script[data-tedix-tenant]"),
				}),
		});
		delete (document as { currentScript?: unknown }).currentScript;
		await settle();
		expect(w.host()?.dataset.tedixWidget).toBe("demo-shop");
		expect(w.host()?.shadowRoot?.querySelector(".tedix-panel")).not.toBeNull();
	});

	it("asks the tenant's default same-origin session route with the current navigation", async () => {
		const w = await bootWidget({ options: { session: undefined } });
		w.fetch.mockResolvedValue(
			new Response(JSON.stringify(sessionResult()), { status: 200 }),
		);
		history.replaceState(null, "", "/orders?tab=open");
		await w.open();
		history.replaceState(null, "", "/");
		const [url, init] = w.fetch.mock.calls[0]!;
		expect(url).toBe("/r/tedi/session");
		expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
		expect(JSON.parse(String(init!.body))).toEqual({
			conversationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			pathname: "/orders",
		});
		expect(JSON.stringify(init)).not.toContain("TEDIX_MCP_API_KEY");
	});

	it("uses a first-party session adapter instead of the default route", async () => {
		const w = await bootWidget();
		await w.open();
		expect(w.session).toHaveBeenCalledWith({
			conversationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			hostConversationContext: null,
			pathname: "/",
		});
		expect(w.fetch).not.toHaveBeenCalled();
	});

	it.each([
		["en-US", undefined, "Chat with Tedi"],
		["es-MX", esCatalog, "Chat con Tedi"],
	])(
		"localizes the %s dialog accessible name",
		async (locale, catalog, expected) => {
			const w = await bootWidget({ options: { locale, catalog } });
			expect(w.$(".tedix-panel")?.getAttribute("aria-label")).toBe(expected);
			expect(w.$(".tedix-panel")?.getAttribute("role")).toBe("dialog");
		},
	);

	it("normalizes a host-supplied locale before Intl or string methods see it", async () => {
		for (const locale of [123, "en_US", "not a locale"]) {
			const w = await bootWidget({ options: { locale } });
			expect(w.Tedix.status().mounted).toBe(true);
		}
	});

	it("derives product presentation from tenant configuration and escapes host labels", async () => {
		const w = await bootWidget({
			dataset: { tedixProduct: "Tienda <b>Uno</b>" },
			options: { title: '<img src=x onerror="boom()">' },
		});
		expect(w.$(".tedix-subtitle")?.textContent).toBe(
			"Your assistant for Tienda <b>Uno</b>",
		);
		expect(w.$(".tedix-subtitle b")).toBeNull();
		expect(w.$(".tedix-title")?.textContent).toBe(
			'<img src=x onerror="boom()">',
		);
		expect(w.$(".tedix-title img")).toBeNull();
	});

	it("titles the tenant from its slug when no product is configured", async () => {
		const w = await bootWidget();
		expect(w.$(".tedix-context strong")?.textContent).toBe("Demo Shop");
	});

	it("validates the CSS accent before it reaches the stylesheet", async () => {
		const accent = async (value: string) => {
			const w = await bootWidget({ options: { accent: value } });
			return w.$("style")?.textContent ?? "";
		};
		expect(await accent("#123456")).toContain("#123456");
		const injected = await accent("red;}body{--pwned:1");
		expect(injected).not.toContain("--pwned");
		expect(injected).toContain("#2557d6");
	});
});

describe("branding", () => {
	it("requests branding in the same validated host locale the widget uses", async () => {
		hoisted.branding.mockResolvedValue({ title: "Branded" });
		const w = await bootWidget({
			before: () => (document.documentElement.lang = "es-MX"),
			options: { branding: undefined, locale: "en_US" },
		});
		expect(hoisted.branding).toHaveBeenCalledWith(
			expect.objectContaining({
				tenant: "demo-shop",
				locale: "es-MX",
				origin: "https://api.tedix.dev",
			}),
		);
		expect(w.$(".tedix-title")?.textContent).toBe("Branded");
	});

	it("reuses the loader's answer for the same tenant and locale", async () => {
		const w = await bootWidget({
			before: () => {
				(window as unknown as { Tedix: unknown }).Tedix = {
					branding: {
						tenant: "demo-shop",
						locale: "en-US",
						ready: Promise.resolve({ title: "From loader" }),
					},
				};
			},
			options: { branding: undefined },
		});
		expect(hoisted.branding).not.toHaveBeenCalled();
		expect(w.$(".tedix-title")?.textContent).toBe("From loader");
	});

	it("applies the published white-label appearance without granting host authority", async () => {
		const w = await bootWidget({
			options: {
				launcherPosition: "bottom-left",
				launcherIconUrl: "https://cdn.example.com/light.svg",
				launcherIconUrlDark: "https://cdn.example.com/dark.svg",
				// Only https artwork renders; anything else is ignored.
				assistantLogoUrl: "javascript:alert(1)",
			},
		});
		const images = w.$$<HTMLImageElement>(".tedix-launcher-mark img");
		expect(images.map((image) => image.getAttribute("src"))).toEqual([
			"https://cdn.example.com/light.svg",
			"https://cdn.example.com/dark.svg",
		]);
		expect(images[1]!.hasAttribute("data-theme-dark")).toBe(true);
		// An unsafe logo falls back to the neutral mark, never a platform initial.
		expect(w.$(".tedix-avatar img")).toBeNull();
		expect(w.$(".tedix-avatar svg")).not.toBeNull();
		expect(w.$(".tedix-avatar")?.textContent?.trim()).toBe("");
		expect(w.$("style")?.textContent).toContain("left");
	});

	it("falls back to the neutral mark for a tenant without artwork", async () => {
		const w = await bootWidget();
		expect(w.$(".tedix-launcher-mark svg path")?.getAttribute("d")).toBe(
			"M7 18.5 3.5 21v-5.2A8.5 8.5 0 1 1 7 18.5Z",
		);
		expect(w.$(".tedix-launcher-mark")?.textContent?.trim()).toBe("");
		expect(w.$(".tedix-attention-dot")).toBeNull();
	});
});

describe("the launcher and panel", () => {
	it("opens from the launcher, a host launcher element, or a host event, and closes on Escape", async () => {
		const w = await bootWidget({ options: { launcherMode: "host" } });
		const panel = w.$(".tedix-panel")!;
		expect(w.$(".tedix-launcher")!.hidden).toBe(true);
		document.body.insertAdjacentHTML(
			"beforeend",
			'<button data-tedix-launcher><span id="inner">Help</span></button>',
		);
		document.getElementById("inner")!.click();
		expect(panel.hasAttribute("data-open")).toBe(true);
		w.root().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(panel.hasAttribute("data-open")).toBe(false);
		window.dispatchEvent(new Event("tedix:open"));
		expect(panel.hasAttribute("data-open")).toBe(true);
		expect(w.eventNames()).toEqual(
			expect.arrayContaining(["opened", "closed"]),
		);
	});

	it("announces whether the compact panel is expanded and grows it in place", async () => {
		const w = await bootWidget();
		const expand = w.$<HTMLButtonElement>(".tedix-expand")!;
		expect(expand.getAttribute("aria-expanded")).toBe("false");
		expand.click();
		expect(expand.getAttribute("aria-expanded")).toBe("true");
		expect(expand.getAttribute("aria-label")).toBe("Collapse");
		expect(w.$(".tedix-panel")!.hasAttribute("data-expanded")).toBe(true);
		expect(location.pathname).toBe("/");
		expand.click();
		expect(expand.getAttribute("aria-label")).toBe("Expand");
	});

	it("follows explicit host light and dark theme changes", async () => {
		const w = await bootWidget();
		expect(w.host()?.dataset.theme).toBeUndefined();
		document.documentElement.classList.add("dark");
		await settle();
		expect(w.host()?.dataset.theme).toBe("dark");
		document.documentElement.classList.replace("dark", "light");
		await settle();
		expect(w.host()?.dataset.theme).toBe("light");
		document.body.dataset.theme = "dark";
		document.documentElement.classList.remove("light");
		await settle();
		expect(w.host()?.dataset.theme).toBe("dark");
		delete document.body.dataset.theme;
	});

	it("follows the visual viewport so the composer stays above a software keyboard", async () => {
		const listeners = new Map<string, () => void>();
		const viewport = {
			height: 800,
			width: 390,
			offsetTop: 0,
			addEventListener: (event: string, listener: () => void) =>
				listeners.set(event, listener),
			removeEventListener: vi.fn(),
		};
		Object.defineProperty(window, "visualViewport", {
			configurable: true,
			value: viewport,
		});
		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: 800,
		});
		const w = await bootWidget();
		expect(w.host()?.style.getPropertyValue("--tedix-viewport-height")).toBe(
			"800px",
		);
		viewport.height = 500;
		listeners.get("resize")?.();
		await settle();
		expect(w.host()?.style.getPropertyValue("--tedix-viewport-height")).toBe(
			"500px",
		);
		expect(w.host()?.hasAttribute("data-keyboard-open")).toBe(true);
		w.Tedix.shutdown();
		expect(viewport.removeEventListener).toHaveBeenCalledWith(
			"resize",
			expect.any(Function),
		);
		delete (window as { visualViewport?: unknown }).visualViewport;
	});
});

describe("the signed session", () => {
	it("owns recovery: a failed session shows a retry, and success clears the error before it is announced", async () => {
		const failure = new Error("host unavailable");
		const session = vi
			.fn()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue(sessionResult({ expiresAt: 12345 }));
		const w = await bootWidget({ options: { session } });
		await w.open();
		const recovery = w.$(".tedix-session-recovery")!;
		expect(recovery.hidden).toBe(false);
		expect(w.Tedix.status().lastError).toBe("session_provider_failed");
		expect(w.detailsOf("error")).toEqual([
			expect.objectContaining({ code: "session_provider_failed" }),
		]);
		const seen: Array<string | null> = [];
		w.Tedix.on("session-refreshed", () =>
			seen.push(w.Tedix.status().lastError),
		);
		w.$<HTMLButtonElement>(".tedix-session-retry")!.click();
		await settle();
		expect(seen).toEqual([null]);
		expect(recovery.hidden).toBe(true);
		expect(w.$(".tedix-status")?.getAttribute("data-state")).toBe("connected");
		expect(w.detailsOf("session-refreshed").at(-1)).toMatchObject({
			expiresAt: 12345,
		});
		expect(w.Tedix.status().reliability.sessionAttempts).toBe(2);
		expect(session).toHaveBeenCalledTimes(2);
	});

	it("keeps the server's own failure code for an HTTP session error", async () => {
		const w = await bootWidget({ options: { session: undefined } });
		w.fetch.mockResolvedValue(
			new Response(
				JSON.stringify({ code: "tenant_suspended", error: "Paused" }),
				{
					status: 403,
				},
			),
		);
		await w.open();
		expect(w.Tedix.status().lastError).toBe("tenant_suspended");
		expect(w.$(".tedix-session-recovery")!.hidden).toBe(false);
	});

	it("reports a network failure distinctly", async () => {
		const w = await bootWidget({ options: { session: undefined } });
		w.fetch.mockRejectedValue(new TypeError("offline"));
		await w.open();
		expect(w.Tedix.status().lastError).toBe("session_network_failed");
	});

	it("refuses to request a session when the host withdraws functional consent", async () => {
		const w = await bootWidget();
		w.Tedix.consent({ functional: false });
		expect(w.Tedix.status().consent).toEqual({
			functional: false,
			personalization: true,
			analytics: undefined,
		});
		const diagnosis = await w.Tedix.diagnose();
		expect(diagnosis.checks.session).toBe("not_checked");
		await expect(w.Tedix.ask("Hello")).resolves.toBe("");
		expect(w.session).not.toHaveBeenCalled();
		expect(transport().streams).toHaveLength(0);
		expect(w.detailsOf("answer-failed")).toHaveLength(1);
	});

	it.each([
		["open", 0],
		["eager", 1],
	])("preloads the session only when asked (%s)", async (preload, calls) => {
		const w = await bootWidget({ options: { preload } });
		await settle();
		expect(w.session).toHaveBeenCalledTimes(calls);
		expect(w.Tedix.status().preload).toBe(preload);
	});

	it("preloads at idle time when the host chooses idle", async () => {
		const idle = vi.fn();
		(
			window as unknown as { requestIdleCallback: unknown }
		).requestIdleCallback = idle;
		const w = await bootWidget({ options: { preload: "idle" } });
		expect(w.session).not.toHaveBeenCalled();
		idle.mock.calls[0]![0]();
		await settle();
		expect(w.session).toHaveBeenCalledTimes(1);
		delete (window as unknown as { requestIdleCallback?: unknown })
			.requestIdleCallback;
	});

	it("coalesces concurrent session requests for one conversation", async () => {
		const w = await bootWidget();
		await Promise.all([w.open(), w.Tedix.diagnose(), w.Tedix.diagnose()]);
		expect(w.session).toHaveBeenCalledOnce();
	});

	it("starts a new signed session for a new conversation", async () => {
		const w = await bootWidget();
		await w.open();
		w.$<HTMLButtonElement>(".tedix-new")!.click();
		await settle();
		const ids = w.session.mock.calls.map(([request]) => request.conversationId);
		expect(new Set(ids).size).toBe(2);
	});

	it("watches pending approvals once the panel opens and removes resolved cards", async () => {
		const w = await bootWidget();
		await w.open();
		const [apply] = w.client()!.watchApprovals.mock.calls[0]!;
		apply({
			data: [
				{
					id: "a-1",
					description: "Plain",
					review: { operatorQuestion: "Refund order 42?" },
				},
			],
		});
		expect(w.$(".tedix-approval p")?.textContent).toBe("Refund order 42?");
		apply({ data: [] });
		expect(w.$(".tedix-approval")).toBeNull();
	});
});

describe("the SDK", () => {
	it("exposes a complete lifecycle and tears down user-scoped state", async () => {
		const w = await bootWidget();
		expect(w.eventNames()).toEqual(expect.arrayContaining(["loaded", "ready"]));
		const ready = vi.fn();
		w.Tedix.on("ready", ready);
		await tick(0);
		expect(ready).toHaveBeenCalledWith(
			expect.objectContaining({ mounted: true }),
		);
		await w.open();
		w.Tedix.close();
		expect(w.$(".tedix-panel")!.hasAttribute("data-open")).toBe(false);
		w.Tedix.update({ context: { pathname: "/orders" } });
		expect(w.Tedix.status().pageContext.pathname).toBe("/orders");
		await w.say("Pending");
		const stream = await w.waitForStream();
		sessionStorage.setItem(THREADS_KEY, "[]");
		sessionStorage.setItem(ACTIVE_THREAD_KEY, "x");
		w.Tedix.shutdown();
		expect(stream.signal.aborted).toBe(true);
		expect(w.client()!.dispose).toHaveBeenCalled();
		expect(w.host()).toBeNull();
		expect(sessionStorage.getItem(THREADS_KEY)).toBeNull();
		expect(sessionStorage.getItem(ACTIVE_THREAD_KEY)).toBeNull();
		expect(w.Tedix.status()).toMatchObject({ state: "idle", mounted: false });
		expect(w.eventNames()).toContain("shutdown");
		// The same script can mount again after a shutdown.
		w.Tedix.boot({ script: w.script, branding: false, session: w.session });
		await settle();
		expect(w.host()).not.toBeNull();
	});

	it("diagnoses the mount without exposing the session", async () => {
		const w = await bootWidget();
		const diagnosis = await w.Tedix.diagnose();
		expect(diagnosis).toMatchObject({
			ok: true,
			checks: {
				runtime: "passed",
				tenant: "passed",
				endpoint: "passed",
				session: "passed",
				transport: "capn-web",
			},
		});
		expect(JSON.stringify(diagnosis)).not.toContain("session-token");
	});

	it("keeps signed host context APIs host-only, without technical controls in chat", async () => {
		const w = await bootWidget();
		await w.open();
		await w.Tedix.capabilities();
		await w.Tedix.attachCapability("cap-1", "Orders");
		await w.Tedix.detachCapability("ref-1");
		await w.Tedix.artifactPins();
		await w.Tedix.pinArtifactRevision("art-1", "Plan");
		await w.Tedix.detachArtifactPin("pin-1");
		const client = w.client()!;
		expect(client.listConversationCapabilities).toHaveBeenCalledOnce();
		expect(client.attachConversationCapability).toHaveBeenCalledWith({
			capabilityId: "cap-1",
			replayName: "Orders",
		});
		expect(client.detachConversationCapability).toHaveBeenCalledWith("ref-1");
		expect(client.listConversationArtifactPins).toHaveBeenCalledOnce();
		expect(client.attachConversationArtifactPin).toHaveBeenCalledWith({
			artifactId: "art-1",
			replayName: "Plan",
		});
		expect(client.detachConversationArtifactPin).toHaveBeenCalledWith("pin-1");
		expect(w.root().textContent).not.toMatch(
			/Replay name|Pinned artifact revisions/,
		);
		expect(
			w.$(
				".tedix-capabilities, .tedix-capability-form, .tedix-artifact-pin-form",
			),
		).toBeNull();
	});

	it("replaces route context without retaining the previous entity or optional fields", async () => {
		const w = await bootWidget({ options: { product: "Tedix" } });
		w.Tedix.context({
			pathname: "/work/items/old",
			routeKey: "work-item-detail",
			params: { workItemId: "old" },
			entity: { type: "work-item", id: "old", label: "Old item" },
			title: "Old page",
			sections: ["Old section"],
			event: { name: "old_action" },
		});
		expect(w.$(".tedix-context strong")?.textContent).toBe("Old item");
		w.Tedix.context({ pathname: "/work", routeKey: "work" });
		expect(w.Tedix.status().pageContext).toEqual({
			pathname: "/work",
			routeKey: "work",
		});
		expect(w.$(".tedix-context strong")?.textContent).toBe("Tedix");
		w.Tedix.track("opened", { tab: "open" });
		expect(w.Tedix.status().pageContext).toEqual({
			pathname: "/work",
			routeKey: "work",
			event: { name: "opened", metadata: { tab: "open" } },
		});
		w.Tedix.track("not a valid name!");
		expect(w.Tedix.status().pageContext.event.name).toBe("opened");
	});

	it("publishes declared host routes on navigation and unbinds them at shutdown", async () => {
		const w = await bootWidget({
			dataset: {
				tedixRoutes: JSON.stringify([
					{
						match: "/orders/:orderId",
						routeKey: "order",
						entity: { type: "order", id: ":orderId", label: "Order :orderId" },
					},
				]),
			},
		});
		history.pushState(null, "", "/orders/42");
		expect(w.Tedix.status().pageContext).toMatchObject({
			routeKey: "order",
			entity: { type: "order", id: "42", label: "Order 42" },
		});
		expect(w.$(".tedix-context strong")?.textContent).toBe("Order 42");
		w.Tedix.shutdown();
		const pushState = history.pushState;
		history.pushState(null, "", "/orders/43");
		expect(history.pushState).toBe(pushState);
		history.replaceState(null, "", "/");
	});

	it("exposes local, content-free reliability timings to the host", async () => {
		const w = await bootWidget();
		expect(w.detailsOf("performance")[0]).toMatchObject({ phase: "ready" });
		await w.open();
		await w.say("Hi");
		const stream = await w.waitForStream();
		stream.frame({ kind: "phase", phase: "generating" });
		stream.frame({ kind: "delta", text: "Hello" });
		stream.frame({ kind: "done", text: "Hello" });
		stream.finish();
		await settle();
		const reliability = w.Tedix.status().reliability;
		expect(reliability).toMatchObject({
			sessionAttempts: 1,
			lastSessionOutcome: "succeeded",
			turnAttempts: 1,
			lastTurnOutcome: "succeeded",
			lastReconnects: 0,
		});
		expect(reliability.lastFirstEventMs).toEqual(expect.any(Number));
		expect(reliability.lastFirstTextMs).toEqual(expect.any(Number));
		expect(w.detailsOf("performance").map((detail) => detail.phase)).toEqual([
			"ready",
			"session",
			"turn",
		]);
		expect(w.eventNames()).toEqual(
			expect.arrayContaining([
				"message-submitted",
				"first-token",
				"answer-completed",
			]),
		);
		expect(JSON.stringify(w.detailsOf("performance"))).not.toContain("Hello");
	});

	it("sends turn milestones only when the provider and the host both allow analytics", async () => {
		const run = async (analyticsEnabled: boolean, consent?: boolean) => {
			const w = await bootWidget({
				options: {
					session: vi.fn(async () => sessionResult({ analyticsEnabled })),
					...(consent === undefined ? {} : { consent: { analytics: consent } }),
				},
			});
			await w.open();
			await w.say("Hi");
			const stream = await w.waitForStream();
			stream.frame({ kind: "phase", phase: "generating" });
			stream.frame({ kind: "delta", text: "Hello" });
			stream.frame({ kind: "done", text: "Hello" });
			stream.finish();
			await settle(8);
			const batches = transport().clients.flatMap((client) =>
				client.metrics.mock.calls.map(
					([batch]) => batch as { events: Array<{ milestone: string }> },
				),
			);
			return batches.flatMap((batch) =>
				batch.events.map((event) => event.milestone),
			);
		};
		const sent = await run(true);
		expect(sent).toEqual(
			expect.arrayContaining([
				"session",
				"ready",
				"submitted",
				"acknowledged",
				"first_phase",
				"first_text",
				"terminal_received",
				"rendered",
			]),
		);
		expect(await run(true, false)).toEqual([]);
		expect(await run(false, true)).toEqual([]);
		expect(await run(true, true)).not.toEqual([]);
	});

	it("records reconnect milestones from the transport", async () => {
		const w = await bootWidget({
			options: {
				session: vi.fn(async () => sessionResult({ analyticsEnabled: true })),
			},
		});
		await w.open();
		await w.say("Hi");
		const stream = await w.waitForStream();
		const client = transport().clients.find((c) => c.stream.mock.calls.length)!;
		client.observer.onRetry?.({ attempt: 1, delayMs: 250 });
		client.observer.onConnect?.();
		stream.frame({ kind: "done", text: "ok" });
		stream.finish();
		await settle(8);
		expect(w.detailsOf("performance")).toContainEqual(
			expect.objectContaining({
				phase: "turn-reconnect",
				attempt: 1,
				delayMs: 250,
			}),
		);
		expect(w.Tedix.status().reliability.lastReconnects).toBe(1);
		const milestones = client.metrics.mock.calls.flatMap(([batch]) =>
			(batch as { events: Array<{ milestone: string }> }).events.map(
				(e) => e.milestone,
			),
		);
		expect(milestones).toEqual(
			expect.arrayContaining(["reconnect_started", "reconnect_recovered"]),
		);
	});
});

describe("WebMCP", () => {
	it("registers a bounded widget scope and remains safe without a host", async () => {
		const bare = await bootWidget();
		expect(bare.Tedix.status().mounted).toBe(true);
		const host = modelContextHost();
		const w = await bootWidget({
			before: () =>
				setTimeout(() => {
					(navigator as { modelContext?: unknown }).modelContext = host;
				}, 300),
		});
		await tick(700);
		expect([...host.tools.keys()]).toEqual([
			"get_tedi_widget_context",
			"open_tedi_widget",
			"ask_tedi",
			"request_tedi_approval",
		]);
		const opened = (await host.tools
			.get("open_tedi_widget")!
			.execute({ suggestedPrompt: "Draft this" })) as {
			structuredContent: unknown;
		};
		expect(opened.structuredContent).toEqual({ open: true, promptSent: false });
		expect(w.input().value).toBe("Draft this");
		expect(transport().streams).toHaveLength(0);
		const context = (await host.tools
			.get("get_tedi_widget_context")!
			.execute({})) as {
			structuredContent: Record<string, unknown>;
		};
		expect(context.structuredContent).toMatchObject({
			tenant: "demo-shop",
			open: true,
		});
	});

	it("keeps the page context current across host navigation events", async () => {
		const navigation = new EventTarget();
		Object.defineProperty(window, "navigation", {
			configurable: true,
			value: navigation,
		});
		const w = await bootWidget();
		history.replaceState(null, "", "/orders?tab=2");
		window.dispatchEvent(new PopStateEvent("popstate"));
		expect(w.Tedix.status().pageContext.pathname).toBe("/orders?tab=2");
		history.replaceState(null, "", "/invoices");
		navigation.dispatchEvent(new Event("currententrychange"));
		expect(w.Tedix.status().pageContext.pathname).toBe("/invoices");
		history.replaceState(null, "", "/");
		delete (window as { navigation?: unknown }).navigation;
	});

	it("withdraws its tools when the widget shuts down", async () => {
		const host = modelContextHost();
		const w = await bootWidget({
			before: () =>
				((navigator as { modelContext?: unknown }).modelContext = host),
		});
		expect(host.tools.size).toBeGreaterThan(0);
		w.Tedix.shutdown();
		expect(host.tools.size).toBe(0);
	});

	const profile = (tools: Array<Record<string, unknown>>) => ({
		webMcpProfile: {
			version: 1,
			routes: [{ id: "records", match: { routeKey: "records" }, tools }],
		},
	});
	const readTool = {
		name: "get_record",
		callable: "os.get_record",
		description: "Read one record",
		inputSchema: { type: "object" },
		resultFields: ["id"],
		annotations: { readOnlyHint: true },
	};

	async function portable(
		tools: Array<Record<string, unknown>>,
		options: Record<string, unknown> = {},
	) {
		const host = modelContextHost();
		const w = await bootWidget({
			before: () =>
				((navigator as { modelContext?: unknown }).modelContext = host),
			options: {
				session: vi.fn(async () => sessionResult(profile(tools))),
				...options,
			},
		});
		w.Tedix.context({ pathname: "/records/one", routeKey: "records" });
		await settle();
		return { w, host };
	}

	it("projects the signed route's tools and runs them through the host's own browser-session authority", async () => {
		const portableTool = vi.fn(async () => ({
			id: "one",
			privateNote: "hidden",
		}));
		const { host } = await portable([readTool], { portableTool });
		const completed = vi.fn();
		window.addEventListener("tedix:tool-completed", completed);
		const result = (await host.tools
			.get("get_record")!
			.execute({ id: "one" })) as {
			structuredContent: unknown;
		};
		window.removeEventListener("tedix:tool-completed", completed);
		expect(result.structuredContent).toEqual({ id: "one" });
		expect(portableTool).toHaveBeenCalledWith({
			callable: "os.get_record",
			args: { id: "one" },
		});
		for (const client of transport().clients)
			expect(client.callPortableTool).not.toHaveBeenCalled();
		expect((completed.mock.calls[0]![0] as CustomEvent).detail).toEqual({
			callable: "os.get_record",
			name: "get_record",
			routeId: "records",
		});
	});

	it("falls back to the signed session's own portable-tool call and preserves cancellation", async () => {
		const { w, host } = await portable([readTool]);
		const controller = new AbortController();
		controller.abort();
		const completed = vi.fn();
		window.addEventListener("tedix:tool-completed", completed);
		const cancelled = (await host.tools
			.get("get_record")!
			.execute({ id: "one" }, { signal: controller.signal })) as {
			structuredContent: unknown;
		};
		expect(cancelled.structuredContent).toEqual({
			status: "cancelled",
			changed: false,
		});
		expect(completed).not.toHaveBeenCalled();
		await host.tools.get("get_record")!.execute({ id: "one" });
		window.removeEventListener("tedix:tool-completed", completed);
		expect(w.client()!.callPortableTool).toHaveBeenCalledWith({
			callable: "os.get_record",
			args: { id: "one" },
		});
		expect(completed).toHaveBeenCalledOnce();
	});

	it("keeps portable writes behind prepare, the published confirmation dialog, and convergence", async () => {
		const writeTool = {
			...readTool,
			name: "update_record",
			callable: "os.update_record",
			annotations: { readOnlyHint: false },
			action: {
				prepareCallable: "os.prepare_update",
				convergeCallable: "os.read_record",
				confirmationTitle: "Update record?",
				confirmationLabel: "Update",
			},
		};
		const portableTool = vi.fn(async ({ callable }: { callable: string }) => ({
			id: "one",
			stage: callable,
		}));
		const { w, host } = await portable([writeTool], {
			portableTool,
		});
		hoisted.confirm.mockResolvedValueOnce(false);
		const declined = (await host.tools
			.get("update_record")!
			.execute({ id: "one" })) as {
			structuredContent: unknown;
		};
		expect(declined.structuredContent).toEqual({
			status: "cancelled",
			changed: false,
		});
		expect(portableTool.mock.calls.map(([call]) => call.callable)).toEqual([
			"os.prepare_update",
		]);
		expect(w.$(".tedix-panel")!.hasAttribute("data-open")).toBe(true);
		const [root, tool, preview] = hoisted.confirm.mock.calls[0]!;
		expect(root).toBe(w.root());
		expect(tool).toMatchObject({ name: "update_record" });
		expect(preview).toEqual({ id: "one", stage: "os.prepare_update" });

		hoisted.confirm.mockResolvedValueOnce(true);
		await host.tools.get("update_record")!.execute({ id: "one" });
		expect(portableTool.mock.calls.map(([call]) => call.callable)).toEqual([
			"os.prepare_update",
			"os.prepare_update",
			"os.update_record",
			"os.read_record",
		]);
	});

	it.each(["/embed.js", "/v1/embed.js", `/v1/embed.${"a".repeat(64)}.js`])(
		"loads the published confirmation asset from the widget origin when served from %s",
		async (pathname) => {
			const host = modelContextHost();
			const w = await bootWidget({
				src: `https://widget.tedix.dev${pathname}?host-sdk=3`,
				before: () =>
					((navigator as { modelContext?: unknown }).modelContext = host),
				options: {
					portableTool: vi.fn(async () => ({ id: "one" })),
					session: vi.fn(async () =>
						sessionResult(
							profile([
								{
									...readTool,
									name: "update_record",
									annotations: { readOnlyHint: false },
									action: {
										prepareCallable: "os.prepare_update",
										convergeCallable: "os.read_record",
										confirmationTitle: "Update record?",
										confirmationLabel: "Update",
									},
								},
							]),
						),
					),
				},
			});
			w.Tedix.context({ pathname: "/records/one", routeKey: "records" });
			await settle();
			hoisted.confirm.mockResolvedValueOnce(false);
			await host.tools.get("update_record")!.execute({ id: "one" });
			// Only https://widget.tedix.dev/confirm.js is mocked; any other URL fails.
			expect(hoisted.confirm).toHaveBeenCalledOnce();
		},
	);

	it("offers advisory route-local discovery without executing a tool", async () => {
		const tools = [
			readTool,
			{
				...readTool,
				name: "list_records",
				callable: "os.list_records",
				description: "List records",
			},
		];
		const portableTool = vi.fn();
		const { w, host } = await portable(tools, { portableTool });
		transport().configure = (client) =>
			client.rankPortableTools.mockResolvedValue({
				rankedIds: ["os.list_records", "os.get_record"],
				receipt: { executionId: "exec-1", usagePersistence: "persisted" },
			});
		const advice = (await host.tools
			.get("find_tedi_widget_tool")!
			.execute({ query: "all records" })) as {
			structuredContent: Record<string, any>;
		};
		expect(w.client()!.rankPortableTools).toHaveBeenCalledWith({
			query: "all records",
			callables: ["os.get_record", "os.list_records"],
		});
		expect(advice.structuredContent).toEqual({
			advisory: true,
			rankingReceipt: {
				ref: "jev-execution:exec-1",
				usagePersistence: "persisted",
			},
			tools: [
				{ name: "list_records", description: "List records" },
				{ name: "get_record", description: "Read one record" },
			],
		});
		expect(portableTool).not.toHaveBeenCalled();
		const refused = (await host.tools
			.get("find_tedi_widget_tool")!
			.execute({ query: "x" })) as { isError?: boolean };
		expect(refused.isError).toBe(true);
		// Advice computed for a route the page has left is withdrawn.
		let rank!: (value: unknown) => void;
		w.client()!.rankPortableTools.mockReturnValueOnce(
			new Promise((resolve) => (rank = resolve)),
		);
		const finder = host.tools.get("find_tedi_widget_tool")!;
		const stale = finder.execute({ query: "all records" }) as Promise<{
			isError?: boolean;
			content: Array<{ text: string }>;
		}>;
		await tick(0);
		w.Tedix.context({ pathname: "/elsewhere" });
		rank({ rankedIds: ["os.get_record", "os.list_records"] });
		const result = await stale;
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toBe("Page tool scope changed");
	});
});

describe("voice", () => {
	async function dictation(w: Widget) {
		w.$<HTMLButtonElement>(".tedix-voice")!.click();
		await tick(0);
		return hoisted.voice.at(-1)!;
	}

	it("turns voice into editable composer text without creating a voice message", async () => {
		const w = await bootWidget();
		await w.open();
		const voice = w.$<HTMLButtonElement>(".tedix-voice")!;
		expect(voice.getAttribute("aria-label")).toBe("Dictate message");
		expect(w.$$(".tedix-voice-wave i").length).toBeGreaterThan(0);
		const controller = await dictation(w);
		expect(controller.start).toHaveBeenCalledOnce();
		controller.publish("recording");
		expect(w.input().hidden).toBe(true);
		expect(voice.getAttribute("aria-label")).toBe("Stop and transcribe");
		expect(w.$(".tedix-voice-cancel")!.hidden).toBe(false);
		// Stop on the physical press, before the composer can claim focus.
		const press = new Event("pointerdown", { cancelable: true });
		voice.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);
		expect(controller.stop).toHaveBeenCalledOnce();
		expect(w.$<HTMLFormElement>(".tedix-form")!.dataset.voiceState).toBe(
			"transcribing",
		);
		expect(voice.hidden).toBe(true);
		voice.click();
		expect(controller.stop).toHaveBeenCalledOnce();
		w.type("Existing");
		controller.options.onTranscript("dictated words");
		controller.publish("idle");
		expect(w.input().value).toBe("Existing dictated words");
		expect(w.input().hidden).toBe(false);
		expect(w.messages()).toEqual([]);
		controller.options.onEvent({ type: "completed" });
		expect(w.detailsOf("voice")).toEqual([
			expect.objectContaining({ tenant: "demo-shop", type: "completed" }),
		]);
	});

	it("cancels an attempt still connecting and offers a retry after an error", async () => {
		const w = await bootWidget();
		await w.open();
		const controller = await dictation(w);
		controller.publish("connecting");
		const voice = w.$<HTMLButtonElement>(".tedix-voice")!;
		expect(voice.getAttribute("aria-label")).toBe("Cancel dictation");
		voice.click();
		expect(controller.cancel).toHaveBeenCalledOnce();
		controller.publish("idle", "Microphone blocked");
		const error = w.$(".tedix-voice-error")!;
		expect(error.hidden).toBe(false);
		expect(error.querySelector("span")?.textContent).toBe("Microphone blocked");
		error.querySelector<HTMLButtonElement>("button")!.click();
		expect(controller.start).toHaveBeenCalledTimes(2);
	});

	it("transcribes over TLS with the signed session and never posts to mixed content", async () => {
		const w = await bootWidget();
		await w.open();
		const controller = await dictation(w);
		w.fetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ text: "hello" }), { status: 200 }),
		);
		const text = await controller.options.transcribeRecording({
			blob: new Blob(["audio"]),
			fileName: "voice.webm",
		});
		expect(text).toBe("hello");
		const [endpoint, init] = w.fetch.mock.calls.at(-1)!;
		expect(String(endpoint)).toBe(
			`${location.protocol === "https:" ? "https" : "http"}://acme.tedi.tedix.dev/voice/transcribe`,
		);
		expect(init).toMatchObject({
			method: "POST",
			headers: { Authorization: "Bearer session-token" },
		});
	});
});
