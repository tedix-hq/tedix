import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PortableRouteContext } from "@tedix/webmcp-core/portable-profile";

const calls: Array<{ path: string; input: unknown }> = [];
// The portable tool caller captures `fetch` when the module loads.
const portableFetch = vi.hoisted(() => {
	const requests: string[] = [];
	globalThis.fetch = (async (url: string) => {
		requests.push(String(url));
		return Response.json({ ok: true, result: {} });
	}) as typeof fetch;
	return { requests };
});
const api = vi.hoisted(() => ({
	handlers: {} as Record<string, (input: unknown) => unknown>,
}));
vi.mock("@/lib/api", () => {
	const client = (path: string[]): unknown =>
		new Proxy(
			(input: unknown) => {
				const key = path.join(".");
				calls.push({ path: key, input });
				return Promise.resolve(api.handlers[key]?.(input) ?? {});
			},
			{
				get: (_target, name) =>
					typeof name === "string" ? client([...path, name]) : undefined,
			},
		);
	return { osApi: client([]) };
});
const route = vi.hoisted(() => ({ pathname: "/work" }));
vi.mock("@tanstack/react-router", () => ({
	useRouterState: ({
		select,
	}: {
		select: (state: { location: { pathname: string } }) => unknown;
	}) => select({ location: { pathname: route.pathname } }),
}));
vi.mock("@/lib/use-os-identity", () => ({
	useOsIdentity: () => ({ email: "ada@example.com", name: "Ada" }),
}));
const reported = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/lib/error-reporting/install", () => ({
	reportOsIssue: (...args: unknown[]) => reported.push(args),
}));
vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "tenant", slug: "acme" }),
}));

import {
	createOsPortableRouteAdapter,
	OsQuickChat,
	osPortableRouteContext,
	shouldSuppressQuickChatLauncher,
} from "./os-quick-chat";

describe("OS quick chat dogfood", () => {
	it("keeps publishing route context after the loader hands off to the runtime", () => {
		const queued: ReturnType<typeof osPortableRouteContext>[] = [];
		const published: ReturnType<typeof osPortableRouteContext>[] = [];
		let target = {
			context: (value: ReturnType<typeof osPortableRouteContext>) => {
				queued.push(value);
			},
		};
		const adapter = createOsPortableRouteAdapter(() => target);
		adapter.setPathname("/work", { routeKey: "work" });
		target = {
			context: (value) => {
				published.push(value);
			},
		};
		for (const value of queued.splice(0)) target.context(value);
		adapter.setPathname("/workspaces", { routeKey: "workspaces" });
		adapter.setPathname("/blueprints", { routeKey: "blueprints" });
		expect(queued).toEqual([]);
		expect(published.map(({ routeKey }) => routeKey)).toEqual([
			"work",
			"workspaces",
			"blueprints",
		]);
	});

	/**
	 * The loader installs a queueing stub synchronously and the runtime replaces
	 * it later, so navigations can land while init is still pending. Ordering is
	 * the property that matters: a queued route must not overtake or be lost
	 * behind one published after the handoff.
	 */
	it("delivers every navigation made while init is pending, in order", () => {
		const queued: PortableRouteContext[] = [];
		const published: PortableRouteContext[] = [];
		let target = {
			context: (value: PortableRouteContext) => {
				queued.push(value);
			},
		};
		const adapter = createOsPortableRouteAdapter(() => target);

		// Three navigations before the runtime exists — all land in the stub queue.
		adapter.setPathname("/work", { routeKey: "work" });
		adapter.setPathname("/workspaces", { routeKey: "workspaces" });
		adapter.setPathname("/skills", { routeKey: "skills" });
		expect(queued).toHaveLength(3);
		expect(published).toEqual([]);

		target = {
			context: (value) => {
				published.push(value);
			},
		};
		for (const value of queued.splice(0)) target.context(value);
		adapter.setPathname("/blueprints", { routeKey: "blueprints" });

		expect(published.map(({ routeKey }) => routeKey)).toEqual([
			"work",
			"workspaces",
			"skills",
			"blueprints",
		]);
	});

	/**
	 * A target that is absent — before the loader script runs, or after teardown
	 * — must not throw. `getTarget()?.context(...)` drops the publish, which is
	 * the intended behaviour: the OS only builds the adapter once `window.Tedix`
	 * exists, so this is the teardown edge rather than the common path.
	 */
	it("drops a navigation when no widget target is present, without throwing", () => {
		const adapter = createOsPortableRouteAdapter(() => undefined);
		expect(() =>
			adapter.setPathname("/work", { routeKey: "work" }),
		).not.toThrow();
	});

	/**
	 * Route-state isolation. `osPortableRouteContext` derives params and entity
	 * per pathname and the adapter publishes a REPLACEMENT snapshot, so leaving a
	 * detail route must not leave its entity behind — the widget-side merge bug
	 * this guards against shipped once as a real defect.
	 */
	it("does not carry entity or params from a detail route into an unrelated route", () => {
		const published: PortableRouteContext[] = [];
		const adapter = createOsPortableRouteAdapter(() => ({
			context: (value: PortableRouteContext) => {
				published.push(value);
			},
		}));

		const detail = osPortableRouteContext("/work/items/c432bec3");
		expect(detail.entity).toEqual({ type: "work-item", id: "c432bec3" });
		expect(detail.params).toEqual({ workItemId: "c432bec3" });

		const { pathname: detailPath, ...detailContext } = detail;
		adapter.setPathname(detailPath, detailContext);

		const plain = osPortableRouteContext("/work");
		const { pathname: plainPath, ...plainContext } = plain;
		adapter.setPathname(plainPath, plainContext);

		expect(published).toHaveLength(2);
		expect(published[0]?.entity).toEqual({ type: "work-item", id: "c432bec3" });
		// The second publish is a fresh snapshot: no residue from the first.
		expect(published[1]?.entity).toBeUndefined();
		expect(published[1]?.params).toBeUndefined();
		expect(published[1]?.routeKey).toBe("work");
		expect(published[1]?.title).toBe("Admission queue");
		expect(published[1]?.description).toContain("Accepted work evaluated");

		const { pathname: unknownPath, ...unknownContext } =
			osPortableRouteContext("/unknown-page");
		adapter.setPathname(unknownPath, unknownContext);
		expect(published[2]?.title).toBeUndefined();
		expect(published[2]?.description).toBeUndefined();
		expect(published[2]?.entity).toBeUndefined();
	});

	it("publishes stable route keys, params, and entities to the widget", () => {
		expect(osPortableRouteContext("/workspaces")).toEqual({
			pathname: "/workspaces",
			routeKey: "workspaces",
			title: "Workspaces",
			description: "Find, create, and reopen workspaces.",
		});
		expect(osPortableRouteContext("/workspace/ws%201")).toEqual({
			pathname: "/workspace/ws%201",
			routeKey: "workspace-detail",
			title: "Workspace",
			description: "A workspace's chat and workpiece canvas.",
			params: { workspaceId: "ws 1" },
			entity: { type: "workspace", id: "ws 1" },
		});
		expect(osPortableRouteContext("/work/items/item-1")).toEqual({
			pathname: "/work/items/item-1",
			routeKey: "work-item-detail",
			title: "Work item",
			description:
				"A selected work item's outcome, attempts, evidence, and lifecycle.",
			params: { workItemId: "item-1" },
			entity: { type: "work-item", id: "item-1" },
		});
	});

	it("suppresses the launcher where a native composer sits bottom-right", () => {
		expect(shouldSuppressQuickChatLauncher("/chat")).toBe(true);
		expect(shouldSuppressQuickChatLauncher("/chat/abc")).toBe(true);
		expect(shouldSuppressQuickChatLauncher("/workspace/ws-1")).toBe(true);
		expect(shouldSuppressQuickChatLauncher("/")).toBe(false);
		expect(shouldSuppressQuickChatLauncher("/tedis")).toBe(false);
		expect(shouldSuppressQuickChatLauncher("/chatter")).toBe(false);
	});
});

/**
 * The mounted quick chat against a fake loader: the component appends the
 * production loader script; the test plays the loader by installing
 * `window.Tedix` and firing the script's load event.
 */
describe("OsQuickChat mount", () => {
	type Listener = (detail: Record<string, unknown>) => void;
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		calls.length = 0;
		reported.length = 0;
		api.handlers = {};
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	async function mount(
		options: { analytics?: boolean; defaultTediId?: string | null } = {},
	) {
		vi.stubEnv("MODE", "development");
		vi.stubGlobal("__LOCAL_DEMO_ENABLED__", false);
		const selection =
			options.defaultTediId === null
				? undefined
				: {
						defaultTediId: options.defaultTediId ?? "tedi-7",
						allowedTediIds: [options.defaultTediId ?? "tedi-7"],
					};
		api.handlers = {
			"userSettings.getContext": () => ({
				organization: { id: "org-1", slug: "acme", name: "Acme" },
			}),
			"organizations.get": () => ({
				name: "Acme",
				metadata: {
					tediWidget: {
						title: "Acme help",
						subtitle: "Ask Acme",
						product: "Acme OS",
						conversationStarters: ["What changed?"],
						analyticsEnabled: options.analytics === true,
						...(selection ? { tediSelection: selection } : {}),
					},
				},
			}),
			"tedis.createEmbeddedSession": (input) => ({ session: input }),
		};
		const listeners = new Map<string, Listener>();
		const disposed: string[] = [];
		const order: string[] = [];
		const widget = {
			init: vi.fn(),
			context: vi.fn(),
			on: (event: string, listener: Listener) => {
				listeners.set(event, listener);
				return () => disposed.push(event);
			},
			shutdown: vi.fn(() => {
				order.push(
					`shutdown:${document.querySelector("script[data-tedix-os-quick-chat]") ? "script-present" : "script-gone"}`,
				);
			}),
		};
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => root.render(createElement(OsQuickChat)));
		const script = document.querySelector<HTMLScriptElement>(
			"script[data-tedix-os-quick-chat]",
		)!;
		(window as unknown as { Tedix?: unknown }).Tedix = widget;
		await act(async () => {
			script.dispatchEvent(new Event("load"));
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
		let mounted = true;
		const unmount = async () => {
			if (!mounted) return;
			mounted = false;
			await act(async () => root.unmount());
			host.remove();
			delete (window as unknown as { Tedix?: unknown }).Tedix;
		};
		cleanups.push(unmount);
		const initOptions = () =>
			widget.init.mock.calls[0]![0] as Record<string, unknown> & {
				session: (input: Record<string, unknown>) => Promise<unknown>;
			};
		return { script, widget, listeners, disposed, order, unmount, initOptions };
	}

	it("loads the production white-label widget, preloaded open", async () => {
		const { script } = await mount();
		expect(script.src).toBe("https://widget.tedix.dev/v1/loader.js?host-sdk=3");
		expect(script.dataset.tedixPreload).toBe("open");
	});

	it("derives the white-label experience from organization configuration", async () => {
		const { initOptions } = await mount();
		const options = initOptions();
		expect(options.tenant).toBe("acme");
		expect(options.title).toBe("Acme help");
		expect(options.subtitle).toBe("Ask Acme");
		expect(options.product).toBe("Acme OS");
		expect(options.prompts).toEqual(["What changed?"]);
		expect(options.conversationStarters).toEqual(["What changed?"]);
		expect(options.locale).toBe("en-US");
		expect(options.requireSignedPortableRoute).toBe(true);
		expect(typeof options.portableTool).toBe("function");
		// External hosts have no canonical embedded transcript provider, so the
		// OS must not hand the widget native history either.
		expect(options).not.toHaveProperty("history");
		expect(options).not.toHaveProperty("transcript");
	});

	it("mints an OS-authenticated embedded session for the configured tedi", async () => {
		const { initOptions } = await mount();
		await initOptions().session({ conversationId: "c-1", pathname: "/work" });
		const minted = calls.find(
			(call) => call.path === "tedis.createEmbeddedSession",
		)!.input as Record<string, unknown>;
		expect(minted.tediId).toBe("tedi-7");
		expect(minted.surface).toBe("os");
		expect(minted.allowedOrigin).toBe(window.location.origin);
		expect(minted.hostOrganizationId).toBe("org-1");
		expect(minted.hostUserId).toBe("ada@example.com");
		expect(minted.conversationId).toBe("c-1");
	});

	it("uses a signed one-route capability for first-party portable tools", async () => {
		const { initOptions } = await mount();
		const portableTool = initOptions().portableTool as (
			input: unknown,
		) => Promise<unknown>;
		await expect(
			portableTool({ callable: "work.list_items", args: {} }),
		).rejects.toThrow(/Signed portable route is required/);
		await portableTool({
			callable: "work.list_items",
			args: {},
			routeCapability: { token: "signed", routeId: "route-1" },
		}).catch(() => undefined);
		expect(portableFetch.requests).toContain("/_tedix/webmcp/portable-call");
	});

	it("uses shared embedded sends, never native kernel conversations or workspaces", async () => {
		const { initOptions, listeners } = await mount();
		listeners.get("opened")?.({});
		await initOptions().session({
			conversationId: "c-1",
			pathname: "/workspaces",
		});
		const paths = calls.map((call) => call.path);
		for (const path of paths) {
			expect(path.startsWith("kernelRuntime.")).toBe(false);
			expect(path.startsWith("osWorkspaces.")).toBe(false);
		}
	});

	it("seeds route context from the current page after initialization", async () => {
		route.pathname = "/work";
		const { widget } = await mount();
		expect(widget.context).toHaveBeenCalledWith(
			expect.objectContaining({
				routeKey: osPortableRouteContext(window.location.pathname).routeKey,
			}),
		);
	});

	it("keeps OS quick chat outside customer widget analytics unless enabled", async () => {
		const disabled = await mount();
		disabled.listeners.get("ready")?.({});
		expect(
			calls.some((call) => call.path === "analytics.trackWidgetLifecycle"),
		).toBe(false);
		await disabled.unmount();
		calls.length = 0;

		const enabled = await mount({ analytics: true });
		enabled.listeners.get("ready")?.({});
		enabled.listeners.get("answer-failed")?.({
			code: "provider_error",
			conversationId: "c-1",
			eventId: "e-1",
			durationMs: 12.4,
		});
		const events = calls
			.filter((call) => call.path === "analytics.trackWidgetLifecycle")
			.map(
				(call) =>
					(call.input as { events: Array<Record<string, unknown>> }).events[0],
			);
		expect(events).toEqual([
			{ event: "ready", surface: "native_os" },
			{
				event: "answer_failed",
				durationMs: 12,
				code: "provider_error",
				conversationId: "c-1",
				eventId: "e-1",
				surface: "native_os",
			},
		]);
	});

	it("dogfoods local reliability marks and reports typed widget failures", async () => {
		const marks = vi.spyOn(performance, "mark");
		const { listeners } = await mount();
		listeners.get("performance")?.({ phase: "ready", durationMs: 5 });
		expect(marks).toHaveBeenCalledWith("tedix:widget:ready", expect.anything());
		listeners.get("error")?.({ code: "session_failed" });
		expect(reported[0]?.[0]).toBe("widget.lifecycle");
		marks.mockRestore();
	});

	it("reports a tedi prefetch failure when selection is not configured", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const { listeners } = await mount({ defaultTediId: null });
		listeners.get("opened")?.({});
		await act(async () => {
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(
			errors.mock.calls.some(
				([tag]) => tag === "[OS quick chat tedi prefetch]",
			),
		).toBe(true);
		errors.mockRestore();
	});

	it("shuts down actor-scoped widget state before removing the loader", async () => {
		const { unmount, order, disposed } = await mount();
		await unmount();
		expect(order).toEqual(["shutdown:script-present"]);
		expect(
			document.querySelector("script[data-tedix-os-quick-chat]"),
		).toBeNull();
		expect(disposed).toEqual(
			expect.arrayContaining([
				"error",
				"performance",
				"ready",
				"opened",
				"closed",
			]),
		);
	});

	it("hides the widget host where a native composer sits bottom-right", async () => {
		const widgetHost = document.createElement("div");
		widgetHost.setAttribute("data-tedix-widget", "");
		document.body.append(widgetHost);
		const previous = window.location.pathname;
		window.history.pushState({}, "", "/chat");
		route.pathname = "/chat";
		try {
			const { listeners } = await mount();
			listeners.get("ready")?.({});
			expect(widgetHost.hidden).toBe(true);
			window.history.pushState({}, "", "/work");
			listeners.get("ready")?.({});
			expect(widgetHost.hidden).toBe(false);
		} finally {
			widgetHost.remove();
			window.history.pushState({}, "", previous);
			route.pathname = "/work";
		}
	});
});
