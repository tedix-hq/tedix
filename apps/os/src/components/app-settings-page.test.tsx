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
	secretDelete: vi.fn(),
	delete: vi.fn(),
}));
const permissions = vi.hoisted(() => ({ manage: true }));
const route = vi.hoisted(() => ({
	appId: "11111111-1111-4111-8111-111111111111",
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		apps: { getByIdWithTools: api.get, update: api.update, delete: api.delete },
		appSecrets: { list: api.secrets, delete: api.secretDelete },
	},
}));
vi.mock("@tanstack/react-router", async (original) => ({
	...(await original<typeof import("@tanstack/react-router")>()),
	useParams: () => ({ appId: route.appId }),
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
import {
	appDetailQueryOptions,
	appSecretsListQueryOptions,
} from "@/lib/os-query-options";
import { AppSettingsPage } from "./app-settings-page";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_APP_ID = "22222222-2222-4222-8222-222222222222";
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
function retryButton(host: HTMLElement) {
	const button = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === "Try again",
	);
	if (!button) throw new Error("Missing Try again button");
	return button;
}
function secretRow(name: string) {
	return {
		id: `id-${name}`,
		name,
		hint: `${name} hint`,
		createdAt: "2026-10-21T10:00:00.000Z",
	};
}
function expectNoWrites() {
	expect(api.update).not.toHaveBeenCalled();
	expect(api.delete).not.toHaveBeenCalled();
	expect(api.secretDelete).not.toHaveBeenCalled();
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.resetAllMocks();
	permissions.manage = true;
	route.appId = APP_ID;
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
	it("deletes the app after the exact name confirmation", async () => {
		api.delete.mockResolvedValue({ deleted: true });
		const { host, client } = await mount();
		await settles(() => expect(input(host, "Name").value).toBe("Sample app"));
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const opener = [...host.querySelectorAll("button")].find((button) =>
			/Delete app/i.test(button.textContent ?? ""),
		)!;
		await act(async () => opener.click());
		expect(document.body.textContent).toContain("Delete Sample app?");
		expect(document.body.textContent).toContain("Type Sample app to confirm");
		const field = document.querySelector<HTMLInputElement>(
			'input[aria-labelledby*="confirmation"]',
		);
		expect(field).not.toBeNull();
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(field!, "Sample app");
			field!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const confirm = [...document.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Delete forever",
		)!;
		expect(confirm.disabled).toBe(false);
		await act(async () => confirm.click());
		await settles(() =>
			expect(api.delete).toHaveBeenCalledWith({ appId: APP_ID }),
		);
		expect(toast.success).toHaveBeenCalledWith("App deleted");
		expect(invalidate).toHaveBeenCalled();
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
	await act(async () => retryButton(host).click());
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

it("constrains an unbroken MCP server name inside its connection row", async () => {
	const serverName =
		"unbrokenmcpservernamethatcannotfitinsidenarrowphoneviewports0123456789";
	api.get.mockResolvedValue({
		app: {
			...detail.app,
			metadata: { mcpConfig: { serverName, authMode: "public" } },
		},
		tools: [],
	});
	const { host } = await mount();
	await settles(() => expect(host.textContent).toContain(serverName));
	const value = [...host.querySelectorAll("span")].find(
		(el) => el.textContent === serverName,
	);
	expect(value?.className).toContain("wrap-anywhere");
	expect(value?.className).toContain("min-w-0");
	const row = value?.parentElement;
	expect(row?.className).toContain("min-w-0");
	expect(row?.firstElementChild?.className).toContain("shrink-0");
});

describe("read recovery", () => {
	it("keeps the loaded settings usable when a refresh fails, then recovers in place", async () => {
		const { host, client } = await mount();
		await settles(() => expect(input(host, "Name").value).toBe("Sample app"));
		api.get.mockRejectedValueOnce(new Error("refresh offline"));
		await act(async () => {
			await client.invalidateQueries({
				queryKey: appDetailQueryOptions(APP_ID).queryKey,
			});
		});
		await settles(() =>
			expect(host.textContent).toContain("App settings could not be refreshed"),
		);
		expect(host.textContent).toContain("refresh offline");
		expect(host.textContent).toContain("last loaded");
		expect(host.querySelector("time")).not.toBeNull();
		expect(input(host, "Name").value).toBe("Sample app");
		expect(host.textContent).not.toContain("App settings are unavailable");
		await act(async () => retryButton(host).click());
		await settles(() =>
			expect(host.textContent).not.toContain(
				"App settings could not be refreshed",
			),
		);
		expect(api.get).toHaveBeenCalledTimes(3);
		expectNoWrites();
	});
	it("reports a cold secret read failure without claiming there are none, then recovers", async () => {
		api.secrets
			.mockRejectedValueOnce(new Error("secrets offline"))
			.mockResolvedValueOnce({ data: [secretRow("SAMPLE_TOKEN")] });
		const { host } = await mount();
		await settles(() =>
			expect(host.textContent).toContain("Secrets are unavailable"),
		);
		expect(host.textContent).toContain("secrets offline");
		expect(host.textContent).not.toContain(
			"No secrets configured for this app.",
		);
		expect(input(host, "Name").value).toBe("Sample app");
		const detailReads = api.get.mock.calls.length;
		await act(async () => retryButton(host).click());
		await settles(() => expect(host.textContent).toContain("SAMPLE_TOKEN"));
		expect(host.textContent).not.toContain("Secrets are unavailable");
		expect(api.secrets).toHaveBeenCalledTimes(2);
		expect(api.get.mock.calls.length).toBe(detailReads);
		expectNoWrites();
	});
	it("keeps cached secret rows on a failed refresh with a last-loaded qualifier, then recovers", async () => {
		api.secrets.mockResolvedValue({ data: [secretRow("SAMPLE_TOKEN")] });
		const { host, client } = await mount();
		await settles(() => expect(host.textContent).toContain("SAMPLE_TOKEN"));
		api.secrets.mockRejectedValueOnce(new Error("secrets offline"));
		await act(async () => {
			await client.invalidateQueries({
				queryKey: appSecretsListQueryOptions(APP_ID).queryKey,
			});
		});
		await settles(() =>
			expect(host.textContent).toContain("Secrets could not be refreshed"),
		);
		expect(host.textContent).toContain("secrets offline");
		expect(host.textContent).toContain("last loaded");
		expect(host.textContent).toContain("SAMPLE_TOKEN");
		expect(host.textContent).not.toContain("Secrets are unavailable");
		const detailReads = api.get.mock.calls.length;
		await act(async () => retryButton(host).click());
		await settles(() =>
			expect(host.textContent).not.toContain("Secrets could not be refreshed"),
		);
		expect(host.textContent).toContain("SAMPLE_TOKEN");
		expect(api.secrets).toHaveBeenCalledTimes(3);
		expect(api.get.mock.calls.length).toBe(detailReads);
		expectNoWrites();
	});
	it("does not repeat the empty-secrets claim while the last load is unconfirmed", async () => {
		const { host, client } = await mount();
		await settles(() =>
			expect(host.textContent).toContain("No secrets configured for this app."),
		);
		api.secrets.mockRejectedValueOnce(new Error("secrets offline"));
		await act(async () => {
			await client.invalidateQueries({
				queryKey: appSecretsListQueryOptions(APP_ID).queryKey,
			});
		});
		await settles(() =>
			expect(host.textContent).toContain("Secrets could not be refreshed"),
		);
		expect(host.textContent).toContain("not confirmed");
		expect(host.textContent).not.toContain(
			"No secrets configured for this app.",
		);
		await act(async () => retryButton(host).click());
		await settles(() =>
			expect(host.textContent).toContain("No secrets configured for this app."),
		);
		expectNoWrites();
	});
	it("scopes both reads to the routed app identity", async () => {
		route.appId = OTHER_APP_ID;
		api.get.mockResolvedValue({
			app: { ...detail.app, id: OTHER_APP_ID, name: "Second app" },
			tools: [],
		});
		const { host } = await mount();
		await settles(() => expect(input(host, "Name").value).toBe("Second app"));
		expect(api.get.mock.calls[0]?.[0]).toEqual({ appId: OTHER_APP_ID });
		expect(api.secrets.mock.calls[0]?.[0]).toEqual({ appId: OTHER_APP_ID });
		expectNoWrites();
	});
});
