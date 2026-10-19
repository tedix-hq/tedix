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
		"Add a comment to the target Work",
		"Write research notes and save an Output",
		"Fix the parser and push through normal gates",
		"Read the paper; do not send messages.",
		"Draft an email to a customer",
		"Read the email inbox",
		"Inspect the OAuth status",
		"Read README; do not read /workspace/.env",
		"Draft email options; the operator reviews every message before sending. No bulk outreach or automatic sends.",
	])("allows non-critical low and medium work: %s", (content) => {
		for (const risk of ["low", "medium"] as const)
			expect(
				decideAutonomousAction({ policy, risk, content }).autoApprove,
			).toBe(true);
	});
	it.each([
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
				policy: { autonomy: policy },
				sessionAllowlist: ["*"],
				proposal: { appSlug: "mail", toolName: "send_email", riskTier: "low" },
			}).autoResolve,
		).toBe(false);
		expect(
			decideKernelWriteApproval({
				policy: { autonomy: policy },
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
