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
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const api = vi.hoisted(() => ({
	listWorkspaces: vi.fn(),
	listGadgets: vi.fn(),
	listOutputs: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			workspaces: { list: api.listWorkspaces },
			gadgets: { list: api.listGadgets },
			outputs: { list: api.listOutputs },
		},
	},
}));

import { OsRoutePending } from "@/components/os-route-boundaries";
import {
	OS_LOADER_FIRST_PAINT_DEADLINE_MS,
	prefetchCanvasRoute,
} from "@/lib/os-route-loaders";

const WORKSPACE_ID = "1f1f7f5c-6b4a-4d0f-9a5e-7c1a2b3c4d5e";

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
	api.listWorkspaces.mockReset();
	api.listGadgets.mockReset();
	api.listOutputs.mockReset();
	api.listGadgets.mockResolvedValue({ items: [], truncated: false });
	api.listOutputs.mockResolvedValue({ items: [], truncated: false });
});

afterEach(() => {
	document.body.replaceChildren();
});

/*
 * Regression: an operator hit the stall watchdog on the FIRST navigation to a
 * workspace: "OS route load still pending after 20000ms", then the fallback
 * card; a plain reload rendered the workbench in seconds. Nothing had failed —
 * the loader was still legitimately waiting. `osApi` bounds one attempt at 15s
 * and the query client retries twice, so a single ensured read has a ~48s worst
 * case, more than twice the 20s watchdog. A cold apps/api isolate that eats one
 * attempt parks the route on the pending screen with no way out.
 *
 * The fix is a first-paint deadline INSIDE the loader, so the route stops being
 * hostage to its warm-up read. The workbench shell is a stand-in component
 * here on purpose: what is under test is the router's load contract (does the
 * route reach its component while the read is still outstanding?), not
 * `CanvasPage`'s internals, which have their own suite and which already read
 * this exact query through `useQuery` and render the shell without it.
 */
describe("workspace route load", () => {
	it("renders the workbench shell inside the stall bound while a loader read never settles", async () => {
		// The wedge shape: the loader's one awaited read neither resolves nor
		// rejects, so nothing downstream of it can ever bound the navigation.
		api.listWorkspaces.mockImplementation(() => new Promise(() => {}));

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const rootRoute = createRootRoute({ component: Outlet });
		const workspaceRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/",
			loader: () => prefetchCanvasRoute(queryClient, WORKSPACE_ID),
			component: () => <main data-canvas-shell>Workbench shell</main>,
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([workspaceRoute]),
			history: createMemoryHistory({ initialEntries: ["/"] }),
			// A watchdog bound just past the loader deadline: the shell has to win
			// the race, and the stalled card must never be reached.
			defaultPendingComponent: () => (
				<OsRoutePending stallAfterMs={OS_LOADER_FIRST_PAINT_DEADLINE_MS + 50} />
			),
			defaultPendingMs: 0,
			defaultPendingMinMs: 0,
		});

		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		// Deliberately no `await router.load()`: before the deadline it never
		// settled, which is the defect this proves is gone.
		act(() => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>,
			);
		});
		await flush();
		expect(container.textContent).toContain("Loading Tedix OS");

		await act(async () => {
			await new Promise((resolve) =>
				setTimeout(resolve, OS_LOADER_FIRST_PAINT_DEADLINE_MS + 10),
			);
		});
		await flush();

		expect(container.querySelector("[data-canvas-shell]")).not.toBeNull();
		expect(container.textContent).not.toContain(
			"Tedix OS is taking too long to load",
		);
		// The read was never cancelled — it is still in flight against the same
		// cache entry the component subscribes to, so the data streams in with no
		// second request rather than being abandoned.
		expect(api.listWorkspaces).toHaveBeenCalledTimes(1);

		act(() => root.unmount());
	});

	it("holds first paint no longer than the read actually takes", async () => {
		// The deadline is a ceiling, not a floor: a warm read still gates the
		// route so the workbench paints with its data already in cache.
		api.listWorkspaces.mockResolvedValue({
			items: [{ id: WORKSPACE_ID }],
			truncated: false,
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const startedAt = Date.now();
		const result = await prefetchCanvasRoute(queryClient, WORKSPACE_ID);

		expect(result).toEqual({ workspaceId: WORKSPACE_ID });
		expect(Date.now() - startedAt).toBeLessThan(
			OS_LOADER_FIRST_PAINT_DEADLINE_MS,
		);
	});
});
