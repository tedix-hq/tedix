import { describe, expect, it } from "bun:test";
import { laneReservedActions } from "./lane-reserved-actions";

// Excerpts of accepted Work from the 27 Oct 2026 lane queue; personal and
// customer names are replaced with fictional ones.
describe("laneReservedActions", () => {
	it.each([
		"Fix the profile panel’s Gmail address, consent check, and approval count; import your sent-email writing style read-only and confirm it live.",
		"Background consent must work with the default personal account (no 'Add account' step)",
		"Launched workers should get least-privilege credentials, not the owner's platform:admin login",
		"Move the GitHub token out of the workstation container onto the outbound handler. apps/tedi/src/workstation/github-credentials.ts writes a real GitHub PAT into the container filesystem at the git credentials path, so any process in the container can read it. Swap the credential file for header injection on the egress handler.",
		"Owner login exceeds the gateway's 100/min limit, so every local command queues. Options: give owner-login traffic a ceiling like external agents.",
		"Keep human logins across turns: takeover-to-persistent session with audit and end-session. After an approved Live View takeover (login/mfa/consent), the logged-in state persists for that tedi until expiry. Record the login, make it visible, and let an operator end it without a new takeover; an operator action/tool ends the session and deletes the Browser Run session.",
		"Public review link: a reviewer opens the app without an account and rates cards. Today every share link redirects to sign-in. Build a guest link for one app: opens on a phone without sign-in, never exposes other workspaces, outputs, connections or credentials.",
		"Internal token exchange pilot with a recorded actor chain: packages/auth token-exchange module + API broker; narrow scopes against consent, actor entitlement and tool policy.",
		"Dissolve apps/tedi into tedi-runtime: delete body-launcher single-use abstraction. Done when: apps/tedi deleted, routes served by tedi-runtime.",
		"Write a short section in the public docs on the reliable pattern: send with run_tedi_turn, treat a timeout as possibly pending, read the reply with messages_read on the same session_key.",
		"Make the pre-push gates pass in every agent environment. A tedi can publish a customer name to the public repo.",
		"Measure current Deck and last 30 days, audit samples, publish Workspace Output and one Feed post. No card writes.",
		"Theme editable directories only. No cutover, routing, DNS or content publish; preserve all five pending drafts.",
		"Read-only research and draft inventory only; no publishing, visibility changes, external sends, credential or consent changes.",
		"Record GitHub security controls and the exact price. Do not enable settings, purchase, accept terms, rotate credentials or publish.",
		"Resolve the programme outcome from application sources. No new application, external send, consent, payment, credentials or legal assertion.",
		"No owner action now; no submission, external sending, booking, consent, payment or publication is authorised.",
		"Requires independent review; no approval weakening, impersonation, real sensitive effect or new permission grant in the diagnostic stage.",
		"Shadow holdout then measure writer suppression, false negatives, cost and latency; no send/publish authority changes.",
		"Agents cannot approve their own consequential actions, invite members, or change roles.",
		"FALLBACK SPEND IS INVISIBLE. UNPRICED SPEND IS DELETED in packages/db/src/utils/model-pricing.ts.",
	])(
		"lets a lane take code or research work that only mentions a reserved subject: %s",
		(text) => {
			expect(laneReservedActions(text)).toEqual([]);
		},
	);

	it.each([
		[
			"Use computer-use on the logged-in WhatsApp Desktop app on this Mac and send questions in the assistant chat.",
			"external_message",
		],
		[
			"Snapshots before 17 Oct still contain the removed listing. Done when the pre-17-Oct archives are gone and archives older than N days are deleted by a retention rule.",
			"delete_data",
		],
		[
			"Align all four listings, publish MCP Registry 0.2.1, then trigger a Context7 refresh.",
			"public_publish",
		],
		["Send an email to a customer", "external_message"],
		["Reply to the client with the signed quote.", "external_message"],
		[
			"Grant the new connector OAuth consent for the shared inbox.",
			"credentials",
		],
		["Revoke consent for the old integration.", "credentials"],
		["Rotate the Stripe API key and update the Worker.", "credentials"],
		["Run wrangler secret put STRIPE_KEY with the new value.", "credentials"],
		["Log in to the supplier portal and download the report.", "credentials"],
		["Issue a new access token for the reporting tedi.", "credentials"],
		["Pay the open supplier invoice today.", "money"],
		["Raise the budget for the research factory to 50 EUR.", "money"],
		["Purge the tenant's archived messages from D1.", "delete_data"],
		["Drop the customer rows older than a year.", "delete_data"],
		["Sign the partner agreement before Friday.", "legal"],
		["Disable SSO in the live customer org settings.", "customer_config"],
		["No rush, pay the invoice for the fictional supplier today.", "money"],
	])("holds a real reserved act: %s", (text, kind) => {
		expect(laneReservedActions(text)).toContain(kind);
	});
});
