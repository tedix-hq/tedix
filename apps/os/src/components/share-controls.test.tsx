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
}));

vi.mock("@/lib/api", () => ({
	osApi: { osShares: { shares: sharesApi } },
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
	) & { compact?: boolean } = { outputId: OUTPUT_ID },
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
	it("renders created time, expiry, status, and the revoke button", () => {
		const html = renderToStaticMarkup(
			<ShareRow share={shareFixture()} onRevoke={() => {}} />,
		);
		expect(html).toContain("Created");
		expect(html).toContain("never expires");
		expect(html).toContain("active");
		expect(html).toContain("Revoke");
	});

	it("hides the revoke button on a revoked link", () => {
		const html = renderToStaticMarkup(
			<ShareRow
				share={shareFixture({ revokedAt: "2026-08-14T11:00:00.000Z" })}
				onRevoke={() => {}}
			/>,
		);
		expect(html).toContain("revoked");
		expect(html).not.toContain("Revoke share link");
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

	it("uses the semantic Kumo layer and bounds its panel to the viewport", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		const surface = renderControls();
		const trigger = findButton(surface, "Share");

		click(trigger);
		await flush();

		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const popup = surface.querySelector<HTMLElement>(".kumo-popover-popup");
		expect(popup).not.toBeNull();
		expect(popup?.className).toContain("overflow-y-auto");
		expect(popup?.className).toContain("var(--available-height)");
		expect(popup?.className).toContain("var(--viewport-tedix-height)");
		expect(popup?.className).toContain("calc(100vw-2rem)");
		expect(popup?.parentElement?.className).toContain(
			"z-(--tedix-layer-dropdown)",
		);

		click(trigger);
		await flush();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
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
		expect(container.textContent).toContain("active");
	});

	it("explains the empty list without implying failure", async () => {
		sharesApi.list.mockResolvedValue({ items: [] });
		const container = renderControls();
		click(findButton(container, "Share"));
		await flush();
		expect(container.textContent).toContain("No share links yet");
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

		click(findButton(container, "Create share link"));
		await flush();

		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "output",
			resourceId: OUTPUT_ID,
			role: "viewer",
			revisionMode: "living",
		});
		expect(container.textContent).toContain(formatShareLink(TOKEN));
		expect(container.textContent).toContain(
			"Anyone holding this link receives viewer access to this output",
		);
		expect(container.textContent).toContain("shown only once");

		// Dismissing hides the plaintext for good.
		click(findButton(container, "Done"));
		await flush();
		expect(container.textContent).not.toContain(TOKEN);
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

		openExpiryCalendar();
		click(expiryDay("2099-01-02"));
		const expiryTime = expiryTimeField();
		setFieldValue(expiryTime, "03:04");

		click(findButton(container, "Create share link"));
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

		// Optional expiry: the trigger reads "No expiry" and offers nothing to
		// clear until a day is chosen.
		const trigger = expiryTrigger();
		expect(trigger.textContent).toContain("No expiry");
		expect(
			document.querySelector('[aria-label="Clear Link expiry"]'),
		).toBeNull();

		openExpiryCalendar();
		click(expiryDay("2099-01-02"));
		expect(expiryTrigger().textContent).not.toContain("No expiry");

		const clear = document.querySelector<HTMLButtonElement>(
			'[aria-label="Clear Link expiry"]',
		);
		if (!clear) throw new Error("clear control missing");
		click(clear);
		expect(expiryTrigger().textContent).toContain("No expiry");

		click(findButton(container, "Create share link"));
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
		click(findButton(container, "Build workspace"));
		click(findButton(container, "Pinned"));
		const note = container.querySelector<HTMLInputElement>(
			'input[aria-label="Share note"]',
		);
		if (!note) throw new Error("share note missing");
		setFieldValue(note, "Approved build handoff");
		click(findButton(container, "Create share link"));
		await flush();
		expect(sharesApi.create).toHaveBeenCalledWith({
			resourceType: "gadget",
			resourceId: GADGET_ID,
			role: "build",
			revisionMode: "pinned",
			pinnedRevisionId: REVISION_ID,
			note: "Approved build handoff",
		});
		expect(container.textContent).toContain("/shared#token=");
		expect(container.textContent).toContain("never transfers your connections");
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
		click(findButton(container, "Pinned"));
		click(findButton(container, "Create share link"));
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
		click(findButton(container, "Revoke"));
		await flush();
		expect(sharesApi.previewRevoke).toHaveBeenCalledWith({ shareId: SHARE_ID });
		expect(container.textContent).toContain(
			"immediately end 2 active sessions",
		);
		expect(container.querySelector('[data-slot="alert"]')).not.toBeNull();
		expect(container.textContent).toContain("Revoke shared link?");
		click(findButton(container, "Confirm revoke"));
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
		click(findButton(container, "Create share link"));
		await flush();
		expect(container.textContent).toContain("Create failed: nope");
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
		click(findButton(container, "Create share link"));
		await flush();

		expect(
			container.querySelector('[data-slot="share-pending"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("Waiting for the server to mint");
		expect(container.textContent).not.toContain("tok_");

		settle.resolve?.({ token: TOKEN, share: shareFixture() });
		await flush();
		expect(container.querySelector('[data-slot="share-pending"]')).toBeNull();
		expect(container.textContent).toContain(TOKEN);
	});
});
