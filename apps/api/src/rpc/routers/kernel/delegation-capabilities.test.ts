import { describe, expect, it } from "vite-plus/test";
import {
	buildDelegationWorkOrder,
	decideDelegationDispatch,
	deriveExecutionRequirement,
	renderDelegationWorkOrderMessage,
} from "./delegation-dispatch";
import type { KernelRouteDecision } from "./route-schema";

const route: KernelRouteDecision = {
	routeKind: "delegate_tedi",
	answer: null,
	rationale: "Read the requested source",
	risk: "low",
	confidence: 1,
	effortClass: "single_read",
	targetTediId: "acme-reader",
	targetTediLabel: "Reader",
	targetActivityId: null,
	plannedToolIds: [],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: "Cited result",
};
function order(content: string, plannedToolIds: string[] = []) {
	return buildDelegationWorkOrder({
		userContent: content,
		card: null,
		route: { ...route, plannedToolIds },
	});
}

describe("request-derived capability plans", () => {
	it("does not infer execution from URL path words or an oversized effort budget", () => {
		expect(
			deriveExecutionRequirement("TLDR https://example.com/deploy/docs", {
				...route,
				effortClass: "embodied",
			}).surface,
		).toBe("native");
	});
	it("keeps checkout edits compatible with the runtime repository tool surface", () => {
		const result = order("Fix the repository README");
		expect(result.capabilityPlan?.allowedToolIds).toContain("open_computer");
		expect(result.capabilityPlan?.allowedToolIds).not.toContain("clone_repo");
	});
	it("does not turn a documentation URL into repository execution", () => {
		expect(
			order("Summarize these docs https://example.com/docs").capabilityPlan
				?.allowedToolIds,
		).toEqual(["browser_markdown", "browser_read_result"]);
	});
	it("keeps a planned read-only browser tool on the native surface", () => {
		expect(
			deriveExecutionRequirement("TLDR https://example.com", {
				...route,
				plannedToolIds: ["browser_markdown", "browser_read_result"],
			}).surface,
		).toBe("native");
	});
	it("grants a URL reader without browser automation, shell or provider mutation", () => {
		const result = order("TLDR https://example.com/article");
		expect(result.capabilityPlan).toEqual({
			version: "delegation-capabilities.v1",
			requiredCapabilities: ["page.read"],
			allowedToolIds: ["browser_markdown", "browser_read_result"],
			missingCapabilities: [],
			urls: ["https://example.com/article"],
			outputIds: [],
		});
		const message = renderDelegationWorkOrderMessage({
			workOrder: { ...result },
			fallbackContent: "",
			fallbackWorkOrderId: "acme-order",
		});
		expect(message).toContain("Required capabilities: page.read");
		expect(message).toContain(
			"Granted tools (subject to executor policy): browser_markdown, browser_read_result",
		);
	});
	it("selects an exact email draft callable and excludes send", () => {
		const result = order("Draft an email reply", [
			"acme_mail.create_draft",
			"acme_mail.send_email",
		]);
		expect(result.capabilityPlan?.allowedToolIds).toEqual([
			"acme_mail.create_draft",
		]);
	});
	it("bounds output readback by a plain output reference too", () => {
		const result = order("Read output 11111111-1111-4111-8111-111111111111", [
			"acme_os.get_os_output",
		]);
		expect(result.capabilityPlan?.requiredCapabilities).toEqual([
			"output.read",
		]);
		expect(result.capabilityPlan?.outputIds).toEqual([
			"11111111-1111-4111-8111-111111111111",
		]);
		expect(
			order("Read that output", ["acme_os.get_os_output"]).capabilityPlan
				?.missingCapabilities,
		).toContain("output.reference");
	});
	it("blocks a mandatory capability with no exact mapping, with Home owning the reroute", () => {
		const result = order("Draft an email reply");
		const decision = decideDelegationDispatch({
			route,
			card: null,
			speaker: { approvalAuthority: true },
			capabilityPlan: result.capabilityPlan,
		});
		expect(decision.mode).toBe("blocked");
		expect(decision.reason).toContain("Home must reroute");
		expect(decision.failure?.category).toBe("capability");
	});
	it("requires output readback instead of a page reader for an OS output reference", () => {
		const result = order(
			"Read https://example.com/outputs/11111111-1111-4111-8111-111111111111",
			["acme_os.get_os_output", "acme_os.update_os_output"],
		);
		expect(result.capabilityPlan?.allowedToolIds).toEqual([
			"acme_os.get_os_output",
		]);
		expect(result.capabilityPlan?.outputIds).toEqual([
			"11111111-1111-4111-8111-111111111111",
		]);
	});
	it("derives workstation execution tools for a repository change requiring native Git", () => {
		const content = "Fix the repository and git push the change";
		expect(deriveExecutionRequirement(content, route).surface).toBe(
			"workstation",
		);
		const result = order(content);
		expect(result.capabilityPlan?.requiredCapabilities).toContain(
			"workstation",
		);
		expect(result.capabilityPlan?.allowedToolIds).toContain("open_computer");
		expect(result.capabilityPlan?.allowedToolIds).not.toContain(
			"tedix_mcp_code",
		);
	});
});
