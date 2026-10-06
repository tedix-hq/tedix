import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const route = vi.hoisted(() => ({ pathname: "/work" }));

const api = vi.hoisted(() => ({
	workspaces: { list: vi.fn() },
	workspacePreferences: { list: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ osApi: { osWorkspaces: api } }));
vi.mock("@descope/react-sdk/flows", () => ({
	getCurrentTenant: () => "acme",
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Outlet: () => <div>Route content</div>,
	useNavigate: () => vi.fn(),
	useRouterState: () => route.pathname,
}));
vi.mock("@/components/os-command-palette", () => ({
	OsCommandPalette: () => null,
}));
vi.mock("@/components/approval-notifications", () => ({
	ApprovalNotifications: () => null,
}));
vi.mock("@/components/os-workspace-switcher", () => ({
	OsWorkspaceSwitcher: ({ children }: { children?: ReactNode }) => (
		<button
			aria-label="Switch workspace or app"
			className="ghost-icon-button"
			type="button"
		>
			{children}
		</button>
	),
}));
vi.mock("@/components/transport-status", () => ({
	TransportStatus: () => <span className="transport-status">Live</span>,
}));
vi.mock("@/lib/use-os-identity", () => ({
	useOsIdentity: () => ({ name: "Ada Lovelace" }),
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsDurableTheme: () => undefined,
	useOsOrganizationTheme: () => undefined,
	useOsOperationalContext: () => ({ data: { authority: { permissions: [] } } }),
}));
vi.mock("@/lib/os-query-options", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/os-query-options")>()),
	billingOverviewQueryOptions: () => ({
		queryKey: ["billing-overview"],
		queryFn: () => Promise.resolve(null),
	}),
}));

import { OsShell } from "./os-shell";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const styles = readFileSync("src/styles.css", "utf8");

function renderShell(): HTMLElement {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	act(() => {
		root.render(
			(
				<QueryClientProvider client={queryClient}>
					<OsShell />
				</QueryClientProvider>
			) as ReactNode,
		);
	});
	return container;
}

function rail(container: HTMLElement) {
	const element = container.querySelector<HTMLElement>(
		'[data-sidebar="sidebar"]',
	);
	if (!element) throw new Error("shell rendered no sidebar rail");
	return element;
}

beforeEach(() => {
	vi.clearAllMocks();
	route.pathname = "/work";
	api.workspaces.list.mockResolvedValue({ items: [], truncated: false });
	api.workspacePreferences.list.mockResolvedValue({ items: [] });
});

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
	document.body.replaceChildren();
});

describe("OS shell chrome", () => {
	it("places the workspace switcher with the organization and keeps settings in the footer", () => {
		const container = renderShell();
		const header = container.querySelector('[data-sidebar="header"]')!;
		const footer = container.querySelector('[data-sidebar="footer"]')!;
		const trigger = footer.querySelector<HTMLButtonElement>(
			'[aria-label="Collapse sidebar"]',
		)!;
		expect(trigger).not.toBeNull();
		const switcher = header.querySelector(
			'[aria-label="Switch workspace or app"]',
		)!;
		expect(switcher.querySelector("strong")?.textContent?.trim()).toBe("OS");
		expect(switcher.textContent).toContain("Local workspace");
		expect(header.querySelector(".brand-mark")?.className).not.toContain(
			"hidden",
		);
		expect(
			footer.querySelector('[aria-label="Switch workspace or app"]'),
		).toBeNull();
		expect(footer.querySelector('[aria-label^="Theme:"]')).toBeNull();
		expect(container.querySelector('[aria-label="Search"]')).toBeNull();
		act(() => trigger.click());
		expect(rail(container).dataset.state).toBe("collapsed");
		expect(trigger.getAttribute("aria-label")).toBe("Expand sidebar");
		expect(container.querySelector('[aria-label="Search"]')).not.toBeNull();
		for (
			let element: Element | null = switcher;
			element && element !== header;
			element = element.parentElement
		) {
			expect(element.className).not.toContain("sidebar:hidden");
		}
		for (const label of [
			"Organization settings",
			"Personal settings",
			"User profile",
		]) {
			expect(footer.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
		}
		expect(
			footer
				.querySelector<HTMLAnchorElement>('[aria-label="User profile"]')
				?.href.endsWith("/account/profile"),
		).toBe(true);
		act(() => trigger.click());
		expect(rail(container).dataset.state).toBe("expanded");
		expect(trigger.getAttribute("aria-label")).toBe("Collapse sidebar");
	});

	it("exposes all destinations directly and keeps primary links outside the scrolling region", () => {
		const container = renderShell();
		const primary = container.querySelector('[aria-label="Primary"]')!;
		expect(
			[...primary.querySelectorAll("a")].map((a) => a.textContent),
		).toEqual(["Work", "Chat", "Workspaces", "Outputs", "Install Tedix"]);
		expect(primary.closest('[data-sidebar="content"]')).toBeNull();
		for (const label of [
			"Team",
			"Skills",
			"MCP Gateway",
			"Brain",
			"Blueprints",
			"Widget",
			"Audit",
			"Usage & budgets",
		]) {
			expect(
				[...rail(container).querySelectorAll("a")].filter(
					(a) => a.textContent === label,
				),
			).toHaveLength(1);
		}
	});

	it("keeps the mobile drawer open until route navigation and then dismisses it", () => {
		const original = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: query.includes("max-width: 819px"),
			media: query,
			onchange: null,
			addListener() {},
			removeListener() {},
			dispatchEvent: () => true,
			addEventListener() {},
			removeEventListener() {},
		})) as typeof window.matchMedia;
		try {
			const container = renderShell();
			const trigger = container.querySelector<HTMLButtonElement>(
				'[aria-label="Toggle navigation"]',
			)!;
			act(() => trigger.click());
			expect(rail(container).dataset.state).toBe("expanded");
			route.pathname = "/apps";
			act(() =>
				roots.at(-1)!.render(
					<QueryClientProvider
						client={
							new QueryClient({ defaultOptions: { queries: { retry: false } } })
						}
					>
						<OsShell />
					</QueryClientProvider>,
				),
			);
			expect(rail(container).dataset.state).toBe("collapsed");
		} finally {
			window.matchMedia = original;
		}
	});

	it("keeps persistent shell identity and default cards flat", () => {
		const brandMark = styles.match(/(?:^|\n)\.brand-mark \{[\s\S]*?\n\}/)?.[0];

		expect(brandMark).toBeDefined();
		expect(brandMark).not.toContain("box-shadow");
		expect(brandMark).not.toContain("transition:");
		expect(styles).not.toMatch(
			/\[data-slot=["']card["']\]\s*\{[^}]*box-shadow/,
		);
		expect(styles).toContain("box-shadow: var(--shadow-tedix-floating)");
		expect(styles).toContain("box-shadow: var(--shadow-tedix-overlay)");
	});

	it("keeps ordinary identity and library hover feedback quiet", () => {
		const galleryCard = styles.match(
			/(?:^|\n)\.blueprint-gallery-card \{[\s\S]*?\n\}/,
		)?.[0];
		const galleryInteraction = styles.match(
			/\.blueprint-gallery-card:hover,[\s\S]*?\n\}/,
		)?.[0];

		expect(styles).not.toContain(".sidebar-brand:hover .brand-mark");
		expect(styles).not.toMatch(/\[data-slot=["']card["']\]:has\(/);
		expect(galleryCard).toContain("transition: border-color");
		expect(galleryCard).not.toContain("box-shadow");
		expect(galleryCard).not.toContain("transform");
		expect(galleryInteraction).toContain("border-color");
		expect(galleryInteraction).not.toContain("box-shadow");
		expect(galleryInteraction).not.toContain("transform");
		expect(styles).toContain(".blueprint-gallery-preview-window {");
		expect(styles).toContain("box-shadow: var(--shadow-tedix-overlay)");
	});

	/*
	 * The rail's geometry used to be ~480 lines of BEM CSS in `styles.css`, so
	 * this suite asserted on the stylesheet's raw text. Kumo's `Sidebar` owns it
	 * now, which means the contract has to be read off the RENDERED shell.
	 */
	it("composes the rail from the Kumo sidebar rather than hand-rolled BEM", () => {
		const container = renderShell();
		const railElement = rail(container);

		expect(railElement.dataset.state).toBe("expanded");
		expect(railElement.dataset.collapsible).toBe("icon");
		expect(container.querySelector('[data-sidebar="header"]')).not.toBeNull();
		expect(container.querySelector('[data-sidebar="content"]')).not.toBeNull();
		expect(container.querySelector('[data-sidebar="footer"]')).not.toBeNull();
		expect(
			container.querySelectorAll('[data-sidebar="menu-button"]').length,
		).toBeGreaterThan(0);

		// The classes Kumo replaced must not come back as shell CSS or markup.
		for (const dead of [
			".os-sidebar",
			".sidebar-nav",
			".sidebar-primary",
			".sidebar-subnav",
			".sidebar-scrim",
			".sidebar-spacer",
			".nav-item",
			".nav-parent",
			".user-chip",
		]) {
			expect(styles, `${dead} survived in styles.css`).not.toContain(
				`\n${dead} `,
			);
			expect(
				container.querySelector(dead),
				`${dead} survived in the shell markup`,
			).toBeNull();
		}
	});

	it("keeps the Console rail geometry through the migration", () => {
		const container = renderShell();
		const wrapper = container.querySelector<HTMLElement>(
			"[data-sidebar-wrapper]",
		);

		expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("260px");
		expect(wrapper?.style.getPropertyValue("--sidebar-width-icon")).toBe(
			"56px",
		);

		const row = container.querySelector<HTMLElement>(
			'[data-sidebar="menu-button"]',
		);
		// 34px rows, 8px radius, 0 12px padding, 13px/500 type.
		expect(row?.className).toContain("min-h-8.5");
		expect(row?.className).toContain("rounded-lg");
		expect(row?.className).toContain("px-3");
		expect(row?.className).toContain("type-tedix-control");
		expect(row?.className).toContain("font-medium");
		// 10px icon gap.
		expect(row?.className).toContain("[&>div]:gap-2.5");
		// Console paints the selected row with the solid control step.
		expect(row?.className).toContain(
			"data-[active]:[--sidebar-active-bg:var(--color-kumo-control)]",
		);
	});

	it("uses semantic shell typography without raw pixel sizes or tracking drift", () => {
		const container = renderShell();
		const railMarkup = rail(container).outerHTML;

		expect(railMarkup).toMatch(/type-tedix-(caption|label|control|body)/);
		expect(railMarkup).not.toMatch(/text-\[\d+px\]/);
		expect(railMarkup).not.toMatch(/tracking-/);

		// Surviving shell CSS keeps the same semantic contract.
		const ruleFor = (selector: string) =>
			styles.match(
				new RegExp(
					`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\}`,
				),
			)?.[1];

		for (const selector of [
			".brand-mark",
			".topbar-context",
			".topbar-search",
			".topbar-search kbd",
			".governed-status",
			".transport-status",
		]) {
			const rule = ruleFor(selector);
			expect(rule, `missing ${selector}`).toBeDefined();
			expect(rule).toMatch(
				/font-size:\s*var\(--text-tedix-(caption|label|control|body)\)/,
			);
			expect(rule).toMatch(
				/line-height:\s*var\(--text-tedix-(caption|label|control|body)--line-height\)/,
			);
			expect(rule).not.toMatch(/letter-spacing:/);
			expect(rule).not.toMatch(/font-size:\s*\d+px/);
		}
	});

	/*
	 * Shared controls carry both halves of the touch contract: `max-sm:` makes
	 * the documented 390px product viewport deterministic under fine-pointer
	 * browser emulation, while `coarse:` still protects tablets and touch laptops
	 * above that breakpoint. The one plain CSS affordance left
	 * (`.ghost-icon-button`, shared with the workspace switcher) retains its
	 * capability floor independently of the mobile shell layout.
	 */
	it("keeps navigation targets touch-friendly by viewport and pointer", () => {
		const container = renderShell();
		const railMarkup = rail(container).outerHTML;

		expect(railMarkup).toContain("max-sm:min-h-11");
		expect(railMarkup).toMatch(/max-sm:min-w-11/);
		expect(railMarkup).toContain("max-sm:size-11");
		expect(railMarkup).toContain("coarse:min-h-11");
		expect(railMarkup).toMatch(/coarse:min-w-11/);

		const coarsePointer = styles.match(
			/@media \(pointer: coarse\) \{[\s\S]*?\n\}\n/,
		)?.[0];
		const mobileShell = [
			...styles.matchAll(/@media \(max-width: 639px\) \{[\s\S]*?\n\}/g),
		].find(([rule]) => rule.includes(".ghost-icon-button"))?.[0];

		expect(coarsePointer).toContain(".ghost-icon-button");
		expect(coarsePointer).toContain("min-height: 44px");
		expect(coarsePointer).toContain("min-width: 44px");
		expect(mobileShell).toBeDefined();
		expect(mobileShell).toContain(".ghost-icon-button");
		expect(mobileShell).toContain("min-height: 44px");
		expect(mobileShell).toContain("min-width: 44px");
		expect(styles).toContain(
			"@custom-variant coarse (@media (pointer: coarse))",
		);
	});
});
