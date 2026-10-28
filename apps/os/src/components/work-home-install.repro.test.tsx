import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
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

it("clears the loading affordance after completion even when the mutation notification is delayed", async () => {
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
	const pending = mutationDispatched(client, "pending");
	await act(async () => {
		button.click();
		await pending;
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(button.querySelector('[role="status"]')).not.toBeNull();
	// The observer's useSyncExternalStore listener is delivered through
	// notifyManager's setTimeout(0) scheduler. Slowing that delivery
	// reproduces the full-suite interleaving: the fixed 10ms wait used to
	// lose the race and leave the spinner mounted after completion.
	notifyManager.setScheduler((callback) => setTimeout(callback, 30));
	try {
		const succeeded = mutationDispatched(client, "success");
		await act(async () => {
			finish({ workspaceId: "11111111-1111-4111-8111-111111111111" });
			await succeeded;
			await new Promise((resolve) => setTimeout(resolve, 40));
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQuery.osWorkspaces.key(),
		});
		expect(button.querySelector('[role="status"]')).toBeNull();
	} finally {
		notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	}
	await act(async () => root.unmount());
});
