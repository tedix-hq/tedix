import { beforeEach, describe, it, expect, vi } from "vite-plus/test";
import type { BaseContext } from "../../rpc/orpc";
import type { Subscription } from "./types";
const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	get: vi.fn(),
	update: vi.fn(),
	addChannel: vi.fn(),
	channels: vi.fn(),
	updateChannel: vi.fn(),
	delivery: vi.fn(),
	pending: vi.fn(),
	claim: vi.fn(),
	settle: vi.fn(),
	credential: vi.fn(),
	register: vi.fn(),
	validate: vi.fn(),
	stop: vi.fn(),
	emit: vi.fn(),
	standing: vi.fn(),
	authorize: vi.fn(),
	run: vi.fn(),
}));
vi.mock("@tedix/db/queries/provider-events", () => ({
	createProviderEventSubscription: mocks.create,
	getProviderEventSubscription: mocks.get,
	updateProviderEventSubscription: mocks.update,
	addProviderEventChannel: mocks.addChannel,
	listProviderEventChannels: mocks.channels,
	updateProviderEventChannel: mocks.updateChannel,
	addProviderEventDelivery: mocks.delivery,
	listPendingProviderEventDeliveries: mocks.pending,
	claimProviderEventDelivery: mocks.claim,
	settleProviderEventDelivery: mocks.settle,
}));
vi.mock("./credentials", () => ({
	resolveProviderEventCredential: mocks.credential,
}));
vi.mock("./google-calendar", () => ({
	googleCalendarAdapter: () => ({
		register: mocks.register,
		stop: mocks.stop,
		validateCalendar: mocks.validate,
	}),
}));
vi.mock("../personal-resource-delegation-authority", () => ({
	resolvePersonalSubscriptionCredential: mocks.standing,
	authorizePersonalResourceDelegation: mocks.authorize,
}));
vi.mock("../../rpc/routers/cognitive-skill-runs", () => ({
	skillsRunWorkflow: {},
}));
vi.mock("../../rpc/routers/cognitive-runtime", () => ({
	cognitiveRuntimeContractRouter: {},
}));
vi.mock("../../rpc/routers/kernel/runtime-shared", () => ({
	buildInternalServiceBindingContext: (base: unknown) => base,
}));
vi.mock("@orpc/server", () => ({
	createRouterClient: () => ({
		emitAutomationEvent: mocks.emit,
		runWorkflow: mocks.run,
	}),
}));
import {
	registerSubscription,
	renewSubscription,
	disableSubscription,
	dispatchProviderEventDeliveries,
	queueReconciliation,
	reconciliationEvent,
	loadSubscription,
} from "./subscriptions";
const id = "11111111-1111-4111-8111-111111111111";
const context = { db: {}, env: { API_URL: "https://api.test" } } as BaseContext;
let row: Subscription;
beforeEach(() => {
	vi.clearAllMocks();
	row = {
		id,
		organizationId: "org-a",
		adapter: "google_calendar",
		providerId: "google",
		connectionInstanceId: id,
		calendarId: "selected",
		connectionScope: "tenant",
		personalOwnerUserId: null,
		workspaceId: null,
		workspaceResourceId: null,
		delegationId: null,
		executionToolId: null,
		resourceDelegationIds: [],
		tediId: id,
		skillId: id,
		skillRevision: 3,
		deliveryMode: "push",
		status: "active",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		nextReconcileAt: new Date().toISOString(),
		lastNotificationAt: null,
		lastDispatchAt: null,
		lastError: null,
		leaseUntil: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	mocks.get.mockImplementation(async () => row);
	mocks.update.mockImplementation(async (_db, _org, _id, patch) => {
		row = { ...row, ...patch };
		return [row];
	});
	mocks.create.mockImplementation(async (_db, value) => {
		row = value;
	});
	mocks.credential.mockResolvedValue("vault-token");
	mocks.stop.mockResolvedValue(undefined);
	mocks.register.mockImplementation(async (_token, _row, channelId) => ({
		providerChannelId: channelId,
		resourceId: "google-resource",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	}));
	mocks.channels.mockResolvedValue([]);
	mocks.delivery.mockResolvedValue([{}]);
	mocks.claim.mockResolvedValue(true);
	mocks.pending.mockResolvedValue([
		{ id: "delivery", organizationId: "org-a", subscriptionId: id },
	]);
	mocks.emit.mockResolvedValue({ queued: true });
});
describe("standing subscription lifecycle", () => {
	it("persists a hash-only pending channel before provider registration and retires old channels afterward", async () => {
		const order: string[] = [];
		mocks.addChannel.mockImplementation(async () => order.push("persist"));
		mocks.register.mockImplementation(async (_t, _r, id) => {
			order.push("provider");
			return {
				providerChannelId: id,
				resourceId: "resource",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			};
		});
		mocks.channels.mockResolvedValue([
			{
				id: "old",
				status: "active",
				providerChannelId: "old-provider",
				resourceId: "old-resource",
			},
		]);
		await renewSubscription(context, row);
		expect(order).toEqual(["persist", "provider"]);
		const saved = mocks.addChannel.mock.calls[0][1];
		expect(saved.tokenHash).toMatch(/^[a-f0-9]{64}$/);
		expect(saved).not.toHaveProperty("secret");
		expect(saved).not.toHaveProperty("accessToken");
		expect(mocks.stop).toHaveBeenCalledWith(
			"vault-token",
			"old-provider",
			"old-resource",
		);
	});
	it("persists disable before provider cleanup and never re-enables on credential failure", async () => {
		mocks.credential.mockRejectedValue(new Error("private-token"));
		const result = await disableSubscription(context, "org-a", id);
		expect(result.status).toBe("disabled");
		expect(result.lastError).not.toContain("private-token");
		expect(mocks.update.mock.calls[0][3]).toMatchObject({ status: "disabled" });
	});
	it("stops a new registration when disabled during the network request", async () => {
		mocks.register.mockImplementation(async (_t, _r, id) => {
			row.status = "disabled";
			return {
				providerChannelId: id,
				resourceId: "resource",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			};
		});
		await renewSubscription(context, row);
		expect(row.status).toBe("disabled");
		expect(mocks.stop).toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ status: "active" }),
		);
	});
	it("validates vault authority before recording standing automation", async () => {
		mocks.credential.mockRejectedValue(new Error("no tenant connection"));
		await expect(
			registerSubscription(context, "org-a", {
				adapter: "google_calendar",
				providerId: "google",
				connectionInstanceId: id,
				calendarId: "selected",
				connectionScope: "tenant",
				resourceDelegationIds: [],
				tediId: id,
				skillId: id,
				skillRevision: 3,
				deliveryMode: "push",
			}),
		).rejects.toThrow("no tenant");
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("explicit polling does not register push and still creates executable reconciliation work", async () => {
		const result = await registerSubscription(context, "org-a", {
			adapter: "google_calendar",
			providerId: "google",
			connectionInstanceId: id,
			calendarId: "selected",
			connectionScope: "tenant",
			resourceDelegationIds: [],
			tediId: id,
			skillId: id,
			skillRevision: 3,
			deliveryMode: "poll",
		});
		expect(result.status).toBe("active");
		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.delivery).toHaveBeenCalled();
	});
});
describe("durable dispatch authority and retries", () => {
	it("rechecks credential and publishes org-owned selected-calendar workflow with stable dedupe", async () => {
		expect(await dispatchProviderEventDeliveries(context)).toBe(1);
		expect(mocks.credential).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				id: row.id,
				organizationId: row.organizationId,
			}),
		);
		expect(mocks.emit).toHaveBeenCalledWith({
			event: reconciliationEvent(row, "delivery"),
		});
		expect(
			mocks.emit.mock.calls[0][0].event.params.providerEvent,
		).toMatchObject({ calendarId: "selected", skillRevision: 3 });
		expect(mocks.settle).toHaveBeenCalledWith(
			{},
			"delivery",
			"org-a",
			"sent",
			expect.any(String),
		);
	});
	it("returns failed queue publication to pending with same idempotency identity", async () => {
		mocks.emit.mockRejectedValueOnce(new Error("temporary"));
		expect(await dispatchProviderEventDeliveries(context)).toBe(0);
		expect(mocks.settle).toHaveBeenCalledWith(
			{},
			"delivery",
			"org-a",
			"pending",
			expect.any(String),
		);
		mocks.emit.mockResolvedValue({ queued: true });
		expect(await dispatchProviderEventDeliveries(context)).toBe(1);
		expect(mocks.emit.mock.calls[0][0].event.idempotencyKey).toBe(
			mocks.emit.mock.calls[1][0].event.idempotencyKey,
		);
	});
	it("discards revoked subscriptions and never emits revoked/missing credentials", async () => {
		row.status = "disabled";
		expect(await dispatchProviderEventDeliveries(context)).toBe(0);
		expect(mocks.emit).not.toHaveBeenCalled();
		row.status = "active";
		mocks.credential.mockRejectedValue(new Error("revoked"));
		expect(await dispatchProviderEventDeliveries(context)).toBe(0);
		expect(mocks.emit).not.toHaveBeenCalled();
	});
	it("rejects a selected calendar read before persisting polling configuration", async () => {
		mocks.validate.mockRejectedValueOnce(new Error("not readable"));
		await expect(
			registerSubscription(context, "org-a", {
				adapter: "google_calendar",
				providerId: "google",
				connectionInstanceId: id,
				calendarId: "selected",
				connectionScope: "tenant",
				resourceDelegationIds: [],
				tediId: id,
				skillId: id,
				skillRevision: 3,
				deliveryMode: "poll",
			}),
		).rejects.toThrow("not readable");
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("terminates exhausted notification deliveries with an actionable error", async () => {
		mocks.pending.mockResolvedValue([
			{
				id: "delivery",
				organizationId: "org-a",
				subscriptionId: id,
				attempts: 10,
			},
		]);
		expect(await dispatchProviderEventDeliveries(context)).toBe(0);
		expect(mocks.emit).not.toHaveBeenCalled();
		expect(mocks.settle).toHaveBeenCalledWith(
			{},
			"delivery",
			"org-a",
			"discarded",
			expect.any(String),
		);
		expect(row.lastError).toContain("reconcile manually");
	});
	it("does not create notifications after revocation", async () => {
		row.status = "disabled";
		expect(await queueReconciliation(context, row, "event")).toBe(false);
		expect(mocks.delivery).not.toHaveBeenCalled();
	});
});

describe("personal notification dispatch", () => {
	it("passes fresh standing consent envelope into the durable pinned run", async () => {
		row = {
			...row,
			connectionScope: "user",
			personalOwnerUserId: "owner",
			workspaceId: id,
			workspaceResourceId: id,
			delegationId: id,
			executionToolId: "reconcile_calendar_subscription",
			resourceDelegationIds: [id],
		};
		const internal = {
			...context,
			authType: "service-binding",
			headers: new Headers(),
			organizationId: "org-a",
		} as BaseContext;
		const envelope = { version: 1, sources: [{ type: "test" }] };
		mocks.standing.mockResolvedValue({ resourceAccessEnvelope: envelope });
		expect(await dispatchProviderEventDeliveries(internal)).toBe(1);
		expect(mocks.run).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedSkillRevision: 3,
				resourceAccessEnvelope: envelope,
				idempotencyKey: expect.stringContaining("provider-event:"),
			}),
		);
		expect(mocks.emit).not.toHaveBeenCalled();
	});
	it("never starts a run after consent revocation", async () => {
		row = { ...row, connectionScope: "user", personalOwnerUserId: "owner" };
		const internal = {
			...context,
			authType: "service-binding",
			headers: new Headers(),
			organizationId: "org-a",
		} as BaseContext;
		mocks.standing.mockRejectedValue(new Error("Consent revoked"));
		expect(await dispatchProviderEventDeliveries(internal)).toBe(0);
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.emit).not.toHaveBeenCalled();
	});
});

it("allows only the exact admitted worker to read a personal subscription", async () => {
	row = {
		...row,
		connectionScope: "user",
		personalOwnerUserId: "owner",
		workspaceId: id,
		workspaceResourceId: id,
		delegationId: id,
		executionToolId: "reconcile_calendar_subscription",
		resourceDelegationIds: [id],
	};
	const worker = {
		...context,
		authType: "service-binding",
		tediId: id,
		organizationId: "org-a",
		headers: new Headers({
			"X-Tedix-Mcp-Tool-Id": "reconcile_calendar_subscription",
		}),
	} as BaseContext;
	mocks.authorize.mockResolvedValue({ ownerUserId: "owner" });
	expect((await loadSubscription(worker, "org-a", id)).id).toBe(id);
	expect(mocks.authorize).toHaveBeenCalledWith(
		worker,
		expect.objectContaining({
			delegationId: id,
			operation: "subscribe",
			toolId: "reconcile_calendar_subscription",
			providerResourceId: "selected",
		}),
	);
	mocks.authorize.mockRejectedValue(new Error("No admitted run"));
	await expect(loadSubscription(worker, "org-a", id)).rejects.toThrow(
		"No admitted run",
	);
});
it("stops the newly created channel when consent changes during provider registration", async () => {
	mocks.credential.mockRejectedValue(new Error("Consent revoked"));
	await expect(renewSubscription(context, row, "prior-token")).rejects.toThrow(
		"Consent revoked",
	);
	expect(mocks.stop).toHaveBeenCalled();
	expect(mocks.update).not.toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		expect.anything(),
		expect.objectContaining({ status: "active" }),
	);
});

it("queues a capability-verified personal callback without requiring the provider to be the account owner", async () => {
	row = { ...row, connectionScope: "user", personalOwnerUserId: "owner" };
	expect(
		await queueReconciliation(context, row, "google:verified-channel:1"),
	).toBe(true);
	expect(mocks.authorize).not.toHaveBeenCalled();
	row = { ...row, status: "disabled" };
	expect(
		await queueReconciliation(context, row, "google:verified-channel:2"),
	).toBe(false);
});
