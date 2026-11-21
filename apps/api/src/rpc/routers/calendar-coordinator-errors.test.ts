import { RPCHandler } from "@orpc/server/fetch";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { calendarCoordinatorContractRouter } from "./calendar-coordinator";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	configuration: vi.fn(),
	routes: vi.fn(),
	plan: vi.fn(),
	install: vi.fn(),
	disable: vi.fn(),
	queue: vi.fn(),
	store: vi.fn(),
}));
vi.mock("@tedix/db/queries/calendar-coordinator", () => ({
	getCalendarCoordinatorPlan: mocks.plan,
	getCalendarCoordinator: mocks.configuration,
}));
vi.mock("@tedix/db/query-client", () => ({
	createDbQueryClient: () => ({}),
}));
vi.mock("../../services/calendar-coordinator/state", () => ({
	loadCalendarConfig: mocks.load,
	calendarMonitoringStatus: vi.fn(),
	resolveCalendarRoutes: mocks.routes,
	installCalendarMonitoring: mocks.install,
	disableCalendarMonitoring: mocks.disable,
	queueCalendarInitialReconcile: mocks.queue,
	createCalendarApplyStore: mocks.store,
}));
vi.mock("../../services/calendar-coordinator/credentials", () => ({
	calendarOwnerUser: (context: BaseContext) => context.user!.sub,
}));

const id = "11111111-1111-4111-8111-111111111111";
const configuration = {
	id,
	organizationId: id,
	ownerUserId: "owner",
	revision: 2,
	calendars: [{ key: "a", calendarId: "a" }],
};

async function invoke(procedure: string, input: Record<string, unknown>) {
	const handler = new RPCHandler(calendarCoordinatorContractRouter);
	const result = await handler.handle(
		new Request(`https://api.example.test/rpc/${procedure}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ json: input }),
		}),
		{
			prefix: "/rpc",
			context: {
				authType: "user",
				user: { sub: "owner", permissions: ["settings:manage"] },
				organizationId: id,
				headers: new Headers(),
				env: {},
				db: {},
			} as BaseContext,
		},
	);
	expect(result.matched).toBe(true);
	expect(mocks.install).not.toHaveBeenCalled();
	expect(mocks.disable).not.toHaveBeenCalled();
	expect(mocks.queue).not.toHaveBeenCalled();
	expect(mocks.store).not.toHaveBeenCalled();
	return result.response!;
}

describe("calendar router HTTP errors", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.load.mockResolvedValue({ configuration, db: {}, row: {} });
		mocks.routes.mockResolvedValue(
			new Map([
				["a", { listCalendars: async () => [{ id: "a", canWrite: false }] }],
			]),
		);
		mocks.plan.mockResolvedValue(null);
	});

	it("returns 403 for a different owner before resolving provider routes", async () => {
		mocks.load.mockResolvedValue({
			configuration: { ...configuration, ownerUserId: "another-owner" },
		});
		const response = await invoke("activate", {
			id,
			expectedRevision: 2,
			actions: ["create"],
		});
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			json: {
				code: "FORBIDDEN",
				message: "Owner and exact configuration revision required",
			},
		});
		expect(mocks.routes).not.toHaveBeenCalled();
	});

	it("returns 409 for a stale configuration revision", async () => {
		const response = await invoke("activate", {
			id,
			expectedRevision: 1,
			actions: ["create"],
		});
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			json: { code: "CONFLICT" },
		});
		expect(mocks.routes).not.toHaveBeenCalled();
	});

	it("returns 403 for a calendar without verified write permission", async () => {
		const response = await invoke("activate", {
			id,
			expectedRevision: 2,
			actions: ["create"],
		});
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			json: {
				code: "FORBIDDEN",
				message: "Every selected calendar requires verified write permission",
			},
		});
	});

	it("returns 404 for a missing organization-scoped configuration through the real loader", async () => {
		const { loadCalendarConfig } = await vi.importActual<
			typeof import("../../services/calendar-coordinator/state")
		>("../../services/calendar-coordinator/state");
		mocks.load.mockImplementation(loadCalendarConfig);
		mocks.configuration.mockResolvedValue(null);
		const response = await invoke("status", { id });
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({
			json: { code: "NOT_FOUND", message: "Calendar configuration not found" },
		});
		expect(mocks.configuration).toHaveBeenCalledWith(
			{},
			{ organizationId: id, configurationId: id },
		);
	});

	it("returns 404 for a missing immutable plan", async () => {
		const response = await invoke("apply", {
			id,
			expectedRevision: 2,
			planId: id,
		});
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({
			json: { code: "NOT_FOUND", message: "Calendar preview not found" },
		});
	});
});
