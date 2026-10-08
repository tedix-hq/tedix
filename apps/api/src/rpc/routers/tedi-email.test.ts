import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { tediEmailContractRouter } from "./tedi-email";

const queries = vi.hoisted(() => ({
	address: vi.fn(),
	ensurePrimary: vi.fn(),
	tedi: vi.fn(),
	activeSlug: vi.fn(),
	ingest: vi.fn(),
	identity: vi.fn(),
	byHeader: vi.fn(),
	recordOutcome: vi.fn(),
	member: vi.fn(),
	recentCount: vi.fn(),
	mark: vi.fn(),
}));

vi.mock("@tedix/db/queries/tedi-email/addresses", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getActiveTediEmailAddressByAddress: queries.address,
	ensurePrimaryTediEmailAddress: queries.ensurePrimary,
}));
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getTediById: queries.tedi,
	getActiveTediSlugById: queries.activeSlug,
}));
vi.mock("@tedix/db/queries/tedi-email/delivery", async (importOriginal) => ({
	...(await importOriginal<object>()),
	ingestInboundTediEmail: queries.ingest,
}));
vi.mock("@tedix/db/queries/tedi-email/messages", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getInboundTediEmailMessageIdentity: queries.identity,
	findUniqueInboundTediEmailMessageIdentityByHeader: queries.byHeader,
	countRecentInboundTediEmailMessages: queries.recentCount,
}));
vi.mock("@tedix/db/queries/organization-members", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getActiveMemberByEmail: queries.member,
}));
vi.mock("@tedix/db/queries/tedi-email/threads", async (importOriginal) => ({
	...(await importOriginal<object>()),
	markTediEmail: queries.mark,
}));
vi.mock("@tedix/db/queries/tedi-email/events", async (importOriginal) => ({
	...(await importOriginal<object>()),
	recordTediEmailOutcome: queries.recordOutcome,
}));

const input = {
	from: { email: "sender@example.com" },
	to: { email: "worker@tedix.tech" },
	subject: "Mailbox persistence",
	body: "Please review this message.",
};
const authPass = {
	dkim: "pass" as const,
	dmarc: "pass" as const,
	spf: "pass" as const,
	dkimDomain: "example.com",
	dmarcDomain: "example.com",
};

function client(serviceBinding = true) {
	return createRouterClient(tediEmailContractRouter, {
		context: {
			db: {} as BaseContext["db"],
			// The incoming API request is service-authenticated; no outbound
			// TEDI_SERVICE binding is needed for mailbox persistence.
			env: {} as CloudflareEnv,
			headers: new Headers(
				serviceBinding ? { "X-Service-Binding": "true" } : {},
			),
			url: new URL("https://api/tediEmail/inbound-email"),
		} as BaseContext,
	});
}

describe("inbound email mailbox acknowledgement", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		queries.address.mockImplementation(async (_db, address: string) =>
			address === "worker@tedix.tech"
				? { tediId: "tedi-1", organizationId: "org-1", routingPolicy: null }
				: null,
		);
		queries.tedi.mockResolvedValue({ id: "tedi-1", organizationId: "org-1" });
		queries.member.mockResolvedValue(undefined);
		queries.recentCount.mockResolvedValue(0);
		queries.ingest.mockResolvedValue({
			thread: { id: "thread-1" },
			message: { id: "message-1" },
		});
	});

	it("acknowledges persisted mail from a stranger as untrusted but delivered", async () => {
		await expect(client().inboundEmail(input)).resolves.toEqual({
			delivered: true,
			threadId: "thread-1",
			messageId: "message-1",
			senderTrust: "untrusted",
			ingressDecision: "deliver",
		});
		expect(queries.ingest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				tediId: "tedi-1",
				organizationId: "org-1",
				to: input.to,
				textBody: input.body,
			}),
		);
		expect(queries.mark).not.toHaveBeenCalled();
		expect(queries.activeSlug).not.toHaveBeenCalled();
	});

	it("does not deliver to a slug without an address row", async () => {
		queries.address.mockResolvedValue(null);
		await expect(
			client().inboundEmail({ ...input, slug: "worker" }),
		).resolves.toEqual({ delivered: false });
		expect(queries.ensurePrimary).not.toHaveBeenCalled();
		expect(queries.ingest).not.toHaveBeenCalled();
	});

	it("trusts an authenticated organization member and skips the rate-limit count", async () => {
		queries.member.mockResolvedValue({ id: "member-1", status: "active" });
		await expect(
			client().inboundEmail({ ...input, authResults: authPass }),
		).resolves.toMatchObject({
			senderTrust: "trusted",
			ingressDecision: "deliver",
		});
		expect(queries.member).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"sender@example.com",
		);
		expect(queries.recentCount).not.toHaveBeenCalled();
	});

	it("keeps a member untrusted without an aligned DKIM or DMARC pass", async () => {
		queries.member.mockResolvedValue({ id: "member-1", status: "active" });
		await expect(client().inboundEmail(input)).resolves.toMatchObject({
			senderTrust: "untrusted",
		});
		await expect(
			client().inboundEmail({
				...input,
				authResults: {
					...authPass,
					dkimDomain: "evil.net",
					dmarcDomain: "evil.net",
				},
			}),
		).resolves.toMatchObject({ senderTrust: "untrusted" });
	});

	it("trusts a same-organization tedi address, not one from another tenant", async () => {
		queries.address.mockImplementation(async (_db, address: string) => {
			if (address === "worker@tedix.tech")
				return {
					tediId: "tedi-1",
					organizationId: "org-1",
					routingPolicy: null,
				};
			if (address === "peer@tedix.tech")
				return { tediId: "tedi-2", organizationId: "org-1" };
			if (address === "foreign@tedix.tech")
				return { tediId: "tedi-9", organizationId: "org-9" };
			return null;
		});
		const auth = {
			...authPass,
			dkimDomain: "tedix.tech",
			dmarcDomain: "tedix.tech",
		};
		await expect(
			client().inboundEmail({
				...input,
				from: { email: "peer@tedix.tech" },
				authResults: auth,
			}),
		).resolves.toMatchObject({ senderTrust: "trusted" });
		await expect(
			client().inboundEmail({
				...input,
				from: { email: "foreign@tedix.tech" },
				authResults: auth,
			}),
		).resolves.toMatchObject({ senderTrust: "untrusted" });
	});

	it("quarantines spam-scored mail: persisted, marked spam, never delivered", async () => {
		await expect(
			client().inboundEmail({ ...input, spamScore: 7.5 }),
		).resolves.toMatchObject({
			delivered: true,
			messageId: "message-1",
			ingressDecision: "quarantine",
		});
		expect(queries.ingest).toHaveBeenCalledTimes(1);
		expect(queries.mark).toHaveBeenCalledWith(expect.anything(), {
			tediId: "tedi-1",
			organizationId: "org-1",
			threadId: "thread-1",
			spam: true,
		});
	});

	it("applies the address routing policy for untrusted senders and the rate limit", async () => {
		queries.address.mockResolvedValue({
			tediId: "tedi-1",
			organizationId: "org-1",
			routingPolicy: { untrustedSenders: "quarantine" },
		});
		await expect(client().inboundEmail(input)).resolves.toMatchObject({
			senderTrust: "untrusted",
			ingressDecision: "quarantine",
		});

		queries.address.mockResolvedValue({
			tediId: "tedi-1",
			organizationId: "org-1",
			routingPolicy: { allowedSenders: ["@example.com"] },
		});
		await expect(
			client().inboundEmail({ ...input, authResults: authPass }),
		).resolves.toMatchObject({
			senderTrust: "trusted",
			ingressDecision: "deliver",
		});

		queries.address.mockResolvedValue({
			tediId: "tedi-1",
			organizationId: "org-1",
			routingPolicy: null,
		});
		queries.recentCount.mockResolvedValue(21);
		await expect(client().inboundEmail(input)).resolves.toMatchObject({
			senderTrust: "untrusted",
			ingressDecision: "quarantine",
		});
		expect(queries.recentCount).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ tediId: "tedi-1", organizationId: "org-1" }),
		);
	});

	it("propagates storage failure instead of acknowledging delivery", async () => {
		const failure = new Error("mailbox storage unavailable");
		queries.ingest.mockRejectedValue(failure);
		await expect(client().inboundEmail(input)).rejects.toThrow(
			"mailbox storage unavailable",
		);
	});
});

describe("email outcome receipts", () => {
	const tediId = "11111111-1111-4111-8111-111111111111";
	const messageId = "22222222-2222-4222-8222-222222222222";
	const message = {
		id: messageId,
		threadId: "thread-1",
		tediId,
		organizationId: "org-1",
	};

	beforeEach(() => {
		vi.resetAllMocks();
		queries.tedi.mockResolvedValue({ id: tediId, organizationId: "org-1" });
		queries.identity.mockResolvedValue(message);
		queries.byHeader.mockResolvedValue({ status: "found", message });
		queries.recordOutcome.mockResolvedValue({
			id: "receipt-1",
			duplicate: false,
		});
	});

	it("rejects non-service callers before an outcome lookup", async () => {
		await expect(
			client(false).recordOutcome({
				kind: "worker_dispatch",
				messageId,
				result: "skipped",
				elapsedMs: 0,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(queries.identity).not.toHaveBeenCalled();
		expect(queries.recordOutcome).not.toHaveBeenCalled();
	});

	it("records a worker observation against an existing inbound message only", async () => {
		await expect(
			client().recordOutcome({
				kind: "worker_dispatch",
				messageId,
				result: "sdk_returned",
				elapsedMs: 42,
			}),
		).resolves.toEqual({
			id: "receipt-1",
			messageId,
			duplicate: false,
		});
		expect(queries.recordOutcome).toHaveBeenCalledWith(expect.anything(), {
			kind: "worker_dispatch",
			messageId,
			message,
			result: "sdk_returned",
			elapsedMs: 42,
		});
		queries.identity.mockResolvedValue(null);
		await expect(
			client().recordOutcome({
				kind: "worker_dispatch",
				messageId,
				result: "skipped",
				elapsedMs: 0,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("scopes runtime header resolution and fails closed on missing or ambiguous mail", async () => {
		const observation = {
			kind: "runtime_turn" as const,
			tediId,
			messageIdHeader: "<source@example.org>",
			runId: "run-1",
			result: "completed" as const,
			elapsedMs: 123,
			replied: false,
		};
		await client().recordOutcome(observation);
		expect(queries.byHeader).toHaveBeenCalledWith(expect.anything(), {
			tediId,
			messageIdHeader: "<source@example.org>",
		});
		queries.byHeader.mockResolvedValue({ status: "ambiguous" });
		await expect(client().recordOutcome(observation)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		queries.byHeader.mockResolvedValue({ status: "missing" });
		await expect(client().recordOutcome(observation)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(queries.recordOutcome).toHaveBeenCalledTimes(1);
	});
});
