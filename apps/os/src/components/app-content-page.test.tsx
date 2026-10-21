import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { contentSourcesQueryOptions } from "@/lib/os-query-options";

const mocks = vi.hoisted(() => ({
	canManage: true,
}));

const api = vi.hoisted(() => ({
	getByIdWithTools: vi.fn(),
	update: vi.fn(),
	listSources: vi.fn(),
	ingestAll: vi.fn(),
	ingestSource: vi.fn(),
	addSource: vi.fn(),
	removeSource: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		apps: {
			getByIdWithTools: api.getByIdWithTools,
			update: api.update,
		},
		content: {
			listSources: api.listSources,
			ingestAll: api.ingestAll,
			ingestSource: api.ingestSource,
			addSource: api.addSource,
			removeSource: api.removeSource,
		},
	},
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useParams: () => ({ appId: APP_ID }),
}));

vi.mock("@/lib/app-permissions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/app-permissions")>()),
	useCanManageApps: () => mocks.canManage,
}));

vi.mock("@/components/kumo/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "@/components/kumo/toast";
import { AppContentPage } from "./app-content-page";

const APP_ID = "11111111-1111-4111-8111-111111111111";

function appDetail(
	syncInterval: "daily" | "weekly" | "monthly" | "disabled" = "disabled",
) {
	return {
		app: {
			id: APP_ID,
			name: "Docs",
			slug: "docs",
			metadata: { contentConfig: { syncInterval } },
		},
	};
}

function source(overrides: Record<string, unknown> = {}) {
	return {
		id: "src-1",
		sourceType: "webpage",
		sourceUrl: "https://docs.example.com/guide",
		title: "Docs guide",
		lastIngestedAt: "2026-10-21T10:00:00.000Z",
		lastIngestStatus: "success",
		documentCount: 12,
		lastError: null,
		...overrides,
	};
}

function sources(...rows: Array<ReturnType<typeof source>>) {
	return { sources: rows };
}

const views: Array<() => Promise<void>> = [];

function mount() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = async () => {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<AppContentPage />
				</QueryClientProvider>,
			);
		});
	};
	views.push(async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	});
	return { client, host, render };
}

async function settles(assertion: () => void) {
	await vi.waitFor(async () => {
		await act(async () => {
			await Promise.resolve();
		});
		assertion();
	});
}

function alertWith(host: HTMLElement, text: string): HTMLElement {
	const alert = [
		...host.querySelectorAll<HTMLElement>('[data-slot="alert"]'),
	].find((candidate) => candidate.textContent?.includes(text));
	if (!alert) throw new Error(`alert containing "${text}" was not rendered`);
	return alert;
}

function buttonIn(scope: HTMLElement, label: string): HTMLButtonElement {
	const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	if (!button) throw new Error(`button "${label}" was not rendered`);
	return button;
}

function countBadge(host: HTMLElement): string {
	const heading = host.querySelector<HTMLElement>("#app-content-sources-title");
	if (!heading) throw new Error("section title was not rendered");
	const badge = heading.parentElement?.querySelector<HTMLElement>(
		'[data-slot="badge"]',
	);
	if (!badge) throw new Error("source count badge was not rendered");
	return badge.textContent?.trim() ?? "";
}

async function pollSources(client: QueryClient) {
	await act(async () => {
		await client.refetchQueries({
			queryKey: contentSourcesQueryOptions(APP_ID).queryKey,
		});
	});
}

function expectNoWrites() {
	for (const call of [
		api.update,
		api.ingestAll,
		api.ingestSource,
		api.addSource,
		api.removeSource,
	]) {
		expect(call).not.toHaveBeenCalled();
	}
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.resetAllMocks();
	mocks.canManage = true;
	api.getByIdWithTools.mockResolvedValue(appDetail());
	api.listSources.mockResolvedValue(sources(source()));
});

afterEach(async () => {
	while (views.length > 0) await views.pop()?.();
	vi.unstubAllGlobals();
});

describe("independent cold-read failures", () => {
	it("keeps loaded sources usable while content settings fail", async () => {
		api.getByIdWithTools.mockRejectedValue(new Error("settings offline"));
		const view = mount();
		await view.render();
		await settles(() =>
			expect(view.host.textContent).toContain(
				"Content settings could not be loaded",
			),
		);
		expect(view.host.textContent).toContain("Docs guide");
		expect(view.host.textContent).not.toContain(
			"Content sources are unavailable",
		);
		expect(countBadge(view.host)).toBe("1");
	});

	it("reports unavailable sources without claiming an empty inventory or touching settings", async () => {
		api.listSources.mockRejectedValue(new Error("sources offline"));
		const view = mount();
		await view.render();
		await settles(() =>
			expect(view.host.textContent).toContain(
				"Content sources are unavailable",
			),
		);
		expect(view.host.textContent).toContain("sources offline");
		expect(view.host.textContent).not.toContain("No content sources yet");
		expect(view.host.textContent).toContain("Manual only");
		expect(countBadge(view.host)).toBe("—");
	});
});

describe("read recovery", () => {
	it("recovers the settings read with Try again and never issues a write", async () => {
		api.getByIdWithTools
			.mockRejectedValueOnce(new Error("settings offline"))
			.mockResolvedValueOnce(appDetail("weekly"));
		const view = mount();
		await view.render();
		await settles(() =>
			expect(view.host.textContent).toContain(
				"Content settings could not be loaded",
			),
		);
		await act(async () =>
			buttonIn(
				alertWith(view.host, "Content settings could not be loaded"),
				"Try again",
			).click(),
		);
		await settles(() => expect(view.host.textContent).toContain("Weekly"));
		expect(view.host.textContent).not.toContain(
			"Content settings could not be loaded",
		);
		expect(api.getByIdWithTools).toHaveBeenCalledTimes(2);
		expectNoWrites();
	});

	it("recovers the sources read with Try again and never issues a write", async () => {
		api.listSources
			.mockRejectedValueOnce(new Error("sources offline"))
			.mockResolvedValueOnce(sources(source()));
		const view = mount();
		await view.render();
		await settles(() =>
			expect(view.host.textContent).toContain(
				"Content sources are unavailable",
			),
		);
		expect(view.host.textContent).not.toContain("No content sources yet");
		await act(async () =>
			buttonIn(
				alertWith(view.host, "Content sources are unavailable"),
				"Try again",
			).click(),
		);
		await settles(() => expect(view.host.textContent).toContain("Docs guide"));
		expect(view.host.textContent).not.toContain(
			"Content sources are unavailable",
		);
		expect(api.listSources).toHaveBeenCalledTimes(2);
		expectNoWrites();
	});
});

describe("refresh failures with a loaded inventory", () => {
	it("keeps loaded rows with an explicit stale status instead of claiming unavailability", async () => {
		const view = mount();
		await view.render();
		await settles(() => expect(view.host.textContent).toContain("Docs guide"));

		api.listSources.mockRejectedValueOnce(new Error("poll failed"));
		await pollSources(view.client);

		await settles(() =>
			expect(view.host.textContent).toContain("Content sources may be stale"),
		);
		expect(view.host.textContent).toContain("Docs guide");
		expect(view.host.textContent).toContain("last loaded inventory");
		expect(view.host.textContent).not.toContain(
			"Content sources are unavailable",
		);
		expect(view.host.textContent).not.toContain("No content sources yet");
		expect(countBadge(view.host)).toBe("1");
	});

	it("recovers the stale inventory with Try again", async () => {
		const view = mount();
		await view.render();
		await settles(() => expect(view.host.textContent).toContain("Docs guide"));

		api.listSources.mockRejectedValueOnce(new Error("poll failed"));
		await pollSources(view.client);
		await settles(() =>
			expect(view.host.textContent).toContain("Content sources may be stale"),
		);

		api.listSources.mockResolvedValueOnce(
			sources(source({ documentCount: 14 })),
		);
		await act(async () =>
			buttonIn(
				alertWith(view.host, "Content sources may be stale"),
				"Try again",
			).click(),
		);
		await settles(() =>
			expect(view.host.textContent).not.toContain(
				"Content sources may be stale",
			),
		);
		expect(view.host.textContent).toContain("14 sections");
		expectNoWrites();
	});
});

describe("successful empty inventory", () => {
	it("renders the empty state only after a successful read", async () => {
		api.listSources.mockResolvedValue(sources());
		const view = mount();
		await view.render();
		await settles(() =>
			expect(view.host.textContent).toContain("No content sources yet"),
		);
		expect(view.host.textContent).not.toContain(
			"Content sources are unavailable",
		);
		expect(view.host.textContent).not.toContain("Content sources may be stale");
		expect(countBadge(view.host)).toBe("0");
	});
});

describe("ingestion status notifications", () => {
	it("toasts once on a pending to success transition and stays quiet on unchanged polls", async () => {
		api.listSources.mockResolvedValue(
			sources(source({ lastIngestStatus: "pending", documentCount: null })),
		);
		const view = mount();
		await view.render();
		await settles(() => expect(view.host.textContent).toContain("Pending"));
		expect(toast.success).not.toHaveBeenCalled();

		api.listSources.mockResolvedValue(sources(source()));
		await pollSources(view.client);
		await settles(() => expect(toast.success).toHaveBeenCalledTimes(1));
		expect(toast.success).toHaveBeenCalledWith(
			expect.stringContaining("synced successfully"),
		);

		await pollSources(view.client);
		await settles(() => expect(view.host.textContent).toContain("Synced"));
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.error).not.toHaveBeenCalled();
		expectNoWrites();
	});
});
