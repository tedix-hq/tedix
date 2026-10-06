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
	delegation: vi.fn(),
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
vi.mock("../../services/personal-resource-delegation-authority", () => ({
	authorizePersonalResourceDelegation: mocks.delegation,
	validatePersonalDelegationToken: (
		row: { accountSubject: string; requiredScopes: string[] },
		token: { id?: string; tokenSub?: string; scopes?: string[] },
		approved: string[],
		tokenId?: string,
	) => {
		if (
			!tokenId ||
			!approved.includes(tokenId) ||
			token.tokenSub !== row.accountSubject ||
			row.requiredScopes.some((s) => !token.scopes?.includes(s))
		)
			throw new Error(
				"Delegated token metadata differs from the approved grant",
			);
	},
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

describe("delegated coordinator credentials", () => {
	const route = {
		...base.calendars[0]!,
		adapter: "google" as const,
		connectionScope: "user" as const,
		providerId: "google-calendar",
		delegationId: id,
	};
	const authority = {
		workspaceId: id,
		tediId: id,
		skillId: id,
		skillRevision: 1,
		ownerUserId: "owner",
	};
	function worker() {
		return {
			authType: "service-binding",
			tediId: id,
			db: {},
			env: {},
			headers: new Headers({
				"X-Tedix-Mcp-Tool-Id": "reconcile_calendar_subscription",
			}),
		} as BaseContext;
	}
	function consent() {
		mocks.delegation.mockResolvedValue({
			ownerUserId: "owner",
			connectionInstanceId: id,
			approvedTokenIds: ["token"],
			delegation: {
				accountSubject: "verified-subject",
				requiredScopes: [
					"https://www.googleapis.com/auth/calendar.events",
					"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
				],
			},
		});
		mocks.personal.mockResolvedValue({
			id: "token",
			accessToken: "secret",
			tokenSub: "verified-subject",
			scopes: [
				"https://www.googleapis.com/auth/calendar.events",
				"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
			],
		});
	}
	it("reauthorizes exact live run consent and named token metadata without owner inventory fallback", async () => {
		consent();
		const selected = await resolveCalendarAdapter(
			worker(),
			"org",
			route,
			true,
			authority,
		);
		expect(selected.account.accountSubject).toBe("verified-subject");
		expect(mocks.instances).not.toHaveBeenCalled();
		expect(mocks.delegation).toHaveBeenCalledTimes(2);
		expect(mocks.delegation.mock.calls[0]![1]).toMatchObject({
			delegationId: id,
			resourceId: id,
			providerResourceId: "a",
			operation: "read",
			toolId: "reconcile_calendar_subscription",
			skillRevision: 1,
		});
		await expect(selected.adapter.listCalendars()).rejects.toThrow(
			"not a selected resource",
		);
		await expect(
			selected.adapter.get(
				{ ...route, key: "a", calendarId: "other" },
				"event",
			),
		).rejects.toThrow("differs from the delegated resource");
	});
	it("rejects a token outside approved grant IDs despite matching account subject", async () => {
		consent();
		mocks.personal.mockResolvedValue({
			id: "other-grant",
			accessToken: "secret",
			tokenSub: "verified-subject",
			scopes: [
				"https://www.googleapis.com/auth/calendar.events",
				"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
			],
		});
		await expect(
			resolveCalendarAdapter(worker(), "org", route, true, authority),
		).rejects.toThrow("metadata differs");
	});
	it("honors consent revocation between credential lookup and provider use", async () => {
		consent();
		mocks.delegation
			.mockResolvedValueOnce({
				ownerUserId: "owner",
				connectionInstanceId: id,
				approvedTokenIds: ["token"],
				delegation: {
					accountSubject: "verified-subject",
					requiredScopes: [
						"https://www.googleapis.com/auth/calendar.events",
						"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
					],
				},
			})
			.mockRejectedValueOnce(new Error("grant revoked"));
		await expect(
			resolveCalendarAdapter(worker(), "org", route, true, authority),
		).rejects.toThrow("revoked");
	});
	it("revalidates returned token against account grants changed during lookup", async () => {
		consent();
		const first = await mocks.delegation();
		mocks.delegation.mockClear();
		mocks.delegation.mockResolvedValueOnce(first).mockResolvedValueOnce({
			...first,
			approvedTokenIds: ["replacement-token"],
		});
		await expect(
			resolveCalendarAdapter(worker(), "org", route, true, authority),
		).rejects.toThrow("metadata differs");
	});
});

describe("standing monitoring binds every selected personal destination", () => {
	it("passes all exact consent IDs on every trigger and derives no owner identity from input", async () => {
		const second = "22222222-2222-4222-8222-222222222222";
		const config = {
			id: "config",
			organizationId: "org",
			workspaceId: id,
			tediId: id,
			skillId: id,
			skillRevision: 2,
			calendars: base.calendars.map((c, n) => ({
				...c,
				adapter: "google",
				connectionScope: "user",
				delegationId: n ? second : id,
				workspaceResourceId: n ? second : id,
			})),
		} as Configuration;
		mocks.register.mockResolvedValue({
			id: "watch",
			status: "active",
			deliveryMode: "poll",
			expiresAt: null,
		});
		await installCalendarMonitoring({} as BaseContext, config);
		expect(mocks.register).toHaveBeenCalledTimes(2);
		for (const call of mocks.register.mock.calls) {
			expect(call[2].connectionScope).toBe("user");
			expect(call[2].resourceDelegationIds).toEqual([id, second]);
			expect(call[2].personalDelegation.toolId).toBe(
				"reconcile_calendar_subscription",
			);
			expect(call[2]).not.toHaveProperty("personalOwnerUserId");
		}
		expect(mocks.register.mock.calls[1]![2].personalDelegation.resourceId).toBe(
			second,
		);
	});
	it("rejects missing personal monitoring consent before any provider subscription write", async () => {
		await expect(
			installCalendarMonitoring(
				{} as BaseContext,
				{
					...base,
					organizationId: "org",
					id: "config",
					revision: 1,
					mode: "preview",
					ownerUserId: "owner",
					actions: [],
				} as Configuration,
			),
		).rejects.toThrow("subscribe consent");
		expect(mocks.register).not.toHaveBeenCalled();
	});
});

describe("physical Google calendar alias rejection", () => {
	it("rejects a shared physical Google calendar selected through two distinct exact account slots", () => {
		const alias = {
			...base,
			calendars: [
				base.calendars[0],
				{
					...base.calendars[1],
					connectionInstanceId: "22222222-2222-4222-8222-222222222222",
					calendarId: base.calendars[0]!.calendarId,
				},
			],
		};
		const result = ConfigureCalendarsInputSchema.safeParse(alias);
		expect(result.success).toBe(false);
		if (!result.success)
			expect(
				result.error.issues.some((i) =>
					i.message.includes("multiple accounts"),
				),
			).toBe(true);
	});
});
