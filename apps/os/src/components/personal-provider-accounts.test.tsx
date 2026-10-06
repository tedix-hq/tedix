import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
	ConnectionInventoryRow,
	ConnectionProvider,
} from "@tedix/api-contract/schemas/connections";
import {
	PersonalProviderAccounts,
	friendlyPersonalProviderName,
	type PersonalProviderAccountsProps,
} from "./personal-provider-accounts";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const provider: ConnectionProvider = {
	appId: "ms-calendar",
	name: "Microsoft Graph Calendar OAuth",
	description: "OAuth connection",
	enabled: true,
	availableScopes: [],
	logoUrl: null,
	connectionType: "oauth",
	registrationMode: null,
	tokenScope: "user",
	supportedScopes: ["user"],
	recommendedScope: "user",
	referencedByOrg: true,
};
const base: ConnectionInventoryRow = {
	provider,
	scope: "user",
	accountState: "present",
	accountLabel: "user@example.com",
	connection: {
		appId: provider.appId,
		providerName: provider.name,
		status: "connected",
		connectedAt: null,
		tokenExpiresAt: null,
		scopes: ["Calendars.Read"],
		tokenScope: "user",
		connectedByEmail: "user@example.com",
	},
	references: [
		{
			appId: "calendar-app",
			appSlug: "microsoft-graph-calendar",
			source: "app",
		},
	],
	referencesComplete: true,
	access: "not_evaluated",
	health: "not_checked",
};
const named: ConnectionInventoryRow = {
	...base,
	connectionInstanceId: "00000000-0000-4000-8000-000000000002",
	instanceLabel: "Work account",
};
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
});
async function render(overrides: Partial<PersonalProviderAccountsProps> = {}) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const props: PersonalProviderAccountsProps = {
		provider,
		rows: [base, named],
		canManage: true,
		canBind: true,
		canAdd: true,
		isConnecting: false,
		isDisconnecting: false,
		isBinding: false,
		onConnect: vi.fn(),
		onRename: vi.fn(),
		onDisconnect: vi.fn(),
		onAdd: vi.fn(),
		onBind: vi.fn(),
		onCheckService: vi.fn(),
		...overrides,
	};
	await act(async () => root?.render(<PersonalProviderAccounts {...props} />));
	return props;
}
async function menu(label = "Work account") {
	const trigger = host.querySelector<HTMLButtonElement>(
		`button[aria-label="Manage Outlook Calendar ${label}"]`,
	)!;
	await act(async () => {
		trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		trigger.click();
	});
	return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}
describe("account-first provider groups", () => {
	it("uses friendly names without combining mail and calendar", () => {
		expect(friendlyPersonalProviderName(provider)).toBe("Outlook Calendar");
		expect(
			friendlyPersonalProviderName({
				...provider,
				name: "Microsoft Graph Mail OAuth",
			}),
		).toBe("Outlook Mail");
		expect(
			friendlyPersonalProviderName({ ...provider, name: "Google Calendar" }),
		).toBe("Google Calendar");
	});
	it("groups exact provider accounts across scopes and keeps technical owner identity in Advanced", async () => {
		await render({
			rows: [
				base,
				named,
				{
					...named,
					connectionInstanceId: "e3cad82c-f39a-4f4e-91a2-cf71e2feee74",
					scope: "tenant",
					instanceLabel: "Organization",
				},
				{
					...named,
					provider: { ...provider, appId: "ms-mail" },
					instanceLabel: "Mail account",
				},
			],
		});
		expect(host.textContent).toContain("Default account");
		expect(host.textContent).toContain("Work account");
		expect(host.textContent).not.toContain("Mail account");
		expect(host.textContent).toContain("Organization account");
		expect(host.textContent).toContain("Personal account");
		expect(host.textContent).not.toContain("user@example.com");
		expect(host.textContent).not.toContain("microsoft-graph-calendar");
		const advanced = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "Advanced details",
		)!;
		await act(async () => advanced.click());
		expect(host.textContent).toContain(
			"Connected by user@example.com (Tedix user)",
		);
		expect(host.textContent).toContain(
			"not provider API access or account usability",
		);
	});
	it.each(["Rename", "Reconnect", "Disconnect"])(
		"routes organization %s through its exact row",
		async (action) => {
			const row = { ...named, scope: "tenant" as const };
			const props = await render({ rows: [row] });
			const items = await menu();
			await act(async () =>
				items.find((item) => item.textContent === action)!.click(),
			);
			const callback =
				action === "Rename"
					? props.onRename
					: action === "Reconnect"
						? props.onConnect
						: props.onDisconnect;
			expect(callback).toHaveBeenCalledWith(row);
		},
	);
	it("routes add and rename to exact provider and slot", async () => {
		const props = await render();
		const add = [...host.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Connect another account"),
		)!;
		await act(async () => add.click());
		expect(props.onAdd).toHaveBeenCalledWith(provider);
		const items = await menu();
		await act(async () =>
			items.find((item) => item.textContent === "Rename")!.click(),
		);
		expect(props.onRename).toHaveBeenCalledWith(named);
	});
	it.each(["Reconnect", "Disconnect"])(
		"routes %s through the exact named row",
		async (action) => {
			const props = await render();
			const items = await menu();
			await act(async () =>
				items.find((item) => item.textContent === action)!.click(),
			);
			expect(
				action === "Reconnect" ? props.onConnect : props.onDisconnect,
			).toHaveBeenCalledWith(named);
		},
	);
	it("preserves uncertain states without asserting provider failure", async () => {
		await render({
			rows: [
				{ ...named, accountState: "unknown", connection: null },
				{ ...base, accountState: "restricted", connection: null },
			],
		});
		expect(host.textContent).toContain("Could not verify");
		expect(host.textContent).toContain("Verification unavailable");
		expect(host.textContent).toContain("does not mean the provider is down");
		expect(host.textContent).not.toContain("Not connected");
	});
	it("keeps management actions disabled without permission", async () => {
		const props = await render({ canManage: false, canBind: false });
		const items = await menu();
		expect(
			items.every(
				(item) =>
					item.getAttribute("aria-disabled") === "true" ||
					item.hasAttribute("data-disabled"),
			),
		).toBe(true);
		await act(async () =>
			items.find((item) => item.textContent === "Disconnect")!.click(),
		);
		expect(props.onDisconnect).not.toHaveBeenCalled();
	});
	it("binds only explicit named account targets from Advanced", async () => {
		const target = {
			appId: "second-calendar-app",
			appSlug: "second-calendar",
			source: "app" as const,
		};
		const row = { ...named, bindingTargets: [target] };
		const props = await render({ rows: [row] });
		await act(async () =>
			[...host.querySelectorAll("button")]
				.find((button) => button.textContent === "Advanced details")!
				.click(),
		);
		await act(async () =>
			[...host.querySelectorAll("button")]
				.find((button) => button.textContent === "Use for second-calendar")!
				.click(),
		);
		expect(props.onBind).toHaveBeenCalledWith(row, target);
	});
});
