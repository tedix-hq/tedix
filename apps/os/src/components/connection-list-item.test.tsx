import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
	ConnectionInventoryRow,
	ConnectionProvider,
	UserConnection,
} from "@tedix/api-contract/schemas/connections";
import {
	ConnectionListItem,
	connectionServiceSummary,
} from "./connection-list-item";

const provider: ConnectionProvider = {
	appId: "initech",
	name: "Initech",
	description: "Accounting",
	enabled: true,
	availableScopes: [],
	logoUrl: null,
	connectionType: "api_key",
	registrationMode: null,
	tokenScope: "tenant",
	supportedScopes: ["tenant"],
	recommendedScope: "tenant",
	referencedByOrg: true,
};
const connection: UserConnection = {
	appId: "initech",
	providerName: "Initech",
	status: "connected",
	connectedAt: null,
	tokenExpiresAt: null,
	scopes: [],
	tokenScope: "tenant",
};
const inventory: ConnectionInventoryRow = {
	provider,
	scope: "tenant",
	accountState: "present",
	accountLabel: null,
	connection,
	references: [{ appId: "app", appSlug: "initech-globex", source: "app" }],
	capabilities: [],
	referencesComplete: true,
	access: "not_evaluated",
	health: "not_checked",
};

describe("connection service health", () => {
	let container: HTMLDivElement;
	afterEach(() => container?.remove());

	it("checks the referenced MCP service without claiming provider API health", async () => {
		container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onCheckService = vi.fn();
		await act(async () =>
			root.render(
				<ConnectionListItem
					provider={provider}
					inventory={inventory}
					connections={[connection]}
					onConnect={vi.fn()}
					isConnecting={false}
					onDisconnect={vi.fn()}
					isDisconnecting={false}
					disconnectingKey={null}
					sectionScope="tenant"
					canManage
					manageDeniedReason=""
					onCheckService={onCheckService}
				/>,
			),
		);
		const summary = container.querySelector(
			'[data-slot="connection-provider-summary"]',
		);
		const badges = container.querySelector(
			'[data-slot="connection-row-badges"]',
		);
		const actions = container.querySelector(
			'[data-slot="connection-row-actions"]',
		);
		expect(summary?.parentElement?.className).toContain(
			"grid-cols-[minmax(0,1fr)_auto]",
		);
		expect(summary?.className).toContain("col-span-2");
		expect(summary?.className).toContain("sm:col-span-1");
		expect(badges?.className).toContain("col-start-1");
		expect(actions?.className).toContain("col-start-2");
		expect(actions?.className).toContain("row-start-2");
		expect(actions?.getAttribute("role")).toBe("group");
		expect(actions?.getAttribute("aria-label")).toBe("Actions for Initech");
		const manage = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Manage",
		)!;
		await act(async () => manage.click());
		expect(container.textContent).toContain(
			"Completing reconnect replaces the live credential immediately",
		);
		expect(container.textContent).toContain(
			"does not stage a second credential before cutover",
		);
		expect(container.textContent).toContain("Check app service");
		expect(container.textContent).toContain(
			"does not execute a provider API tool or prove credential usability",
		);
		const check = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Check app service"),
		)!;
		await act(async () => check.click());
		expect(onCheckService).toHaveBeenCalledWith("initech", "initech-globex");
		await act(async () => root.unmount());
	});

	it("keeps unchecked, checked health, and live inventory explicit", () => {
		expect(connectionServiceSummary(undefined)).toBe("MCP service not checked");
		expect(
			connectionServiceSummary({
				status: "healthy",
				detail: "All checks passed.",
				appSlug: "initech-globex",
				toolCount: 223,
				checkedAt: "2026-08-31T12:00:00.000Z",
			}),
		).toContain("MCP healthy · 223 live tools · Checked");
		expect(
			connectionServiceSummary({
				status: "unhealthy",
				detail: "A protocol check failed.",
				appSlug: "initech-globex",
				toolCount: null,
				checkedAt: "2026-08-31T12:00:00.000Z",
			}),
		).toContain("MCP service issue · tool inventory unavailable · Checked");
	});

	it("renders checked health, timestamp, and discovered tool count in the row", async () => {
		container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ConnectionListItem
					provider={provider}
					inventory={inventory}
					connections={[connection]}
					onConnect={vi.fn()}
					isConnecting={false}
					onDisconnect={vi.fn()}
					isDisconnecting={false}
					disconnectingKey={null}
					sectionScope="tenant"
					canManage
					manageDeniedReason=""
					serviceHealth={{
						status: "healthy",
						detail: "All protocol checks passed.",
						appSlug: "initech-globex",
						toolCount: 223,
						checkedAt: "2026-08-31T12:00:00.000Z",
					}}
					onCheckService={vi.fn()}
				/>,
			),
		);
		expect(container.textContent).toContain(
			"MCP healthy · 223 live tools · Checked",
		);
		const manage = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Manage",
		)!;
		await act(async () => manage.click());
		expect(container.textContent).toContain("223 live tools discovered");
		await act(async () => root.unmount());
	});

	it("offers reconnect when account inspection is restricted", async () => {
		container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onConnect = vi.fn();
		await act(async () =>
			root.render(
				<ConnectionListItem
					provider={{ ...provider, connectionType: "oauth" }}
					inventory={{
						...inventory,
						accountState: "restricted",
						connection: null,
					}}
					connections={[]}
					onConnect={onConnect}
					isConnecting={false}
					onDisconnect={vi.fn()}
					isDisconnecting={false}
					disconnectingKey={null}
					sectionScope="tenant"
					canManage
					manageDeniedReason=""
					onCheckService={vi.fn()}
				/>,
			),
		);
		const reconnect = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Reconnect",
		)!;
		expect(reconnect.disabled).toBe(false);
		await act(async () => reconnect.click());
		expect(onConnect).toHaveBeenCalledWith("initech", "oauth", "tenant");
		await act(async () => root.unmount());
	});
});

const rowStates: {
	name: string;
	accountState?: ConnectionInventoryRow["accountState"];
	statuses: UserConnection["status"][];
	badge: string;
	action: "Connect" | "Reconnect" | "Manage";
}[] = [
	{
		name: "no inventory",
		statuses: [],
		badge: "Not connected",
		action: "Connect",
	},
	{
		name: "missing",
		accountState: "missing",
		statuses: [],
		badge: "Not connected",
		action: "Connect",
	},
	{
		name: "present without credential",
		accountState: "present",
		statuses: [],
		badge: "Not connected",
		action: "Connect",
	},
	{
		name: "expired without credential",
		accountState: "expired",
		statuses: [],
		badge: "Reconnect needed",
		action: "Reconnect",
	},
	{
		name: "unknown",
		accountState: "unknown",
		statuses: [],
		badge: "Could not verify",
		action: "Reconnect",
	},
	{
		name: "restricted",
		accountState: "restricted",
		statuses: [],
		badge: "Could not verify",
		action: "Reconnect",
	},
	{
		name: "expired",
		accountState: "expired",
		statuses: ["expired"],
		badge: "Reconnect needed",
		action: "Reconnect",
	},
	{
		name: "needs consent",
		accountState: "present",
		statuses: ["reconnect_needed"],
		badge: "Reconnect needed",
		action: "Reconnect",
	},
	{
		name: "revoked",
		accountState: "present",
		statuses: ["revoked"],
		badge: "Disconnected",
		action: "Reconnect",
	},
	{
		name: "unknown with credential",
		accountState: "unknown",
		statuses: ["connected"],
		badge: "Could not verify",
		action: "Reconnect",
	},
	{
		name: "restricted with credential",
		accountState: "restricted",
		statuses: ["connected"],
		badge: "Could not verify",
		action: "Reconnect",
	},
	{
		name: "mixed healthy and expired",
		accountState: "present",
		statuses: ["connected", "expired"],
		badge: "Reconnect needed",
		action: "Reconnect",
	},
	{
		name: "mixed healthy and revoked",
		accountState: "present",
		statuses: ["connected", "revoked"],
		badge: "Disconnected",
		action: "Reconnect",
	},
	{
		name: "connected",
		accountState: "present",
		statuses: ["connected"],
		badge: "Connected",
		action: "Manage",
	},
];

const providerKinds: {
	name: string;
	connectionType: ConnectionProvider["connectionType"];
	registrationMode: ConnectionProvider["registrationMode"];
}[] = [
	{
		name: "API key (manual)",
		connectionType: "api_key",
		registrationMode: null,
	},
	{
		name: "OAuth pre-registered",
		connectionType: "oauth",
		registrationMode: "pre_registered",
	},
	{ name: "OAuth CIMD", connectionType: "oauth", registrationMode: "cimd" },
	{ name: "OAuth DCR", connectionType: "oauth", registrationMode: "dcr" },
	{
		name: "OAuth invalid registration",
		connectionType: "oauth",
		registrationMode: "invalid",
	},
];

describe("connection row setup state matrix", () => {
	it.each(
		rowStates.flatMap((row) =>
			providerKinds.flatMap((kind) =>
				(["tenant", "user"] as const).flatMap((scope) =>
					(
						["unchecked", "checking", "healthy", "unhealthy", "error"] as const
					).map((health) => ({
						...row,
						kind,
						scope,
						health,
						caseName: `${row.name} / ${kind.name} / ${scope} / ${health}`,
					})),
				),
			),
		),
	)(
		"$caseName",
		async ({ accountState, statuses, badge, action, kind, scope, health }) => {
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			const onConnect = vi.fn();
			const props = {
				provider: { ...provider, ...kind },
				inventory: accountState
					? { ...inventory, accountState, capabilities: [] }
					: undefined,
				connections: statuses.map((status) => ({
					...connection,
					status,
					tokenScope: scope,
				})),
				onConnect,
				isConnecting: false,
				onDisconnect: vi.fn(),
				isDisconnecting: false,
				disconnectingKey: null,
				sectionScope: scope,
				canManage: true,
				manageDeniedReason:
					"Ask an organization admin to manage this connection.",
				serviceHealth:
					health === "unchecked"
						? undefined
						: {
								status: health,
								detail: "Service check result",
								appSlug: "initech-globex",
								toolCount: null,
							},
				onCheckService: vi.fn(),
			};
			const findAction = () =>
				[
					...host.querySelectorAll<HTMLButtonElement>(
						'[data-slot="connection-row-actions"] button',
					),
				].find((button) => button.textContent?.trim() === action);
			try {
				await act(async () => root.render(<ConnectionListItem {...props} />));
				expect(
					host.querySelector('[data-slot="connection-row-badges"]')
						?.textContent,
				).toContain(badge);
				const control = findAction();
				expect(control, `Accessible ${action} control`).toBeDefined();
				expect(control!.disabled).toBe(false);
				expect(control!.tabIndex).toBeGreaterThanOrEqual(0);
				expect(control!.getAttribute("aria-hidden")).not.toBe("true");
				await act(async () => control!.click());
				if (action === "Manage") {
					expect(onConnect).not.toHaveBeenCalled();
					expect(host.textContent).toContain(
						"Completing reconnect replaces the live credential",
					);
				} else {
					expect(onConnect).toHaveBeenCalledExactlyOnceWith(
						provider.appId,
						kind.connectionType,
						scope,
					);
					onConnect.mockClear();
					await act(async () =>
						root.render(<ConnectionListItem {...props} canManage={false} />),
					);
					expect(findAction()!.disabled).toBe(true);
					expect(findAction()!.getAttribute("aria-label")).toBe(
						props.manageDeniedReason,
					);
					await act(async () => findAction()!.click());
					expect(onConnect).not.toHaveBeenCalled();
					await act(async () =>
						root.render(<ConnectionListItem {...props} isConnecting />),
					);
					expect(findAction()!.disabled).toBe(true);
					await act(async () => findAction()!.click());
					expect(onConnect).not.toHaveBeenCalled();
				}
			} finally {
				await act(async () => root.unmount());
				host.remove();
			}
		},
	);
});
