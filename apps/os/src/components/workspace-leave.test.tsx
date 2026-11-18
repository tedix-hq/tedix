import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const collaborators = vi.hoisted(() => ({
	access: vi.fn(),
	leave: vi.fn(),
	listShared: vi.fn(),
	dismissShared: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osCollaborators: collaborators,
		osWorkspaces: { workspaces: { list: vi.fn() } },
	},
}));

// A menu entry is tested as the plain control it is, without the menu's portal.
vi.mock("@/components/kumo/dropdown-menu", () => ({
	DropdownMenuItem: ({
		children,
		onClick,
	}: {
		children: ReactNode;
		onClick?: () => void;
	}) => (
		<button type="button" data-menu-item onClick={onClick}>
			{children}
		</button>
	),
}));

import { SharedWorkspacesList } from "./shared-workspaces-list";
import {
	LEAVE_BLOCKED_TEXT,
	LEAVE_CONFIRM_TEXT,
	useWorkspaceLeave,
} from "./workspace-leave";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const cleanups: Array<() => void> = [];

function render(node: ReactNode): HTMLElement {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>{node}</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 6; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function button(scope: ParentNode, text: string): HTMLButtonElement {
	const match = [...scope.querySelectorAll("button")].find(
		(candidate) => (candidate.textContent ?? "").trim() === text,
	);
	if (!(match instanceof HTMLButtonElement))
		throw new Error(`button not found: ${text}`);
	return match;
}

function dialog(): Element | null {
	return document.querySelector('[role="alertdialog"]');
}

function MenuHarness(props: { onLeft: () => void }) {
	const leave = useWorkspaceLeave(
		{ id: WORKSPACE_ID, name: "Launch plan" },
		props.onLeft,
	);
	return (
		<>
			<div data-menu>{leave.menuItem}</div>
			{leave.dialog}
		</>
	);
}

beforeEach(() => {
	for (const mock of Object.values(collaborators)) mock.mockReset();
	collaborators.listShared.mockResolvedValue({
		items: [
			{
				workspaceId: WORKSPACE_ID,
				title: "Launch plan",
				ownerName: "Robin Fictional",
				firstOpenedAt: "2020-03-04T10:00:00.000Z",
				lastOpenedAt: "2020-03-04T10:00:00.000Z",
			},
		],
	});
	collaborators.leave.mockResolvedValue({ left: true });
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("leaving from the shared list", () => {
	it("asks first, saying what is lost, then leaves and refreshes the list", async () => {
		collaborators.access.mockResolvedValue({ role: "use", leave: "allowed" });
		const container = render(<SharedWorkspacesList />);
		await flush();
		// Hiding is still there, and still only hides.
		expect(
			container.querySelector('button[aria-label="Hide Launch plan"]'),
		).not.toBeNull();
		const leave = container.querySelector(
			'button[aria-label="Leave Launch plan"]',
		) as HTMLButtonElement;
		act(() => leave.click());
		await flush();

		expect(dialog()?.textContent).toContain("Leave Launch plan?");
		expect(dialog()?.textContent).toContain(LEAVE_CONFIRM_TEXT);
		// Nothing happens until the person confirms.
		expect(collaborators.leave).not.toHaveBeenCalled();
		act(() => button(document.body, "Cancel").click());
		await flush();
		expect(dialog()).toBeNull();
		expect(collaborators.leave).not.toHaveBeenCalled();

		act(() => leave.click());
		await flush();
		collaborators.listShared.mockResolvedValue({ items: [] });
		await act(async () => button(document.body, "Leave workspace").click());
		await flush();
		expect(collaborators.leave).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
		});
		expect(collaborators.dismissShared).not.toHaveBeenCalled();
		expect(dialog()).toBeNull();
		// The list was read again and the workspace is gone from it.
		expect(container.textContent).not.toContain("Launch plan");
	});

	it("keeps the confirm open with the reason when leaving fails", async () => {
		collaborators.access.mockResolvedValue({ role: "use", leave: "allowed" });
		collaborators.leave.mockRejectedValue(new Error("Try again in a moment"));
		const container = render(<SharedWorkspacesList />);
		await flush();
		act(() =>
			(
				container.querySelector(
					'button[aria-label="Leave Launch plan"]',
				) as HTMLButtonElement
			).click(),
		);
		await flush();
		await act(async () => button(document.body, "Leave workspace").click());
		await flush();
		expect(dialog()?.textContent).toContain("Try again in a moment");
		expect(container.textContent).toContain("Launch plan");
	});

	it.each([
		["link", LEAVE_BLOCKED_TEXT.link],
		["organization", LEAVE_BLOCKED_TEXT.organization],
	] as const)(
		"says why %s access can't be left instead of offering to",
		async (status, text) => {
			collaborators.access.mockResolvedValue({ role: "use", leave: status });
			const container = render(<SharedWorkspacesList />);
			await flush();
			act(() =>
				(
					container.querySelector(
						'button[aria-label="Leave Launch plan"]',
					) as HTMLButtonElement
				).click(),
			);
			await flush();
			expect(dialog()?.textContent).toContain("You can't leave Launch plan");
			expect(document.querySelector("[data-leave-blocked]")?.textContent).toBe(
				text,
			);
			// There is nothing to confirm: only a way out of the dialog.
			expect(
				[...(dialog()?.querySelectorAll("button") ?? [])].map((control) =>
					(control.textContent ?? "").trim(),
				),
			).toEqual(["Close"]);
			act(() => button(document.body, "Close").click());
			await flush();
			expect(collaborators.leave).not.toHaveBeenCalled();
		},
	);

	it("says there is nothing to leave once access is already gone", async () => {
		collaborators.access.mockRejectedValue({
			code: "FORBIDDEN",
			message: "You don't have access to this workspace",
		});
		const container = render(<SharedWorkspacesList />);
		await flush();
		act(() =>
			(
				container.querySelector(
					'button[aria-label="Leave Launch plan"]',
				) as HTMLButtonElement
			).click(),
		);
		await flush();
		expect(document.querySelector("[data-leave-blocked]")?.textContent).toBe(
			"You no longer have access to this workspace, so there is nothing to leave.",
		);
	});
});

describe("leaving from the workspace menu", () => {
	it("offers Leave workspace to someone invited, and tells the host once they left", async () => {
		collaborators.access.mockResolvedValue({ role: "build", leave: "allowed" });
		const onLeft = vi.fn();
		const container = render(<MenuHarness onLeft={onLeft} />);
		// Nothing is offered before the answer is known.
		expect(container.querySelector("[data-menu-item]")).toBeNull();
		await flush();
		const entry = container.querySelector(
			"[data-menu-item]",
		) as HTMLButtonElement;
		expect(entry.textContent?.trim()).toBe("Leave workspace");
		act(() => entry.click());
		await flush();
		expect(dialog()?.textContent).toContain(LEAVE_CONFIRM_TEXT);
		await act(async () =>
			button(dialog() as Element, "Leave workspace").click(),
		);
		await flush();
		expect(collaborators.leave).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
		});
		expect(onLeft).toHaveBeenCalledOnce();
		expect(dialog()).toBeNull();
	});

	it("never offers it to the owner", async () => {
		collaborators.access.mockResolvedValue({ role: "build", leave: "owner" });
		const container = render(<MenuHarness onLeft={() => undefined} />);
		await flush();
		expect(container.querySelector("[data-menu-item]")).toBeNull();
	});

	it("explains organization access instead of offering to leave", async () => {
		collaborators.access.mockResolvedValue({
			role: "build",
			leave: "organization",
		});
		const container = render(<MenuHarness onLeft={() => undefined} />);
		await flush();
		act(() =>
			(
				container.querySelector("[data-menu-item]") as HTMLButtonElement
			).click(),
		);
		await flush();
		expect(document.querySelector("[data-leave-blocked]")?.textContent).toBe(
			LEAVE_BLOCKED_TEXT.organization,
		);
		expect(() => button(dialog() as Element, "Leave workspace")).toThrow();
	});
});
