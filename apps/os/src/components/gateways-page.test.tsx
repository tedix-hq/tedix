import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
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

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: { apps: { listGatewayMemberships: mocks.read } },
}));

import { appGatewayMembershipsQueryOptions } from "@/lib/os-query-options";
import { GatewaysPage } from "./gateways-page";

const loaded = {
	gateway: {
		id: "11111111-1111-4111-8111-111111111111",
		name: "Example shared connection",
		slug: `example-${"long-endpoint-".repeat(12)}`,
	},
	memberships: [],
};
const empty = { gateway: null, memberships: [] };
const cleanups: (() => void)[] = [];

beforeEach(() => {
	mocks.read.mockReset();
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function mount(seed?: typeof loaded | typeof empty) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	if (seed)
		client.setQueryData(appGatewayMembershipsQueryOptions().queryKey, seed);
	const router = createRouter({
		routeTree: createRootRoute({ component: GatewaysPage }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
		node.remove();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);
		await router.load();
	});
	return { node, client };
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

describe("shared connection read recovery", () => {
	it("does not claim absent setup during a pending cold read", async () => {
		mocks.read.mockReturnValue(new Promise(() => {}));
		const { node } = await mount();
		expect(mocks.read).toHaveBeenCalledTimes(1);
		expect(node.textContent).not.toContain("No shared connection");
		expect(node.querySelector('[role="alert"]')).toBeNull();
	});

	it("claims absent setup only after a successful empty read", async () => {
		mocks.read.mockResolvedValue(empty);
		const { node } = await mount();
		await flush();
		expect(node.textContent).toContain("No shared connection is set up");
		expect(node.querySelector('[role="alert"]')).toBeNull();
	});

	it("keeps a loaded gateway link and its full long endpoint", async () => {
		mocks.read.mockResolvedValue(loaded);
		const { node } = await mount();
		await flush();
		const link = node.querySelector(`a[href="/apps/${loaded.gateway.id}"]`);
		expect(link?.textContent).toContain(loaded.gateway.name);
		expect(link?.textContent).toContain(loaded.gateway.slug);
		expect(node.textContent).not.toContain("No shared connection");
	});

	it("never turns a cold failure into an empty setup and retries with one read", async () => {
		mocks.read.mockRejectedValueOnce(new Error("Read temporarily unavailable"));
		const { node } = await mount();
		await flush();
		expect(node.querySelector('[role="alert"]')?.textContent).toContain(
			"Read temporarily unavailable",
		);
		expect(node.textContent).not.toContain("No shared connection");
		const retry = [...node.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry shared connection",
		);
		expect(retry).toBeDefined();
		let resolve!: (value: typeof loaded) => void;
		mocks.read.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		await act(async () => retry!.click());
		await flush();
		expect(
			node.querySelector('[role="status"]')?.getAttribute("aria-label"),
		).toBe("Loading shared connection");
		expect(node.textContent).not.toContain("No shared connection");
		await act(async () => resolve(loaded));
		await flush();
		expect(mocks.read).toHaveBeenCalledTimes(2);
		expect(node.querySelector('[role="alert"]')).toBeNull();
		expect(
			node.querySelector(`a[href="/apps/${loaded.gateway.id}"]`),
		).not.toBeNull();
	});

	it("preserves cached navigation with a stale qualifier after a failed refresh", async () => {
		mocks.read.mockRejectedValue(new Error("Refresh failed"));
		const { node, client } = await mount(loaded);
		await act(async () => {
			await client.refetchQueries(appGatewayMembershipsQueryOptions());
		});
		await flush();
		expect(node.querySelector('[role="alert"]')?.textContent).toContain(
			"Showing the last loaded shared connection",
		);
		expect(node.textContent).toContain("may be out of date");
		expect(
			node.querySelector(`a[href="/apps/${loaded.gateway.id}"]`),
		).not.toBeNull();
		expect(node.textContent).not.toContain("No shared connection");
	});

	it("does not repeat cached empty setup as current after a failed refresh", async () => {
		mocks.read.mockRejectedValue(new Error("Refresh failed"));
		const { node, client } = await mount(empty);
		await act(async () => {
			await client.refetchQueries(appGatewayMembershipsQueryOptions());
		});
		await flush();
		expect(node.textContent).not.toContain("No shared connection");
		expect(node.textContent).toContain("Connections are unavailable");
	});
});
