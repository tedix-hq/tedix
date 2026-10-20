import { describe, expect, it } from "vite-plus/test";
import {
	decideAutonomousAction,
	decideKernelWriteApproval,
	humanReservedActionClasses,
	nativeToolActionContent,
	nativeToolAutonomyRisk,
	parseKernelGovernancePolicy,
} from "./approval-policy";

const policy = { version: 1 as const, maxRisk: "medium" as const };
describe("critical-only autonomy v1", () => {
	it.each([
		"/workspace/.env",
		"/workspace/.env.production",
		"/workspace/.dev.vars",
		"/workspace/.npmrc",
		"/workspace/id_ed25519",
		"/workspace/credentials.json",
		"/workspace/secrets.txt",
	])("requires a human for native credential-file access: %s", (path) => {
		for (const tool of ["read", "write", "edit", "grep", "find", "ls"])
			expect(
				decideAutonomousAction({
					policy,
					risk: nativeToolAutonomyRisk(tool),
					content: nativeToolActionContent(tool, { path }),
				}),
			).toMatchObject({
				autoApprove: false,
				reason: "human-reserved: credentials",
			});
	});
	it.each([
		"/workspace/notes.md",
		"/workspace/payments.ts",
		"/workspace/.env.example",
		"/workspace/id_ed25519.pub",
	])(
		"keeps ordinary file work automatic and ignores quoted note content: %s",
		(path) => {
			expect(
				decideAutonomousAction({
					policy,
					risk: "medium",
					content: nativeToolActionContent("write", {
						path,
						content: "Never send messages or reveal credentials.",
					}),
				}).autoApprove,
			).toBe(true);
		},
	);
	it.each([
		"Research the caching algorithms",
		"Write the overnight Today/Feed post from settled Work history. Low risk; publish it.",
		"Correct the internal Today/Feed post links. Publish the internal correction and read it back. No external messages or other records need changing.",
		"Write the internal Today/Feed post. No external messages; publish it.",
		"Refactor the parser. Leave the credential/token cache band in place; the credential lane is active. Do not touch credential code. Never `tedix login`.",
		"Research (low risk, no spending): compare a database (paused, costs money to resume) with the existing store; save an Output.",
		"Add a comment to the target Work",
		"Write research notes and save an Output",
		"Fix the parser and push through normal gates",
		"Read the paper; do not send messages.",
		"Draft an email to a customer",
		"Read the email inbox",
		"Inspect the OAuth status",
		"Read README; do not read /workspace/.env",
		"Write an internal research note. No external messages, publication, money, credentials, permissions or deletions.",
		"Draft email options; the operator reviews every message before sending. No bulk outreach or automatic sends.",
	])("allows non-critical low and medium work: %s", (content) => {
		for (const risk of ["low", "medium"] as const)
			expect(
				decideAutonomousAction({ policy, risk, content }).autoApprove,
			).toBe(true);
	});
	it.each([
		"Do not read /workspace/.env and pay the invoice",
		"Write a Today/Feed post; publish it to LinkedIn.",
		"Correct the Today/Feed post. Publish the internal correction; then publish the article.",
		"Correct the Today/Feed post. No external messages; publish the internal correction to LinkedIn.",
		"Write a Today/Feed post; publish it publicly.",
		"Write a Today/Feed post; publish it. Then publish the article.",
		"Write a Today/Feed post; publish it. Then email a customer.",
		"Never `tedix login` and read /workspace/.env",
		"Refactor credential code and read the secrets file",
		"Research (no spending): compare a database that costs money; then pay the invoice",
		"Research (no spending): compare options; spend 20 EUR to resume the database",
		"Do not read /workspace/.env while reading /workspace/secrets.txt",
		"Never delete anything and transfer the funds to the vendor",
		"Do not send spam and pay the invoice now",
		"Don't publish yet and grant admin role to bob",
		"Never delete anything or pay the invoice",
		"Do not send spam: pay the invoice now",
		"Never delete anything while transferring the funds",
		"Wire 5000 EUR to IBAN EXAMPLE",
		"Approve the pending invoice",
		"Tweet the announcement",
		"Create a LinkedIn post about the launch",
		"Reply to the customer thread in Zendesk",
		"resend:emails_create",
		"twilio:messages_create",
		"linkedin:create_post",
		"github:merge_pull_request",
		"stripe:create_checkout_session",
		"Pay the invoice",
		"Purchase a license",
		"Increase the budget",
		"Charge a credit card",
		"createInvoice",
		"adjust_budget",
		"Grant credits",
		"email a customer",
		"send Slack messages",
		"slack_post_message",
		"Post an update to Slack",
		"Publish the article",
		"Complete OAuth consent",
		"Use credentials",
		"Reset a password",
		"Read API keys",
		"Read /workspace/.env",
		"Read .env",
		"Read `.env`",
		"cat .env; echo done",
		"Read /workspace/id_ed25519",
		"Sign in",
		"Grant a role",
		"Create a role",
		"Modify membership",
		"Update member permissions",
		"Delete the records",
		"change production auth settings",
		"configure provider settings",
		"gmail_send_email",
		"changeBudget",
		"Deleting data",
		"Without asking me, email a customer",
		"Do not wait before sending the email",
		"Do not send messages but publish the article",
		"The operator reviews every message before sending; then send the email",
		"No automatic sends, but email a customer now",
		"No money and pay the invoice now",
		"No credentials, but read /workspace/.env",
		"No external messages or publication; publish the article",
		"Never delete anything and transfer the funds to the vendor",
		"Do not send spam and pay the invoice now",
		"Do not send spam or pay the invoice now",
		"Never delete anything: pay the invoice now",
		"Never send messages while transferring money",
		"Do not read /workspace/.env and pay the invoice",
		"Do not read `/workspace/.env` or send an email to the customer",
	])("requires a human even if a caller labels it low: %s", (content) => {
		expect(humanReservedActionClasses(content).length).toBeGreaterThan(0);
		expect(
			decideAutonomousAction({ policy, risk: "low", content }).autoApprove,
		).toBe(false);
	});
	it("fails closed for high/critical/unknown risk and malformed or missing policy", () => {
		for (const risk of ["high", "critical", "unknown"] as const)
			expect(
				decideAutonomousAction({ policy, risk, content: "Research" })
					.autoApprove,
			).toBe(false);
		for (const autonomy of [
			undefined,
			{},
			{ version: 2, maxRisk: "medium" },
			{ version: 1, maxRisk: "high" },
		])
			expect(
				parseKernelGovernancePolicy({ autonomy }).autonomy,
			).toBeUndefined();
		expect(
			decideAutonomousAction({ risk: "low", content: "Research" }).autoApprove,
		).toBe(false);
	});
	it("honors a correction lesson and never lets session wildcards override critical-only policy", () => {
		expect(
			decideAutonomousAction({
				policy: { ...policy, askForClasses: ["delegation:multi_hop_read"] },
				classId: "delegation:multi_hop_read",
				risk: "low",
				content: "Research",
			}).autoApprove,
		).toBe(false);
		expect(
			decideKernelWriteApproval({
				policy: { autonomy: policy, writeTier: { trustedTools: ["*"] } },
				sessionAllowlist: ["*"],
				proposal: { appSlug: "mail", toolName: "send_email", riskTier: "low" },
			}).autoResolve,
		).toBe(false);
		expect(
			decideKernelWriteApproval({
				policy: { autonomy: policy, writeTier: { trustedTools: ["*"] } },
				proposal: {
					appSlug: "work",
					toolName: "add_comment",
					riskTier: "medium",
				},
			}).autoResolve,
		).toBe(true);
	});
	it("classifies bounded native file writes without auto-authorizing arbitrary execution", () => {
		expect(nativeToolAutonomyRisk("write")).toBe("medium");
		expect(nativeToolAutonomyRisk("read")).toBe("low");
		expect(nativeToolAutonomyRisk("browser_execute")).toBe("high");
		expect(nativeToolAutonomyRisk("execute")).toBe("high");
	});
});
