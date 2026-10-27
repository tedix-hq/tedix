import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	tediDetailQueryOptions,
	tediEmailAddressesQueryOptions,
	tediEmailInboxQueryOptions,
	tediEmailThreadQueryOptions,
} from "@/lib/os-query-options";
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
	send: vi.fn(),
}));
const tedisApi = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn() }));
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
		senderTrust: "trusted" | "untrusted";
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
		senderTrust: overrides.senderTrust ?? "trusted",
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

function mountMailbox() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const rerender = (tediId: string) =>
		act(() => {
			root.render(
				<QueryClientProvider client={client}>
					<TediMailbox tediId={tediId} />
				</QueryClientProvider>,
			);
		});
	rerender(TEDI_ID);
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
		container.remove();
	});
	return { container, client, rerender };
}

function render() {
	return mountMailbox().container;
}

async function settle(assertion: () => void) {
	await vi.waitFor(async () => {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		assertion();
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
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.resetAllMocks();
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
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
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
	it("waits for a delayed address query instead of a fixed number of timer turns", async () => {
		const pending = Promise.withResolvers<{ addresses: Address[] }>();
		tediEmailApi.listAddresses.mockReturnValue(pending.promise);
		const container = render();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(container.querySelector('[aria-label="Sender policy"]')).toBeNull();
		expect(tediEmailApi.listAddresses).toHaveBeenCalledOnce();
		await act(async () => pending.resolve({ addresses: [address()] }));
		await settle(() =>
			expect(
				container.querySelector("#mailbox-trusted-senders"),
			).not.toBeNull(),
		);
		expect(
			container.querySelector<HTMLTextAreaElement>("#mailbox-trusted-senders")
				?.value,
		).toBe("ana@example.com");
	});

	it("renders Enable mailbox when no address exists and creates the primary", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [] });
		const container = render();
		await settle(() =>
			expect(container.textContent).toContain("No mailbox yet"),
		);

		expect(container.textContent).toContain("No mailbox yet");
		expect(container.textContent).toContain("ledger@tedix.tech");
		expect(container.querySelector('[aria-label="Sender policy"]')).toBeNull();

		act(() => buttonByText(container, "Enable mailbox").click());
		await settle(() =>
			expect(tediEmailApi.createAddress).toHaveBeenCalledOnce(),
		);

		expect(inputs(tediEmailApi.createAddress)).toContainEqual({
			tediId: TEDI_ID,
			address: "ledger@tedix.tech",
			kind: "primary",
		});
	});

	it("renders the policy form, saves lowercase entries without status, and keeps source", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		const container = render();
		await settle(() =>
			expect(
				container.querySelector("#mailbox-trusted-senders"),
			).not.toBeNull(),
		);

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
		await settle(() =>
			expect(tediEmailApi.updateAddress).toHaveBeenCalledOnce(),
		);

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
		await settle(() =>
			expect(
				container.querySelector("#mailbox-trusted-senders"),
			).not.toBeNull(),
		);
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
		await settle(() => expect(buttonByText(container, "Pause")).toBeDefined());

		act(() => buttonByText(container, "Pause").click());
		await settle(() =>
			expect(tediEmailApi.updateAddress).toHaveBeenCalledOnce(),
		);

		expect(inputs(tediEmailApi.updateAddress)).toContainEqual({
			tediId: TEDI_ID,
			addressId: ADDRESS_ID,
			status: "paused",
		});
	});

	it("marks a thread from an unverified sender and no other", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		tediEmailApi.listInbox.mockResolvedValue({
			threads: [
				thread(),
				thread({
					id: "55555555-5555-4555-8555-555555555555",
					senderTrust: "untrusted",
				}),
			],
			nextCursor: null,
		});
		const container = render();
		await settle(() =>
			expect(container.querySelectorAll("[data-thread-id]")).toHaveLength(2),
		);

		const rows = container.querySelectorAll("[data-thread-id]");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).not.toContain("Unverified sender");
		expect(rows[1]?.textContent).toContain("Unverified sender");
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
		await settle(() =>
			expect(container.querySelectorAll("[data-thread-id]")).toHaveLength(1),
		);

		const list = container.querySelector('[aria-label="Inbox threads"]');
		if (!list) throw new Error("inbox list not rendered");
		expect(list.textContent).toContain("Invoice 42");
		expect(list.textContent).toContain("Ana <ana@example.com>");
		expect(list.textContent).toContain("1 unread");
		expect(list.textContent).toContain("Open");

		act(() => buttonByText(container, "Mark read").click());
		await settle(() => expect(tediEmailApi.mark).toHaveBeenCalledTimes(1));
		expect(inputs(tediEmailApi.mark)).toContainEqual({
			tediId: TEDI_ID,
			threadId: THREAD_ID,
			read: true,
		});

		act(() => buttonByText(container, "Archive").click());
		await settle(() => expect(tediEmailApi.mark).toHaveBeenCalledTimes(2));
		expect(inputs(tediEmailApi.mark)).toContainEqual({
			tediId: TEDI_ID,
			threadId: THREAD_ID,
			archived: true,
		});

		act(() => buttonByText(container, "Mark spam").click());
		await settle(() => expect(tediEmailApi.mark).toHaveBeenCalledTimes(3));
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
		await settle(() => expect(container.textContent).toContain("Thanks, Ana"));
		expect(inputs(tediEmailApi.readThread)).toContainEqual({
			tediId: TEDI_ID,
			threadId: THREAD_ID,
		});
		expect(container.textContent).toContain("Thanks, Ana");
	});
});

function expectReadOnly() {
	for (const mutation of [
		tediEmailApi.mark,
		tediEmailApi.createAddress,
		tediEmailApi.updateAddress,
		tediEmailApi.deleteAddress,
		tediEmailApi.send,
		tedisApi.run,
	])
		expect(mutation).not.toHaveBeenCalled();
}

function expandReadThread(container: HTMLElement) {
	const row = container.querySelector<HTMLButtonElement>(
		'[aria-label="Inbox threads"] button[aria-expanded]',
	);
	if (!row) throw new Error("thread row missing");
	act(() => row.click());
	return row;
}

describe("mailbox read recovery", () => {
	it.each([false, true])(
		"recovers a deferred addresses failure, empty=%s",
		async (empty) => {
			const failed = Promise.withResolvers<{ addresses: Address[] }>();
			const recovered = Promise.withResolvers<{ addresses: Address[] }>();
			tediEmailApi.listAddresses
				.mockReturnValueOnce(failed.promise)
				.mockReturnValueOnce(recovered.promise);
			const container = render();
			expect(container.textContent).not.toContain("No mailbox yet");
			await act(async () => failed.reject(new Error("Address read failed")));
			await settle(() =>
				expect(container.textContent).toContain("Address read failed"),
			);
			expect(container.textContent).not.toContain("No mailbox yet");
			act(() => buttonByText(container, "Retry addresses").click());
			await settle(() =>
				expect(tediEmailApi.listAddresses).toHaveBeenCalledTimes(2),
			);
			expectReadOnly();
			await act(async () =>
				recovered.resolve({ addresses: empty ? [] : [address()] }),
			);
			await settle(() =>
				expect(container.textContent).toContain(
					empty ? "No mailbox yet" : "Sender policy",
				),
			);
			expect(container.textContent).not.toContain("Address read failed");
			expect(inputs(tediEmailApi.listAddresses)).toEqual(
				Array(2).fill({ tediId: TEDI_ID, status: "all" }),
			);
			expectReadOnly();
		},
	);

	it.each([false, true])(
		"recovers a deferred inbox failure without changing the filter, empty=%s",
		async (empty) => {
			tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
			const failed = Promise.withResolvers<{
				threads: ReturnType<typeof thread>[];
				nextCursor: null;
			}>();
			const recovered = Promise.withResolvers<{
				threads: ReturnType<typeof thread>[];
				nextCursor: null;
			}>();
			tediEmailApi.listInbox
				.mockReturnValueOnce(failed.promise)
				.mockReturnValueOnce(recovered.promise);
			const container = render();
			await settle(() => expect(tediEmailApi.listInbox).toHaveBeenCalledOnce());
			await act(async () => failed.reject(new Error("Inbox read failed")));
			await settle(() =>
				expect(container.textContent).toContain("Inbox read failed"),
			);
			expect(container.textContent).toContain("ledger@tedix.tech");
			expect(container.textContent).not.toContain("Nothing here");
			act(() => buttonByText(container, "Retry inbox").click());
			await settle(() =>
				expect(tediEmailApi.listInbox).toHaveBeenCalledTimes(2),
			);
			await act(async () =>
				recovered.resolve({
					threads: empty ? [] : [thread({ unreadCount: 0 })],
					nextCursor: null,
				}),
			);
			await settle(() =>
				expect(container.textContent).toContain(
					empty ? "No open threads yet." : "Invoice 42",
				),
			);
			expect(inputs(tediEmailApi.listInbox)).toEqual(
				Array(2).fill({ tediId: TEDI_ID, status: "open", limit: 50 }),
			);
			expectReadOnly();
		},
	);

	it.each([false, true])(
		"recovers an expanded already-read thread without marking it, empty=%s",
		async (empty) => {
			tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
			tediEmailApi.listInbox.mockResolvedValue({
				threads: [thread({ unreadCount: 0 })],
				nextCursor: null,
			});
			const failed = Promise.withResolvers<unknown>();
			const recovered = Promise.withResolvers<unknown>();
			tediEmailApi.readThread
				.mockReturnValueOnce(failed.promise)
				.mockReturnValueOnce(recovered.promise);
			const container = render();
			await settle(() => expect(container.textContent).toContain("Invoice 42"));
			const row = expandReadThread(container);
			await act(async () => failed.reject(new Error("Thread read failed")));
			await settle(() =>
				expect(container.textContent).toContain("Thread read failed"),
			);
			expect(row.getAttribute("aria-expanded")).toBe("true");
			expect(container.textContent).toContain("Ana <ana@example.com>");
			act(() => buttonByText(container, "Retry thread").click());
			await settle(() =>
				expect(tediEmailApi.readThread).toHaveBeenCalledTimes(2),
			);
			await act(async () =>
				recovered.resolve({
					thread: thread({ unreadCount: 0 }),
					messages: empty ? [] : [thread().latestMessage],
				}),
			);
			await settle(() =>
				expect(container.textContent).toContain(
					empty ? "No messages in this thread." : "Thanks, Ana",
				),
			);
			expect(row.getAttribute("aria-expanded")).toBe("true");
			expect(inputs(tediEmailApi.readThread)).toEqual(
				Array(2).fill({ tediId: TEDI_ID, threadId: THREAD_ID }),
			);
			expectReadOnly();
		},
	);

	it.each(["addresses", "inbox", "thread"] as const)(
		"retains cached content and expanded context after a failed %s refresh",
		async (level) => {
			tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
			tediEmailApi.listInbox.mockResolvedValue({
				threads: [thread({ unreadCount: 0 })],
				nextCursor: null,
			});
			const transcript = {
				thread: thread({ unreadCount: 0 }),
				messages: [thread().latestMessage],
			};
			tediEmailApi.readThread.mockResolvedValue(transcript);
			const { container, client } = mountMailbox();
			await settle(() => expect(container.textContent).toContain("Invoice 42"));
			expandReadThread(container);
			await settle(() =>
				expect(container.textContent).toContain("Thanks, Ana"),
			);
			const failed = Promise.withResolvers<unknown>();
			const read =
				level === "addresses"
					? tediEmailApi.listAddresses
					: level === "inbox"
						? tediEmailApi.listInbox
						: tediEmailApi.readThread;
			read.mockReturnValueOnce(failed.promise);
			const options =
				level === "addresses"
					? tediEmailAddressesQueryOptions(TEDI_ID)
					: level === "inbox"
						? tediEmailInboxQueryOptions(TEDI_ID)
						: tediEmailThreadQueryOptions(TEDI_ID, THREAD_ID);
			act(() => {
				void client.invalidateQueries({
					queryKey: options.queryKey,
					exact: true,
				});
			});
			await settle(() => expect(read).toHaveBeenCalledTimes(2));
			await act(async () => failed.reject(new Error("Refresh failed")));
			await settle(() =>
				expect(container.textContent).toContain("Refresh failed"),
			);
			expect(container.textContent).toContain("ledger@tedix.tech");
			expect(container.textContent).toContain("Invoice 42");
			expect(container.textContent).toContain("Thanks, Ana");
			expect(
				container.querySelector('button[aria-expanded="true"]'),
			).not.toBeNull();
			act(() => buttonByText(container, `Retry ${level}`).click());
			await settle(() =>
				expect(container.textContent).not.toContain("Refresh failed"),
			);
			expect(read).toHaveBeenCalledTimes(3);
			expectReadOnly();
		},
	);

	it("does not present cached empty reads as a successful empty mailbox or inbox", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [] });
		const { container, client } = mountMailbox();
		await settle(() =>
			expect(container.textContent).toContain("No mailbox yet"),
		);
		tediEmailApi.listAddresses.mockRejectedValueOnce(
			new Error("Addresses unavailable"),
		);
		await act(async () => {
			await client.invalidateQueries({
				queryKey: tediEmailAddressesQueryOptions(TEDI_ID).queryKey,
			});
		});
		await settle(() =>
			expect(container.textContent).toContain("Addresses unavailable"),
		);
		expect(container.textContent).not.toContain("No mailbox yet");
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		act(() => buttonByText(container, "Retry addresses").click());
		await settle(() => expect(container.textContent).toContain("Nothing here"));
		tediEmailApi.listInbox.mockRejectedValueOnce(
			new Error("Inbox unavailable"),
		);
		await act(async () => {
			await client.invalidateQueries({
				queryKey: tediEmailInboxQueryOptions(TEDI_ID).queryKey,
			});
		});
		await settle(() =>
			expect(container.textContent).toContain("Inbox unavailable"),
		);
		expect(container.textContent).not.toContain("Nothing here");
		expectReadOnly();
	});

	it("retries only the current filter after changing filters during a failed read", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		const old = Promise.withResolvers<unknown>();
		tediEmailApi.listInbox
			.mockReturnValueOnce(old.promise)
			.mockRejectedValueOnce(new Error("Archived unavailable"))
			.mockResolvedValue({ threads: [], nextCursor: null });
		const container = render();
		await settle(() => expect(tediEmailApi.listInbox).toHaveBeenCalledOnce());
		const archived = container.querySelector<HTMLElement>(
			'[aria-label="Inbox filter"] button:nth-child(2)',
		);
		if (!archived) throw new Error("Archived filter missing");
		act(() => archived.click());
		await act(async () => old.reject(new Error("Old open failure")));
		await settle(() =>
			expect(container.textContent).toContain("Archived unavailable"),
		);
		expect(container.textContent).not.toContain("Old open failure");
		act(() => buttonByText(container, "Retry inbox").click());
		await settle(() =>
			expect(container.textContent).toContain("No archived threads yet."),
		);
		expect(inputs(tediEmailApi.listInbox)).toEqual([
			{ tediId: TEDI_ID, status: "open", limit: 50 },
			{ tediId: TEDI_ID, status: "archived", limit: 50 },
			{ tediId: TEDI_ID, status: "archived", limit: 50 },
		]);
		expectReadOnly();
	});

	it("clears expanded context and retries the new tedi after a target change", async () => {
		const nextId = "99999999-9999-4999-8999-999999999999";
		tediEmailApi.listAddresses
			.mockResolvedValueOnce({ addresses: [address()] })
			.mockRejectedValueOnce(new Error("New addresses unavailable"))
			.mockResolvedValue({
				addresses: [address({ tediId: nextId, address: "next@tedix.tech" })],
			});
		tediEmailApi.listInbox.mockResolvedValue({
			threads: [thread({ unreadCount: 0 })],
			nextCursor: null,
		});
		const oldThread = Promise.withResolvers<unknown>();
		tediEmailApi.readThread.mockReturnValue(oldThread.promise);
		const { container, rerender } = mountMailbox();
		await settle(() => expect(container.textContent).toContain("Invoice 42"));
		expandReadThread(container);
		rerender(nextId);
		await act(async () => oldThread.reject(new Error("Old thread failure")));
		await settle(() =>
			expect(container.textContent).toContain("New addresses unavailable"),
		);
		expect(container.textContent).not.toContain("ledger@tedix.tech");
		expect(container.textContent).not.toContain("Old thread failure");
		act(() => buttonByText(container, "Retry addresses").click());
		await settle(() =>
			expect(container.textContent).toContain("next@tedix.tech"),
		);
		expect(container.querySelector('button[aria-expanded="true"]')).toBeNull();
		expect(inputs(tediEmailApi.listAddresses).at(-1)).toEqual({
			tediId: nextId,
			status: "all",
		});
		expect(tediEmailApi.readThread).toHaveBeenCalledOnce();
		expectReadOnly();
	});

	it("shows independent tedi-detail failure instead of claiming the tedi has no slug", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [] });
		const detail = Promise.withResolvers<unknown>();
		tedisApi.get
			.mockReturnValueOnce(detail.promise)
			.mockResolvedValue({ id: TEDI_ID, slug: "ledger" });
		const container = render();
		await settle(() =>
			expect(tediEmailApi.listAddresses).toHaveBeenCalledOnce(),
		);
		expect(container.textContent).not.toContain("needs a slug");
		await act(async () => detail.reject(new Error("Tedi read failed")));
		await settle(() =>
			expect(container.textContent).toContain("Tedi read failed"),
		);
		expect(container.textContent).not.toContain("needs a slug");
		expect(container.textContent).not.toContain("No mailbox yet");
		act(() => buttonByText(container, "Retry tedi details").click());
		await settle(() =>
			expect(container.textContent).toContain("ledger@tedix.tech"),
		);
		expectReadOnly();
	});

	it("keeps known mailbox metadata when the independent tedi detail refresh fails", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		const { container, client } = mountMailbox();
		await settle(() =>
			expect(container.textContent).toContain("ledger@tedix.tech"),
		);
		tedisApi.get.mockRejectedValueOnce(new Error("Tedi refresh failed"));
		await act(async () => {
			await client.invalidateQueries({
				queryKey: tediDetailQueryOptions(TEDI_ID).queryKey,
			});
		});
		await settle(() =>
			expect(container.textContent).toContain("Tedi refresh failed"),
		);
		expect(container.textContent).toContain("ledger@tedix.tech");
		expect(container.textContent).toContain("Sender policy");
		act(() => buttonByText(container, "Retry tedi details").click());
		await settle(() =>
			expect(container.textContent).not.toContain("Tedi refresh failed"),
		);
		expectReadOnly();
	});

	it("still marks an unread thread exactly when it is opened", async () => {
		tediEmailApi.listAddresses.mockResolvedValue({ addresses: [address()] });
		tediEmailApi.listInbox.mockResolvedValue({
			threads: [thread()],
			nextCursor: null,
		});
		tediEmailApi.readThread.mockResolvedValue({
			thread: thread(),
			messages: [],
		});
		const container = render();
		await settle(() => expect(container.textContent).toContain("Invoice 42"));
		expandReadThread(container);
		await settle(() => expect(tediEmailApi.mark).toHaveBeenCalledOnce());
		expect(inputs(tediEmailApi.mark)).toEqual([
			{ tediId: TEDI_ID, threadId: THREAD_ID, read: true },
		]);
	});
});
