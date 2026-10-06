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
