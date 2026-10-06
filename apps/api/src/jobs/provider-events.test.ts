import { beforeEach, describe, it, expect, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	due: vi.fn(),
	prune: vi.fn(),
	claim: vi.fn(),
	update: vi.fn(),
	credential: vi.fn(),
	renew: vi.fn(),
	queue: vi.fn(),
	dispatch: vi.fn(),
	failure: vi.fn(),
}));
vi.mock("../rpc/orpc", () => ({ createContext: () => ({ db: {} }) }));
vi.mock("@tedix/db/queries/provider-events", () => ({
	pruneProviderEvents: mocks.prune,
	dueProviderEventSubscriptions: mocks.due,
	claimProviderEventSubscription: mocks.claim,
	updateProviderEventSubscription: mocks.update,
}));
vi.mock("../services/provider-events/credentials", () => ({
	resolveProviderEventCredential: mocks.credential,
}));
vi.mock("../services/provider-events/subscriptions", () => ({
	renewSubscription: mocks.renew,
	queueReconciliation: mocks.queue,
	dispatchProviderEventDeliveries: mocks.dispatch,
	recordSubscriptionFailure: mocks.failure,
	RECONCILE_INTERVAL_MS: 300_000,
	RENEW_BEFORE_MS: 3_600_000,
}));
import { maintainProviderEvents } from "./provider-events";
const row = {
	id: "sub",
	organizationId: "org",
	deliveryMode: "push",
	expiresAt: new Date(Date.now() + 1000).toISOString(),
	nextReconcileAt: "due",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.prune.mockResolvedValue({ channels: 0, deliveries: 0 });
	mocks.due.mockResolvedValue([row]);
	mocks.claim.mockResolvedValue(true);
	mocks.credential.mockResolvedValue("vault");
	mocks.queue.mockResolvedValue(true);
	mocks.dispatch.mockResolvedValue(1);
});
describe("provider notification maintenance", () => {
	it("renews before expiry and queues missing-notification reconciliation using due-time identity", async () => {
		expect(await maintainProviderEvents({} as CloudflareEnv)).toMatchObject({
			renewed: 1,
			reconciled: 1,
			dispatched: 1,
			failed: 0,
		});
		expect(mocks.renew).toHaveBeenCalledWith(expect.anything(), row, "vault");
		expect(mocks.queue).toHaveBeenCalledWith(
			expect.anything(),
			row,
			"poll:due",
		);
	});
	it("cannot create parallel renewal under a lost D1 claim", async () => {
		mocks.claim.mockResolvedValue(false);
		await maintainProviderEvents({} as CloudflareEnv);
		expect(mocks.renew).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
	});
	it("does not renew explicit polling and marks failures while still draining outbox", async () => {
		mocks.due.mockResolvedValue([{ ...row, deliveryMode: "poll" }]);
		await maintainProviderEvents({} as CloudflareEnv);
		expect(mocks.renew).not.toHaveBeenCalled();
		mocks.credential.mockRejectedValue(new Error("revoked"));
		expect(await maintainProviderEvents({} as CloudflareEnv)).toMatchObject({
			failed: 1,
			dispatched: 1,
		});
		expect(mocks.failure).toHaveBeenCalled();
	});
});
