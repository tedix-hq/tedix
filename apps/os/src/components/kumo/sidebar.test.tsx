import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
	Sidebar,
	SidebarContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarProvider,
	SidebarTrigger,
	useSidebar,
} from "./sidebar";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const COLLAPSED_KEY = "tedix-os-sidebar-collapsed";
const roots: Root[] = [];

// happy-dom under this runner exposes no localStorage; the adapter's persistence
// contract is the thing under test, so give it a real store to write to.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		clear: () => store.clear(),
		getItem: (key: string) => store.get(key) ?? null,
		removeItem: (key: string) => store.delete(key),
		setItem: (key: string, value: string) => store.set(key, value),
	},
});

function Dot({ className }: { className?: string }) {
	return <svg className={className} />;
}

function shell(children: React.ReactNode) {
	return renderToStaticMarkup(
		<SidebarProvider>
			<Sidebar>{children}</Sidebar>
		</SidebarProvider>,
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
	document.body.replaceChildren();
	localStorage.clear();
});

describe("SidebarProvider", () => {
	it("restores and persists the collapsed desktop rail under the shell key", () => {
		localStorage.setItem(COLLAPSED_KEY, "1");
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);

		act(() => {
			root.render(
				<SidebarProvider collapsedStorageKey={COLLAPSED_KEY}>
					<Sidebar>
						<SidebarHeader>
							<SidebarTrigger />
						</SidebarHeader>
					</Sidebar>
				</SidebarProvider>,
			);
		});

		const rail = container.querySelector('[data-sidebar="sidebar"]');
		expect(rail?.getAttribute("data-state")).toBe("collapsed");

		const trigger = container.querySelector<HTMLButtonElement>(
			'[data-sidebar="trigger"]',
		);
		act(() => trigger?.click());

		expect(rail?.getAttribute("data-state")).toBe("expanded");
		expect(localStorage.getItem(COLLAPSED_KEY)).toBe("0");

		act(() => trigger?.click());
		expect(localStorage.getItem(COLLAPSED_KEY)).toBe("1");
	});

	it("renders the rail as a mobile sheet, and keeps the sheet out of the persisted preference", () => {
		localStorage.setItem(COLLAPSED_KEY, "1");
		const restore = window.matchMedia;
		window.matchMedia = ((query: string) =>
			({
				matches: query.includes("max-width: 819px"),
				media: query,
				addEventListener: () => {},
				removeEventListener: () => {},
			}) as unknown as MediaQueryList) as typeof window.matchMedia;

		try {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			roots.push(root);
			act(() => {
				root.render(
					<SidebarProvider collapsedStorageKey={COLLAPSED_KEY}>
						<Sidebar>
							<SidebarHeader>
								<SidebarTrigger />
							</SidebarHeader>
						</Sidebar>
					</SidebarProvider>,
				);
			});

			// Kumo owns the drawer and its backdrop; the shell no longer hand-rolls
			// either, and the sheet starts closed regardless of the stored rail.
			const sheet = container.querySelector('[data-sidebar="sidebar"]');
			expect(sheet?.getAttribute("data-mobile")).toBe("true");
			expect(sheet?.getAttribute("data-state")).toBe("collapsed");
			expect(container.querySelector("[data-sidebar-backdrop]")).not.toBeNull();

			act(() =>
				container
					.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')
					?.click(),
			);

			expect(sheet?.getAttribute("data-state")).toBe("expanded");
			// Opening the drawer must NOT rewrite the operator's desktop rail.
			expect(localStorage.getItem(COLLAPSED_KEY)).toBe("1");
		} finally {
			window.matchMedia = restore;
		}
	});
});

describe("SidebarMenuButton", () => {
	it("marks the active row and renders child rows in a Kumo sub-menu", () => {
		const html = shell(
			<SidebarContent>
				<SidebarMenu>
					<SidebarMenuButton active href="/work" icon={Dot}>
						Work
					</SidebarMenuButton>
					<SidebarMenuSub>
						<SidebarMenuSubButton href="/outputs">Outputs</SidebarMenuSubButton>
					</SidebarMenuSub>
				</SidebarMenu>
			</SidebarContent>,
		);

		expect(html).toContain("data-active");
		expect(html).toContain('href="/work"');
		expect(html).toContain('data-sidebar="menu-sub"');
		expect(html).toContain('data-sidebar="menu-sub-button"');
		expect(html).toContain('href="/outputs"');
	});
});

describe("collapsed rail", () => {
	/*
	 * The regression this guards: Kumo publishes NO `display: none` for a nav
	 * label. The row is `icon (shrink-0) + gap + label (flex-1 min-w-0)`, and the
	 * collapsed rail is deliberately narrower than `icon + gap`, so the label is
	 * squeezed to zero width and `tooltip` carries the name. Giving the row
	 * `px-0` when collapsed hands that width back and the rail renders truncated
	 * labels ("W..", "C.."). Measured in a real browser at 56px: label width 0,
	 * icon centre exactly 28px.
	 */
	it("renders icon-only rows: no label box, and a tooltip carrying the name", () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		act(() => {
			root.render(
				<SidebarProvider defaultOpen={false}>
					<Sidebar>
						<SidebarContent>
							<SidebarMenu>
								<SidebarMenuButton href="/work" icon={Dot} tooltip="Work">
									Work
								</SidebarMenuButton>
							</SidebarMenu>
						</SidebarContent>
					</Sidebar>
				</SidebarProvider>,
			);
		});

		const rail = container.querySelector('[data-sidebar="sidebar"]');
		expect(rail?.getAttribute("data-state")).toBe("collapsed");
		expect(rail?.getAttribute("data-collapsible")).toBe("icon");
		// The collapsed rail must resolve to the OS token, not Kumo's 57px.
		expect((rail as HTMLElement).style.width).toBe("var(--sidebar-width-icon)");

		const row = container.querySelector<HTMLElement>(
			'[data-sidebar="menu-button"]',
		);
		// Kumo arms the tooltip only while collapsed.
		expect(row?.hasAttribute("data-trigger-disabled")).toBe(false);
		expect(
			container.querySelector("[data-base-ui-tooltip-trigger]"),
		).not.toBeNull();
	});

	it("keeps the tooltip disarmed while the rail is expanded", () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		act(() => {
			root.render(
				<SidebarProvider>
					<Sidebar>
						<SidebarContent>
							<SidebarMenu>
								<SidebarMenuButton href="/work" icon={Dot} tooltip="Work">
									Work
								</SidebarMenuButton>
							</SidebarMenu>
						</SidebarContent>
					</Sidebar>
				</SidebarProvider>,
			);
		});

		const row = container.querySelector<HTMLElement>(
			'[data-sidebar="menu-button"]',
		);
		expect(row?.hasAttribute("data-trigger-disabled")).toBe(true);
	});
});

describe("useSidebar", () => {
	it("reports the collapsed rail so call sites can swap dense variants", () => {
		function Probe() {
			return <span>{useSidebar().state}</span>;
		}
		const html = renderToStaticMarkup(
			<SidebarProvider defaultOpen={false}>
				<Sidebar>
					<Probe />
				</Sidebar>
			</SidebarProvider>,
		);

		expect(html).toContain("collapsed");
	});
});
