import { describe, expect, it } from "vite-plus/test";
import { resolveWebSearchAccess } from "@tedix/api-contract/schemas/web-search";
import { isAppLevelGrant } from "./delegation-capabilities";
import { buildAutoDelegationDispatcher } from "./auto-dispatch";
import {
	buildDelegationWorkOrder,
	decideDelegationDispatch,
	deriveExecutionRequirement,
	renderDelegationWorkOrderMessage,
} from "./delegation-dispatch";
import type { KernelRouteDecision } from "./route-schema";
import type { TediCapabilityCard } from "./tedi-capabilities";

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

const readerCard: TediCapabilityCard = {
	tediId: "acme-reader",
	slug: "reader",
	name: "Reader",
	apps: [],
	scopeGroups: ["mcp:work"],
	skills: [],
	runtimeKind: "isolate",
	embodied: false,
	availability: "running",
	hasWarmWorkstationLease: false,
	hasRepository: false,
	depsReady: false,
	environmentReady: false,
	requiresApproval: false,
	delegationEntrustments: [],
	dispatchPolicy: null,
	mcpCapabilityProfile: null,
};

describe("read-only Work sweeps", () => {
	it("does not derive Work writes from pasted commit subjects in a read-only reconciliation", () => {
		const result = buildDelegationWorkOrder({
			userContent: [
				'Please reconcile the "accepted" Work items in project 11111111-1111-4111-8111-111111111111 against the commits below and give me a settle-or-keep table. Read-only: do not settle, complete or edit any Work item.',
				"Commits on main:",
				"1a2b3c4 fix(db): batch Work completion with its closing comment",
				"5d6e7f8 fix(home): distinguish source comments from Work writes",
				"Save the table as a document in the internal project. Low risk; drafts only.",
			].join("\n"),
			card: readerCard,
			route,
		});
		const tools = result.capabilityPlan?.allowedToolIds ?? [];
		expect(tools).not.toContain("work.add_comment");
		expect(tools).not.toContain("work.complete_work_item");
		expect(tools).toContain("work.list_work_items");
		expect(tools).toContain("os.create_os_output");
		expect(result.capabilityPlan?.missingCapabilities).toEqual([]);
	});

	it("maps a read-only blocker sweep to Work reads and a saved document", () => {
		const result = buildDelegationWorkOrder({
			userContent:
				'Please sweep stale "night shift blocker" items on the Tedix Work board and give me a table of what can be closed. Read-only on the board; do not cancel, complete or edit anything. Look each up in project 11111111-1111-4111-8111-111111111111. Save it as a document in the internal project.',
			card: readerCard,
			route,
		});
		expect(result.capabilityPlan).toBeDefined();
		expect(result.capabilityPlan?.allowedToolIds).toEqual(
			expect.arrayContaining([
				"work.get_work_items_by_id",
				"work.list_work_item_events",
				"os.create_os_output",
			]),
		);
	});
});

describe("request-derived capability plans", () => {
	it.each(
		[[], ["tedix_mcp_code"], ["tedix_mcp_search_tools"]].map(
			(plannedToolIds) => ({ plannedToolIds }),
		),
	)(
		"dispatches a synthesis question under supervised tools for %j",
		({ plannedToolIds }) => {
			const result = buildDelegationWorkOrder({
				userContent: "Read-only: what did the operator commit to this week?",
				card: readerCard,
				route: { ...route, plannedToolIds },
			});
			expect(result.capabilityPlan).toBeUndefined();
			expect(result.capabilityPlanDecision).toMatchObject({
				capabilityPlan: null,
				reason: expect.stringContaining("supervised tool ceiling"),
			});
			const decision = decideDelegationDispatch({
				route: { ...route, plannedToolIds },
				card: readerCard,
				speaker: { approvalAuthority: true },
				capabilityPlan: result.capabilityPlan,
			});
			expect(decision.mode).toBe("auto");
		},
	);
	it("maps a platform Work comment omitted by the planner without granting unrelated tools", () => {
		const card: TediCapabilityCard = {
			tediId: "acme-reader",
			slug: "reader",
			name: "Reader",
			apps: [],
			scopeGroups: ["mcp:work"],
			skills: [],
			runtimeKind: "isolate",
			embodied: false,
			availability: "running",
			hasWarmWorkstationLease: false,
			hasRepository: false,
			depsReady: false,
			environmentReady: false,
			requiresApproval: false,
			delegationEntrustments: [],
			dispatchPolicy: null,
			mcpCapabilityProfile: null,
		};
		const result = buildDelegationWorkOrder({
			userContent: "Read Work history and add a closing comment",
			card,
			route,
		});
		expect(result.capabilityPlan).toMatchObject({
			requiredCapabilities: ["work.comment", "work.read"],
			missingCapabilities: [],
		});
		expect(result.capabilityPlan?.allowedToolIds).toContain("work.add_comment");
		expect(result.capabilityPlan?.allowedToolIds).toContain(
			"work.list_work_item_attempts",
		);
		expect(result.capabilityPlan?.allowedToolIds).not.toContain(
			"work.complete_work_item",
		);
		const closeout = buildDelegationWorkOrder({
			userContent:
				"Work backlog hygiene for project 11111111-1111-4111-8111-111111111111: verify SHAs on origin/main. Mark each completed with a closing comment.",
			card,
			route,
		});
		expect(closeout.executionRequirement.surface).toBe("workstation");
		expect(closeout.capabilityPlan?.allowedToolIds).toContain(
			"close_completed_work_item",
		);
		expect(closeout.capabilityPlan?.allowedToolIds).not.toContain(
			"work.add_comment",
		);
		expect(closeout.capabilityPlan?.allowedToolIds).not.toContain(
			"work.complete_work_item",
		);
		const summary = buildDelegationWorkOrder({
			userContent: "Summarize Work settled since yesterday in this project.",
			card,
			route,
		});
		expect(summary.capabilityPlan?.requiredCapabilities).toEqual(["work.read"]);
		expect(summary.capabilityPlan?.allowedToolIds).toContain(
			"work.list_attempt_projection",
		);
		expect(summary.capabilityPlan?.allowedToolIds).toContain(
			"work.list_work_item_events",
		);
		expect(summary.capabilityPlan?.allowedToolIds).not.toContain(
			"work.complete_work_item",
		);
		const post = buildDelegationWorkOrder({
			userContent:
				"Write the Today/Feed post from Work settled since yesterday; publish it.",
			card,
			route,
		});
		expect(post.capabilityPlan?.requiredCapabilities).toEqual([
			"work.read",
			"today.read",
			"today.update",
		]);
		expect(post.capabilityPlan?.allowedToolIds).toContain(
			"os.revise_os_output",
		);
		expect(post.capabilityPlan?.allowedToolIds).not.toContain(
			"work.complete_work_item",
		);
		const read = buildDelegationWorkOrder({
			userContent: "Read the Today/Feed post",
			card,
			route,
		});
		expect(read.capabilityPlan?.allowedToolIds).not.toContain(
			"os.revise_os_output",
		);
		const research = buildDelegationWorkOrder({
			userContent:
				"Research the repo and save a 1-page Output in this project.",
			card,
			route,
		});
		expect(research.capabilityPlan?.allowedToolIds).toContain(
			"os.create_os_output",
		);
		expect(research.capabilityPlan?.allowedToolIds).not.toContain(
			"os.revise_os_output",
		);
		const coding = buildDelegationWorkOrder({
			userContent:
				"Refactor the repository. Admission: create (or reuse the named existing) Work item, accept/start it; settle with full SHAs.",
			card,
			route,
		});
		expect(coding.capabilityPlan?.allowedToolIds).not.toContain(
			"work.start_work_item_attempt",
		);
		expect(coding.capabilityPlan?.allowedToolIds).not.toContain(
			"work.settle_work_item_attempt",
		);
		expect(coding.capabilityPlan?.allowedToolIds).not.toContain(
			"work.complete_work_item",
		);
		expect(
			renderDelegationWorkOrderMessage({
				workOrder: { ...coding, workItemId: "linked-work" },
				fallbackContent: "",
				fallbackWorkOrderId: "order",
			}),
		).toContain("Home and the native runtime manage admission");
	});
	it("does not treat source-code comments as a requested Work mutation", () => {
		const result = order(
			"Refactor the repository for the Work item. Leave the header comment intact; keep index.ts untouched except a comment path fix.",
		);
		expect(result.capabilityPlan?.requiredCapabilities).not.toContain(
			"work.comment",
		);
		expect(result.capabilityPlan?.missingCapabilities).not.toContain(
			"work.comment",
		);
	});
	it("falls back before dispatch when a requested Work comment has no exact mapping", () => {
		const content =
			"Research https://example.com and post a comment on Work abcdef01";
		expect(order(content).capabilityPlan).toBeUndefined();
		expect(order(content).capabilityPlanDecision).toMatchObject({
			capabilityPlan: null,
			reason: expect.stringContaining("work.comment"),
		});
		expect(
			order(
				"Work abcdef01\nRead documentation at https://example.com\nPost a comment.",
			).capabilityPlanDecision?.reason,
		).toContain("work.comment");
		expect(
			deriveExecutionRequirement(
				"Research documentation at https://example.com",
				route,
			).requiredCapabilities,
		).toEqual([]);
		const mapped = order(content, ["work.add_comment"]).capabilityPlan;
		expect(mapped?.allowedToolIds).toContain("work.add_comment");
		expect(mapped?.missingCapabilities).toEqual([]);
	});
	it("does not grant access from appended CLI repository metadata", () => {
		const content =
			"Read https://example.com/\n\nLocal terminal context:\n- cwd: /workspace/acme\n- origin: https://code.example/acme/repo.git\n- gitStatus:\n M package.json";
		expect(order(content).capabilityPlan?.urls).toEqual([
			"https://example.com/",
		]);
		expect(
			deriveExecutionRequirement(content, route).requiredCapabilities,
		).toEqual([]);
		expect(order(content).sourceContent).toBe(content);
		expect(
			deriveExecutionRequirement(
				"Run a shell command\n\nLocal terminal context:\n- cwd: /workspace/no workstation",
				route,
			).surface,
		).toBe("workstation");
	});
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
			order("Read that output", ["acme_os.get_os_output"])
				.capabilityPlanDecision?.reason,
		).toContain("output.reference");
	});
	it("runs an app-level Code Mode grant under the executor ceiling instead of an unsatisfiable plan", () => {
		const content =
			"Draft a customer invoice in the accounting app for Example Customer GmbH, EUR 8,000 net. Draft only: do not finalize, send or book.";
		// Connected app slugs are not tool ids the child runtime can serve.
		expect(
			order(content, ["tedix-unified", "sevdesk-tedix"]).capabilityPlan,
		).toBeUndefined();
		// Neither is the aggregate alias of one app tool.
		expect(
			order(content, ["mcp__tedix-unified__code"]).capabilityPlan,
		).toBeUndefined();
		// A known assigned app is recognized by its slug even without a hyphen.
		expect(
			buildDelegationWorkOrder({
				userContent: content,
				card: { ...readerCard, apps: ["sevdesk"] },
				route: { ...route, plannedToolIds: ["sevdesk"] },
			}).capabilityPlan,
		).toBeUndefined();
		// Exact callables and native ids still narrow as before.
		expect(
			order(content, ["sevdesk_tedix.create_invoice_draft"]).capabilityPlan
				?.allowedToolIds,
		).toEqual(["sevdesk_tedix.create_invoice_draft"]);
		expect(isAppLevelGrant("browser_markdown", null)).toBe(false);
		expect(isAppLevelGrant("acme_os.get_os_output", null)).toBe(false);
	});
	it("dispatches an unsatisfiable mapping under supervised tools and records the reason in child metadata", async () => {
		const content = "Draft an email reply";
		const result = buildDelegationWorkOrder({
			userContent: content,
			route,
			card: readerCard,
		});
		const decision = decideDelegationDispatch({
			route,
			card: readerCard,
			speaker: { approvalAuthority: true },
			capabilityPlan: result.capabilityPlan,
		});
		expect(decision.mode).toBe("auto");
		expect(result.capabilityPlan).toBeUndefined();
		expect(result.capabilityPlanDecision).toMatchObject({
			capabilityPlan: null,
			reason: expect.stringContaining("email.draft"),
		});
		const metadata: Record<string, unknown>[] = [];
		const dispatch = buildAutoDelegationDispatcher({
			predictChildRunId: () => "child-run",
			enqueueChild: async (args) => {
				metadata.push(args.metadata);
				return { status: "queued", runId: "child-run" };
			},
		});
		await dispatch({
			homeRunId: "home-run",
			homeConversationId: "conversation",
			userMessageId: "message",
			content,
			delegatedTediId: readerCard.tediId,
			organizationId: "example-org",
			workOrder: result,
		});
		expect(metadata[0]).toMatchObject({
			delegationWorkOrder: {
				capabilityPlanDecision: {
					capabilityPlan: null,
					reason: expect.stringContaining("email.draft"),
				},
			},
		});
		expect(
			(metadata[0]?.delegationWorkOrder as Record<string, unknown>)
				.capabilityPlan,
		).toBeUndefined();
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

describe("web search delegation", () => {
	it.each([
		"Search the web for the latest widget pricing",
		"Search online for widget pricing",
		"Search the internet for widget pricing",
		"Look up widget pricing",
		"What is the latest version of Widget?",
		"What is the latest stable Widget version? Look it up on the web and cite links.",
		"Find the widget price on the internet",
		"Look this up: widget pricing",
	])(
		"infers native search when the planner omitted tools: %s",
		(userContent) => {
			const result = buildDelegationWorkOrder({
				userContent,
				card: { ...readerCard, webSearch: true },
				route,
			});
			expect(result.capabilityPlan).toMatchObject({
				requiredCapabilities: ["web.search"],
				allowedToolIds: [
					"web_search",
					"browser_markdown",
					"browser_read_result",
				],
				missingCapabilities: [],
			});
		},
	);

	it.each([
		{ organization: { enabled: false }, tediPolicy: "inherit" as const },
		{ organization: { enabled: true }, tediPolicy: "off" as const },
		{ organization: { enabled: true }, runtimeTools: ["browser_markdown"] },
	])("does not infer search when policy disables it: %j", (policy) => {
		const result = buildDelegationWorkOrder({
			userContent: "Search the web for widget pricing",
			card: {
				...readerCard,
				webSearch: resolveWebSearchAccess(policy).enabled,
			},
			route,
		});
		expect(result.capabilityPlan?.allowedToolIds ?? []).not.toContain(
			"web_search",
		);
		expect(result.capabilityPlan?.requiredCapabilities ?? []).not.toContain(
			"web.search",
		);
	});

	it.each([
		"Summarize the supplied text",
		"Look up our Work items",
		"Look up the latest invoice",
		"Look it up in our Work items",
		"Read https://example.com/widget",
		"Summarize this text\n\nLocal terminal context:\n- cwd: /tmp/search the web",
	])("does not infer search for a non-web request: %s", (userContent) => {
		const result = buildDelegationWorkOrder({
			userContent,
			card: { ...readerCard, webSearch: true },
			route,
		});
		expect(result.capabilityPlan?.allowedToolIds ?? []).not.toContain(
			"web_search",
		);
	});

	const ask = "What changed in the latest public pricing for example widgets?";
	it("allows planned web search only on a tedi that offers it", () => {
		const enabled = buildDelegationWorkOrder({
			userContent: ask,
			card: { ...readerCard, webSearch: true },
			route: { ...route, plannedToolIds: ["web_search"] },
		});
		expect(enabled.capabilityPlan?.requiredCapabilities).toContain(
			"web.search",
		);
		expect(enabled.capabilityPlan?.allowedToolIds).toEqual(
			expect.arrayContaining([
				"web_search",
				"browser_markdown",
				"browser_read_result",
			]),
		);

		const disabled = buildDelegationWorkOrder({
			userContent: ask,
			card: readerCard,
			route: { ...route, plannedToolIds: ["web_search"] },
		});
		expect(disabled.capabilityPlan?.allowedToolIds ?? []).not.toContain(
			"web_search",
		);
		expect(disabled.capabilityPlan?.requiredCapabilities ?? []).not.toContain(
			"web.search",
		);
	});
});
