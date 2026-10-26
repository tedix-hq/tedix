import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
	ConnectionCapability,
	ConnectionInventoryRow,
	ConnectionProvider,
} from "@tedix/api-contract/schemas/connections";
import { AccountList, groupAccounts } from "./account-list";
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
	accountMode: "multiple",
	availableAccountModes: ["single", "multiple"],
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
	it.each(["organization", "personal"] as const)(
		"%s account list shows each permission and a link for every missing one, including read-only viewers",
		async (owner) => {
			(
				globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
			).IS_REACT_ACT_ENVIRONMENT = true;
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			await act(async () =>
				root.render(
					<AccountList
						owner={owner}
						groups={groupAccounts([row])}
						isChecking={false}
						onCheck={noop}
						canManage={() => false}
						deniedReason={() => "Ask an administrator"}
						canAdd={() => false}
						canBind={false}
						isConnecting={false}
						isDisconnecting={false}
						isBinding={false}
						onConnect={noop}
						onReconnect={noop}
						onDisconnect={noop}
						onRename={noop}
						onAdd={noop}
						onBind={noop}
						serviceHealth={{}}
						onCheckService={noop}
					/>,
				),
			);
			// The missing permissions are the row's one status.
			expect(host.textContent).toContain(
				"Needs attention: Missing permission for Send mail, Write mail",
			);
			await act(async () =>
				host
					.querySelector<HTMLButtonElement>(
						'button[aria-label="Mail details"]',
					)!
					.click(),
			);
			for (const capability of capabilities) {
				const element = host.querySelector(
					`[data-connection-capability="${capability.id}"]`,
				);
				expect(element, `${owner}: missing ${capability.label}`).not.toBeNull();
				expect(element?.textContent).toContain(capability.label);
				expect(element?.textContent).toContain(
					{
						connected: "Granted",
						not_configured: "Not granted",
						needs_reauth: "Sign in again",
						not_supported: "Not available here",
					}[capability.state],
				);
				if (
					capability.state === "not_configured" ||
					capability.state === "needs_reauth"
				) {
					const link = element?.querySelector("a");
					expect(link?.getAttribute("aria-label")).toBe(
						`Set up ${capability.label}`,
					);
					expect(link?.getAttribute("href")).toBe(capability.setupUrl);
				}
			}
			await act(async () => root.unmount());
			host.remove();
		},
	);
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
