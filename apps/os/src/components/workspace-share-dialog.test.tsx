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
	list: vi.fn(),
	presence: vi.fn(),
	add: vi.fn(),
	createLink: vi.fn(),
	copyLink: vi.fn(),
	setRole: vi.fn(),
	updateLink: vi.fn(),
	previewRemove: vi.fn(),
	remove: vi.fn(),
}));
const shares = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
	revoke: vi.fn(),
	invitees: { list: vi.fn() },
}));
const outputs = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", () => ({
	osApi: {
		osCollaborators: collaborators,
		osShares: { shares },
		osWorkspaces: { outputs, gadgets: { get: vi.fn() } },
		userSettings: { getContext: vi.fn() },
	},
}));

// Keep the tests on the dialog's own logic instead of Kumo's portal.
vi.mock("@/components/kumo/dialog", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/kumo/dialog")>()),
	Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
		open ? <>{children}</> : null,
	DialogContent: ({ children }: { children: ReactNode }) => (
		<section>{children}</section>
	),
	DialogDescription: ({ children }: { children: ReactNode }) => (
		<p data-description>{children}</p>
	),
	DialogHeader: ({ children }: { children: ReactNode }) => (
		<header>{children}</header>
	),
	DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import {
	inviteFailureText,
	itemAccessRows,
	parseInviteEmails,
	WorkspaceShareDialog,
	type WorkspaceShareItem,
	workspaceAddress,
} from "./workspace-share-dialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTPUT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const kai = {
	userId: "member-kai",
	email: "kai@example.test",
	name: "Kai Fictional",
	role: "use" as const,
	addedBy: ["Robin Fictional"],
	canRemove: true,
	canChangeRole: false,
	lastOpenedAt: null,
};

const cleanups: Array<() => void> = [];

function renderDialog(
	props: {
		item?: WorkspaceShareItem;
		initialScope?: "workspace" | "item";
	} = {},
): HTMLElement {
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
			<QueryClientProvider client={client}>
				<WorkspaceShareDialog
					workspaceId={WORKSPACE_ID}
					workspaceName="Launch plan"
					open
					onOpenChange={() => undefined}
					{...props}
				/>
			</QueryClientProvider>,
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

function button(container: Element, text: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => (candidate.textContent ?? "").trim() === text,
	);
	if (!(match instanceof HTMLButtonElement))
		throw new Error(`button not found: ${text}`);
	return match;
}

function setValue(field: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	act(() => {
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function emailField(container: Element): HTMLInputElement {
	return container.querySelector("[data-invite-emails]") as HTMLInputElement;
}

const writeText = vi.fn();

beforeEach(() => {
	for (const mock of Object.values(collaborators)) mock.mockReset();
	for (const mock of [shares.list, shares.create, shares.revoke])
		mock.mockReset();
	shares.invitees.list.mockReset();
	shares.invitees.list.mockResolvedValue({ items: [] });
	outputs.get.mockReset();
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	});
	shares.list.mockResolvedValue({ items: [], truncated: false });
	collaborators.presence.mockResolvedValue({
		workspaceId: WORKSPACE_ID,
		userId: "member-kai",
		displayName: "Kai Fictional",
		role: "use",
	});
	collaborators.list.mockResolvedValue({
		role: "build",
		isOwner: false,
		ownerName: "Robin Fictional",
		collaborators: [kai],
		links: [
			{
				id: LINK_ID,
				role: "use",
				label: "Reviewers",
				createdBy: { userId: "member-robin", email: null, name: "Robin" },
				createdAt: "2020-03-04T10:00:00.000Z",
				canRevoke: true,
				canEdit: true,
			},
		],
	});
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("invite helpers", () => {
	it("splits addresses on commas, spaces and new lines, each one once", () => {
		expect(
			parseInviteEmails(" ana@x.test, ben@x.test\ncy@x.test  ANA@x.test;"),
		).toEqual(["ana@x.test", "ben@x.test", "cy@x.test"]);
		expect(parseInviteEmails("  ")).toEqual([]);
	});

	it("names the address that failed", () => {
		expect(
			inviteFailureText(
				"bob@x.test",
				new Error(
					"No Tedix account uses that email. Send them a share link instead.",
				),
			),
		).toBe("No Tedix account uses bob@x.test. Send them a share link instead.");
		expect(inviteFailureText("bob@x.test", new Error("Not allowed"))).toBe(
			"bob@x.test: Not allowed",
		);
		expect(inviteFailureText("bob@x.test", null)).toBe(
			"Couldn't add bob@x.test.",
		);
	});

	it("builds the workspace address without a key", () => {
		expect(workspaceAddress("https://os.example.test", WORKSPACE_ID)).toBe(
			`https://os.example.test/shared/workspace/${WORKSPACE_ID}`,
		);
	});
});

describe("itemAccessRows", () => {
	const person = (userId: string, role: "use" | "build", email: string) => ({
		userId,
		email,
		name: null,
		role,
		addedBy: [],
		canRemove: true,
		canChangeRole: true,
		lastOpenedAt: null,
	});
	const invitee = (
		id: string,
		email: string,
		userId: string | null = null,
	) => ({
		id,
		shareLinkId: "share-1",
		email,
		userId,
		name: null,
		addedByKind: "user" as const,
		addedById: "user-1",
		addedAt: "2026-08-14T10:00:00.000Z",
	});
	const sharing = {
		ownerName: "Robin",
		collaborators: [
			person("u-build", "build", "ana@example.test"),
			person("u-use", "use", "ben@example.test"),
		],
	};

	it("says for each person whether the workspace or the file's link lets them in", () => {
		const rows = itemAccessRows({
			itemType: "output",
			visibility: "private",
			organization: "Acme",
			sharing,
			link: { access: "invited", role: "viewer" },
			invitees: [
				invitee("i-1", "Ana@Example.test"),
				invitee("i-2", "guest@example.test"),
			],
		});
		expect(rows.map((row) => [row.name, row.through])).toEqual([
			["Robin", "Through the workspace"],
			// Invited as well: listed once, with both ways in.
			["ana@example.test", "Through the workspace and this link"],
			["guest@example.test", "Through this link"],
		]);
	});

	it("leaves out people who only use the workspace's apps when the item is a file", () => {
		const names = (itemType: "output" | "gadget") =>
			itemAccessRows({
				itemType,
				visibility: "private",
				organization: "Acme",
				sharing,
				link: null,
			}).map((row) => row.name);
		expect(names("output")).toEqual(["Robin", "ana@example.test"]);
		expect(names("gadget")).toEqual([
			"Robin",
			"ana@example.test",
			"ben@example.test",
		]);
	});

	it("names the groups a link or an organization workspace reaches", () => {
		expect(
			itemAccessRows({
				itemType: "output",
				visibility: "org",
				organization: "Acme",
				link: { access: "anyone_with_link", role: "viewer" },
			}).map((row) => [row.name, row.through]),
		).toEqual([
			["Everyone in Acme", "Through the workspace"],
			["Anyone with the link", "Through this link"],
		]);
		expect(
			itemAccessRows({
				itemType: "output",
				visibility: "private",
				organization: "Acme",
				link: { access: "organization", role: "viewer" },
			}).map((row) => [row.name, row.through]),
		).toEqual([["People in Acme", "Through this link"]]);
	});
});

describe("WorkspaceShareDialog", () => {
	it("quotes the workspace name, explains itself and marks your own row", async () => {
		const container = renderDialog();
		await flush();
		expect(container.querySelector("h2")?.textContent).toBe(
			"Share “Launch plan”",
		);
		expect(container.querySelector("[data-description]")?.textContent).toBe(
			"Invite people or share a link.",
		);
		const row = container.querySelector('[data-collaborator="member-kai"]');
		expect(row?.textContent).toContain("Kai Fictional (you)");
		// The owner is someone else here.
		expect(container.textContent).not.toContain("Robin Fictional (you)");
		const link = container.querySelector(`[data-share-link="${LINK_ID}"]`);
		expect(link?.textContent).toContain(
			"Can use · made by Robin · Mar 4, 2020",
		);
	});

	it("opens on the item when its own Share was pressed", async () => {
		outputs.get.mockResolvedValue({
			output: { id: OUTPUT_ID, title: "Budget" },
			currentRevision: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
		});
		const item = { type: "output" as const, id: OUTPUT_ID };
		const onItem = renderDialog({ item, initialScope: "item" });
		await flush();
		expect(onItem.querySelector("h2")?.textContent).toBe("Share “Budget”");
		expect(onItem.querySelector("[data-share-open-item]")).not.toBeNull();
		// With no link, the file is open to the workspace's people only.
		const access = onItem.querySelector("[data-item-access]");
		expect(access?.textContent).toContain("Through the workspace");
		expect(access?.textContent).toContain(
			"Nobody outside the workspace can open this file.",
		);

		const onWorkspace = renderDialog({ item });
		await flush();
		expect(onWorkspace.querySelector("h2")?.textContent).toBe(
			"Share “Launch plan”",
		);
		expect(onWorkspace.querySelector("[data-share-open-item]")).toBeNull();
	});

	it("invites several people, reports each failure and offers the link to send", async () => {
		collaborators.add.mockImplementation(async ({ email }) => {
			if (email === "bob@x.test")
				throw new Error(
					"No Tedix account uses that email. Send them a share link instead.",
				);
			return {
				collaborator: {
					...kai,
					userId: `member-${email}`,
					email,
					name: email === "lee@x.test" ? "Lee Fictional" : null,
				},
			};
		});
		const container = renderDialog();
		await flush();
		expect(button(container, "Invite").disabled).toBe(true);
		setValue(emailField(container), "lee@x.test, bob@x.test ana@x.test nope");
		const invite = button(container, "Invite 4 people");
		await act(async () => invite.click());
		await flush();

		expect(collaborators.add.mock.calls.map(([input]) => input.email)).toEqual([
			"lee@x.test",
			"bob@x.test",
			"ana@x.test",
		]);
		const failures = container.querySelector("[data-invite-failures]");
		expect(failures?.textContent).toContain(
			"No Tedix account uses bob@x.test.",
		);
		expect(failures?.textContent).toContain(
			"nope doesn't look like an email address.",
		);
		// Failed addresses stay to be corrected.
		expect(emailField(container).value).toBe("bob@x.test, nope");
		const card = container.querySelector("[data-invited-link]");
		expect(card?.textContent).toContain(
			"Added Lee Fictional and ana@x.test. Send them this link to open it",
		);
		expect(card?.querySelector("[data-share-url]")?.textContent).toBe(
			`${window.location.origin}/shared/workspace/${WORKSPACE_ID}`,
		);
		await act(async () => button(card as Element, "Copy link").click());
		expect(writeText).toHaveBeenCalledWith(
			`${window.location.origin}/shared/workspace/${WORKSPACE_ID}`,
		);
		expect(button(card as Element, "Copied")).toBeTruthy();

		// The card goes away on the next invite.
		collaborators.add.mockRejectedValue(new Error("Not allowed right now"));
		setValue(emailField(container), "bob@x.test");
		await act(async () => button(container, "Invite").click());
		await flush();
		expect(container.querySelector("[data-invited-link]")).toBeNull();
		expect(container.querySelector("[data-invite-failures]")?.textContent).toBe(
			"bob@x.test: Not allowed right now",
		);
	});

	it("says Copied for about two seconds after copying a workspace link", async () => {
		collaborators.copyLink.mockResolvedValue({ key: "FreshKey" });
		const container = renderDialog();
		await flush();
		await act(async () => button(container, "Copy link").click());
		await flush();
		expect(writeText).toHaveBeenCalledWith(
			`${window.location.origin}/shared/workspace/${WORKSPACE_ID}#share=FreshKey`,
		);
		expect(button(container, "Copied")).toBeTruthy();
		const status = container.querySelector("[data-link-copy-status]");
		expect(status?.getAttribute("aria-live")).toBe("polite");
		expect(status?.textContent).toBe("Link copied");
		await act(async () => new Promise((resolve) => setTimeout(resolve, 2100)));
		expect(button(container, "Copy link")).toBeTruthy();
	});

	it("shows the address to copy by hand when the browser refuses", async () => {
		collaborators.copyLink.mockResolvedValue({ key: "FreshKey" });
		writeText.mockRejectedValue(new Error("denied"));
		const container = renderDialog();
		await flush();
		await act(async () => button(container, "Copy link").click());
		await flush();
		expect(container.textContent).toContain(
			"Couldn't copy the link. Select it and copy it yourself.",
		);
		expect(container.textContent).not.toContain("Couldn't change the link");
		expect(
			container.querySelector("[data-fresh-link] [data-share-url]")
				?.textContent,
		).toBe(
			`${window.location.origin}/shared/workspace/${WORKSPACE_ID}#share=FreshKey`,
		);
	});
});
