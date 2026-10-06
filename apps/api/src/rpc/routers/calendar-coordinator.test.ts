import { beforeEach, describe, it, expect, vi } from "vite-plus/test";
import { ConfigureCalendarsInputSchema } from "@tedix/api-contract/schemas/calendar-coordinator";
import { calendarOwnerUser } from "../../services/calendar-coordinator/credentials";
import type { BaseContext } from "../orpc";
const id = "11111111-1111-4111-8111-111111111111";
const base = {
	workspaceId: id,
	expectedRevision: 0,
	tediId: id,
	skillId: id,
	skillRevision: 1,
	timeZone: "UTC",
	window: { start: "2026-10-01T00:00:00Z", end: "2026-10-10T00:00:00Z" },
	calendars: [
		{
			key: "a",
			adapter: "google",
			providerId: "p",
			connectionScope: "user",
			connectionInstanceId: id,
			calendarId: "a",
			workspaceResourceId: id,
		},
		{
			key: "b",
			adapter: "google",
			providerId: "p",
			connectionScope: "user",
			connectionInstanceId: id,
			calendarId: "b",
			workspaceResourceId: id,
		},
	],
};
describe("calendar setup boundary", () => {
	it("requires exact named account, canonical workspace resources and distinct selected calendars", () => {
		expect(ConfigureCalendarsInputSchema.safeParse(base).success).toBe(true);
		expect(
			ConfigureCalendarsInputSchema.safeParse({
				...base,
				calendars: [base.calendars[0], base.calendars[0]],
			}).success,
		).toBe(false);
		expect(
			ConfigureCalendarsInputSchema.safeParse({
				...base,
				calendars: base.calendars.map((c) => ({
					...c,
					connectionInstanceId: undefined,
				})),
			}).success,
		).toBe(false);
	});
	it("rejects API key, standalone tedi and service-binding impersonation for personal interactive access", () => {
		for (const authType of ["tedi", "apikey", "service-binding", "m2m"])
			expect(() =>
				calendarOwnerUser({ authType, user: { sub: "owner" } } as BaseContext),
			).toThrow("signed-in");
		expect(
			calendarOwnerUser({
				authType: "user",
				user: { sub: "owner" },
			} as BaseContext),
		).toBe("owner");
	});
});

const mocks = vi.hoisted(() => ({
	providers: vi.fn(),
	instances: vi.fn(),
	instance: vi.fn(),
	personal: vi.fn(),
	tenant: vi.fn(),
	register: vi.fn(),
	disable: vi.fn(),
	subscription: vi.fn(),
}));
vi.mock("@tedix/db/queries/connection-providers", () => ({
	listConnectionProviders: mocks.providers,
}));
vi.mock("@tedix/db/queries/connection-instances", () => ({
	listConnectionInstances: mocks.instances,
	getConnectionInstance: mocks.instance,
}));
vi.mock("@tedix/auth/connections", () => ({
	fetchPersonalConnectionToken: mocks.personal,
	fetchNamedTenantConnectionToken: mocks.tenant,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationDescopeTenantId: async () => "tenant",
}));
vi.mock("../../services/provider-events/subscriptions", () => ({
	registerSubscription: mocks.register,
	disableSubscription: mocks.disable,
	loadSubscription: mocks.subscription,
	statusProjection: (row: unknown) => row,
}));
import {
	resolveCalendarAdapter,
	supportedCalendarAccounts,
} from "../../services/calendar-coordinator/credentials";
import {
	installCalendarMonitoring,
	calendarMonitoringStatus,
} from "../../services/calendar-coordinator/state";
import type { Configuration } from "../../services/calendar-coordinator/types";
beforeEach(() => {
	vi.clearAllMocks();
	mocks.providers.mockResolvedValue([
		{ id: "google-calendar", descopeAppId: "google-calendar" },
	]);
	mocks.instances.mockResolvedValue([
		{
			id,
			providerId: "google-calendar",
			label: "Adriana",
			tokenIds: ["token"],
			tokenSub: "verified-subject",
		},
	]);
	mocks.instance.mockResolvedValue({
		id,
		tokenIds: ["token"],
		tokenSub: "verified-subject",
	});
	mocks.personal.mockResolvedValue({
		id: "token",
		accessToken: "secret",
		tokenSub: "verified-subject",
		scopes: [],
	});
});

describe("exact calendar accounts and installed monitoring", () => {
	it("classifies from canonical provider inventory and keeps editable label separate from verified subject", async () => {
		const ctx = {
			authType: "user",
			user: { sub: "owner" },
			db: {},
		} as BaseContext;
		const rows = await supportedCalendarAccounts(ctx, "org", "user");
		expect(rows[0]).toMatchObject({
			adapter: "google",
			instanceLabel: "Adriana",
			accountSubject: "verified-subject",
		});
		expect(rows[0]).not.toHaveProperty("accessToken");
	});
	it("uses only the exact owner slot and rejects changed credential identity", async () => {
		const ctx = {
			authType: "user",
			user: { sub: "owner" },
			db: {},
			env: {},
		} as BaseContext;
		const selected = {
			adapter: "google" as const,
			providerId: "google-calendar",
			connectionScope: "user" as const,
			connectionInstanceId: id,
		};
		await resolveCalendarAdapter(ctx, "org", selected);
		expect(mocks.personal.mock.calls[0]![1]).toMatchObject({
			userId: "owner",
			externalIdentifier: `tedix_${id}`,
		});
		mocks.personal.mockResolvedValue({
			accessToken: "wrong",
			tokenSub: "other-subject",
		});
		await expect(resolveCalendarAdapter(ctx, "org", selected)).rejects.toThrow(
			"identity changed",
		);
		expect(mocks.tenant).not.toHaveBeenCalled();
	});
	it("does not turn foreground personal access into background access without explicit delegation", async () => {
		await expect(
			resolveCalendarAdapter(
				{} as BaseContext,
				"org",
				{
					adapter: "google",
					providerId: "google-calendar",
					connectionScope: "user",
					connectionInstanceId: id,
				},
				true,
			),
		).rejects.toThrow("explicit revocable delegation");
		expect(mocks.personal).not.toHaveBeenCalled();
	});
	it("rolls back partial provider registration rather than reporting active", async () => {
		const config = {
			id: "config",
			organizationId: "org",
			tediId: id,
			skillId: id,
			skillRevision: 2,
			calendars: base.calendars.map((c) => ({
				...c,
				adapter: "google",
				connectionScope: "tenant",
			})),
		} as Configuration;
		mocks.register
			.mockResolvedValueOnce({
				id: "one",
				status: "active",
				deliveryMode: "push",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
			.mockResolvedValueOnce({
				id: "two",
				status: "error",
				deliveryMode: "push",
				expiresAt: null,
			});
		await expect(
			installCalendarMonitoring({} as BaseContext, config),
		).rejects.toThrow("activation remains disabled");
		expect(mocks.disable.mock.calls.map((c) => c[2])).toEqual(["one", "two"]);
	});
	it("reports an expired watch as needs attention even when configuration is active", async () => {
		mocks.subscription.mockResolvedValue({
			id: "one",
			status: "active",
			deliveryMode: "push",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		expect(
			(
				await calendarMonitoringStatus(
					{} as BaseContext,
					{
						organizationId: "org",
						mode: "active",
						subscriptionIds: ["one"],
					} as Configuration,
				)
			).monitoring,
		).toBe("needs_attention");
	});
});
