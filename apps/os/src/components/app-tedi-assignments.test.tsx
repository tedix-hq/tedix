import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	TEDI_ROSTER_LIMIT,
	osQueryKeys,
	tediAppAssignmentsByAppQueryOptions,
} from "@/lib/os-query-options";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	listByApp: vi.fn(),
	create: vi.fn(),
	delete: vi.fn(),
	updateRole: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		tedis: { list: api.list },
		tediAppAssignments: {
			listByApp: api.listByApp,
			create: api.create,
			delete: api.delete,
			updateRole: api.updateRole,
		},
	},
}));
vi.mock("@/components/kumo/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { AppTediAssignments } from "./app-tedi-assignments";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";
const TEDI_A = "33333333-3333-4333-8333-333333333333";
const TEDI_B = "44444444-4444-4444-8444-444444444444";
const ASSIGNMENT_A = "assignment-a";
const ASSIGNMENT_B = "assignment-b";

function assignment(
	id: string,
	appId: string,
	tediId: string,
	role: "operator" | "observer" = "operator",
) {
	return {
		id,
		organizationId: ORG_ID,
		appId,
		tediId,
		role,
		assignedBy: null,
		createdAt: "2026-10-20T10:00:00.000Z",
		updatedAt: "2026-10-20T10:00:00.000Z",
	};
}

function roster(...tedis: Array<{ id: string; name: string }>) {
	return {
		data: tedis.map((tedi) => ({
			...tedi,
			slug: tedi.name.toLowerCase(),
			organizationId: ORG_ID,
			status: "active",
		})),
		pagination: { limit: TEDI_ROSTER_LIMIT, offset: 0, total: tedis.length },
	};
}

function assignments(...data: ReturnType<typeof assignment>[]) {
	return { data };
}

const views: Array<() => Promise<void>> = [];

function mount(appId = APP_A) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = async (nextAppId = appId) => {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<AppTediAssignments appId={nextAppId} />
				</QueryClientProvider>,
			);
		});
	};
	views.push(async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	});
	return { client, host, render };
}

function button(host: HTMLElement, label: string) {
	const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	if (!result) throw new Error(`button ${label} was not rendered`);
	return result;
}

function labelledButton(host: HTMLElement, label: string) {
	const result = host.querySelector<HTMLButtonElement>(
		`[aria-label="${label}"]`,
	);
	if (!result) throw new Error(`button ${label} was not rendered`);
	return result;
}

async function settles(assertion: () => void) {
	await vi.waitFor(async () => {
		await act(async () => {
			await Promise.resolve();
		});
		assertion();
	});
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.resetAllMocks();
	api.list.mockResolvedValue(roster({ id: TEDI_A, name: "Atlas" }));
	api.listByApp.mockResolvedValue(
		assignments(assignment(ASSIGNMENT_A, APP_A, TEDI_A)),
	);
	api.create.mockResolvedValue({});
	api.delete.mockResolvedValue({});
	api.updateRole.mockResolvedValue({});
});

afterEach(async () => {
	while (views.length > 0) await views.pop()?.();
	vi.unstubAllGlobals();
});

describe("AppTediAssignments", () => {
	it("fences a previous app's placeholder row until the current app resolves", async () => {
		const first = Promise.withResolvers<ReturnType<typeof assignments>>();
		const second = Promise.withResolvers<ReturnType<typeof assignments>>();
		api.listByApp.mockImplementation(({ appId }) =>
			appId === APP_A ? first.promise : second.promise,
		);
		const view = mount();
		await view.render();
		await act(async () =>
			first.resolve(assignments(assignment(ASSIGNMENT_A, APP_A, TEDI_A))),
		);
		await settles(() => expect(view.host.textContent).toContain("Atlas"));

		await view.render(APP_B);
		expect(view.host.querySelector('[aria-label="Unassign Atlas"]')).toBeNull();
		expect(button(view.host, "Assign tedi").disabled).toBe(true);
		expect(api.delete).not.toHaveBeenCalled();

		await act(async () =>
			second.resolve(assignments(assignment(ASSIGNMENT_B, APP_B, TEDI_A))),
		);
		await settles(() =>
			expect(
				view.client.getQueryData(
					tediAppAssignmentsByAppQueryOptions(APP_B).queryKey,
				),
			).toEqual(assignments(assignment(ASSIGNMENT_B, APP_B, TEDI_A))),
		);
		await settles(() =>
			expect(
				view.host.querySelector('[aria-label="Unassign Atlas"]'),
			).not.toBeNull(),
		);
		expect(labelledButton(view.host, "Unassign Atlas").disabled).toBe(false);
		expect(api.listByApp.mock.calls.map(([input]) => input)).toEqual([
			{ appId: APP_A },
			{ appId: APP_B },
		]);
	});

	it("keeps roster failure independent from assignments and retries assignment errors", async () => {
		api.list.mockRejectedValue(new Error("Roster offline"));
		api.listByApp
			.mockRejectedValueOnce(new Error("Assignments offline"))
			.mockResolvedValueOnce(assignments());
		const view = mount();
		await view.render();
		await settles(() =>
			expect(view.host.textContent).toContain(
				"Failed to load assignments: Assignments offline",
			),
		);
		expect(button(view.host, "Assign tedi").disabled).toBe(true);
		await act(async () => button(view.host, "Retry").click());
		await settles(() =>
			expect(view.host.textContent).toContain(
				"No tedis assigned to this app yet.",
			),
		);
		expect(view.host.textContent).toContain(
			"Available tedis could not be loaded.",
		);
		expect(api.list.mock.calls.map(([input]) => input)).toEqual([
			{ limit: TEDI_ROSTER_LIMIT, offset: 0 },
		]);
		expect(api.listByApp).toHaveBeenCalledTimes(2);
	});

	it("waits for the roster before naming assignments or enabling available controls", async () => {
		const delayedRoster = Promise.withResolvers<ReturnType<typeof roster>>();
		api.list.mockReturnValue(delayedRoster.promise);
		api.listByApp.mockResolvedValue(
			assignments(assignment(ASSIGNMENT_A, APP_A, TEDI_A)),
		);
		const view = mount();
		await view.render();
		await settles(() => expect(view.host.textContent).toContain(TEDI_A));
		expect(view.host.textContent).not.toContain("Atlas");
		expect(button(view.host, "Assign tedi").disabled).toBe(true);
		await act(async () =>
			delayedRoster.resolve(
				roster({ id: TEDI_A, name: "Atlas" }, { id: TEDI_B, name: "Beacon" }),
			),
		);
		await settles(() => expect(view.host.textContent).toContain("Atlas"));
		expect(button(view.host, "Assign tedi").disabled).toBe(false);
	});

	it("renders a genuinely empty assignment list without claiming a bounded roster is exhaustive", async () => {
		api.list.mockResolvedValue(
			roster(
				...Array.from({ length: TEDI_ROSTER_LIMIT }, (_, index) => ({
					id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
					name: `Tedi ${index}`,
				})),
			),
		);
		api.listByApp.mockResolvedValue(assignments());
		const view = mount();
		await view.render();
		await settles(() =>
			expect(view.host.textContent).toContain(
				"No tedis assigned to this app yet.",
			),
		);
		expect(view.host.textContent).not.toContain("No tedis exist");
		expect(api.list.mock.calls.map(([input]) => input)).toEqual([
			{ limit: TEDI_ROSTER_LIMIT, offset: 0 },
		]);
	});

	it("discards a late app A response after app B has rendered", async () => {
		const delayedA = Promise.withResolvers<ReturnType<typeof assignments>>();
		const delayedB = Promise.withResolvers<ReturnType<typeof assignments>>();
		api.listByApp.mockImplementation(({ appId }) =>
			appId === APP_A ? delayedA.promise : delayedB.promise,
		);
		const view = mount();
		await view.render();
		await view.render(APP_B);
		await act(async () =>
			delayedB.resolve(assignments(assignment(ASSIGNMENT_B, APP_B, TEDI_A))),
		);
		await settles(() => expect(view.host.textContent).toContain("Atlas"));
		await act(async () =>
			delayedA.resolve(assignments(assignment(ASSIGNMENT_A, APP_A, TEDI_B))),
		);
		await settles(() =>
			expect(
				view.client.getQueryData(
					tediAppAssignmentsByAppQueryOptions(APP_A).queryKey,
				),
			).toBeUndefined(),
		);
		expect(
			view.client.getQueryData(
				tediAppAssignmentsByAppQueryOptions(APP_B).queryKey,
			),
		).toEqual(assignments(assignment(ASSIGNMENT_B, APP_B, TEDI_A)));
		expect(view.host.textContent).toContain("Atlas");
	});

	it("sends the canonical operator assignment payload on a successful create", async () => {
		api.list.mockResolvedValue(roster({ id: TEDI_A, name: "Atlas" }));
		api.listByApp.mockResolvedValue(assignments());
		const view = mount();
		await view.render();
		await settles(() =>
			expect(button(view.host, "Assign tedi").disabled).toBe(false),
		);
		await act(async () => button(view.host, "Assign tedi").click());
		const tediTrigger = () =>
			document.querySelector<HTMLButtonElement>('[data-kumo-part="trigger"]');
		await settles(() => expect(tediTrigger()).not.toBeNull());
		await act(async () => tediTrigger()?.click());
		await settles(() =>
			expect(
				[...document.querySelectorAll('[role="option"]')].some(
					(item) => item.textContent === "Atlas",
				),
			).toBe(true),
		);
		await act(async () =>
			[...document.querySelectorAll<HTMLElement>('[role="option"]')]
				.find((item) => item.textContent === "Atlas")
				?.click(),
		);
		await act(async () => button(document.body, "Assign").click());
		await settles(() => expect(api.create).toHaveBeenCalledTimes(1));
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			appId: APP_A,
			tediId: TEDI_A,
			role: "operator",
		});
		await settles(() =>
			expect(document.body.textContent).not.toContain("Assign tedi to app"),
		);
	});

	it("sends the canonical observer assignment payload and retains the form after rejection", async () => {
		api.list.mockResolvedValue(roster({ id: TEDI_A, name: "Atlas" }));
		api.listByApp.mockResolvedValue(assignments());
		api.create.mockRejectedValue(new Error("Role no longer allowed"));
		const view = mount();
		await view.render();
		await settles(() =>
			expect(button(view.host, "Assign tedi").disabled).toBe(false),
		);
		await act(async () => button(view.host, "Assign tedi").click());
		const triggers = () => [
			...document.querySelectorAll<HTMLButtonElement>(
				'[data-kumo-part="trigger"]',
			),
		];
		await settles(() => expect(triggers()).toHaveLength(2));
		await act(async () => triggers()[0]?.click());
		await settles(() =>
			expect(
				[...document.querySelectorAll('[role="option"]')].some(
					(item) => item.textContent === "Atlas",
				),
			).toBe(true),
		);
		await act(async () =>
			[...document.querySelectorAll<HTMLElement>('[role="option"]')]
				.find((item) => item.textContent === "Atlas")
				?.click(),
		);
		await act(async () => triggers()[1]?.click());
		await settles(() =>
			expect(
				[...document.querySelectorAll('[role="option"]')].some(
					(item) => item.textContent === "Observer",
				),
			).toBe(true),
		);
		await act(async () =>
			[...document.querySelectorAll<HTMLElement>('[role="option"]')]
				.find((item) => item.textContent === "Observer")
				?.click(),
		);
		await act(async () => button(document.body, "Assign").click());
		await settles(() => expect(api.create).toHaveBeenCalledTimes(1));
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			appId: APP_A,
			tediId: TEDI_A,
			role: "observer",
		});
		expect(document.body.textContent).toContain("Atlas");
		expect(document.body.textContent).toContain("Observer");
	});

	it("submits one pending observer create and reconciles the generated assignments domain", async () => {
		const created = Promise.withResolvers<unknown>();
		const serverAssignment = assignments(
			assignment("assignment-server", APP_A, TEDI_A, "observer"),
		);
		api.list.mockResolvedValue(roster({ id: TEDI_A, name: "Atlas" }));
		api.listByApp
			.mockResolvedValueOnce(assignments())
			.mockResolvedValueOnce(serverAssignment);
		api.create.mockReturnValue(created.promise);
		const view = mount();
		const invalidate = vi.spyOn(view.client, "invalidateQueries");
		await view.render();
		await settles(() =>
			expect(button(view.host, "Assign tedi").disabled).toBe(false),
		);
		await act(async () => button(view.host, "Assign tedi").click());
		const triggers = () => [
			...document.querySelectorAll<HTMLButtonElement>(
				'[data-kumo-part="trigger"]',
			),
		];
		await settles(() => expect(triggers()).toHaveLength(2));
		await act(async () => triggers()[0]?.click());
		await settles(() =>
			expect(
				[...document.querySelectorAll('[role="option"]')].some(
					(item) => item.textContent === "Atlas",
				),
			).toBe(true),
		);
		await act(async () =>
			[...document.querySelectorAll<HTMLElement>('[role="option"]')]
				.find((item) => item.textContent === "Atlas")
				?.click(),
		);
		await act(async () => triggers()[1]?.click());
		await settles(() =>
			expect(
				[...document.querySelectorAll('[role="option"]')].some(
					(item) => item.textContent === "Observer",
				),
			).toBe(true),
		);
		await act(async () =>
			[...document.querySelectorAll<HTMLElement>('[role="option"]')]
				.find((item) => item.textContent === "Observer")
				?.click(),
		);
		const submit = button(document.body, "Assign");
		await act(async () => submit.click());
		await settles(() => expect(submit.disabled).toBe(true));
		await act(async () => submit.click());
		expect(api.create).toHaveBeenCalledTimes(1);
		expect(api.create.mock.calls[0]?.[0]).toEqual({
			appId: APP_A,
			tediId: TEDI_A,
			role: "observer",
		});
		await act(async () => created.resolve({}));
		await settles(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: osQueryKeys.appTediAssignments(),
			}),
		);
		await settles(() => expect(api.listByApp).toHaveBeenCalledTimes(2));
		await settles(() =>
			expect(
				view.client.getQueryData(
					tediAppAssignmentsByAppQueryOptions(APP_A).queryKey,
				),
			).toEqual(serverAssignment),
		);
	});

	it("does not mutate on cancel, rejects role changes, and rolls back an optimistic removal", async () => {
		const initial = assignments(assignment(ASSIGNMENT_A, APP_A, TEDI_A));
		const deletion = Promise.withResolvers<unknown>();
		api.list.mockResolvedValue(roster({ id: TEDI_A, name: "Atlas" }));
		api.listByApp.mockResolvedValue(initial);
		api.updateRole.mockRejectedValue(new Error("Role no longer allowed"));
		api.delete.mockReturnValue(deletion.promise);
		const view = mount();
		await view.render();
		await settles(() => expect(view.host.textContent).toContain("Atlas"));

		await act(async () => labelledButton(view.host, "Unassign Atlas").click());
		await settles(() =>
			expect(document.body.textContent).toContain("Unassign this tedi?"),
		);
		await act(async () => button(document.body, "Cancel").click());
		expect(api.delete).not.toHaveBeenCalled();

		const role = view.host.querySelector<HTMLButtonElement>(
			'[aria-label="Role for Atlas"]',
		);
		await act(async () => role?.click());
		await settles(() =>
			expect(
				[...document.querySelectorAll('[role="option"]')].some((item) =>
					item.textContent?.includes("Observer"),
				),
			).toBe(true),
		);
		await act(async () =>
			[...document.querySelectorAll<HTMLElement>('[role="option"]')]
				.find((item) => item.textContent?.includes("Observer"))
				?.click(),
		);
		await settles(() => expect(api.updateRole).toHaveBeenCalledTimes(1));
		expect(api.updateRole.mock.calls[0]?.[0]).toEqual({
			assignmentId: ASSIGNMENT_A,
			role: "observer",
		});
		expect(role?.textContent).toContain("Operator");

		await act(async () => labelledButton(view.host, "Unassign Atlas").click());
		await settles(() =>
			expect(document.body.textContent).toContain("Unassign this tedi?"),
		);
		await act(async () => button(document.body, "Unassign tedi").click());
		await settles(() =>
			expect(
				view.client.getQueryData(
					tediAppAssignmentsByAppQueryOptions(APP_A).queryKey,
				),
			).toEqual(assignments()),
		);
		expect(api.delete).toHaveBeenCalledTimes(1);
		await act(async () => deletion.reject(new Error("Delete rejected")));
		await settles(() =>
			expect(
				view.client.getQueryData(
					tediAppAssignmentsByAppQueryOptions(APP_A).queryKey,
				),
			).toEqual(initial),
		);
		expect(api.delete.mock.calls[0]?.[0]).toEqual({
			assignmentId: ASSIGNMENT_A,
		});
	});
});
