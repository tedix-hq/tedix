import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import type { PersonalResourceDelegationSchema } from "@tedix/api-contract/schemas/personal-resource-delegations";
import type { z } from "zod";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const harness = vi.hoisted(() => ({
	list: vi.fn(),
	setPersonalAccess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			schedules: { setPersonalAccess: harness.setPersonalAccess },
		},
	},
}));

vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		personalResourceDelegations: {
			list: {
				key: () => ["personal-resource-delegations", "list"],
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["personal-resource-delegations", "list", input],
					queryFn: () => harness.list(input),
				}),
			},
		},
	},
	workspaceSchedulesQueryOptions: (workspaceId: string) => ({
		queryKey: ["workspace-schedules", workspaceId],
	}),
}));

import { WorkspacePersonalAccess } from "./workspace-personal-access";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const resource: OsWorkspaceResource = {
	id: "22222222-2222-4222-8222-222222222222",
	organizationId: "fictional-org",
	workspaceId: WORKSPACE_ID,
	slot: "mail",
	providerId: "sample-mail",
	connectionScope: "user",
	personalOwnerUserId: "fictional-owner",
	connectionInstanceId: "33333333-3333-4333-8333-333333333333",
	providerAccess: null,
	requiredScopes: [],
	resourceType: "mailbox",
	providerResourceId: "sample-mailbox",
	name: "Sample mailbox",
	metadata: {},
	status: "active",
	createdByKind: "user",
	createdById: "fictional-owner",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	removedAt: null,
};
const grant: z.infer<typeof PersonalResourceDelegationSchema> = {
	id: "66666666-6666-4666-8666-666666666666",
	organizationId: resource.organizationId,
	tediId: "77777777-7777-4777-8777-777777777777",
	skillId: "88888888-8888-4888-8888-888888888888",
	skillRevision: 1,
	connectionInstanceId: resource.connectionInstanceId!,
	ownerUserId: "fictional-owner",
	providerId: resource.providerId,
	resourceType: resource.resourceType,
	providerResourceId: resource.providerResourceId,
	requiredScopes: [],
	toolIds: ["read_mail"],
	createdAt: resource.createdAt,
	workspaceId: WORKSPACE_ID,
	resourceId: resource.id,
	operations: ["read"],
	revokedAt: null,
	expiresAt: "2099-01-01T00:00:00.000Z",
};

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 6; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function mount() {
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkspacePersonalAccess
					workspaceId={WORKSPACE_ID}
					resource={resource}
				/>
			</QueryClientProvider>,
		),
	);
	await flush();
}
const text = () => container.textContent ?? "";
const combobox = () =>
	container.querySelector<HTMLButtonElement>('[role="combobox"]');
const retry = () =>
	[...container.querySelectorAll("button")].find(
		(item) => item.textContent === "Retry access",
	);
const unverified = "Access could not be verified.";

beforeEach(() => {
	harness.list.mockReset();
	harness.setPersonalAccess.mockReset();
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	client.clear();
});

describe("WorkspacePersonalAccess", () => {
	it("shows checking while the first grants read is pending", async () => {
		harness.list.mockReturnValue(new Promise(() => {}));
		await mount();
		expect(text()).toContain("Checking access…");
		expect(combobox()).toBeNull();
		expect(text()).not.toContain("No access");
	});
	it("shows unverified access on a cold rejection and only offers a read retry", async () => {
		harness.list.mockRejectedValue(new Error("offline"));
		await mount();
		expect(text()).toContain(unverified);
		expect(combobox()).toBeNull();
		expect(retry()).toBeTruthy();
		expect(text()).not.toContain("No access");
		expect(harness.setPersonalAccess).not.toHaveBeenCalled();
	});
	it("shows unverified access when a refresh of cached grants fails", async () => {
		harness.list.mockResolvedValue([grant]);
		await mount();
		expect(combobox()?.textContent).toBe("Read");
		harness.list.mockRejectedValue(new Error("offline"));
		await act(async () => {
			await client.refetchQueries({
				queryKey: ["personal-resource-delegations"],
			});
		});
		await flush();
		expect(text()).toContain(unverified);
		expect(combobox()).toBeNull();
	});
	it("shows unverified access when the bounded read fills the limit", async () => {
		harness.list.mockResolvedValue(
			Array.from({ length: 100 }, (_, index) => ({
				...grant,
				id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
			})),
		);
		await mount();
		expect(text()).toContain(unverified);
		expect(combobox()).toBeNull();
		expect(retry()).toBeTruthy();
	});
	it("shows no access on an empty read and enables changes", async () => {
		harness.list.mockResolvedValue([]);
		await mount();
		expect(combobox()?.textContent).toBe("No access");
		expect(combobox()?.disabled).toBe(false);
	});
	it("shows read access for an active grant on this resource", async () => {
		harness.list.mockResolvedValue([grant]);
		await mount();
		expect(combobox()?.textContent).toBe("Read");
	});
	it.each([
		{ revokedAt: "2026-01-01T00:00:00.000Z" },
		{ expiresAt: "2000-01-01T00:00:00.000Z" },
		{ workspaceId: "44444444-4444-4444-8444-444444444444" },
		{ resourceId: "55555555-5555-4555-8555-555555555555" },
	])("ignores an inactive or unrelated grant: %j", async (override) => {
		harness.list.mockResolvedValue([{ ...grant, ...override }]);
		await mount();
		expect(combobox()?.textContent).toBe("No access");
	});
	it.each([
		{ ownerUserId: "another-owner" },
		{ connectionInstanceId: "99999999-9999-4999-8999-999999999999" },
	])("ignores a grant bound to another identity: %j", async (override) => {
		harness.list.mockResolvedValue([{ ...grant, ...override }]);
		await mount();
		expect(combobox()?.textContent).toBe("No access");
	});
	it("shows the strongest active grant and explains its limits", async () => {
		harness.list.mockResolvedValue([
			grant,
			{ ...grant, operations: ["read", "modify"] },
		]);
		await mount();
		expect(combobox()?.textContent).toBe(
			"Read + organise (archive, label, unsubscribe; never sends or deletes)",
		);
	});
	it("recovers through the read retry", async () => {
		harness.list
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue([grant]);
		await mount();
		expect(text()).toContain(unverified);
		act(() => retry()!.click());
		await flush();
		expect(harness.list).toHaveBeenCalledTimes(2);
		expect(combobox()?.textContent).toBe("Read");
	});
	it("disables the select and shows the chosen level while the change is pending", async () => {
		harness.list.mockResolvedValue([grant]);
		harness.setPersonalAccess.mockReturnValue(new Promise(() => {}));
		await mount();
		await act(async () => {
			combobox()!.click();
			await Promise.resolve();
		});
		const option = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((candidate) => candidate.textContent?.includes("organise"))!;
		await act(async () => {
			option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			option.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
			option.click();
			await Promise.resolve();
		});
		expect(harness.setPersonalAccess).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			resourceId: resource.id,
			level: "organise",
		});
		expect(combobox()?.disabled).toBe(true);
		expect(combobox()?.textContent).toContain("organise");
	});
});
