import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { App } from "@tedix/db/schema/apps";
import type { DbClient } from "@tedix/db/client";
const mocks = vi.hoisted(() => ({
	consent: vi.fn(),
	surfaces: vi.fn(),
	call: vi.fn(),
	requirement: vi.fn(),
}));
vi.mock("@tedix/db/queries/personal-request-consent", () => ({
	getPersonalRequestConsent: mocks.consent,
}));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppsBySlugsWithTools: mocks.surfaces,
}));
vi.mock("../kernel-runtime/direct-read", () => ({
	callDirectReadMcp: mocks.call,
	directReadConnectionRequirement: mocks.requirement,
}));
import { readPersonalCalendar } from "./personal-calendar";
const now = Date.parse("2026-10-25T12:00:00Z");
const args = {
	db: {} as DbClient,
	env: {},
	organizationId: "org",
	userId: "caller",
	runId: "home",
	conversationId: "conversation",
	now,
	apps: [
		{
			id: "app",
			slug: "calendar",
			metadata: { mcpConfig: { connectionProviderId: "google-calendar" } },
		},
	] as App[],
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.consent.mockResolvedValue({
		actorId: "caller",
		timestamp: new Date(now),
		metadata: {
			requesterUserId: "caller",
			rootRunId: "home",
			conversationId: "conversation",
			expiresAt: new Date(now + 60000).toISOString(),
		},
	});
	mocks.surfaces.mockResolvedValue([
		{
			app: { organizationId: "org", slug: "calendar" },
			tools: [
				{
					toolId: "list_events",
					enabled: true,
					annotations: { readOnlyHint: true },
					config: { mcpToolName: "list_events", auth: { type: "connection" } },
				},
			],
		},
	]);
	mocks.requirement.mockReturnValue({
		providerId: "google-calendar",
		tokenScope: "user",
	});
	mocks.call.mockResolvedValue({
		events: [{ summary: "Ada", start: { dateTime: "2026-10-24T12:00:00Z" } }],
	});
});
describe("personal calendar context", () => {
	it("reads a bounded dated slice through the existing gateway as the admitted caller", async () => {
		expect(await readPersonalCalendar(args)).toContain("2026-10-24");
		expect(mocks.call).toHaveBeenCalledWith(
			expect.objectContaining({
				actingUserId: "caller",
				method: "tools/call",
				params: {
					name: "list_events",
					arguments: expect.objectContaining({
						calendarId: "primary",
						maxResults: 25,
						timeMin: "2026-10-18T12:00:00.000Z",
						timeMax: "2026-11-01T12:00:00.000Z",
					}),
				},
			}),
		);
	});
	it("does not read without human admission", async () => {
		mocks.consent.mockResolvedValue(null);
		expect(await readPersonalCalendar(args)).toContain(
			"no active personal request admission",
		);
		expect(mocks.call).not.toHaveBeenCalled();
		expect(mocks.surfaces).not.toHaveBeenCalled();
	});
	it("does not substitute tenant or hybrid account credentials", async () => {
		mocks.requirement.mockReturnValue({
			providerId: "google-calendar",
			tokenScope: "either",
		});
		expect(await readPersonalCalendar(args)).toContain(
			"no reviewed personal event reader",
		);
		expect(mocks.call).not.toHaveBeenCalled();
	});
	it("reports gateway denial without inventing calendar entries", async () => {
		mocks.call.mockRejectedValue(new Error("No calendar connection granted"));
		expect(await readPersonalCalendar(args)).toBe(
			"Calendar read unavailable: No calendar connection granted",
		);
	});
});
