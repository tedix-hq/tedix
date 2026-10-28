import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { WorkHome } from "./work-home";
import { osQuery } from "@/lib/os-query-options";

const mocks = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: { osWorkspaces: { gadgets: { installWorkDefaults: mocks.install } } },
}));
vi.mock("@/lib/use-work-apps", () => ({
	useWorkApps: () => ({
		apps: [],
		pending: false,
		failed: false,
		truncated: false,
		retry: vi.fn(),
	}),
}));
vi.mock("@/lib/use-deck-count", () => ({
	useDeckCount: () => ({
		requests: [],
		count: 0,
		more: false,
		pending: false,
		failed: false,
	}),
}));
vi.mock("@/lib/use-os-locale", () => ({ useOsLocale: () => "en-US" }));
vi.mock("@/lib/use-document-title", () => ({ useDocumentTitle: vi.fn() }));

afterEach(() => {
	vi.clearAllMocks();
	document.body.innerHTML = "";
});

/**
 * A mutation's state change reaches the useSyncExternalStore listener through
 * notifyManager's setTimeout(0) scheduler — a macrotask, not the microtask
 * queue. Await the cache's dispatch event first, then yield one timer so the
 * already-scheduled notification fires before this act scope ends. A fixed
 * sleep races that timer and loses under load.
 */
const mutationDispatched = (
	client: QueryClient,
	action: "pending" | "success" | "error",
) =>
	new Promise<void>((resolve) => {
		const unsubscribe = client.getMutationCache().subscribe((event) => {
			if (event.type === "updated" && event.action.type === action) {
				unsubscribe();
				resolve();
			}
		});
	});

it("installs the defaults with one button, prevents duplicate clicks and refreshes the workspace domain", async () => {
	let finish!: (value: { workspaceId: string }) => void;
	mocks.install.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const root = createRoot(
		document.body.appendChild(document.createElement("div")),
	);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkHome />
			</QueryClientProvider>,
		),
	);
	const button = [...document.querySelectorAll("button")].find(
		(item) => item.textContent === "Set up Activity and Decisions",
	)!;
	expect(button.textContent).toBe("Set up Activity and Decisions");
	const pending = mutationDispatched(client, "pending");
	await act(async () => {
		button.click();
		await pending;
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(mocks.install).toHaveBeenCalledExactlyOnceWith({});
	expect(button.disabled).toBe(true);
	// The shared loading affordance announces the pending install.
	expect(
		button.querySelector('[role="status"]')?.getAttribute("aria-label"),
	).toBe("Loading");
	expect(button.textContent).toBe("Setting up Activity and Decisions…");
	const succeeded = mutationDispatched(client, "success");
	await act(async () => {
		finish({ workspaceId: "11111111-1111-4111-8111-111111111111" });
		await succeeded;
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(invalidate).toHaveBeenCalledWith({
		queryKey: osQuery.osWorkspaces.key(),
	});
	expect(button.querySelector('[role="status"]')).toBeNull();
	await act(async () => root.unmount());
});

it("shows an installation failure and leaves the button available for retry", async () => {
	mocks.install.mockRejectedValue(new Error("unavailable"));
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const root = createRoot(
		document.body.appendChild(document.createElement("div")),
	);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkHome />
			</QueryClientProvider>,
		),
	);
	const button = [...document.querySelectorAll("button")].find(
		(item) => item.textContent === "Set up Activity and Decisions",
	)!;
	const failed = mutationDispatched(client, "error");
	await act(async () => {
		button.click();
		await failed;
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"could not be set up",
	);
	expect(button.disabled).toBe(false);
	await act(async () => root.unmount());
});
