import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	authorizeRuntimeInference: vi.fn(),
	releaseBillingReservation: vi.fn(),
}));

vi.mock("./runtime-entitlement-admission", () => ({
	authorizeRuntimeInference: mocks.authorizeRuntimeInference,
}));
vi.mock("@tedix/db/queries/billing/reservations", () => ({
	releaseBillingReservation: mocks.releaseBillingReservation,
}));

import {
	authorizeWorkspaceInference,
	releaseInferenceReservation,
} from "./workspace-inference-admission";

const execution = {
	provider: "workers-ai" as const,
	requestModel: "@cf/fixture/model",
	gatewayAccountId: "fixture-account",
	gatewayId: "fixture-gateway",
	transportKind: "gateway-https" as const,
	apiKind: "workers-ai-chat" as const,
	providerResource: null,
	providerOrigin: null,
	deployment: null,
};

const request = {
	organizationId: "org-1",
	workspaceId: "workspace-1",
	turnId: "turn-1",
	execution,
	estimatedInputTokens: 120,
	estimatedOutputTokens: 16_000,
	idempotencyKey: "workspace-inference:fixture",
};

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.authorizeRuntimeInference.mockResolvedValue({
		allowed: false,
		code: "member_monthly_credit_cap_reached",
		entitlement: null,
	});
});

describe("workspace chat inference admission", () => {
	it.each([
		["a member's turn", { userId: "user-1" }, "user-1", null],
		[
			"a guest tedi turn a member sent",
			{ userId: "user-1", tediId: "tedi-1" },
			"user-1",
			"tedi-1",
		],
		["an agent's turn", {}, null, null],
	] as const)(
		"reserves through the shared path for %s",
		async (_label, actor, userId, tediId) => {
			const result = await authorizeWorkspaceInference({
				db: {} as never,
				env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
				request: { ...request, ...actor },
			});
			expect(result).toEqual({
				allowed: false,
				code: "member_monthly_credit_cap_reached",
				entitlement: null,
			});
			expect(mocks.authorizeRuntimeInference).toHaveBeenCalledWith(
				expect.objectContaining({
					plane: "workspace_object",
					request: expect.objectContaining({
						organizationId: "org-1",
						tediId,
						userId,
						settlementMode: "managed",
						source: "operator",
						execution,
						workItemId: null,
						// The gateway log names the turn as its run, so settlement matches it.
						runId: "turn-1",
						idempotencyKey: "workspace-inference:fixture",
					}),
				}),
			);
		},
	);

	it("releases an unused hold and reports whether one was held", async () => {
		mocks.releaseBillingReservation.mockResolvedValueOnce({ id: "r-1" });
		await expect(
			releaseInferenceReservation({
				db: {} as never,
				request: {
					organizationId: "org-1",
					reservationId: "r-1",
					reason: "provider_request_not_sent",
				},
				nowMs: Date.parse("2026-11-19T12:00:00.000Z"),
			}),
		).resolves.toEqual({ released: true });
		expect(mocks.releaseBillingReservation).toHaveBeenCalledWith(
			{},
			{
				reservationId: "r-1",
				organizationId: "org-1",
				reason: "provider_request_not_sent",
				now: "2026-11-19T12:00:00.000Z",
			},
		);
		mocks.releaseBillingReservation.mockResolvedValueOnce(null);
		await expect(
			releaseInferenceReservation({
				db: {} as never,
				request: {
					organizationId: "org-1",
					reservationId: "r-1",
					reason: "provider_request_failed",
				},
			}),
		).resolves.toEqual({ released: false });
	});
});
