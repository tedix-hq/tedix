import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DecisionContextRail } from "./decision-context-rail";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const route = vi.hoisted(() => ({ pathname: "/work", context: false }));

const api = vi.hoisted(() => ({
	workspaces: { list: vi.fn() },
	workspacePreferences: { list: vi.fn(), setFavorite: vi.fn() },
}));
const unreadSummary = vi.hoisted(() => ({
	read: vi.fn(async () => ({
		total: 0,
		workspaces: [] as { workspaceId: string; total: number }[],
	})),
}));

vi.mock("@/components/work-actor-directory", () => ({
	WorkActorDirectory: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		directory: { listMyWorkspaces: vi.fn() },
		osWorkspaces: api,
		// Sidebar workspace rows read what is new and whether a workspace is muted.
		workspaceUnread: {
			summary: () => unreadSummary.read(),
			markRead: vi.fn(),
		},
		webPush: {
			getStatus: vi.fn(async () => ({
				enabled: false,
				publicKey: null,
				preferences: { mutedProjectIds: [], mutedWorkspaceIds: [] },
			})),
			setPreferences: vi.fn(),
		},
		userProfile: {
			getMine: vi.fn(async () => ({ id: "fictional-shell-person" })),
		},
	},
}));
vi.mock("@descope/react-sdk/flows", () => ({
	getCurrentTenant: () => "acme",
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Outlet: () =>
		route.context ? (
			<DecisionContextRail>
				<p>Route content</p>
			</DecisionContextRail>
		) : (
			<div>Route content</div>
		),
	useNavigate: () => vi.fn(),
	useRouterState: () => route.pathname,
}));
vi.mock("@/components/kumo/link-provider", () => ({
	OsRouterLink: ({ to, ...props }: { to: string }) => (
		<a href={to} {...props} />
	),
}));
vi.mock("@/components/os-command-palette", () => ({
	OsCommandPalette: () => null,
}));
vi.mock("@/components/get-started", () => ({
	GetStartedEntry: () => null,
}));
vi.mock("@/components/approval-notifications", () => ({
	ApprovalNotifications: () => null,
}));
vi.mock("@/components/workspace-toasts", () => ({
	WorkspaceToasts: () => null,
}));
vi.mock("@/components/os-workspace-switcher", () => ({
	OsWorkspaceSwitcher: ({ children }: { children?: ReactNode }) => (
		<button
			aria-label="Switch organization"
			className="ghost-icon-button"
			type="button"
		>
			{children}
		</button>
	),
}));
vi.mock("@/components/work-needs-you-count", () => ({
	WorkNeedsYouCount: () => null,
}));
vi.mock("@/lib/shared-deck-inbox", () => ({
	SharedDeckInboxProvider: ({ children }: { children: React.ReactNode }) =>
		children,
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
import { userProfileQueryOptions } from "@/lib/os-query-options";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function renderShell(): HTMLElement {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(userProfileQueryOptions().queryKey, {
		welcomeCompleted: true,
		id: "fictional-shell-person",
		email: "person@example.com",
		name: "Fictional person",
		avatarUrl: null,
		revision: 1,
		updatedAt: null,
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
	route.context = false;
	api.workspaces.list.mockResolvedValue({ items: [], truncated: false });
	api.workspacePreferences.list.mockResolvedValue({ items: [] });
	unreadSummary.read.mockResolvedValue({ total: 0, workspaces: [] });
});

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
	document.body.replaceChildren();
});

describe("OS shell chrome", () => {
	it("mounts starred workspace shortcuts outside the workspace library", async () => {
		api.workspaces.list.mockResolvedValue({
			items: [{ id: "starred-workspace", name: "Shared planning" }],
			truncated: false,
		});
		api.workspacePreferences.list.mockResolvedValue({
			items: [{ workspaceId: "starred-workspace", favorite: true }],
		});
		const container = renderShell();
		await act(async () => {
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(
			rail(container).querySelector('[aria-label="Pinned workspaces"]')
				?.textContent,
		).toContain("Shared planning");
	});

	it("links to the Inbox from the sidebar and counts what is new", async () => {
		unreadSummary.read.mockResolvedValue({
			total: 7,
			workspaces: [{ workspaceId: "starred-workspace", total: 7 }],
		});
		const container = renderShell();
		const item = () =>
			rail(container).querySelector<HTMLAnchorElement>(
				'[aria-label="Primary"] a[href="/inbox"]',
			)!;
		expect(item().textContent).toBe("Inbox");
		expect(item().hasAttribute("data-active")).toBe(false);
		await act(async () => {
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(item().textContent).toBe("Inbox7");
		expect(item().querySelector('[aria-label="7 unread"]')).not.toBeNull();
	});

	it("shows no count on Inbox when everything is read and marks it current on its page", async () => {
		route.pathname = "/inbox";
		const container = renderShell();
		await act(async () => {
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const item = rail(container).querySelector<HTMLAnchorElement>(
			'[aria-label="Primary"] a[href="/inbox"]',
		)!;
		expect(item.textContent).toBe("Inbox");
		expect(item.hasAttribute("data-active")).toBe(true);
	});

	it("lets keyboard users bypass the shell navigation", () => {
		const container = renderShell();
		const skipLink = container.querySelector<HTMLAnchorElement>(
			'a[href="#os-main-content"]',
		)!;
		const main = container.querySelector<HTMLElement>("#os-main-content")!;

		expect(skipLink.textContent).toBe("Skip to main content");
		expect(main.tabIndex).toBe(-1);
		act(() => skipLink.click());
		expect(document.activeElement).toBe(main);
	});

	it("opens route context from the shell topbar and removes the entry on navigation", async () => {
		route.context = true;
		const container = renderShell();
		const trigger = container.querySelector<HTMLButtonElement>(
			'header.topbar [aria-label="Decision context"]',
		)!;
		expect(trigger).not.toBeNull();
		expect(
			container.querySelector('main [aria-label="Decision context"]'),
		).toBeNull();
		await act(async () => trigger.click());
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
			"Decision context",
		);
		expect(container.querySelector("aside.fd-context-rail")).toBeNull();
		await act(async () =>
			document
				.querySelector<HTMLButtonElement>(
					'[aria-label="Close decision context"]',
				)!
				.click(),
		);
		route.context = false;
		route.pathname = "/team";
		await act(async () =>
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
		expect(
			container.querySelector('header [aria-label="Decision context"]'),
		).toBeNull();
	});
	it("toggles the rail with Cmd/Ctrl+B while leaving editor shortcuts alone", () => {
		const container = renderShell();
		const shortcut = (options: KeyboardEventInit = {}) =>
			new KeyboardEvent("keydown", {
				key: "b",
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
				...options,
			});
		const event = shortcut();
		act(() => window.dispatchEvent(event));
		expect(event.defaultPrevented).toBe(true);
		expect(rail(container).dataset.state).toBe("collapsed");
		act(() =>
			window.dispatchEvent(shortcut({ ctrlKey: false, metaKey: true })),
		);
		expect(rail(container).dataset.state).toBe("expanded");
		for (const html of [
			"<input>",
			"<textarea></textarea>",
			"<select></select>",
			'<div contenteditable="true"></div>',
		]) {
			const editor = document.createElement("div");
			editor.innerHTML = html;
			container.append(editor);
			const event = shortcut();
			act(() => editor.firstElementChild!.dispatchEvent(event));
			expect(event.defaultPrevented).toBe(false);
			expect(rail(container).dataset.state).toBe("expanded");
		}
		for (const options of [
			{ repeat: true },
			{ shiftKey: true },
			{ altKey: true },
		]) {
			act(() => window.dispatchEvent(shortcut(options)));
			expect(rail(container).dataset.state).toBe("expanded");
		}
		const handled = shortcut();
		handled.preventDefault();
		act(() => window.dispatchEvent(handled));
		expect(rail(container).dataset.state).toBe("expanded");
	});

	it("places the workspace switcher with the organization and keeps the account menu in the footer", () => {
		const container = renderShell();
		const header = container.querySelector('[data-sidebar="header"]')!;
		const footer = container.querySelector('[data-sidebar="footer"]')!;
		const trigger = footer.querySelector<HTMLButtonElement>(
			'[aria-label="Collapse sidebar"]',
		)!;
		expect(trigger).not.toBeNull();
		const account = footer.querySelector('[aria-label="Account menu"]')!;
		expect(trigger.closest('[data-sidebar="menu-item"]')).toBe(
			account.closest('[data-sidebar="menu-item"]'),
		);
		expect(account.contains(trigger)).toBe(false);
		expect(footer.className).toContain("gap-1");
		const switcher = header.querySelector(
			'[aria-label="Switch organization"]',
		)!;
		expect(switcher.querySelector("strong")?.textContent?.trim()).toBe(
			"Local workspace",
		);
		expect(switcher.textContent).toContain("OS");
		const mark = header.querySelector('[data-entity-kind="workspace"]')!;
		expect(mark).not.toBeNull();
		expect(
			[...mark.classList].some(
				(value) => value === "hidden" || value.endsWith(":hidden"),
			),
		).toBe(false);
		expect(
			footer.querySelector('[aria-label="Switch organization"]'),
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
		expect(footer.querySelector('[aria-label="Account menu"]')).not.toBeNull();
		for (const href of ["/admin", "/account/settings", "/account/profile"]) {
			expect(footer.querySelector(`a[href="${href}"]`)).toBeNull();
		}
		act(() => trigger.click());
		expect(rail(container).dataset.state).toBe("expanded");
		expect(trigger.getAttribute("aria-label")).toBe("Collapse sidebar");
	});

	it("exposes all destinations directly and keeps primary links outside the scrolling region", () => {
		const container = renderShell();
		const primary = container.querySelector('[aria-label="Primary"]')!;
		expect(
			[...primary.querySelectorAll("a")].map((a) => a.textContent),
		).toEqual(["Work", "Chat", "Workspaces", "Documents", "Inbox"]);
		expect(primary.closest('[data-sidebar="content"]')).toBeNull();
		expect(container.querySelector('[aria-label="Setup"]')).toBeNull();
		expect(container.querySelector('[data-sidebar="group-label"]')).toBeNull();
		for (const label of ["Team", "Skills", "Connections", "Websites"]) {
			expect(
				[...rail(container).querySelectorAll("a")].filter(
					(a) => a.textContent === label,
				),
			).toHaveLength(1);
		}
		// Memory lives with each tedi, not as its own sidebar entry.
		expect(
			[...rail(container).querySelectorAll("a")].some(
				(a) => a.textContent === "Memory",
			),
		).toBe(false);
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
			expect(trigger.dataset.kumoComponent).toBe("Button");
			expect(trigger.className).toContain("!size-8");
			const search = container.querySelector<HTMLButtonElement>(
				'[aria-label="Search"]',
			)!;
			expect(search.className).toContain("!size-8");
			expect(search.className).toContain("ring-kumo-line");
			expect(search.querySelector("kbd")).toBeNull();
			for (const button of [trigger, search])
				for (const floor of [
					"max-sm:min-h-11",
					"max-sm:min-w-11",
					"coarse:min-h-11",
					"coarse:min-w-11",
				])
					expect(button.className).toContain(floor);
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
});
