import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { tediEmailContractRouter } from "./tedi-email";

const queries = vi.hoisted(() => ({
	address: vi.fn(),
	ensurePrimary: vi.fn(),
	tedi: vi.fn(),
	activeId: vi.fn(),
	activeSlug: vi.fn(),
	ingest: vi.fn(),
	identity: vi.fn(),
	byHeader: vi.fn(),
	recordOutcome: vi.fn(),
}));

vi.mock("@tedix/db/queries/tedi-email/addresses", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getActiveTediEmailAddressByAddress: queries.address,
	ensurePrimaryTediEmailAddress: queries.ensurePrimary,
}));
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getTediById: queries.tedi,
	getActiveTediIdBySlug: queries.activeId,
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
		queries.address.mockResolvedValue({ tediId: "tedi-1" });
		queries.tedi.mockResolvedValue({ id: "tedi-1", organizationId: "org-1" });
		queries.ingest.mockResolvedValue({
			thread: { id: "thread-1" },
			message: { id: "message-1" },
		});
	});

	it("acknowledges persisted mail without a runtime service binding or slug lookup", async () => {
		await expect(client().inboundEmail(input)).resolves.toEqual({
			delivered: true,
			threadId: "thread-1",
			messageId: "message-1",
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
		expect(queries.activeSlug).not.toHaveBeenCalled();
	});

	it("preserves primary-address provisioning for a known slug fallback", async () => {
		queries.address.mockResolvedValue(null);
		queries.activeId.mockResolvedValue("tedi-1");
		await expect(
			client().inboundEmail({ ...input, slug: "worker" }),
		).resolves.toMatchObject({ delivered: true });
		expect(queries.ensurePrimary).toHaveBeenCalledWith(expect.anything(), {
			tediId: "tedi-1",
			organizationId: "org-1",
			slug: "worker",
		});
	});

	it("does not ingest mail for an unknown recipient", async () => {
		queries.address.mockResolvedValue(null);
		queries.activeId.mockResolvedValue(null);
		await expect(
			client().inboundEmail({ ...input, slug: "unknown" }),
		).resolves.toEqual({ delivered: false });
		expect(queries.ingest).not.toHaveBeenCalled();
		expect(queries.ensurePrimary).not.toHaveBeenCalled();
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
