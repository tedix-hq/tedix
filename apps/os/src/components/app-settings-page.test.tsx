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

const api = vi.hoisted(() => ({
	get: vi.fn(),
	update: vi.fn(),
	secrets: vi.fn(),
	delete: vi.fn(),
}));
const permissions = vi.hoisted(() => ({ manage: true }));
vi.mock("@/lib/api", () => ({
	osApi: {
		apps: { getByIdWithTools: api.get, update: api.update, delete: api.delete },
		appSecrets: { list: api.secrets },
	},
}));
vi.mock("@tanstack/react-router", async (original) => ({
	...(await original<typeof import("@tanstack/react-router")>()),
	useParams: () => ({ appId: APP_ID }),
	useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/app-permissions", async (original) => ({
	...(await original<typeof import("@/lib/app-permissions")>()),
	useCanManageApps: () => permissions.manage,
	useCanManageSecrets: () => false,
}));
vi.mock("@/components/app-gateway-membership", () => ({
	AppGatewayMembership: () => null,
}));
vi.mock("@/components/app-image-upload", () => ({
	AppImageUpload: () => null,
}));
vi.mock("@/components/app-mcp-oauth-settings", () => ({
	McpOAuthSettings: () => null,
}));
vi.mock("@/components/app-tedi-assignments", () => ({
	AppTediAssignments: () => null,
}));
vi.mock("@/components/app-detail", () => ({
	mcpEndpointUrl: () => "https://example.com/mcp",
}));
vi.mock("@/components/kumo/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));
import { toast } from "@/components/kumo/toast";
import { AppSettingsPage } from "./app-settings-page";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const detail = {
	app: {
		id: APP_ID,
		name: "Sample app",
		slug: "sample-app",
		description: "Sample description",
		primaryDomain: "https://example.com",
		visibility: "private",
		logoUrl: null,
		metadata: { contentConfig: { syncInterval: "weekly" } },
	},
	tools: [],
};
const cleanups: Array<() => Promise<void>> = [];
async function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanups.push(async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AppSettingsPage />
			</QueryClientProvider>,
		),
	);
	return { host, client };
}
async function settles(assertion: () => void) {
	await vi.waitFor(async () => {
		await act(async () => {
			await Promise.resolve();
		});
		assertion();
	});
}
function input(host: HTMLElement, name: string) {
	const label = [...host.querySelectorAll("label")].find((label) =>
		label.textContent?.toLowerCase().startsWith(name.toLowerCase()),
	);
	const field =
		label && host.querySelector<HTMLInputElement>(`#${label.htmlFor}`);
	if (!field) throw new Error(`Missing field ${name}`);
	return field;
}
async function changeName(host: HTMLElement) {
	await settles(() => expect(input(host, "Name").value).toBe("Sample app"));
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!.call(input(host, "Name"), "Updated app");
		input(host, "Name").dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function save(host: HTMLElement) {
	const button = [...host.querySelectorAll("button")].find((button) =>
		/Save changes/i.test(button.textContent ?? ""),
	);
	if (!button) throw new Error("Missing save button");
	return button;
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.resetAllMocks();
	permissions.manage = true;
	api.get.mockResolvedValue(detail);
	api.secrets.mockResolvedValue({ data: [] });
	api.update.mockResolvedValue({ success: true });
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.unstubAllGlobals();
});

describe("AppSettingsPage", () => {
	it("shows loading while the app read is pending, without an empty or editable form", async () => {
		api.get.mockReturnValue(new Promise(() => {}));
		const { host } = await mount();
		expect(
			host.querySelector('[aria-label="Loading app settings"]'),
		).not.toBeNull();
		expect(host.querySelector("form")).toBeNull();
		expect(api.update).not.toHaveBeenCalled();
	});
	it("loads every saved form value", async () => {
		const { host } = await mount();
		await settles(() =>
			expect(input(host, "Name").value).toBe(detail.app.name),
		);
		expect(input(host, "Slug").value).toBe(detail.app.slug);
		expect(host.querySelector("textarea")?.value).toBe(detail.app.description);
		expect(input(host, "Primary domain").value).toBe(detail.app.primaryDomain);
		expect(host.textContent).toContain("private");
		expect(api.update).not.toHaveBeenCalled();
	});
	it("saves edited details with the original slug, domain, description and visibility", async () => {
		const { host, client } = await mount();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		await changeName(host);
		await settles(() => expect(save(host).disabled).toBe(false));
		await act(async () => save(host).click());
		await settles(() =>
			expect(api.update).toHaveBeenCalledWith({
				appId: APP_ID,
				name: "Updated app",
				slug: "sample-app",
				description: "Sample description",
				primaryDomain: "https://example.com",
				visibility: "private",
			}),
		);
		expect(toast.success).toHaveBeenCalledWith("App updated");
		expect(invalidate).toHaveBeenCalled();
	});
	it("reports a failed save and keeps the edited values for retry", async () => {
		api.update.mockRejectedValue(new Error("Save unavailable"));
		const { host } = await mount();
		await changeName(host);
		await settles(() => expect(save(host).disabled).toBe(false));
		await act(async () => save(host).click());
		await settles(() =>
			expect(toast.error).toHaveBeenCalledWith("Save unavailable"),
		);
		expect(input(host, "Name").value).toBe("Updated app");
		expect(toast.success).not.toHaveBeenCalled();
	});
	it("reports a failed load without showing an editable form", async () => {
		api.get.mockRejectedValue(new Error("Read unavailable"));
		const { host } = await mount();
		await settles(() =>
			expect(host.textContent).toContain("App settings are unavailable"),
		);
		expect(host.textContent).toContain("Read unavailable");
		expect(host.querySelector("form")).toBeNull();
	});
	it("keeps app writes disabled without permission", async () => {
		permissions.manage = false;
		const { host } = await mount();
		await settles(() => expect(input(host, "Name").disabled).toBe(true));
		expect(save(host).disabled).toBe(true);
		expect(api.update).not.toHaveBeenCalled();
	});
	it("does not delete from the initial danger-zone action", async () => {
		const { host } = await mount();
		await settles(() => expect(input(host, "Name").value).toBe("Sample app"));
		const button = [...host.querySelectorAll("button")].find((button) =>
			/Delete app/i.test(button.textContent ?? ""),
		)!;
		await act(async () => button.click());
		expect(api.delete).not.toHaveBeenCalled();
		const confirmation = [...document.querySelectorAll("button")].find(
			(button) => /Delete forever/i.test(button.textContent ?? ""),
		);
		expect(confirmation).toBeDefined();
		await act(async () => confirmation!.click());
		expect(api.delete).not.toHaveBeenCalled();
	});
});

it("retries a failed settings read without writing app values", async () => {
	api.get
		.mockRejectedValueOnce(new Error("Read unavailable"))
		.mockResolvedValue(detail);
	const { host } = await mount();
	await settles(() =>
		expect(host.textContent).toContain("App settings are unavailable"),
	);
	const retry = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === "Try again",
	);
	expect(retry).toBeDefined();
	await act(async () => retry!.click());
	await settles(() => expect(input(host, "Name").value).toBe("Sample app"));
	expect(api.get).toHaveBeenCalledTimes(2);
	expect(api.update).not.toHaveBeenCalled();
});

it("renders secrets as a labeled table with the shared date display", async () => {
	api.secrets.mockResolvedValue({
		data: [
			{
				id: "secret-1",
				name: "SAMPLE_TOKEN",
				hint: "token ending 1234",
				createdAt: "2026-10-21T10:00:00.000Z",
			},
		],
	});
	const { host } = await mount();
	await settles(() =>
		expect(
			host.querySelector('table[aria-label="App secrets"]'),
		).not.toBeNull(),
	);
	expect(host.textContent).toContain("SAMPLE_TOKEN");
	expect(host.textContent).toContain("token ending 1234");
	const time = host.querySelector("time");
	expect(time?.dateTime).toBe("2026-10-21T10:00:00.000Z");
	expect(time?.title).toBeTruthy();
	expect(
		host.querySelector<HTMLButtonElement>(
			'[aria-label="Delete secret SAMPLE_TOKEN"]',
		)?.disabled,
	).toBe(true);
});
