import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
	ConnectionCapability,
	ConnectionInventoryRow,
	ConnectionProvider,
} from "@tedix/api-contract/schemas/connections";
import { ConnectionListItem } from "./connection-list-item";
import { PersonalProviderAccounts } from "./personal-provider-accounts";
import { SetupChecklist } from "./tedi-setup";
import { ConnectionCapabilities } from "./connection-capabilities";

const provider: ConnectionProvider = {
	appId: "mail",
	name: "Mail",
	description: null,
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
const capabilities: ConnectionCapability[] = [
	{
		id: "read",
		label: "Read mail",
		requiredScopes: ["mail.read"],
		state: "connected",
		setupUrl: "/account/connections?connect=mail&capability=read",
		verified: true,
	},
	{
		id: "send",
		label: "Send mail",
		requiredScopes: ["mail.send"],
		state: "not_configured",
		setupUrl: "/account/connections?connect=mail&capability=send",
		verified: true,
	},
	{
		id: "write",
		label: "Write mail",
		requiredScopes: ["mail.write"],
		state: "needs_reauth",
		setupUrl: "/account/connections?connect=mail&capability=write",
		verified: true,
	},
	{
		id: "admin",
		label: "Admin mail",
		requiredScopes: ["mail.admin"],
		state: "not_supported",
		setupUrl: "/account/connections?connect=mail&capability=admin",
		verified: true,
	},
];
const row: ConnectionInventoryRow = {
	provider,
	scope: "user",
	accountState: "present",
	accountLabel: null,
	connection: {
		appId: "mail",
		providerName: "Mail",
		status: "connected",
		connectedAt: null,
		tokenExpiresAt: null,
		scopes: ["mail.read"],
		tokenScope: "user",
	},
	references: [],
	referencesComplete: true,
	access: "not_evaluated",
	health: "not_checked",
	capabilities,
};
const noop = vi.fn();
const surfaces = {
	"organization connections": () => (
		<ConnectionListItem
			provider={provider}
			inventory={row}
			connections={[row.connection!]}
			onConnect={noop}
			isConnecting={false}
			onDisconnect={noop}
			isDisconnecting={false}
			disconnectingKey={null}
			canManage={false}
			manageDeniedReason="Ask an administrator"
			onCheckService={noop}
		/>
	),
	"personal account connections": () => (
		<PersonalProviderAccounts
			provider={provider}
			rows={[row]}
			canManage={false}
			canBind={false}
			canAdd={false}
			isConnecting={false}
			isDisconnecting={false}
			isBinding={false}
			onConnect={noop}
			onRename={noop}
			onDisconnect={noop}
			onAdd={noop}
			onBind={noop}
			onCheckService={noop}
		/>
	),
	"tedi setup checklist": () => (
		<SetupChecklist
			setup={{
				tediId: "worker",
				observedAt: "2026-10-20T18:00:00Z",
				items: [
					{
						id: "mail",
						kind: "connection",
						state: "missing",
						label: "Mail",
						detail: "Mail permissions",
						href: "/account/connections?connect=mail",
						capabilities,
					},
				],
			}}
		/>
	),
};
describe("capability setup links across every unconfigured surface", () => {
	for (const [name, render] of Object.entries(surfaces)) {
		it(`${name} shows individual states and a Set up link for every unconfigured capability, including read-only viewers`, () => {
			const host = document.createElement("div");
			host.innerHTML = renderToStaticMarkup(render());
			for (const capability of capabilities) {
				const element = host.querySelector(
					`[data-connection-capability="${capability.id}"]`,
				);
				expect(element, `${name}: missing ${capability.label}`).not.toBeNull();
				expect(element?.textContent).toContain(capability.label);
				expect(element?.textContent).toContain(
					{
						connected: "Connected",
						not_configured: "Not configured",
						needs_reauth: "Needs re-auth",
						not_supported: "Not supported",
					}[capability.state],
				);
				if (
					capability.state === "not_configured" ||
					capability.state === "needs_reauth"
				) {
					const link = element?.querySelector("a");
					expect(link?.textContent).toBe("Set up");
					expect(link?.getAttribute("href")).toBe(capability.setupUrl);
				}
			}
		});
	}
	it("keeps unverified account inspection distinct from a missing capability", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			<ConnectionCapabilities
				capabilities={[{ ...capabilities[1]!, verified: false }]}
			/>,
		);
		expect(host.textContent).toContain("Could not verify");
		expect(host.textContent).not.toContain("Not configured");
		expect(host.querySelector("a")?.getAttribute("href")).toBe(
			capabilities[1]!.setupUrl,
		);
	});
});
