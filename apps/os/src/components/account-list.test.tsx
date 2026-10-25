import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
	ConnectionInventoryRow,
	ConnectionProvider,
} from "@tedix/api-contract/schemas/connections";
import {
	AccountList,
	accountStatus,
	appNames,
	friendlyProviderName,
	groupAccounts,
	humanizeAppSlug,
	type AccountListProps,
} from "./account-list";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const provider: ConnectionProvider = {
	appId: "ms-calendar",
	name: "Microsoft Graph Calendar OAuth",
	description: "client_credentials M2M",
	enabled: true,
	availableScopes: [],
	logoUrl: null,
	connectionType: "oauth",
	registrationMode: "pre_registered",
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
	capabilities: [],
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
			appSlug: "microsoft-graph-calendar-f9ab445d",
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

async function render(
	rows: ConnectionInventoryRow[],
	overrides: Partial<AccountListProps> = {},
) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const props: AccountListProps = {
		owner: "personal",
		groups: groupAccounts(rows),
		checkedAt: "2026-10-24T15:00:00Z",
		isChecking: false,
		onCheck: vi.fn(),
		canManage: () => true,
		deniedReason: () => "Ask an organization admin.",
		canAdd: () => true,
		canBind: true,
		isConnecting: false,
		isDisconnecting: false,
		isBinding: false,
		onConnect: vi.fn(),
		onReconnect: vi.fn(),
		onDisconnect: vi.fn(),
		onRename: vi.fn(),
		onAdd: vi.fn(),
		onBind: vi.fn(),
		serviceHealth: {},
		onCheckService: vi.fn(),
		...overrides,
	};
	await act(async () => root?.render(<AccountList {...props} />));
	return props;
}

function button(label: string, parent: ParentNode = host) {
	return [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent?.trim() === label,
	);
}

async function expand(name = "Outlook Calendar") {
	const trigger = host.querySelector<HTMLButtonElement>(
		`button[aria-label="${name} details"]`,
	)!;
	await act(async () => trigger.click());
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

describe("account list model", () => {
	it("uses friendly names without combining mail and calendar", () => {
		expect(friendlyProviderName(provider)).toBe("Outlook Calendar");
		expect(
			friendlyProviderName({ ...provider, name: "Microsoft Graph Mail OAuth" }),
		).toBe("Outlook Mail");
		expect(friendlyProviderName({ ...provider, name: "Google Calendar" })).toBe(
			"Google Calendar",
		);
	});

	it("names apps for people, never by internal slug", () => {
		expect(humanizeAppSlug("pricewise-official-f9ab445d")).toBe(
			"Pricewise official",
		);
		expect(humanizeAppSlug("alegra-tedix")).toBe("Alegra");
		expect(
			appNames([
				{ appId: "a", appSlug: "pricewise-official-f9ab445d", source: "app" },
				{ appId: "a", appSlug: "pricewise-official-f9ab445d", source: "tool" },
				{ appId: "b", appSlug: "x-1", appName: "Pricing desk", source: "app" },
			]),
		).toEqual(["Pricewise official", "Pricing desk"]);
	});

	it("gives every account exactly one status and never reads a failed check as absence", () => {
		expect(accountStatus(base).label).toBe("Connected");
		expect(accountStatus({ ...base, accountState: "unknown" }).label).toBe(
			"Needs attention: Couldn't check this account",
		);
		expect(
			accountStatus({ ...base, accountState: "restricted", connection: null })
				.kind,
		).toBe("attention");
		expect(
			accountStatus({
				...base,
				provider: { ...provider, connectionType: "api_key" },
				accountState: "expired",
			}).label,
		).toBe("Needs attention: Key stopped working");
		expect(
			accountStatus({
				...base,
				capabilities: [
					{
						id: "write",
						label: "Write calendar",
						requiredScopes: ["Calendars.Write"],
						state: "not_configured",
						setupUrl: "/account/connections?connect=ms-calendar",
						verified: true,
					},
				],
			}).label,
		).toBe("Needs attention: Missing permission for Write calendar");
		expect(
			accountStatus({ ...named, accountState: "missing", connection: null }),
		).toMatchObject({ kind: "attention", action: "connect" });
		expect(
			accountStatus({ ...base, accountState: "missing", connection: null }),
		).toMatchObject({ kind: "available", action: "connect" });
	});

	it("sorts needs-attention before connected and keeps never-used defaults out of used groups", () => {
		const mail: ConnectionInventoryRow = {
			...base,
			provider: { ...provider, appId: "ms-mail", name: "Microsoft Graph Mail" },
			accountState: "expired",
		};
		const unused: ConnectionInventoryRow = {
			...base,
			provider: { ...provider, appId: "alpic", name: "Alpic" },
			accountState: "missing",
			connection: null,
		};
		const groups = groupAccounts([
			unused,
			{ ...base, accountState: "missing", connection: null },
			named,
			mail,
		]);
		expect(groups.map((group) => group.provider.appId)).toEqual([
			"ms-mail",
			"ms-calendar",
			"alpic",
		]);
		expect(groups[1]!.accounts).toEqual([named]);
		expect(groups[2]!.status.kind).toBe("available");
	});
});

describe("account list rows", () => {
	it("shows one status, no Access label, and keeps identifiers behind Technical details", async () => {
		const access = {
			...base,
			toolCapabilities: [
				{ id: "read", label: "Read events", riskTier: "read" as const },
				{
					id: "write",
					label: "Create events",
					riskTier: "bounded_write" as const,
				},
				{
					id: "invite",
					label: "Send invitations",
					riskTier: "external_side_effect" as const,
				},
			],
			toolCapabilitiesComplete: true,
			capabilities: [
				{
					id: "access",
					label: "Access",
					requiredScopes: [],
					state: "connected" as const,
					setupUrl: "/account/connections?connect=ms-calendar",
					verified: true,
				},
			],
		};
		await render([access]);
		const row = host.querySelector('[data-account-group="ms-calendar"]')!;
		expect(row.textContent?.match(/Connected/g)).toHaveLength(1);
		expect(row.textContent).toContain("Used by Microsoft graph calendar");
		expect(row.textContent).toContain("Multiple accounts");
		await expand();
		expect(host.textContent).toContain("What Tedix can do with it");
		expect(host.textContent).toContain("Read: Read events. Automatic.");
		expect(host.textContent).toContain(
			"Create and edit: Create events. Automatic, logged.",
		);
		expect(host.textContent).toContain(
			"Protected effects: Send invitations. Asks a person first.",
		);
		expect(host.textContent?.match(/Tedix keeps your/g)).toHaveLength(1);
		expect(host.textContent).toContain("Only you.");
		expect(host.textContent).toContain(
			"You can sign in with more than one account",
		);
		expect(host.textContent).not.toContain("Access");
		expect(host.textContent).not.toContain("client_credentials");
		expect(host.textContent).not.toContain("user@example.com");
		expect(host.textContent).not.toContain("microsoft-graph-calendar-f9ab445d");
		await act(async () => button("Technical details")!.click());
		expect(host.textContent).toContain("client_credentials M2M");
		expect(host.textContent).toContain("user@example.com");
		expect(host.textContent).toContain("microsoft-graph-calendar-f9ab445d");
		expect(host.textContent).toContain("MCP service not checked");
	});

	it("lists every account of a multi-account provider under one row", async () => {
		const mail = {
			...named,
			provider: { ...provider, appId: "ms-mail", name: "Microsoft Graph Mail" },
			instanceLabel: "Mail account",
		};
		await render([base, named, mail]);
		const calendar = host.querySelector('[data-account-group="ms-calendar"]')!;
		expect(calendar.textContent).toContain("Default account");
		expect(calendar.textContent).toContain("Work account");
		expect(calendar.textContent).not.toContain("Mail account");
	});

	it.each(["Rename", "Reconnect", "Disconnect"])(
		"routes %s through the exact named account",
		async (action) => {
			const props = await render([base, named]);
			const items = await menu();
			await act(async () =>
				items.find((item) => item.textContent === action)!.click(),
			);
			const callback =
				action === "Rename"
					? props.onRename
					: action === "Reconnect"
						? props.onReconnect
						: props.onDisconnect;
			expect(callback).toHaveBeenCalledWith(named);
		},
	);

	it("routes Connect another account to the exact provider", async () => {
		const props = await render([base, named]);
		await act(async () => button("Connect another account")!.click());
		expect(props.onAdd).toHaveBeenCalledWith(provider);
	});

	it("offers no second account where the app takes one account", async () => {
		await render(
			[{ ...base, provider: { ...provider, connectionType: "api_key" } }],
			{ owner: "organization" },
		);
		expect(host.textContent).toContain("One account");
		await expand();
		expect(host.textContent).toContain("Everyone in this organization");
		expect(host.textContent).toContain("Tedix keeps one key per owner");
		expect(button("Connect another account")).toBeUndefined();
	});

	it("puts the actionable reason on the affected row instead of a page banner", async () => {
		const props = await render([
			{ ...named, accountState: "unknown", connection: null },
			{ ...base, accountState: "restricted", connection: null },
		]);
		expect(host.textContent).toContain("Couldn't check this account");
		expect(host.textContent).toContain("Provider didn't allow a status check");
		expect(host.textContent).not.toContain("Not connected");
		expect(host.textContent).not.toContain("Verification");
		await expand();
		await act(async () => button("Check connection")!.click());
		expect(props.onCheck).toHaveBeenCalledOnce();
	});

	it("keeps management actions disabled without permission", async () => {
		const props = await render([base, named], { canManage: () => false });
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

	it("binds only explicit named account targets, by app name", async () => {
		const target = {
			appId: "second-calendar-app",
			appSlug: "second-calendar",
			source: "app" as const,
		};
		const row = { ...named, bindingTargets: [target] };
		const props = await render([row]);
		await expand();
		await act(async () => button("Use for Second calendar")!.click());
		expect(props.onBind).toHaveBeenCalledWith(row, target);
	});

	it("collapses never-connected apps under Available to connect", async () => {
		const props = await render([
			base,
			{
				...base,
				provider: { ...provider, appId: "alpic", name: "Alpic" },
				accountState: "missing",
				connection: null,
			},
		]);
		expect(host.textContent).toContain("Available to connect");
		expect(host.querySelector('[data-account-group="alpic"]')).toBeNull();
		await act(async () =>
			[...host.querySelectorAll("button")]
				.find((item) => item.textContent?.includes("Available to connect"))!
				.click(),
		);
		const alpic = host.querySelector('[data-account-group="alpic"]')!;
		await act(async () => button("Connect", alpic)!.click());
		expect(props.onConnect).toHaveBeenCalledOnce();
	});
});
