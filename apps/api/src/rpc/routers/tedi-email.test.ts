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
	validateToken: vi.fn(),
	createAddress: vi.fn(),
	addressById: vi.fn(),
	updateAddressStatus: vi.fn(),
	deleteAddress: vi.fn(),
}));

vi.mock("@tedix/auth/jwt", async (importOriginal) => ({
	...(await importOriginal<object>()),
	validateToken: queries.validateToken,
}));
vi.mock("@tedix/db/queries/tedi-email/addresses", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getActiveTediEmailAddressByAddress: queries.address,
	ensurePrimaryTediEmailAddress: queries.ensurePrimary,
	createTediEmailAddress: queries.createAddress,
	getTediEmailAddressById: queries.addressById,
	updateTediEmailAddressStatus: queries.updateAddressStatus,
	deleteTediEmailAddress: queries.deleteAddress,
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

describe("tenant self-serve mailbox addresses", () => {
	const ORG = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
	const OTHER_ORG = "7d0a4a7e-2d7f-4e42-9d7f-2d6f6c3f1a11";
	const TEDI = "d3b0f0a2-51f6-4a7e-9a36-2a8f1f0b1f11";
	const ADDRESS_ID = "53146845-24c0-4e89-b681-9309a98156a3";

	function orgAdmin(organizationId = ORG, permissions = ["tedis:update"]) {
		return createRouterClient(tediEmailContractRouter, {
			context: {
				authType: "user",
				db: {} as BaseContext["db"],
				env: { ENVIRONMENT: "test" } as CloudflareEnv,
				headers: new Headers(),
				organizationId,
				url: new URL("https://api.tedix.test/rpc/tediEmail"),
				user: {
					aud: "test",
					dct: "tenant-1",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions,
					roles: [],
					sub: "user-1",
				},
			} as BaseContext,
		});
	}

	/** A real tedi JWT strategy run: withAuth resolves authType "tedi" from the token. */
	function tediJwt() {
		queries.validateToken.mockResolvedValue({
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			sub: "key-1",
			entityType: "tedi",
			tediId: TEDI,
			descopeUserId: "descope-user-1",
			tedixRuntimeApiScopes: ["mcp:messaging.write"],
		});
		return createRouterClient(tediEmailContractRouter, {
			context: {
				db: {} as BaseContext["db"],
				env: { ENVIRONMENT: "test" } as CloudflareEnv,
				headers: new Headers({ Authorization: "Bearer tedi-token" }),
				organizationId: ORG,
				url: new URL("https://api.tedix.test/rpc/tediEmail"),
			} as BaseContext,
		});
	}

	beforeEach(() => {
		vi.resetAllMocks();
		queries.tedi.mockResolvedValue({
			id: TEDI,
			organizationId: ORG,
			slug: "worker",
		});
		queries.createAddress.mockImplementation(async (_db, input) => ({
			id: ADDRESS_ID,
			...input,
			localPart: input.address.split("@")[0],
			domain: input.address.split("@")[1],
		}));
		queries.addressById.mockResolvedValue({
			id: ADDRESS_ID,
			organizationId: ORG,
			tediId: TEDI,
			address: "worker@tedix.tech",
			localPart: "worker",
			domain: "tedix.tech",
			kind: "primary",
			status: "active",
			routingPolicy: null,
		});
		queries.updateAddressStatus.mockImplementation(async (_db, input) => ({
			id: input.id,
			organizationId: input.organizationId,
			tediId: input.tediId,
			address: "worker@tedix.tech",
			localPart: "worker",
			domain: "tedix.tech",
			kind: "primary",
			status: input.status ?? "active",
			routingPolicy: input.routingPolicy ?? null,
		}));
		queries.deleteAddress.mockResolvedValue({
			id: ADDRESS_ID,
			address: "worker@tedix.tech",
		});
	});

	it("lets an org admin create and activate its own slug address", async () => {
		const { address } = await orgAdmin().createAddress({
			tediId: TEDI,
			address: "Worker@Tedix.tech",
			kind: "primary",
		});
		expect(address).toMatchObject({
			address: "worker@tedix.tech",
			status: "active",
			kind: "primary",
		});
		expect(queries.createAddress).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ status: "active", organizationId: ORG }),
		);

		const plus = await orgAdmin().createAddress({
			tediId: TEDI,
			address: "worker+billing@tedix.tech",
			kind: "plus",
		});
		expect(plus.address).toMatchObject({ status: "active", kind: "plus" });
	});

	it("rejects a local part that is not the tedi slug, a bad plus tag, or a foreign domain", async () => {
		for (const [address, kind] of [
			["other@tedix.tech", "primary"],
			["worker+Bad_Tag@tedix.tech", "plus"],
			["other+tag@tedix.tech", "plus"],
			["worker@example.com", "primary"],
		] as const) {
			await expect(
				orgAdmin().createAddress({ tediId: TEDI, address, kind }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(queries.createAddress).not.toHaveBeenCalled();
	});

	it("keeps custom-domain activation behind platform authority", async () => {
		await expect(
			orgAdmin().createAddress({
				tediId: TEDI,
				address: "worker@example.com",
				kind: "custom_domain",
				status: "active",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const { address } = await orgAdmin().createAddress({
			tediId: TEDI,
			address: "worker@example.com",
			kind: "custom_domain",
		});
		expect(address.status).toBe("reserved");

		queries.addressById.mockResolvedValue({
			id: ADDRESS_ID,
			organizationId: ORG,
			tediId: TEDI,
			address: "worker@example.com",
			localPart: "worker",
			domain: "example.com",
			kind: "custom_domain",
			status: "reserved",
			routingPolicy: null,
		});
		await expect(
			orgAdmin().updateAddress({
				tediId: TEDI,
				addressId: ADDRESS_ID,
				status: "active",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			orgAdmin().deleteAddress({ tediId: TEDI, addressId: ADDRESS_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(queries.updateAddressStatus).not.toHaveBeenCalled();
		expect(queries.deleteAddress).not.toHaveBeenCalled();
	});

	it("keeps a tedi JWT on reserved and out of mailbox administration", async () => {
		const { address } = await tediJwt().createAddress({
			tediId: TEDI,
			address: "worker@tedix.tech",
			kind: "primary",
			status: "active",
		});
		expect(address.status).toBe("reserved");
		await expect(
			tediJwt().updateAddress({
				tediId: TEDI,
				addressId: ADDRESS_ID,
				status: "paused",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			tediJwt().deleteAddress({ tediId: TEDI, addressId: ADDRESS_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("validates and lowercases the routing policy", async () => {
		await expect(
			orgAdmin().updateAddress({
				tediId: TEDI,
				addressId: ADDRESS_ID,
				routingPolicy: { allowedSenders: ["not-an-email"] },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			orgAdmin().updateAddress({
				tediId: TEDI,
				addressId: ADDRESS_ID,
				routingPolicy: { spamThreshold: 99 },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			orgAdmin().updateAddress({
				tediId: TEDI,
				addressId: ADDRESS_ID,
				routingPolicy: { unknownKey: true } as never,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const { address } = await orgAdmin().updateAddress({
			tediId: TEDI,
			addressId: ADDRESS_ID,
			status: "paused",
			routingPolicy: {
				allowedSenders: [" Alice@Example.com ", "@Partner.example.com"],
				untrustedSenders: "quarantine",
				spamThreshold: 3,
			},
		});
		expect(address.status).toBe("paused");
		expect(address.routingPolicy).toEqual({
			allowedSenders: ["alice@example.com", "@partner.example.com"],
			untrustedSenders: "quarantine",
			spamThreshold: 3,
		});
	});

	it("rejects a tenant moving an address back to reserved", async () => {
		await expect(
			orgAdmin().updateAddress({
				tediId: TEDI,
				addressId: ADDRESS_ID,
				status: "reserved",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("deletes an own shared-domain address", async () => {
		await expect(
			orgAdmin().deleteAddress({ tediId: TEDI, addressId: ADDRESS_ID }),
		).resolves.toEqual({
			deleted: true,
			addressId: ADDRESS_ID,
			address: "worker@tedix.tech",
		});
		expect(queries.deleteAddress).toHaveBeenCalledWith(expect.anything(), {
			id: ADDRESS_ID,
			tediId: TEDI,
			organizationId: ORG,
		});
	});

	it("denies a caller from another organization and one without tedis:update", async () => {
		for (const call of [
			() =>
				orgAdmin(OTHER_ORG).createAddress({
					tediId: TEDI,
					address: "worker@tedix.tech",
					kind: "primary",
				}),
			() =>
				orgAdmin(OTHER_ORG).updateAddress({
					tediId: TEDI,
					addressId: ADDRESS_ID,
					status: "active",
				}),
			() =>
				orgAdmin(OTHER_ORG).deleteAddress({
					tediId: TEDI,
					addressId: ADDRESS_ID,
				}),
			() =>
				orgAdmin(ORG, ["tedis:read"]).createAddress({
					tediId: TEDI,
					address: "worker@tedix.tech",
					kind: "primary",
				}),
		]) {
			await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(queries.createAddress).not.toHaveBeenCalled();
		expect(queries.updateAddressStatus).not.toHaveBeenCalled();
		expect(queries.deleteAddress).not.toHaveBeenCalled();
	});
});
