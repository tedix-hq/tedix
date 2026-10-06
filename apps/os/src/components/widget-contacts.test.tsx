import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
	EmbeddedContactCompany,
	EmbeddedContactUser,
} from "@tedix/api-contract/schemas/embedded-contact";
const calls = vi.hoisted(() => ({
	list: vi.fn(),
	detail: vi.fn(),
	history: vi.fn(),
	access: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		tedis: {
			listWidgetContacts: calls.list,
			getWidgetContact: calls.detail,
			listWidgetAccessConfigurations: calls.access,
		},
		analytics: { getEmbeddedProviderActivity: calls.history },
	},
}));
import { WidgetContacts } from "./widget-contacts";
import { WidgetAudiencePicker } from "./widget-audience-picker";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const company: EmbeddedContactCompany = {
	installationId: "11111111-1111-4111-8111-111111111111",
	externalTenantId: "367",
	name: "Initech",
	customAttributes: {
		city: "Monterrey",
		plan_name: "Business",
		plan_id: "42",
		active: true,
	},
	firstSeenAt: "2025-01-01T00:00:00Z",
	lastSeenAt: "2025-02-01T00:00:00Z",
};
const person: EmbeddedContactUser = {
	installationId: company.installationId,
	externalTenantId: company.externalTenantId,
	hostUserId: "1743",
	name: "Jordan Rivera",
	email: "jordan@example.com",
	role: "garage_owner",
	customAttributes: { language: "es", visits: 4, trial_user: false },
	firstSeenAt: "2025-01-01T00:00:00Z",
	lastSeenAt: "2025-02-01T00:00:00Z",
};
const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});
beforeEach(() => {
	vi.clearAllMocks();
	calls.access.mockResolvedValue({ data: [] });
	calls.history.mockRejectedValue(new Error("History unavailable"));
	calls.detail.mockResolvedValue({ company, user: person });
});
async function render(element: React.ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
		client.clear();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>{element}</QueryClientProvider>,
		);
	});
	return container;
}
async function click(text: string) {
	const button = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent === text,
	);
	expect(button, text).toBeDefined();
	await act(async () => button!.click());
}
async function type(input: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

it("searches the server and opens an old contact with separate fields despite unavailable history", async () => {
	calls.list.mockImplementation(
		async ({ search, kind }: { search?: string; kind: string }) => ({
			people:
				kind === "people" && search === "jordan@example.com" ? [person] : [],
			companies: [company],
			total: 1,
			nextOffset: null,
		}),
	);
	const audience = vi.fn();
	const container = await render(<WidgetContacts onAudience={audience} />);
	await type(
		container.querySelector('input[aria-label="Search customers"]')!,
		"jordan@example.com",
	);
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Jordan Rivera"),
	);
	expect(calls.list).toHaveBeenCalledWith(
		expect.objectContaining({
			search: "jordan@example.com",
			kind: "people",
			offset: 0,
		}),
		expect.anything(),
	);
	await click("Jordan Rivera");
	await vi.waitFor(() =>
		expect(document.body.textContent).toContain("Activity is unavailable"),
	);
	expect(calls.detail).toHaveBeenCalledWith(
		{ installationId: company.installationId, hostUserId: "1743" },
		expect.anything(),
	);
	const profile = document.querySelector('[aria-label="Profile details"]')!;
	expect(profile.textContent).toContain("Name: Jordan Rivera");
	expect(profile.textContent).toContain("Email: jordan@example.com");
	expect(profile.textContent).toContain("User ID: 1743");
	expect(profile.textContent).toContain("Role: Garage owner");
	expect(profile.textContent).toContain("Company ID: 367");
	expect(profile.textContent).toContain("Language: es");
	expect(profile.textContent).toContain("Trial user: No");
	await click("Manage audience");
	expect(audience).toHaveBeenCalledWith(company.installationId);
});

it("paginates canonical companies and filters people by the selected company", async () => {
	calls.list.mockImplementation(
		async ({ kind, offset }: { kind: string; offset: number }) => ({
			people: [],
			companies: kind === "companies" && offset === 50 ? [company] : [],
			total: 51,
			nextOffset: offset === 0 ? 50 : null,
		}),
	);
	calls.detail.mockResolvedValue({ company, user: null });
	await render(<WidgetContacts onAudience={vi.fn()} />);
	await click("Companies");
	await vi.waitFor(() =>
		expect(calls.list).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "companies" }),
			expect.anything(),
		),
	);
	// The request starts before React Query publishes its result. Wait for the
	// loaded company page, not just the mock invocation, before paginating.
	await vi.waitFor(() =>
		expect(
			document.querySelector('[aria-label="Customer pages"]')?.textContent,
		).toContain("51 companies"),
	);
	await click("Next");
	await vi.waitFor(() =>
		expect(document.body.textContent).toContain("Initech"),
	);
	expect(calls.list).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "companies", offset: 50 }),
		expect.anything(),
	);
	await click("Initech");
	await vi.waitFor(() =>
		expect(document.body.textContent).toContain("City: Monterrey"),
	);
	expect(document.body.textContent).toContain("Plan name: Business");
	expect(document.body.textContent).toContain("Plan ID: 42");
	expect(document.body.textContent).toContain("Active: Yes");
	await click("View people");
	expect(document.body.textContent).toContain(
		"Company: Initech · Company ID 367",
	);
	await vi.waitFor(() =>
		expect(calls.list).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "people",
				installationId: company.installationId,
				offset: 0,
			}),
			expect.anything(),
		),
	);
});

it("hydrates off-page audience selections and scopes remote name search to the installation", async () => {
	calls.list.mockImplementation(
		async ({ hostUserIds }: { hostUserIds?: string[] }) => ({
			people: hostUserIds ? [person] : [],
			companies: [company],
			total: hostUserIds ? 1 : 0,
			nextOffset: null,
		}),
	);
	const changed = vi.fn();
	const container = await render(
		<WidgetAudiencePicker
			label="Included people"
			installationId={company.installationId}
			selected={["1743", "not-known"]}
			onChange={changed}
		/>,
	);
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Jordan Rivera"),
	);
	expect(container.textContent).toContain("jordan@example.com");
	expect(container.textContent).toContain("User not-known");
	await type(container.querySelector("input")!, "another person");
	await vi.waitFor(() =>
		expect(calls.list).toHaveBeenCalledWith(
			expect.objectContaining({
				installationId: company.installationId,
				search: "another person",
			}),
			expect.anything(),
		),
	);
	expect(container.textContent).toContain("Jordan Rivera");
	expect(changed).not.toHaveBeenCalled();
});

it("keeps identical host user IDs in different companies as distinct profiles", async () => {
	const otherCompany = {
		...company,
		installationId: "22222222-2222-4222-8222-222222222222",
		externalTenantId: "999",
		name: "Globex",
	};
	const otherPerson = {
		...person,
		installationId: otherCompany.installationId,
		externalTenantId: otherCompany.externalTenantId,
		name: "Another Jordan",
	};
	calls.list.mockResolvedValue({
		people: [person, otherPerson],
		companies: [company, otherCompany],
		total: 2,
		nextOffset: null,
	});
	calls.detail.mockImplementation(
		async ({ installationId }: { installationId: string }) =>
			installationId === otherCompany.installationId
				? { company: otherCompany, user: otherPerson }
				: { company, user: person },
	);
	await render(<WidgetContacts onAudience={vi.fn()} />);
	await vi.waitFor(() =>
		expect(document.body.textContent).toContain("Another Jordan"),
	);
	await click("Another Jordan");
	await vi.waitFor(() =>
		expect(
			document.querySelector('[aria-label="Profile details"]')?.textContent,
		).toContain("Company ID: 999"),
	);
	expect(calls.detail).toHaveBeenCalledWith(
		{ installationId: otherCompany.installationId, hostUserId: "1743" },
		expect.anything(),
	);
});

it("keeps audience IDs when saved-name lookup fails", async () => {
	calls.list.mockImplementation(
		async ({ hostUserIds }: { hostUserIds?: string[] }) => {
			if (hostUserIds) throw new Error("Directory lookup unavailable");
			return { people: [], companies: [], total: 0, nextOffset: null };
		},
	);
	const changed = vi.fn();
	const container = await render(
		<WidgetAudiencePicker
			label="Excluded people"
			installationId={company.installationId}
			selected={["1743"]}
			onChange={changed}
		/>,
	);
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Some names are unavailable"),
	);
	expect(container.textContent).toContain("User 1743");
	expect(changed).not.toHaveBeenCalled();
});
