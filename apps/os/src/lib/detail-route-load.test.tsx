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

const api = vi.hoisted(() => ({
	getOutput: vi.fn(),
	inspectRun: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: { outputs: { get: api.getOutput } },
		skills: { inspectWorkflowRun: api.inspectRun },
	},
}));

import { OsRoutePending } from "@/components/os-route-boundaries";
import { DetailUnavailable } from "@/components/detail-unavailable";
import {
	OS_LOADER_FIRST_PAINT_DEADLINE_MS,
	prefetchOutputRoute,
} from "@/lib/os-route-loaders";

const OUTPUT_ID = "3d2f1e0a-4b5c-4d6e-8f90-a1b2c3d4e5f6";

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

function notFoundError() {
	return Object.assign(new Error("Output not found"), { code: "NOT_FOUND" });
}

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	api.getOutput.mockReset();
	api.inspectRun.mockReset();
});

afterEach(() => {
	document.body.replaceChildren();
});

/*
 * Regression: the deferred half of the first-paint fix.
 *
 * `prefetchOutputRoute` awaited an unbounded identity
 * read, and unlike the canvas loader that await also DECIDED existence: a
 * rejected read rejected the loader, so a ~48s worst-case transport failure and
 * a genuine 404 reached the operator as the same outcome. The semantics chosen
 * here: a slow read is not evidence of absence. The loader bounds its read with
 * the shared `withFirstPaintDeadline`, the route renders, and the component's
 * own query owns the verdict — pending while the read is outstanding,
 * "not found" only on a settled NOT_FOUND.
 *
 * The stand-in components below are deliberate: what is under test is the
 * router's load contract, not the detail pages' internals (those have their own
 * suites and already read these exact queries through `useQuery`).
 */

type Case = {
	name: string;
	call: ReturnType<typeof vi.fn>;
	loader: (queryClient: QueryClient) => Promise<unknown>;
	resource: string;
};

const cases: Case[] = [
	{
		name: "output detail route",
		call: api.getOutput,
		loader: (queryClient) => prefetchOutputRoute(queryClient, OUTPUT_ID),
		resource: "Output",
	},
];

describe.each(cases)("$name load", ({ call, loader }) => {
	it("renders the route shell inside the stall bound while the identity read never settles", async () => {
		call.mockImplementation(() => new Promise(() => {}));

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const rootRoute = createRootRoute({ component: Outlet });
		const detailRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/",
			loader: () => loader(queryClient),
			component: () => <main data-detail-shell>Detail shell</main>,
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([detailRoute]),
			history: createMemoryHistory({ initialEntries: ["/"] }),
			// Bound just past the loader deadline: the shell has to win the race and
			// the stalled card must never be reached.
			defaultPendingComponent: () => (
				<OsRoutePending stallAfterMs={OS_LOADER_FIRST_PAINT_DEADLINE_MS + 50} />
			),
			defaultPendingMs: 0,
			defaultPendingMinMs: 0,
		});

		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		// Deliberately no `await router.load()`: the read never settles, which is
		// exactly the wedge this proves is gone.
		act(() => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>,
			);
		});
		await flush();

		await act(async () => {
			await new Promise((resolve) =>
				setTimeout(resolve, OS_LOADER_FIRST_PAINT_DEADLINE_MS + 10),
			);
		});
		await flush();

		expect(container.querySelector("[data-detail-shell]")).not.toBeNull();
		expect(container.textContent).not.toContain(
			"Tedix OS is taking too long to load",
		);

		act(() => root.unmount());
	});

	it("issues the identity read exactly once and never abandons it", async () => {
		// The read outlives the deadline and lands in the SAME cache entry the
		// component subscribes to, so the surface's own `useQuery` resolves from it
		// instead of firing a second request.
		let settle: ((value: unknown) => void) | undefined;
		call.mockImplementation(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		vi.useFakeTimers();
		try {
			const load = loader(queryClient);
			await vi.advanceTimersByTimeAsync(OS_LOADER_FIRST_PAINT_DEADLINE_MS);
			await load;
		} finally {
			vi.useRealTimers();
		}
		expect(call).toHaveBeenCalledTimes(1);

		settle?.({ marker: "late" });
		await flush();

		expect(call).toHaveBeenCalledTimes(1);
		const entry = queryClient
			.getQueryCache()
			.getAll()
			.find((query) => query.state.data !== undefined);
		expect(entry?.state.data).toEqual({ marker: "late" });
	});

	it("does not turn a rejected identity read into a route error", async () => {
		// A 404 no longer rejects the loader — the navigation completes and the
		// component renders the verdict.
		call.mockRejectedValue(notFoundError());
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		await expect(loader(queryClient)).resolves.toBeDefined();
		expect(call).toHaveBeenCalledTimes(1);
	});
});

describe("detail not-found ownership", () => {
	it("reports a settled NOT_FOUND as absence, without outage styling", () => {
		for (const resource of ["Output", "Run"]) {
			const html = renderToStaticMarkup(
				<DetailUnavailable resource={resource} error={notFoundError()} />,
			);
			expect(html).toContain(`${resource} not found`);
			// A deleted resource is a normal state, not an outage.
			expect(html).toContain('data-variant="default"');
		}
	});

	it("never reports a timeout or transport failure as not found", () => {
		for (const resource of ["Output", "Run"]) {
			const html = renderToStaticMarkup(
				<DetailUnavailable
					resource={resource}
					error={new Error("The request timed out.")}
				/>,
			);
			expect(html).toContain(`${resource} is unavailable`);
			expect(html).toContain("The request timed out.");
			expect(html).not.toContain("not found");
		}
	});
});
