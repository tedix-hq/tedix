import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsShareLink } from "@tedix/api-contract/contracts/os-shares";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const sharesApi = vi.hoisted(() => ({
	create: vi.fn(),
	list: vi.fn(),
	previewRevoke: vi.fn(),
	revoke: vi.fn(),
	setDisabled: vi.fn(),
	delete: vi.fn(),
	update: vi.fn(),
	invitees: { list: vi.fn(), add: vi.fn(), remove: vi.fn() },
}));

const getContext = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
	osApi: {
		osShares: { shares: sharesApi },
		userSettings: { getContext },
	},
}));

import {
	ShareControls,
	ShareRow,
	shareExpiryLabel,
	shareStatus,
	shareStatusVariant,
} from "./share-controls";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OUTPUT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHARE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "tok_one-time-plaintext";
const PUBLIC_ID = "AbCdEfGhIjKlMnOpQrStUv";
const SHARE_URL = `https://example.os.tedix.test/s/${PUBLIC_ID}`;
const GADGET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVISION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function shareFixture(overrides: Partial<OsShareLink> = {}): OsShareLink {
	return {
		id: SHARE_ID,
		publicId: PUBLIC_ID,
		url: SHARE_URL,
		organizationId: "org-1",
		resourceType: "output",
		resourceId: OUTPUT_ID,
		access: "anyone_with_link",
		role: "viewer",
		revisionMode: "living",
		pinnedRevisionId: null,
		note: null,
		policyMaxRole: null,
		policyReason: null,
		policyRestrictedAt: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-14T10:00:00.000Z",
		expiresAt: null,
		revokedAt: null,
		disabledAt: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Interactive harness
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderControls(
	props: (
		| { outputId: string; currentRevisionId?: string | null }
		| {
				resourceType: "gadget" | "workspace";
				resourceId: string;
				currentRevisionId?: string | null;
		  }
	) & { compact?: boolean; guestEntry?: boolean; onOpenReview?: () => void } = {
		outputId: OUTPUT_ID,
	},
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
				<ShareControls {...props} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	// ShareControls is a real Kumo Popover: its panel portals to body so it can
	// escape Canvas and output-preview clipping contexts. Return the composed
	// document surface so behavior assertions cover both trigger and portal.
	return document.body;
}

/** One macrotask tick is occasionally not enough for a query to settle. */
async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

function linkField(container: Element): { value: string } | null {
	const field = container.querySelector("[data-share-url]");
	return field ? { value: field.textContent ?? "" } : null;
}

function findButton(container: Element, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((button) =>
		(button.textContent ?? "").includes(label),
	);
	if (!match) throw new Error(`button not found: ${label}`);
	return match;
}

function click(element: Element) {
	if (!(element instanceof HTMLElement))
		throw new Error("click target missing");
	act(() => {
		element.click();
	});
}

/** Opens a row's quiet "…" menu and picks one item from it. */
async function pickMenuItem(
	container: Element,
	triggerLabel: string,
	itemLabel: string,
) {
	const trigger = container.querySelector<HTMLButtonElement>(
		`button[aria-label="${triggerLabel}"]`,
	);
	if (!trigger) throw new Error(`menu trigger not found: ${triggerLabel}`);
	click(trigger);
	await flush();
	const item = [...document.querySelectorAll('[role="menuitem"]')].find(
		(node) => (node.textContent ?? "").includes(itemLabel),
	);
	if (!item) throw new Error(`menu item not found: ${itemLabel}`);
	click(item);
	await flush();
}

/** The create form sits behind "Link options" so the main row stays short. */
async function openCreateForm(container: Element) {
	await pickMenuItem(container, "Link options", "New link with options");
}

function setFieldValue(field: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("value setter missing");
	act(() => {
		setter.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/**
 * The expiry control is a composite: a Popover-anchored calendar plus a
 * discrete time field. Its popup portals to document.body, so these read from
 * the document rather than the render container.
 */
function expiryTrigger(): HTMLButtonElement {
	const trigger = document.querySelector<HTMLButtonElement>(
		'button[aria-label="Link expiry"]',
	);
	if (!trigger) throw new Error("expiry trigger missing");
	return trigger;
}

function openExpiryCalendar() {
	click(expiryTrigger());
}

function expiryDay(day: string): HTMLButtonElement {
	const cell = document.querySelector<HTMLButtonElement>(
		`td[data-day="${day}"] button`,
	);
	if (!cell) throw new Error(`calendar day missing: ${day}`);
	return cell;
}

function expiryTimeField(): HTMLInputElement {
	const field = document.querySelector<HTMLInputElement>(
		'input[aria-label="Link expiry time"]',
	);
	if (!field) throw new Error("expiry time field missing");
	return field;
}

/** Pins "now" so the calendar's min floor and default month are deterministic. */
function withSystemTime(now: Date) {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(now);
}

beforeEach(() => {
	for (const mock of [
		sharesApi.create,
		sharesApi.list,
		sharesApi.previewRevoke,
		sharesApi.revoke,
		sharesApi.setDisabled,
		sharesApi.delete,
		sharesApi.update,
		...Object.values(sharesApi.invitees),
	])
		mock.mockReset();
	sharesApi.invitees.list.mockResolvedValue({ items: [] });
});

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("shareStatus", () => {
	it("distinguishes active, off, expired, and revoked; revoked wins", () => {
		const now = new Date("2026-08-15T00:00:00.000Z");
		expect(shareStatus(shareFixture(), now)).toBe("active");
		expect(
			shareStatus(shareFixture({ expiresAt: "2026-08-14T00:00:00.000Z" }), now),
		).toBe("expired");
		expect(
			shareStatus(shareFixture({ expiresAt: "2026-08-16T00:00:00.000Z" }), now),
		).toBe("active");
		expect(
			shareStatus(
				shareFixture({
					disabledAt: "2026-08-14T11:00:00.000Z",
					expiresAt: "2026-08-14T00:00:00.000Z",
				}),
				now,
			),
		).toBe("off");
		expect(
			shareStatus(
				shareFixture({
					expiresAt: "2099-01-01T00:00:00.000Z",
					revokedAt: "2026-08-14T11:00:00.000Z",
				}),
				now,
			),
		).toBe("revoked");
	});

	it("maps every status to a badge variant", () => {
		expect(shareStatusVariant("active")).toBe("success");
		expect(shareStatusVariant("off")).toBe("secondary");
		expect(shareStatusVariant("expired")).toBe("warning");
		expect(shareStatusVariant("revoked")).toBe("secondary");
	});
});

describe("shareExpiryLabel", () => {
	it("states never / expires / expired honestly", () => {
		expect(shareExpiryLabel(shareFixture())).toBe("never expires");
		expect(
			shareExpiryLabel(shareFixture({ expiresAt: "2020-01-01T00:00:00.000Z" })),
		).toMatch(/^expired /);
		expect(
			shareExpiryLabel(shareFixture({ expiresAt: "2099-01-01T00:00:00.000Z" })),
		).toMatch(/^expires /);
	});
});

// ---------------------------------------------------------------------------
// Presentational
// ---------------------------------------------------------------------------

describe("ShareRow", () => {
	it("summarizes access, version, expiry and age with plain actions", () => {
		const html = renderToStaticMarkup(
			<ShareRow
				share={shareFixture({ note: "For the team" })}
				onRevoke={() => {}}
				onEdit={() => {}}
			/>,
		);
		expect(html).toContain("For the team");
		expect(html).toContain("created");
		expect(html).toContain("never expires");
		expect(html).toContain("Can view");
		expect(html).toContain("latest version");
		// Edit and Turn off live in the row's quiet menu.
		expect(html).toContain('aria-label="Options for For the team"');
	});

	it("asks inline before turning a link off", () => {
		const html = renderToStaticMarkup(
			<ShareRow
				share={shareFixture()}
				onRevoke={() => {}}
				confirmRevoke={{ activeSessionCount: 1 }}
			/>,
		);
		expect(html).toContain("Turn off this link?");
		expect(html).toContain("1 person has it open now");
		expect(html).toContain("Keep link");
	});

	it("hides the options menu on a deleted link", () => {
		const html = renderToStaticMarkup(
			<ShareRow
				share={shareFixture({ revokedAt: "2026-08-14T11:00:00.000Z" })}
				onRevoke={() => {}}
			/>,
		);
		expect(html).toContain("Deleted");
		expect(html).not.toContain("Options for");
	});
});

// ---------------------------------------------------------------------------
// Behavior (mocked osApi)
// ---------------------------------------------------------------------------

async function openDialog(
	props?: Parameters<typeof renderControls>[0],
): Promise<HTMLElement> {
	const container = renderControls(props);
	click(findButton(container, "Share"));
	await flush();
	return container;
}

describe("ShareControls", () => {
	beforeEach(() => {
		getContext.mockResolvedValue({
			organization: { name: "Acme Fictional" },
			authority: { role: "member", permissions: ["os:author"] },
		});
	});

	it("keeps the compact trigger accessible while removing its visible label", () => {
		const container = renderControls({ outputId: OUTPUT_ID, compact: true });
		const trigger = findButton(container, "Share");
		expect(trigger.getAttribute("aria-label")).toBe("Share");
		expect(trigger.className).toContain("size-8");
		expect(trigger.querySelector(".sr-only")?.textContent).toBe("Share");
	});

	it("opens one dialog, fetching links only once it is open", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		const container = renderControls();
		await flush();
		expect(sharesApi.list).not.toHaveBeenCalled();
		click(findButton(container, "Share"));
		await flush();
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
		expect(dialog?.textContent).toContain("Share this file");
		expect(dialog?.textContent).toContain("Who can open it");
		expect(container.querySelector(".kumo-popover-popup")).toBeNull();
		expect(sharesApi.list.mock.calls[0]?.[0]).toEqual({
			resourceType: "output",
			resourceId: OUTPUT_ID,
		});
	});

	it("shows the permanent address with Copy, any time the dialog opens", async () => {
		sharesApi.list.mockResolvedValue({ items: [shareFixture()] });
		const container = await openDialog();
		expect(linkField(container)?.value).toBe(SHARE_URL);
		expect(findButton(container, "Copy link")).toBeTruthy();
		expect(container.textContent).toContain("Can view");
		expect(container.textContent).toContain("never expires");
		expect(container.textContent).not.toContain("#token=");
	});

	it("offers the three audiences in plain words, naming the organization", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		const container = await openDialog();
		const options = [
			...container.querySelectorAll(
				'[role="radiogroup"][aria-label="Who can open it"] [role="radio"]',
			),
		];
		expect(options.map((node) => node.textContent?.trim())).toEqual([
			"Anyone with the link",
			"People in Acme Fictional",
			"Only people you invite",
		]);
		expect(options.map((node) => node.getAttribute("aria-checked"))).toEqual([
			"true",
			"false",
			"false",
		]);
		// One plain line says what the choice means.
		expect(
			container.querySelector("[data-share-explainer]")?.textContent,
		).toContain("without signing in");
	});

	it("creates a link for the chosen audience", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockResolvedValue({
			share: shareFixture({ access: "organization" }),
			token: TOKEN,
		});
		const container = await openDialog();
		click(findButton(container, "People in Acme Fictional"));
		await flush();
		click(findButton(container, "Create link"));
		await flush();
		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "output",
			resourceId: OUTPUT_ID,
			role: "viewer",
			access: "organization",
			revisionMode: "living",
		});
	});

	it("changes who can open a link without changing its address", async () => {
		sharesApi.list.mockResolvedValue({ items: [shareFixture()] });
		sharesApi.update.mockResolvedValue({
			share: shareFixture({ access: "invited" }),
			revokedSessionCount: 0,
		});
		const container = await openDialog();
		click(findButton(container, "Only people you invite"));
		await flush();
		expect(sharesApi.update).toHaveBeenCalledWith({
			shareId: SHARE_ID,
			access: "invited",
		});
		expect(sharesApi.create).not.toHaveBeenCalled();
	});

	it("adds and removes invited people on an invite-only link", async () => {
		sharesApi.list.mockResolvedValue({
			items: [shareFixture({ access: "invited" })],
		});
		const invitee = {
			id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
			shareLinkId: SHARE_ID,
			email: "kai@example.test",
			userId: null,
			name: null,
			addedByKind: "user",
			addedById: "user-1",
			addedAt: "2026-08-14T10:00:00.000Z",
		};
		sharesApi.invitees.list.mockResolvedValue({ items: [invitee] });
		sharesApi.invitees.add.mockResolvedValue({ invitee });
		sharesApi.invitees.remove.mockResolvedValue({ removed: true });
		const container = await openDialog();
		expect(container.textContent).toContain("kai@example.test");
		const email = container.querySelector<HTMLInputElement>(
			'input[aria-label="Email address to invite"]',
		);
		setFieldValue(email!, "zoe@example.test");
		click(findButton(container, "Add"));
		await flush();
		expect(sharesApi.invitees.add).toHaveBeenCalledWith({
			shareId: SHARE_ID,
			email: "zoe@example.test",
		});
		click(
			container.querySelector('button[aria-label="Remove kai@example.test"]')!,
		);
		await flush();
		expect(sharesApi.invitees.remove).toHaveBeenCalledWith({
			shareId: SHARE_ID,
			inviteeId: invitee.id,
		});
	});

	it("explains why a no-sign-in link will not open an app that reaches a connected account", async () => {
		sharesApi.list.mockResolvedValue({
			items: [],
			guestRefusal: { slot: "notes", reason: "connection_grant" },
		});
		const container = await openDialog({
			resourceType: "gadget",
			resourceId: OUTPUT_ID,
			guestEntry: true,
		});
		const note = container.querySelector("[data-guest-refusal]");
		expect(note?.getAttribute("data-guest-refusal")).toBe("connection_grant");
		expect(note?.textContent).toContain('"notes"');
	});

	it("asks before turning a link off, then turns it off in place", async () => {
		sharesApi.list.mockResolvedValue({ items: [shareFixture()] });
		sharesApi.previewRevoke.mockResolvedValue({
			share: shareFixture(),
			activeSessionCount: 2,
		});
		sharesApi.setDisabled.mockResolvedValue({
			share: shareFixture({ disabledAt: "2026-08-14T11:00:00.000Z" }),
			revokedSessionCount: 2,
		});
		const container = await openDialog();
		const listCallsBefore = sharesApi.list.mock.calls.length;
		await pickMenuItem(container, "Link options", "Turn off link");
		expect(sharesApi.previewRevoke).toHaveBeenCalledWith({ shareId: SHARE_ID });
		expect(container.textContent).toContain("2 people have it open now");
		click(findButton(container, "Turn off link"));
		await flush();
		expect(sharesApi.setDisabled).toHaveBeenCalledWith({
			shareId: SHARE_ID,
			disabled: true,
		});
		expect(sharesApi.revoke).not.toHaveBeenCalled();
		expect(sharesApi.list.mock.calls.length).toBeGreaterThan(listCallsBefore);
	});

	it("keeps the address struck through with Copy off while the link is off", async () => {
		sharesApi.list.mockResolvedValue({
			items: [shareFixture({ disabledAt: "2026-08-14T11:00:00.000Z" })],
		});
		sharesApi.setDisabled.mockResolvedValue({
			share: shareFixture(),
			revokedSessionCount: 0,
		});
		const container = await openDialog();
		const field = linkField(container);
		expect(field?.value).toBe(SHARE_URL);
		expect(field?.value).not.toContain("#token=");
		const copy = findButton(container, "Copy link");
		expect(copy.disabled).toBe(true);
		click(findButton(container, "Turn link back on"));
		await flush();
		expect(sharesApi.setDisabled).toHaveBeenCalledWith({
			shareId: SHARE_ID,
			disabled: false,
		});
	});

	it("asks before deleting a link for good, then deletes it", async () => {
		getContext.mockResolvedValue({
			organization: { name: "Acme Fictional" },
			authority: { role: "admin", permissions: ["os:admin"] },
		});
		sharesApi.list.mockResolvedValue({ items: [shareFixture()] });
		sharesApi.delete.mockResolvedValue({ deleted: true });
		const container = await openDialog();
		await pickMenuItem(container, "Link options", "Delete link");
		expect(container.textContent).toContain("Delete this link?");
		click(findButton(container, "Delete link"));
		await flush();
		expect(sharesApi.delete).toHaveBeenCalledWith({ shareId: SHARE_ID });
	});

	it("lets an admin edit a link's settings in place", async () => {
		getContext.mockResolvedValue({
			organization: { name: "Acme Fictional" },
			authority: { role: "admin", permissions: ["os:admin"] },
		});
		const share = shareFixture({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			role: "build",
			note: "Launch team",
		});
		sharesApi.list.mockResolvedValue({ items: [share] });
		sharesApi.update.mockResolvedValue({
			share: { ...share, role: "use", note: "Reviewers" },
			revokedSessionCount: 1,
		});
		const container = await openDialog({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			currentRevisionId: REVISION_ID,
		});
		await pickMenuItem(container, "Link options", "Edit settings");
		const note = container.querySelector<HTMLInputElement>(
			'input[aria-label="Share note"]',
		);
		setFieldValue(note!, "Reviewers");
		click(findButton(container, "Use"));
		click(findButton(container, "Save"));
		await flush();
		expect(sharesApi.update).toHaveBeenCalledWith({
			shareId: SHARE_ID,
			role: "use",
			note: "Reviewers",
			expiresAt: null,
		});
	});

	it("offers in-place edits only to owners and admins", async () => {
		sharesApi.list.mockResolvedValue({ items: [shareFixture()] });
		const container = await openDialog();
		await expect(
			pickMenuItem(container, "Link options", "Edit settings"),
		).rejects.toThrow("menu item not found");
	});

	it("passes an optional expiry as an absolute timestamp", async () => {
		withSystemTime(new Date(2099, 0, 1, 12, 0, 0));
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockResolvedValue({
			share: shareFixture(),
			token: TOKEN,
		});
		const container = await openDialog();
		click(findButton(container, "More options"));
		openExpiryCalendar();
		click(expiryDay("2099-01-02"));
		setFieldValue(expiryTimeField(), "03:04");
		click(findButton(container, "Create link"));
		await flush();
		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "output",
			resourceId: OUTPUT_ID,
			role: "viewer",
			access: "anyone_with_link",
			revisionMode: "living",
			expiresAt: new Date(2099, 0, 2, 3, 4, 0, 0).toISOString(),
		});
	});

	it("pins an app link to the version on screen", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockResolvedValue({
			share: shareFixture(),
			token: TOKEN,
		});
		const container = await openDialog({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			currentRevisionId: REVISION_ID,
		});
		click(findButton(container, "More options"));
		click(findButton(container, "Build"));
		click(findButton(container, "This version"));
		click(findButton(container, "Create link"));
		await flush();
		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			role: "build",
			access: "anyone_with_link",
			revisionMode: "pinned",
			pinnedRevisionId: REVISION_ID,
		});
	});

	it("surfaces a failed create inline", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockRejectedValue(
			new Error("The link could not be made right now"),
		);
		const container = await openDialog();
		click(findButton(container, "Create link"));
		await flush();
		expect(container.textContent).toContain(
			"The link could not be made right now",
		);
	});
});

describe("ShareControls review entry", () => {
	const useLink = () =>
		shareFixture({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			role: "use",
		});

	it("links the organization owner to the app's Review tab", async () => {
		sharesApi.list.mockResolvedValue({ items: [useLink()] });
		getContext.mockResolvedValue({ authority: { role: "owner" } });
		const onOpenReview = vi.fn();
		const container = renderControls({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			onOpenReview,
		});
		click(findButton(container, "Share"));
		await flush();
		// One link, none of the review form.
		expect(container.textContent).not.toContain("Items come from");
		click(findButton(container, "Ask people to review items"));
		await flush();
		expect(onOpenReview).toHaveBeenCalledTimes(1);
	});

	it("hides the review entry from everyone else", async () => {
		sharesApi.list.mockResolvedValue({ items: [useLink()] });
		getContext.mockResolvedValue({ authority: { role: "member" } });
		const container = renderControls({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			onOpenReview: vi.fn(),
		});
		click(findButton(container, "Share"));
		await flush();
		expect(container.textContent).not.toContain("Ask people to review");
	});
});
