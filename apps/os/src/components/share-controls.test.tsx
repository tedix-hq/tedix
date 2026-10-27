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
	update: vi.fn(),
}));

const getContext = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
	osApi: {
		osShares: { shares: sharesApi },
		userSettings: { getContext },
	},
}));

import {
	formatShareLink,
	shareLinkBase,
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
const GADGET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVISION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function shareFixture(overrides: Partial<OsShareLink> = {}): OsShareLink {
	return {
		id: SHARE_ID,
		organizationId: "org-1",
		resourceType: "output",
		resourceId: OUTPUT_ID,
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
	for (const mock of Object.values(sharesApi)) {
		mock.mockReset();
	}
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

describe("formatShareLink", () => {
	it("builds the public redemption URL from the one-time token", () => {
		expect(formatShareLink("abc")).toBe(
			"https://api.tedix.dev/os-shared#token=abc",
		);
	});

	it("keeps every isolated-local share on localhost", () => {
		expect(
			shareLinkBase({
				resourceType: "output",
				origin: "http://localhost:3030",
				localEvaluation: true,
			}),
		).toBe("http://localhost:3030/shared");
	});

	it("uses the central production redeemer only for production outputs", () => {
		expect(
			shareLinkBase({
				resourceType: "output",
				origin: "https://acme.os.tedix.dev",
				localEvaluation: false,
			}),
		).toBe("https://api.tedix.dev/os-shared");
		expect(
			shareLinkBase({
				resourceType: "workspace",
				origin: "https://acme.os.tedix.dev",
				localEvaluation: false,
			}),
		).toBe("https://acme.os.tedix.dev/shared");
	});
});

describe("shareStatus", () => {
	it("distinguishes active, expired, and revoked; revoked wins", () => {
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
					expiresAt: "2099-01-01T00:00:00.000Z",
					revokedAt: "2026-08-14T11:00:00.000Z",
				}),
				now,
			),
		).toBe("revoked");
	});

	it("maps every status to a badge variant", () => {
		expect(shareStatusVariant("active")).toBe("success");
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

	it("hides the revoke button on a revoked link", () => {
		const html = renderToStaticMarkup(
			<ShareRow
				share={shareFixture({ revokedAt: "2026-08-14T11:00:00.000Z" })}
				onRevoke={() => {}}
			/>,
		);
		expect(html).toContain("Turned off");
		expect(html).not.toContain("Options for");
	});
});

// ---------------------------------------------------------------------------
// Behavior (mocked osApi)
// ---------------------------------------------------------------------------

describe("ShareControls", () => {
	it("keeps the compact trigger accessible while removing its visible label", () => {
		const container = renderControls({ outputId: OUTPUT_ID, compact: true });
		const trigger = findButton(container, "Share");
		expect(trigger.getAttribute("aria-label")).toBe("Share");
		expect(trigger.className).toContain("size-8");
		expect(trigger.className).not.toContain("ring-kumo-line");
		expect(trigger.querySelector(".sr-only")?.textContent).toBe("Share");
	});

	it("opens one dialog, never a popover", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		const surface = renderControls();
		const trigger = findButton(surface, "Share");

		click(trigger);
		await flush();

		const dialog = surface.querySelector<HTMLElement>('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain("Share this file");
		expect(dialog?.textContent).toContain("General access");
		expect(surface.querySelector(".kumo-popover-popup")).toBeNull();
	});

	it("fetches links only when opened and lists them", async () => {
		sharesApi.list.mockResolvedValue({ items: [shareFixture()] });
		const container = renderControls();
		await flush();
		expect(sharesApi.list).not.toHaveBeenCalled();

		click(findButton(container, "Share"));
		await flush();
		expect(sharesApi.list.mock.calls[0]?.[0]).toEqual({
			resourceType: "output",
			resourceId: OUTPUT_ID,
		});
		expect(container.textContent).toContain("never expires");
		expect(container.textContent).toContain("Can view");
	});

	it("explains why a guest link will not open an app that reaches a connected account", async () => {
		sharesApi.list.mockResolvedValue({
			items: [],
			guestRefusal: { slot: "notes", reason: "connection_grant" },
		});
		const container = renderControls({
			resourceType: "gadget",
			resourceId: OUTPUT_ID,
			guestEntry: true,
		});
		click(findButton(container, "Share"));
		await flush();
		const note = container.querySelector("[data-guest-refusal]");
		expect(note?.getAttribute("data-guest-refusal")).toBe("connection_grant");
		expect(note?.textContent).toContain(
			"People without a Tedix account can't open this app",
		);
		expect(note?.textContent).toContain('"notes"');
	});

	it("tucks turned-off links away behind one toggle", async () => {
		sharesApi.list.mockResolvedValue({
			items: [
				shareFixture(),
				shareFixture({
					id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
					note: "Old handoff",
					revokedAt: "2026-08-14T11:00:00.000Z",
				}),
			],
		});
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		expect(container.textContent).not.toContain("Old handoff");
		click(findButton(container, "Show 1 old link"));
		expect(container.textContent).toContain("Old handoff");
		expect(container.textContent).toContain("Turned off");
	});

	it("edits a link by making a new one and turning the old one off", async () => {
		sharesApi.list.mockResolvedValue({
			items: [shareFixture({ note: "Old note" })],
		});
		sharesApi.create.mockResolvedValue({
			share: shareFixture({
				id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				note: "New note",
			}),
			token: TOKEN,
		});
		sharesApi.revoke.mockResolvedValue({
			share: shareFixture({ revokedAt: "2026-08-14T11:00:00.000Z" }),
			revokedSessionCount: 0,
		});
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		expect(container.textContent).not.toContain("Create link");

		await pickMenuItem(container, "Options for Old note", "Get a new link");
		const note = container.querySelector<HTMLInputElement>(
			'input[aria-label="Share note"]',
		);
		expect(note?.value).toBe("Old note");
		if (!note) throw new Error("share note missing");
		setFieldValue(note, "New note");
		click(findButton(container, "Save and get new link"));
		await flush();

		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "output",
			resourceId: OUTPUT_ID,
			role: "viewer",
			revisionMode: "living",
			note: "New note",
		});
		expect(sharesApi.revoke).toHaveBeenCalledWith({ shareId: SHARE_ID });
		expect(linkField(container)?.value).toBe(formatShareLink(TOKEN));
		expect(container.textContent).toContain("The old link no longer works");
	});

	it("keeps the new link visible when the old one fails to turn off", async () => {
		sharesApi.list.mockResolvedValue({ items: [shareFixture()] });
		sharesApi.create.mockResolvedValue({
			share: shareFixture({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }),
			token: TOKEN,
		});
		sharesApi.revoke.mockRejectedValue(new Error("offline"));
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		await pickMenuItem(container, "Options for link", "Get a new link");
		click(findButton(container, "Save and get new link"));
		await flush();
		expect(linkField(container)?.value).toBe(formatShareLink(TOKEN));
		expect(container.textContent).toContain("The old link is still on");
	});

	it("lets an admin edit a link's settings in place, without a new URL", async () => {
		getContext.mockResolvedValue({
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
		const container = renderControls({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			currentRevisionId: REVISION_ID,
		});
		click(findButton(container, "Share"));
		await flush();
		await pickMenuItem(container, "Options for Launch team", "Edit settings");
		expect(container.textContent).toContain("The link stays the same");
		expect(
			container.querySelector('[aria-label="Share revision behavior"]'),
		).toBeNull();
		const note = container.querySelector<HTMLInputElement>(
			'input[aria-label="Share note"]',
		);
		if (!note) throw new Error("share note missing");
		setFieldValue(note, "Reviewers");
		click(findButton(container, "Use"));
		click(findButton(container, "Save"));
		await flush();

		expect(sharesApi.update).toHaveBeenCalledWith({
			shareId: SHARE_ID,
			role: "use",
			note: "Reviewers",
			expiresAt: null,
		});
		expect(sharesApi.create).not.toHaveBeenCalled();
		expect(sharesApi.revoke).not.toHaveBeenCalled();
		expect(linkField(container)).toBeNull();
	});

	it("offers in-place edits only to owners and admins", async () => {
		getContext.mockResolvedValue({
			authority: { role: "member", permissions: ["os:author"] },
		});
		sharesApi.list.mockResolvedValue({
			items: [shareFixture({ note: "Handoff" })],
		});
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		await expect(
			pickMenuItem(container, "Options for Handoff", "Edit settings"),
		).rejects.toThrow("menu item not found");
	});

	it("explains the empty list without implying failure", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		expect(container.textContent).toContain("Only people in the workspace");
		expect(container.textContent).toContain("Anyone with the link");
		expect(container.textContent).not.toContain("Couldn't");
	});

	it("creates a link and shows the one-time URL with the access warning", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockResolvedValue({
			share: shareFixture(),
			token: TOKEN,
		});
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();

		await openCreateForm(container);
		click(findButton(container, "Create link"));
		await flush();

		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "output",
			resourceId: OUTPUT_ID,
			role: "viewer",
			revisionMode: "living",
		});
		expect(linkField(container)?.value).toBe(formatShareLink(TOKEN));
		expect(findButton(container, "Copy link")).toBeTruthy();
		expect(container.textContent).toContain(
			"Anyone with this link can view this file",
		);
		expect(container.textContent).toContain("shown only once");

		// Dismissing hides the plaintext for good.
		click(findButton(container, "Done"));
		await flush();
		expect(linkField(container)).toBeNull();
	});

	it("passes an optional expiry as an absolute timestamp", async () => {
		withSystemTime(new Date(2099, 0, 1, 12, 0, 0));
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockResolvedValue({
			share: shareFixture(),
			token: TOKEN,
		});
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		await openCreateForm(container);

		openExpiryCalendar();
		click(expiryDay("2099-01-02"));
		const expiryTime = expiryTimeField();
		setFieldValue(expiryTime, "03:04");

		click(findButton(container, "Create link"));
		await flush();
		// Unchanged wire format: the same absolute instant the native
		// datetime-local input used to produce.
		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "output",
			resourceId: OUTPUT_ID,
			role: "viewer",
			revisionMode: "living",
			expiresAt: new Date(2099, 0, 2, 3, 4, 0, 0).toISOString(),
		});
	});

	it("omits the expiry once it is cleared back to no expiry", async () => {
		withSystemTime(new Date(2099, 0, 1, 12, 0, 0));
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockResolvedValue({
			share: shareFixture(),
			token: TOKEN,
		});
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		await openCreateForm(container);

		// Optional expiry: the trigger reads "No expiry" and offers nothing to
		// clear until a day is chosen.
		const trigger = expiryTrigger();
		expect(trigger.textContent).toContain("Never");
		expect(
			document.querySelector('[aria-label="Clear Link expiry"]'),
		).toBeNull();

		openExpiryCalendar();
		click(expiryDay("2099-01-02"));
		expect(expiryTrigger().textContent).not.toContain("Never");

		const clear = document.querySelector<HTMLButtonElement>(
			'[aria-label="Clear Link expiry"]',
		);
		if (!clear) throw new Error("clear control missing");
		click(clear);
		expect(expiryTrigger().textContent).toContain("Never");

		click(findButton(container, "Create link"));
		await flush();
		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "output",
			resourceId: OUTPUT_ID,
			role: "viewer",
			revisionMode: "living",
		});
	});

	it("mints a pinned build Gadget link on the tenant viewer without inheriting connections", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockResolvedValue({
			share: shareFixture({
				resourceType: "gadget",
				resourceId: GADGET_ID,
				role: "build",
				revisionMode: "pinned",
				pinnedRevisionId: REVISION_ID,
			}),
			token: TOKEN,
		});
		const container = renderControls({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			currentRevisionId: REVISION_ID,
		});
		click(findButton(container, "Share"));
		await flush();
		await openCreateForm(container);
		click(findButton(container, "Build"));
		click(findButton(container, "This version"));
		const note = container.querySelector<HTMLInputElement>(
			'input[aria-label="Share note"]',
		);
		if (!note) throw new Error("share note missing");
		setFieldValue(note, "Approved build handoff");
		click(findButton(container, "Create link"));
		await flush();
		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			role: "build",
			revisionMode: "pinned",
			pinnedRevisionId: REVISION_ID,
			note: "Approved build handoff",
		});
		expect(linkField(container)?.value).toContain("/shared#token=");
		expect(container.textContent).toContain("can build this app");
	});

	it("pins an output to the exact revision shown in its detail view", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockResolvedValue({
			share: shareFixture({
				revisionMode: "pinned",
				pinnedRevisionId: REVISION_ID,
			}),
			token: TOKEN,
		});
		const container = renderControls({
			outputId: OUTPUT_ID,
			currentRevisionId: REVISION_ID,
		});
		click(findButton(container, "Share"));
		await flush();
		await openCreateForm(container);
		click(findButton(container, "This version"));
		click(findButton(container, "Create link"));
		await flush();
		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "output",
			resourceId: OUTPUT_ID,
			role: "viewer",
			revisionMode: "pinned",
			pinnedRevisionId: REVISION_ID,
		});
	});

	it("revokes a listed link and refetches the list", async () => {
		sharesApi.list.mockResolvedValue({ items: [shareFixture()] });
		sharesApi.revoke.mockResolvedValue({
			share: shareFixture({ revokedAt: "2026-08-14T11:00:00.000Z" }),
			revokedSessionCount: 2,
		});
		sharesApi.previewRevoke.mockResolvedValue({
			share: shareFixture(),
			activeSessionCount: 2,
		});
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();

		const listCallsBefore = sharesApi.list.mock.calls.length;
		await pickMenuItem(container, "Options for link", "Turn off");
		expect(sharesApi.previewRevoke).toHaveBeenCalledWith({ shareId: SHARE_ID });
		expect(container.textContent).toContain("2 people have it open now");
		expect(container.querySelector('[data-slot="alert"]')).not.toBeNull();
		expect(container.textContent).toContain("Turn off this link?");
		click(findButton(container, "Turn off link"));
		await flush();

		expect(sharesApi.revoke).toHaveBeenCalledWith({ shareId: SHARE_ID });
		expect(sharesApi.list.mock.calls.length).toBeGreaterThan(listCallsBefore);
	});

	it("surfaces a failed create inline", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		sharesApi.create.mockRejectedValue(new Error("nope"));
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		await openCreateForm(container);
		click(findButton(container, "Create link"));
		await flush();
		expect(container.textContent).toContain("Couldn't create the link. nope");
	});

	it("shows no share link until the server has actually minted one", async () => {
		// AUTHORITATIVE-ONLY: the token is shown exactly once and only the server
		// can produce it, so an optimistic row would be a link that does not work.
		sharesApi.list.mockResolvedValue({ items: [] });
		const settle: { resolve?: (value: unknown) => void } = {};
		sharesApi.create.mockReturnValue(
			new Promise((resolve) => {
				settle.resolve = resolve;
			}),
		);
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		await openCreateForm(container);
		click(findButton(container, "Create link"));
		await flush();

		expect(
			container.querySelector('[data-slot="share-pending"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("Creating link…");
		expect(container.textContent).not.toContain("tok_");

		settle.resolve?.({ token: TOKEN, share: shareFixture() });
		await flush();
		expect(container.querySelector('[data-slot="share-pending"]')).toBeNull();
		expect(linkField(container)?.value).toContain(TOKEN);
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
