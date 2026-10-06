import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConnectionInventoryRow } from "@tedix/api-contract/schemas/connections";
import {
	connectionInventoryCountLabel,
	ConnectionVerificationNotice,
	AdminConnectionsPage,
	filterPersonalAccountRows,
} from "./admin-connections-page";

const state = vi.hoisted(() => ({
	rows: [] as ConnectionInventoryRow[],
	add: vi.fn(),
	connect: vi.fn(),
	invalidate: vi.fn(),
	canManage: true,
	canManageOrg: false,
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: { rows: state.rows, issues: [] },
		isPending: false,
		isError: false,
	}),
	useQueryClient: () => ({ invalidateQueries: state.invalidate }),
	useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/lib/connections-actions", () => ({
	useCanManageConnections: () => state.canManageOrg,
	useCanManagePersonalOauthConnections: () => state.canManage,
	useCanBindPersonalAccounts: () => false,
	useConnectionCompleteListener: () => {},
	useDisconnectConnection: () => ({ isPending: false, isError: false }),
	startNamedOauthConnect: state.add,
	startOauthConnect: state.connect,
	effectiveConnectionScope: () => "user",
}));
vi.mock("@/components/capability-navigation", () => ({
	CapabilityNavigation: () => null,
}));
vi.mock("@/lib/webmcp/use-webmcp-tools", () => ({ useWebMcpTools: () => {} }));
vi.mock("@/lib/os-query-options", () => ({
	connectionsOverviewQueryOptions: () => ({}),
	osQueryKeys: { connections: () => ["test-connections"] },
}));

function row(label?: string): ConnectionInventoryRow {
	return {
		provider: {
			appId: "microsoft-graph-ca-tedix-oauth",
			name: "Microsoft Graph Calendar OAuth",
			description: null,
			enabled: true,
			availableScopes: [],
			logoUrl: null,
			tokenScope: "user",
			recommendedScope: "user",
			connectionType: "oauth",
			registrationMode: "pre_registered",
			referencedByOrg: true,
			supportedScopes: ["user"],
		},
		scope: "user",
		accountState: "missing",
		accountLabel: null,
		access: "not_evaluated",
		health: "not_checked",
		connection: null,
		references: [],
		bindingTargets: [],
		referencesComplete: true,
		...(label
			? { instanceLabel: label, connectionInstanceId: "slot-work" }
			: {}),
	};
}

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	state.rows = [];
	state.canManage = true;
	state.canManageOrg = false;
	vi.clearAllMocks();
});

describe("Account-first personal integration", () => {
	it("keeps account actions read-only without personal OAuth permission", async () => {
		state.rows = [row()];
		state.canManage = false;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AdminConnectionsPage
					scope="personal"
					search={{ q: "", status: "all" }}
					onSearchChange={() => {}}
				/>,
			),
		);
		expect(host.textContent).not.toContain("Connect another account");
		const connect = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "Connect",
		)!;
		expect(connect.disabled).toBe(true);
		expect(state.add).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"uses the same organization account list with manage permission %s",
		async (canManage) => {
			state.rows = [
				{
					...row("Shared"),
					scope: "tenant",
					provider: { ...row().provider, supportedScopes: ["user", "tenant"] },
				},
			];
			state.canManageOrg = canManage;
			host = document.createElement("div");
			document.body.append(host);
			root = createRoot(host);
			await act(async () =>
				root?.render(
					<AdminConnectionsPage
						scope="organization"
						search={{ q: "", status: "all" }}
						onSearchChange={() => {}}
					/>,
				),
			);
			expect(host.textContent).toContain("Shared");
			expect(host.textContent).toContain("Organization account");
			const add = [...host.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Connect another account"),
			);
			if (canManage) {
				expect(add).toBeDefined();
				await act(async () => add!.click());
				expect(state.add).toHaveBeenCalledWith({
					appId: "microsoft-graph-ca-tedix-oauth",
					effectiveScope: "tenant",
				});
			} else {
				expect(add).toBeUndefined();
				expect(
					[...host.querySelectorAll("button")].find(
						(b) => b.textContent === "Connect",
					)!.disabled,
				).toBe(true);
			}
		},
	);
	it("connects a named account using its exact slot ID", async () => {
		state.rows = [row(), row("Work account")];
		state.connect.mockResolvedValue(undefined);
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AdminConnectionsPage
					scope="personal"
					search={{ q: "", status: "all" }}
					onSearchChange={() => {}}
				/>,
			),
		);
		const named = [...host.querySelectorAll("li")].find((item) =>
			item.textContent?.includes("Work account"),
		)!;
		const connect = [...named.querySelectorAll("button")].find(
			(button) => button.textContent === "Connect",
		)!;
		await act(async () => connect.click());
		expect(state.connect).toHaveBeenCalledWith({
			appId: "microsoft-graph-ca-tedix-oauth",
			effectiveScope: "user",
			registrationMode: "pre_registered",
			connectionInstanceId: "slot-work",
		});
	});
	it("filters exact rows by friendly provider name, named labels and truthful references", () => {
		const rows = [row(), row("Work account")];
		expect(filterPersonalAccountRows(rows, "Outlook", "all")).toHaveLength(2);
		expect(filterPersonalAccountRows(rows, "Work", "all")).toEqual([rows[1]]);
		expect(filterPersonalAccountRows(rows, "", "used")).toHaveLength(0);
		expect(filterPersonalAccountRows(rows, "", "unused")).toHaveLength(2);
		expect(
			filterPersonalAccountRows(
				[{ ...rows[1]!, referencesComplete: false }],
				"",
				"unused",
			),
		).toHaveLength(0);
		const unknown = {
			...row(),
			accountState: "unknown",
		} as ConnectionInventoryRow;
		const expired = {
			...row(),
			accountState: "present",
			connection: { status: "expired" },
		} as ConnectionInventoryRow;
		expect(
			filterPersonalAccountRows([unknown, expired], "", "connected"),
		).toHaveLength(0);
		expect(
			filterPersonalAccountRows([unknown, expired], "", "not_connected"),
		).toHaveLength(0);
		expect(
			filterPersonalAccountRows([unknown, expired], "", "attention"),
		).toHaveLength(2);
	});

	it("starts OAuth directly and refreshes inventory after cancellation without creating a label dialog", async () => {
		state.rows = [row(), row("Work account")];
		let rejectConnect!: (error: Error) => void;
		state.add.mockImplementation(
			() =>
				new Promise((_, reject) => {
					rejectConnect = reject;
				}),
		);
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AdminConnectionsPage
					scope="personal"
					search={{ q: "", status: "all" }}
					onSearchChange={() => {}}
				/>,
			),
		);
		expect(host.textContent).toContain("2 of 2 shown");
		const add = [...host.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Connect another account"),
		)!;
		await act(async () => add.click());
		expect(state.add).toHaveBeenCalledWith({
			appId: "microsoft-graph-ca-tedix-oauth",
			effectiveScope: "user",
		});
		expect(host.textContent).not.toContain("Add personal account");
		await act(async () => rejectConnect(new Error("Connection cancelled")));
		expect(state.invalidate).toHaveBeenCalledWith({
			queryKey: ["test-connections"],
		});
		expect(host.textContent).toContain("Connection cancelled");
	});
});

describe("Connection inventory coverage", () => {
	it("scopes filtered counts to loaded rows when more rows exist", () => {
		expect(connectionInventoryCountLabel(12, 100, true)).toBe(
			"12 of first 100 shown",
		);
		expect(connectionInventoryCountLabel(12, 12, false)).toBe("12 of 12 shown");
	});

	it("groups verification failures without describing them as provider health", async () => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<ConnectionVerificationNotice
					issues={[
						{ source: "credentials", message: "Credential read timed out." },
						{ source: "references", message: "App references were partial." },
					]}
				/>,
			),
		);
		expect(host.textContent).toContain("Verification incomplete");
		expect(host.textContent).toContain("Some accounts could not be checked");
		expect(host.querySelectorAll('[data-slot="alert"]')).toHaveLength(1);
		const details = [...host.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("View 2 verification issues"),
		)!;
		await act(async () => details.click());
		expect(host.textContent).toContain("Credential read timed out.");
		expect(host.textContent).toContain("App references were partial.");
		expect(host.textContent).not.toContain("Provider healthy");
	});
});
