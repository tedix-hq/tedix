import { stepLabel } from "./wire";
import { describe, expect, test } from "bun:test";
import {
	BINDING_NAMES,
	describeBinding,
	renderEnvDeclarations,
} from "./declarations";
import {
	buildSystemPrompt,
	dynamicPromptSuffix,
	STATIC_RULES,
	staticPromptPrefix,
} from "./prompt";

describe("prompt", () => {
	test("typed sheet and presentation methods are discoverable and writes are labeled", () => {
		for (const [binding, type] of [
			["sheets", "Sheets"],
			["presentations", "Presentations"],
		] as const) {
			expect(describeBinding(binding)).toContain(`interface ${type}`);
			expect(renderEnvDeclarations()).toContain(`${binding}: ${type}`);
			expect(stepLabel(binding, "read").kind).toBe("read");
			for (const method of ["replace", "edit"])
				expect(stepLabel(binding, method).kind).toBe("write");
		}
	});

	test("building an app is a labeled write the agent is told how to make", () => {
		expect(stepLabel("apps", "create")).toEqual({
			label: "Creating a new app",
			kind: "write",
		});
		expect(
			stepLabel("outputs", "create", {
				title: "Trip budget",
				content: { kind: "sheet" },
			}).label,
		).toBe("Creating the sheet Trip budget");
		expect(describeBinding("apps")).toContain("create(input: { name: string");
		expect(STATIC_RULES).toContain("env.apps.create({ name, files })");
		expect(STATIC_RULES).toContain("server.js");
		expect(STATIC_RULES).toContain("client.js");
	});

	test("the agent can discover read tools and ask for a missing connection", () => {
		expect(stepLabel("resources", "requestConnection")).toEqual({
			label: "Asking for a connected account",
			kind: "read",
		});
		const declared = describeBinding("resources") ?? "";
		for (const field of [
			"slot",
			"providerId",
			"service",
			"connectionScope",
			"connectionInstanceId",
			"providerAccess",
			"connectedForYou",
		])
			expect(declared).toContain(`${field}:`);
		expect(declared).toContain("requestConnection(input: { resourceId");
		expect(declared).not.toContain("personalOwnerUserId");
		expect(STATIC_RULES).toContain("env.resources.requestConnection");
		expect(STATIC_RULES).toContain("env.accounts.describe(resourceId)");
		expect(describeBinding("accounts")).toContain("interface Accounts");
	});

	test("static prefix is identical across turns and carries every binding", () => {
		const a = staticPromptPrefix();
		const b = staticPromptPrefix();
		expect(a).toBe(b);
		for (const name of BINDING_NAMES) expect(a).toContain(`${name}:`);
		expect(a).toContain("interface Env");
	});

	test("dynamic suffix comes after the prefix", () => {
		const prompt = buildSystemPrompt({
			workspaceName: "Programme workspace",
			nowIso: "2026-11-07T17:00:00.000Z",
			tediPrompt: "You are Pat Example, a tedi.",
		});
		expect(prompt.startsWith(staticPromptPrefix())).toBe(true);
		expect(prompt.indexOf("Workspace: Programme workspace")).toBeGreaterThan(
			prompt.indexOf("interface Env"),
		);
		expect(
			dynamicPromptSuffix({ workspaceName: "x", nowIso: "t" }),
		).not.toContain("tedi");
	});

	test("describeBinding returns one binding whole, unknown names null", () => {
		expect(describeBinding("work")).toContain("interface Work");
		expect(describeBinding("work")).not.toContain("interface Outputs");
		expect(describeBinding("nope")).toBeNull();
		expect(renderEnvDeclarations()).toContain("interface Work");
	});

	test("a referenced skill body is part of the dynamic suffix, not the static prefix", () => {
		const input = {
			workspaceName: "Programme workspace",
			nowIso: "2026-11-07T17:00:00.000Z",
			referencedSkills: [
				{
					slug: "weekly-report",
					title: "Weekly report",
					content: "Step 1: do it",
				},
			],
		};
		expect(dynamicPromptSuffix(input)).toContain('slug="weekly-report"');
		expect(dynamicPromptSuffix(input)).toContain("Step 1: do it");
		expect(staticPromptPrefix()).not.toContain("Step 1: do it");
	});

	test("a held write does not tell the agent to stop", () => {
		const prefix = staticPromptPrefix();
		expect(prefix).toContain("while the chat goes on");
		expect(prefix).not.toContain("needs approval and stop");
	});

	test("the agent is told which changes apply at once and which wait", () => {
		expect(STATIC_RULES).toContain(
			"A new document, sheet or presentation and an edit to one apply at once",
		);
		expect(STATIC_RULES).toContain(
			"undo it from your reply or from version history",
		);
		expect(STATIC_RULES).toContain(
			"Removing content from a file, deleting, sharing, a new app, a web page and filing a proposed Work Item wait for the person",
		);
		const prefix = staticPromptPrefix();
		expect(prefix).not.toContain("workspace rule");
		expect(prefix).not.toMatch(/may (need|require) approval/);
	});

	test("changes still waiting for a decision are in the turn's context", () => {
		const suffix = dynamicPromptSuffix({
			workspaceName: "Programme workspace",
			nowIso: "2026-11-07T17:00:00.000Z",
			pendingApprovals: [
				{ action: "Creating a new output", target: "Budget" },
				{ action: "Filing a Work Item", target: null },
			],
		});
		expect(suffix).toContain("<waiting_for_approval");
		expect(suffix).toContain("- Creating a new output: Budget");
		expect(suffix).toContain("- Filing a Work Item\n");
		expect(staticPromptPrefix()).not.toContain("Budget");
		expect(
			dynamicPromptSuffix({
				workspaceName: "Programme workspace",
				nowIso: "2026-11-07T17:00:00.000Z",
			}),
		).not.toContain("waiting_for_approval");
	});
});

test("the agent reads a web page by calling it, not by asking in the chat first", () => {
	expect(STATIC_RULES).toContain("call `env.web.fetch(url)`");
	expect(STATIC_RULES).toContain(
		"never ask in the chat first whether you may read a page",
	);
	expect(STATIC_RULES).toContain("approval card that names the site");
	expect(STATIC_RULES).not.toContain("then stop");
});
