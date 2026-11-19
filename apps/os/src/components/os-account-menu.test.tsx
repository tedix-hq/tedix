import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { SidebarProvider } from "@/components/kumo/sidebar";
import { OS_LOGOUT_PATH } from "@/shared/session-status";

const viewer = vi.hoisted(() => ({
	permissions: [] as string[],
	local: false,
}));
const billing = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: { authority: { role: "member", permissions: viewer.permissions } },
	}),
}));
vi.mock("@/components/kumo/link-provider", () => ({
	OsRouterLink: ({ to, ...props }: { to: string }) => (
		<a href={to} {...props} />
	),
}));
vi.mock("@/lib/local-inference", () => ({
	isLocalSession: () => viewer.local,
}));
vi.mock("@/lib/os-query-options", () => ({
	billingOverviewQueryOptions: () => ({
		queryKey: ["billing-overview"],
		queryFn: billing.query,
	}),
}));

import { OsAccountMenu } from "./os-account-menu";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let client: QueryClient;

async function openMenu() {
	const container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root = createRoot(container);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<SidebarProvider>
					<OsAccountMenu
						identity={{ name: "Ada Lovelace", email: "ada@example.invalid" }}
					/>
				</SidebarProvider>
			</QueryClientProvider>,
		);
	});
	const trigger = container.querySelector<HTMLButtonElement>(
		'[aria-label="Account menu"]',
	)!;
	expect(document.querySelector('[role="menu"]')).toBeNull();
	await act(async () => trigger.click());
	return document.querySelector<HTMLElement>('[role="menu"]')!;
}

beforeEach(() => {
	viewer.permissions = [];
	viewer.local = false;
	billing.query.mockReset().mockResolvedValue({
		credits: {
			includedCredits: 100,
			usedCredits: 70,
			remainingIncludedCredits: 30,
			topUpCredits: 20,
			payAsYouGo: { enabled: false, monthlyCapMicros: null, spentMicros: 0 },
		},
	});
});
afterEach(() => {
	act(() => root?.unmount());
	client?.clear();
	document.body.replaceChildren();
});

describe("sidebar account menu", () => {
	it("uses a sidebar row without a hover icon and keeps collapse outside its trigger", async () => {
		await openMenu();
		const trigger = document.querySelector<HTMLButtonElement>(
			'[aria-label="Account menu"]',
		)!;
		expect(trigger.dataset.sidebar).toBe("menu-button");
		expect(trigger.textContent).toBe("AAda Lovelace");
		expect(trigger.querySelector("svg")).toBeNull();
		expect(trigger.querySelector('[data-slot="avatar"]')).not.toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const collapse = document.querySelector<HTMLButtonElement>(
			'[aria-label="Collapse sidebar"]',
		)!;
		expect(trigger.contains(collapse)).toBe(false);
		expect(collapse.closest('[data-sidebar="menu-item"]')).toBe(
			trigger.closest('[data-sidebar="menu-item"]'),
		);
		await act(async () =>
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
		);
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		await act(async () => collapse.click());
		expect(collapse.getAttribute("aria-label")).toBe("Expand sidebar");
		await act(async () => trigger.click());
		expect(document.querySelector('[role="menu"]')).not.toBeNull();
	});

	it("opens on click with account destinations and no owner billing for members", async () => {
		const menu = await openMenu();
		expect(menu).not.toBeNull();
		expect(menu.textContent).toContain("Ada Lovelace");
		expect(menu.textContent).toContain("ada@example.invalid");
		expect(
			[...menu.querySelectorAll('[role="menuitem"]')].map((item) => [
				item.textContent,
				item.getAttribute("href"),
			]),
		).toEqual([
			["Usage", "/compute"],
			["Personal settings", "/account/settings"],
			["Install apps", "/install"],
			["Sign out", OS_LOGOUT_PATH],
		]);
		expect(billing.query).not.toHaveBeenCalled();
	});

	it("shows Settings only with organization settings access", async () => {
		viewer.permissions = ["settings:manage"];
		const menu = await openMenu();
		expect(menu.querySelector('[href="/admin"]')?.textContent).toBe("Settings");
		expect(menu.querySelector('[href="/admin/billing"]')).toBeNull();
	});

	it("closes when a navigation item is selected", async () => {
		const menu = await openMenu();
		const usage = menu.querySelector<HTMLAnchorElement>('[href="/compute"]')!;
		usage.addEventListener("click", (event) => event.preventDefault());
		await act(async () => usage.click());
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});

	it("shows Billing and the share of this month's credits used to billing managers", async () => {
		viewer.permissions = ["billing:manage"];
		const menu = await openMenu();
		expect(menu.querySelector('[href="/admin/billing"]')?.textContent).toBe(
			"Billing",
		);
		const usage = menu.querySelector('[href="/compute"]')!;
		// 70 of 100 included plus 20 top-up credits, rounded down.
		expect(usage.textContent).toMatch(/^Usage58% used this month/);
		expect(usage.textContent).not.toContain("credits");
		expect(
			usage.querySelector('[role="meter"]')?.getAttribute("aria-valuenow"),
		).toBe("58");
		expect(billing.query).toHaveBeenCalledOnce();
	});

	it("hides billing and skips its query in local sessions even for an owner", async () => {
		viewer.permissions = ["billing:manage"];
		viewer.local = true;
		const menu = await openMenu();
		expect(menu.querySelector('[href="/admin/billing"]')).toBeNull();
		expect(menu.querySelector('[href="/compute"]')?.textContent).toBe("Usage");
		expect(billing.query).not.toHaveBeenCalled();
	});
});
