import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

// Stable identities: the mock object is created once so `osQuery` (built from
// `osApi` at module load) keeps pointing at these exact functions.
const tediEmailApi = vi.hoisted(() => ({
	listAddresses: vi.fn(),
	createAddress: vi.fn(),
	updateAddress: vi.fn(),
	deleteAddress: vi.fn(),
	listInbox: vi.fn(),
	readThread: vi.fn(),
	mark: vi.fn(),
}));
const tedisApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: { tediEmail: tediEmailApi, tedis: tedisApi },
}));
vi.mock("@/components/kumo/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import {
	invalidSenderEntries,
	normalizePlusTag,
	parseSenderEntries,
	readRoutingPolicy,
	sortAddresses,
	TediMailbox,
} from "./tedi-mailbox";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TEDI_ID = "11111111-1111-4111-8111-111111111111";
const ADDRESS_ID = "22222222-2222-4222-8222-222222222222";
const THREAD_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "aaaaaaaa-0000-4000-8000-0000000000ff";
const T = "2026-10-08T08:30:00.000Z";

type Address = Awaited<
	ReturnType<typeof tediEmailApi.listAddresses>
>["addresses"][number];

const address = (overrides: Partial<Address> = {}): Address => ({
	id: ADDRESS_ID,
	organizationId: ORG_ID,
	tediId: TEDI_ID,
	address: "ledger@tedix.tech",
	localPart: "ledger",
	domain: "tedix.tech",
	kind: "primary",
	status: "active",
	routingPolicy: {
		allowedSenders: ["ana@example.com"],
		untrustedSenders: "deliver",
		spamThreshold: 5,
		source: "os",
	},
	createdBy: null,
	createdAt: T,
	updatedAt: T,
	...overrides,
});

const thread = (
	overrides: Partial<{
		id: string;
		status: "open" | "archived" | "spam";
		unreadCount: number;
	}> = {},
) => {
	const id = overrides.id ?? THREAD_ID;
	return {
		id,
		tediId: TEDI_ID,
		organizationId: ORG_ID,
		subjectNorm: "invoice 42",
		participants: [{ email: "ana@example.com", name: "Ana" }],
		lastMessageAt: T,
		status: overrides.status ?? "open",
		labels: null,
		unreadCount: overrides.unreadCount ?? 1,
		createdAt: T,
		updatedAt: T,
		latestMessage: {
			id: "44444444-4444-4444-8444-444444444444",
			threadId: id,
			tediId: TEDI_ID,
			organizationId: ORG_ID,
			direction: "inbound" as const,
			fromAddr: "ana@example.com",
			from: { email: "ana@example.com", name: "Ana" },
			to: [{ email: "ledger@tedix.tech" }],
			subject: "Invoice 42",
			bodyPreview: "Please find invoice 42 attached.",
			textBody: "Please find invoice 42 attached.\nThanks, Ana",
			receivedAt: T,
			status: "received" as const,
		},
	};
};

const cleanups: Array<() => void> = [];

function render() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<TediMailbox tediId={TEDI_ID} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/** oRPC passes a call context as the second argument; assert on inputs only. */
function inputs(fn: { mock: { calls: unknown[][] } }): unknown[] {
	return fn.mock.calls.map((call) => call[0]);
}

function buttonByText(container: HTMLElement, text: string): HTMLElement {
	const button = [...container.querySelectorAll<HTMLElement>("button")].find(
		(node) => node.textContent?.trim() === text,
	);
	if (!button) throw new Error(`button "${text}" not rendered`);
	return button;
}

async function setValue(
	field: HTMLInputElement | HTMLTextAreaElement,
	value: string,
) {
	const proto =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	if (!setter) throw new Error("value setter missing");
	await act(async () => {
		setter.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	tedisApi.get.mockResolvedValue({ id: TEDI_ID, slug: "ledger" });
	tediEmailApi.listInbox.mockResolvedValue({ threads: [], nextCursor: null });
	tediEmailApi.mark.mockResolvedValue({
		ok: true,
		threadId: THREAD_ID,
		unreadCount: 0,
	});
	tediEmailApi.updateAddress.mockImplementation(async (input) => ({
		address: address({
			status: input.status ?? "active",
			routingPolicy: input.routingPolicy ?? null,
		}),
	}));
	tediEmailApi.createAddress.mockImplementation(async (input) => ({
		address: address({ address: input.address, kind: input.kind }),
	}));
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseSenderEntries", () => {
	it("splits on newlines and commas, lowercases, trims, and de-duplicates", () => {
		expect(
			parseSenderEntries(" Ana@Example.com\n@Example.com, ana@example.com\n\n"),
		).toEqual(["ana@example.com", "@example.com"]);
	});
});

describe("invalidSenderEntries", () => {
	it("accepts emails and @domain suffixes only", () => {
		expect(
			invalidSenderEntries([
				"ana@example.com",
				"@example.com",
				"example.com",
				"x",
			]),
		).toEqual(["example.com", "x"]);
	});
});

describe("readRoutingPolicy", () => {
	it("falls back to deliver and the default threshold on a missing policy", () => {
		expect(readRoutingPolicy(null)).toEqual({
			allowedSenders: [],
			source: undefined,
			untrustedSenders: "deliver",
			spamThreshold: 5,
		});
	});

	it("ignores malformed entries", () => {
		expect(
			readRoutingPolicy({
				allowedSenders: ["ana@example.com", 3],
				untrustedSenders: "nonsense",
				spamThreshold: "7",
			}),
		).toEqual({
			allowedSenders: ["ana@example.com"],
			source: undefined,
			untrustedSenders: "deliver",
			spamThreshold: 5,
		});
	});
});

describe("normalizePlusTag", () => {
	it("lowercases a valid tag and rejects separators", () => {
		expect(normalizePlusTag(" Invoices ")).toBe("invoices");
		expect(normalizePlusTag("a b")).toBeNull();
		expect(normalizePlusTag("a@b")).toBeNull();
	});
});

describe("sortAddresses", () => {
	it("puts the primary address first", () => {
		const rows = sortAddresses([
			address({ id: "p", kind: "plus", address: "ledger+x@tedix.tech" }),
			address(),
		]);
		expect(rows.map((row) => row.kind)).toEqual(["primary", "plus"]);
	});
});

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

describe("TediMailbox", () => {
	it("renders Enable mailbox when no address exists and creates the primary", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [] });
		const container = render();
		await settle();

		expect(container.textContent).toContain("No mailbox yet");
		expect(container.textContent).toContain("ledger@tedix.tech");
		expect(container.querySelector('[aria-label="Sender policy"]')).toBeNull();

		act(() => buttonByText(container, "Enable mailbox").click());
		await settle();

		expect(inputs(tediEmailApi.createAddress)).toContainEqual({
			tediId: TEDI_ID,
			address: "ledger@tedix.tech",
			kind: "primary",
		});
	});

	it("renders the policy form, saves lowercase entries without status, and keeps source", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		const container = render();
		await settle();

		expect(container.textContent).toContain("ledger@tedix.tech");
		expect(container.textContent).toContain(
			"Trusted senders get the tedi's full tool set",
		);
		const senders = container.querySelector<HTMLTextAreaElement>(
			"#mailbox-trusted-senders",
		);
		if (!senders) throw new Error("trusted senders field not rendered");
		expect(senders.value).toBe("ana@example.com");

		await setValue(senders, "Ana@Example.com\n@Partner.Example.org");
		const threshold = container.querySelector<HTMLInputElement>(
			"#mailbox-spam-threshold",
		);
		if (!threshold) throw new Error("threshold field not rendered");
		expect(threshold.value).toBe("5");
		await setValue(threshold, "3");

		act(() => buttonByText(container, "Save policy").click());
		await settle();

		expect(inputs(tediEmailApi.updateAddress)).toContainEqual({
			tediId: TEDI_ID,
			addressId: ADDRESS_ID,
			routingPolicy: {
				allowedSenders: ["ana@example.com", "@partner.example.org"],
				untrustedSenders: "deliver",
				spamThreshold: 3,
				source: "os",
			},
		});
	});

	it("blocks a save that contains a malformed sender", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		const container = render();
		await settle();
		const senders = container.querySelector<HTMLTextAreaElement>(
			"#mailbox-trusted-senders",
		);
		if (!senders) throw new Error("trusted senders field not rendered");
		await setValue(senders, "not-an-email");

		expect(container.textContent).toContain("Not an email or @domain");
		const save = buttonByText(container, "Save policy");
		expect((save as HTMLButtonElement).disabled).toBe(true);
		expect(tediEmailApi.updateAddress).not.toHaveBeenCalled();
	});

	it("pauses an active address with status only", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		const container = render();
		await settle();

		act(() => buttonByText(container, "Pause").click());
		await settle();

		expect(inputs(tediEmailApi.updateAddress)).toContainEqual({
			tediId: TEDI_ID,
			addressId: ADDRESS_ID,
			status: "paused",
		});
	});

	it("renders inbox threads and mark actions call the mutation", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		tediEmailApi.listInbox.mockResolvedValue({
			threads: [thread()],
			nextCursor: null,
		});
		tediEmailApi.readThread.mockResolvedValue({
			thread: { ...thread(), latestMessage: undefined },
			messages: [thread().latestMessage],
		});
		const container = render();
		await settle();

		const list = container.querySelector('[aria-label="Inbox threads"]');
		if (!list) throw new Error("inbox list not rendered");
		expect(list.textContent).toContain("Invoice 42");
		expect(list.textContent).toContain("Ana <ana@example.com>");
		expect(list.textContent).toContain("1 unread");
		expect(list.textContent).toContain("open");

		act(() => buttonByText(container, "Mark read").click());
		await settle();
		expect(inputs(tediEmailApi.mark)).toContainEqual({
			tediId: TEDI_ID,
			threadId: THREAD_ID,
			read: true,
		});

		act(() => buttonByText(container, "Archive").click());
		await settle();
		expect(inputs(tediEmailApi.mark)).toContainEqual({
			tediId: TEDI_ID,
			threadId: THREAD_ID,
			archived: true,
		});

		act(() => buttonByText(container, "Mark spam").click());
		await settle();
		expect(inputs(tediEmailApi.mark)).toContainEqual({
			tediId: TEDI_ID,
			threadId: THREAD_ID,
			spam: true,
		});

		// Expanding reads the thread body.
		const row = container.querySelector<HTMLElement>(
			'[aria-label="Inbox threads"] button[aria-expanded]',
		);
		if (!row) throw new Error("thread row not rendered");
		act(() => row.click());
		await settle();
		expect(inputs(tediEmailApi.readThread)).toContainEqual({
			tediId: TEDI_ID,
			threadId: THREAD_ID,
		});
		expect(container.textContent).toContain("Thanks, Ana");
	});
});
