import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	OsRouteError,
	OsRouteNotFound,
	OsRoutePending,
} from "@/components/os-route-boundaries";
import { Empty } from "@/components/kumo/empty";
import { installOsErrorReporting } from "@/lib/error-reporting/install";
import type { OsClientErrorReportV1 } from "@/lib/error-reporting/report";

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
	document.body.replaceChildren();
});

describe("OS route boundaries", () => {
	it("delegates route empty surfaces to Kumo defaults", async () => {
		const kumoEmpty = new DOMParser().parseFromString(
			renderToStaticMarkup(<Empty className="min-h-64" />),
			"text/html",
		).body.firstElementChild?.className;
		const emptyOf = (html: string) =>
			new DOMParser()
				.parseFromString(html, "text/html")
				.querySelector('[data-slot="empty"]')?.className;

		expect(emptyOf(renderToStaticMarkup(<OsRouteNotFound />))).toBe(kumoEmpty);
		expect(
			emptyOf(
				renderToStaticMarkup(
					<OsRouteError error={new Error("boom")} reset={() => {}} />,
				),
			),
		).toBe(kumoEmpty);

		// The stalled pending state.
		const host = document.createElement("div");
		document.body.append(host);
		vi.spyOn(console, "error").mockImplementation(() => {});
		await act(async () =>
			createRoot(host).render(<OsRoutePending stallAfterMs={0} />),
		);
		await flush();
		expect(host.textContent).toContain("taking too long to load");
		expect(host.querySelector('[data-slot="empty"]')?.className).toBe(
			kumoEmpty,
		);
		vi.mocked(console.error).mockRestore();
	});

	it("announces the global pending state accessibly", () => {
		const html = renderToStaticMarkup(<OsRoutePending />);

		expect(html).toContain('role="status"');
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain("Loading Tedix OS");
	});

	/*
	 * Regression: direct document loads intermittently
	 * wedged on the "Loading Tedix OS…" spinner forever, with zero console
	 * output. Loader API reads are transport-bounded, but a route chunk
	 * `import()` (or any await that never settles) rejects nothing — so the
	 * pending component itself must carry the bound: past
	 * OS_ROUTE_PENDING_STALL_MS it escalates to a visible stalled state with a
	 * Reload action and reports the wedge.
	 */
	it("escalates a never-settling route load to a stalled retry state within the bound", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const sent: OsClientErrorReportV1[] = [];
		const teardown = installOsErrorReporting(window, (report) => {
			sent.push(report);
		});
		const reload = vi.fn();
		const rootRoute = createRootRoute({ component: Outlet });
		const indexRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/",
			// The wedge shape: an await that neither resolves nor rejects. No
			// timeout, no retry, no error — previously an eternal spinner.
			loader: () => new Promise<never>(() => {}),
			component: () => <p>Unreachable</p>,
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([indexRoute]),
			history: createMemoryHistory({ initialEntries: ["/"] }),
			defaultPendingComponent: () => (
				<OsRoutePending stallAfterMs={25} reload={reload} />
			),
			defaultPendingMs: 0,
			defaultPendingMinMs: 0,
		});

		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		// Deliberately no `await router.load()` — it would never settle.
		act(() => {
			root.render(<RouterProvider router={router} />);
		});
		await flush();
		expect(container.textContent).toContain("Loading Tedix OS");

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
		});
		await flush();

		expect(container.textContent).toContain(
			"Tedix OS is taking too long to load",
		);
		const reloadButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Reload",
		);
		expect(reloadButton).toBeDefined();
		act(() => reloadButton?.click());
		expect(reload).toHaveBeenCalledTimes(1);

		// The wedge is reported, so the next occurrence carries a diagnosis.
		expect(errorLog).toHaveBeenCalledWith(
			"Tedix OS route load stalled",
			expect.any(Error),
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			schemaVersion: 1,
			failureSite: "os.route-pending-stall",
			handled: true,
		});
		expect(sent[0]?.exception?.message).toContain("still pending after 25ms");

		act(() => root.unmount());
		teardown();
		errorLog.mockRestore();
	});

	it("keeps the plain spinner below the stall bound", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		act(() => {
			root.render(<OsRoutePending stallAfterMs={10_000} />);
		});
		await flush();

		expect(container.textContent).toContain("Loading Tedix OS");
		expect(container.textContent).not.toContain(
			"Tedix OS is taking too long to load",
		);
		act(() => root.unmount());
	});

	it("renders the root not-found component for an unknown route", async () => {
		const rootRoute = createRootRoute({
			component: Outlet,
			notFoundComponent: OsRouteNotFound,
		});
		const knownRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/known",
			component: () => <p>Known route</p>,
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([knownRoute]),
			history: createMemoryHistory({ initialEntries: ["/missing"] }),
		});

		await router.load();
		const html = renderToStaticMarkup(<RouterProvider router={router} />);

		expect(html).toContain("Page not found");
		expect(html).toContain("Go to Activity");
	});

	it("reports a caught render failure as a react capture", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const sent: OsClientErrorReportV1[] = [];
		// Installed against this window with a capturing transport, so the
		// assertion covers the real reporter the boundary calls — not a mock of
		// it. Without an install the module-level reporter is null and the
		// boundary's capture site is a silent no-op.
		const teardown = installOsErrorReporting(window, (report) => {
			sent.push(report);
		});
		const rootRoute = createRootRoute({ component: Outlet });
		const indexRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/",
			loader: () => {
				throw new Error("route failed");
			},
			component: () => <p>Unreachable</p>,
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([indexRoute]),
			history: createMemoryHistory({ initialEntries: ["/"] }),
			defaultErrorComponent: OsRouteError,
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		await router.load();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		act(() => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>,
			);
		});
		await flush();

		expect(container.textContent).toContain("This view could not be loaded");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			schemaVersion: 1,
			failureSite: "os.route-boundary",
			captureMechanism: "react",
			handled: false,
			severity: "error",
		});
		expect(sent[0]?.exception?.message).toContain("route failed");

		act(() => root.unmount());
		teardown();
		errorLog.mockRestore();
	});

	it("resets and retries a failed route without a page reload", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		let attempts = 0;
		const rootRoute = createRootRoute({ component: Outlet });
		const indexRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/",
			loader: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("route failed");
			},
			component: () => <p>Route recovered</p>,
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([indexRoute]),
			history: createMemoryHistory({ initialEntries: ["/"] }),
			defaultErrorComponent: OsRouteError,
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		await router.load();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		act(() => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>,
			);
		});
		await flush();

		expect(container.textContent).toContain("This view could not be loaded");
		const retry = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry",
		);
		expect(retry).toBeDefined();
		act(() => retry?.click());
		await flush();

		expect(attempts).toBe(2);
		expect(container.textContent).toContain("Route recovered");
		expect(errorLog).toHaveBeenCalledWith(
			"Tedix OS route failed",
			expect.any(Error),
		);
		act(() => root.unmount());
		errorLog.mockRestore();
	});
});
