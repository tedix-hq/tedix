import { call } from "@orpc/server";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userContext } from "../../test-context";

const mocks = vi.hoisted(() => ({
	stage: vi.fn(),
	byHash: vi.fn(),
	redeem: vi.fn(),
	instance: vi.fn(),
	organization: vi.fn(),
	named: vi.fn(),
}));
vi.mock("@tedix/db/queries/connection-connect-tickets", () => ({
	stageConnectionConnectTicket: mocks.stage,
	getConnectionConnectTicketByHash: mocks.byHash,
	redeemConnectionConnectTicket: mocks.redeem,
}));
vi.mock("@tedix/db/queries/connection-instances", async (load) => ({
	...(await load<object>()),
	getConnectionInstance: mocks.instance,
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<object>()),
	getOrganizationById: mocks.organization,
}));
vi.mock("./policy-resolution", async (load) => ({
	...(await load<object>()),
	fetchNamedConnection: mocks.named,
}));
import { redeemConnectTicket, stageConnectTicket } from "./connect-tickets";

const slot = "11111111-1111-4111-8111-111111111111";
function context(sub = "user-1", permissions = ["apps:read"]) {
	return userContext({ sub, permissions });
}
function staged(patch: Record<string, unknown> = {}) {
	return {
		id: "ticket-1",
		organizationId: "org-1",
		userId: "user-1",
		providerId: "fictional-mail",
		scope: "user",
		connectionInstanceId: null,
		ticketHash: "hash",
		status: "staged",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		createdAt: new Date().toISOString(),
		redeemedAt: null,
		...patch,
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.stage.mockImplementation(async (_db, row) => row);
	mocks.redeem.mockImplementation(async (_db, params) =>
		staged({ status: "redeemed", redeemedAt: params.now }),
	);
	mocks.instance.mockResolvedValue({ id: slot });
	mocks.named.mockResolvedValue({ id: "token-1" });
});

describe("staged connect tickets", () => {
	it("stages a hashed ticket bound to the signed-in person and returns the raw value once", async () => {
		const result = await call(
			stageConnectTicket,
			{ appId: "fictional-mail", scope: "user" },
			{ context: context() },
		);
		expect(result.ticket.length).toBeGreaterThanOrEqual(32);
		const row = mocks.stage.mock.calls[0]![1];
		expect(row).toMatchObject({
			organizationId: "org-1",
			userId: "user-1",
			providerId: "fictional-mail",
			scope: "user",
			connectionInstanceId: null,
			status: "staged",
			ticketHash: await sha256Hex(result.ticket),
		});
		expect(row.ticketHash).not.toContain(result.ticket);
		expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(Date.now());
	});
	it("refuses to stage a named slot the person does not own", async () => {
		mocks.instance.mockResolvedValue(undefined);
		await expect(
			call(
				stageConnectTicket,
				{ appId: "fictional-mail", scope: "user", connectionInstanceId: slot },
				{ context: context() },
			),
		).rejects.toThrow(/Account not found/);
		expect(mocks.stage).not.toHaveBeenCalled();
	});
	it("redeems once over the same person's session", async () => {
		mocks.byHash.mockResolvedValue(staged());
		const result = await call(
			redeemConnectTicket,
			{ ticket: "raw-ticket" },
			{ context: context() },
		);
		expect(mocks.byHash).toHaveBeenCalledWith(
			expect.anything(),
			await sha256Hex("raw-ticket"),
		);
		expect(mocks.redeem).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: "ticket-1",
				organizationId: "org-1",
				userId: "user-1",
			}),
		);
		expect(result).toEqual({
			appId: "fictional-mail",
			scope: "user",
			connectionInstanceId: null,
			recorded: false,
		});
	});
	it("refuses a different signed-in person, another organization, reuse and expiry", async () => {
		mocks.byHash.mockResolvedValue(staged());
		await expect(
			call(
				redeemConnectTicket,
				{ ticket: "raw-ticket" },
				{ context: context("user-2") },
			),
		).rejects.toThrow(/different person/);
		mocks.byHash.mockResolvedValue(staged({ organizationId: "org-2" }));
		await expect(
			call(
				redeemConnectTicket,
				{ ticket: "raw-ticket" },
				{ context: context() },
			),
		).rejects.toThrow(/not started in this workspace/);
		mocks.byHash.mockResolvedValue(staged({ status: "redeemed" }));
		await expect(
			call(
				redeemConnectTicket,
				{ ticket: "raw-ticket" },
				{ context: context() },
			),
		).rejects.toThrow(/already completed/);
		mocks.byHash.mockResolvedValue(
			staged({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
		);
		await expect(
			call(
				redeemConnectTicket,
				{ ticket: "raw-ticket" },
				{ context: context() },
			),
		).rejects.toThrow(/took too long/);
		mocks.byHash.mockResolvedValue(undefined);
		await expect(
			call(
				redeemConnectTicket,
				{ ticket: "raw-ticket" },
				{ context: context() },
			),
		).rejects.toThrow(/not started in this workspace/);
		expect(mocks.redeem).not.toHaveBeenCalled();
		expect(mocks.named).not.toHaveBeenCalled();
	});
	it("loses a concurrent redeem race without recording anything", async () => {
		mocks.byHash.mockResolvedValue(staged({ connectionInstanceId: slot }));
		mocks.redeem.mockResolvedValue(undefined);
		await expect(
			call(
				redeemConnectTicket,
				{ ticket: "raw-ticket" },
				{ context: context() },
			),
		).rejects.toThrow(/already completed/);
		expect(mocks.named).not.toHaveBeenCalled();
	});
	it("records a named personal slot's grant under the redeeming person's own session", async () => {
		mocks.byHash.mockResolvedValue(staged({ connectionInstanceId: slot }));
		mocks.redeem.mockResolvedValue(
			staged({ connectionInstanceId: slot, status: "redeemed" }),
		);
		const result = await call(
			redeemConnectTicket,
			{ ticket: "raw-ticket" },
			{ context: context() },
		);
		expect(mocks.named).toHaveBeenCalledWith(
			expect.anything(),
			{ userId: "user-1" },
			"fictional-mail",
			slot,
		);
		expect(result).toMatchObject({
			connectionInstanceId: slot,
			recorded: true,
		});
	});
});
