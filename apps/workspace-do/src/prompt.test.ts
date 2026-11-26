import { stepLabel } from "./wire";
import { describe, expect, test } from "bun:test";
import type {
	MemoryEntry,
	MemoryRevision,
} from "@tedix/agent-governance/types";
import {
	BINDING_NAMES,
	describeBinding,
	renderEnvDeclarations,
} from "./declarations";
import {
	buildSystemPrompt,
	dynamicPromptSuffix,
	markOtherReplies,
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
		expect(declared).toContain("requestConnection(input: { resourceId?");
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
		});
		expect(prompt.startsWith(staticPromptPrefix())).toBe(true);
		expect(prompt.indexOf("Workspace: Programme workspace")).toBeGreaterThan(
			prompt.indexOf("interface Env"),
		);
		expect(
			dynamicPromptSuffix({ workspaceName: "x", nowIso: "t" }),
		).not.toContain("tedi");
	});

	test("a guest tedi's own prompt leads and the workspace rules follow", () => {
		const prompt = buildSystemPrompt({
			workspaceName: "Programme workspace",
			nowIso: "2026-11-07T17:00:00.000Z",
			tediPrompt: "You are Pat Example, a tedi.",
		});
		expect(prompt.startsWith("You are Pat Example, a tedi.\n\n")).toBe(true);
		expect(prompt).not.toContain("You are the agent of one Tedix workspace");
		expect(prompt.indexOf("How to act:")).toBeGreaterThan(0);
		expect(prompt).toContain("interface Env");
	});

	test("a reply someone else wrote is marked with its author; the rest is untouched", () => {
		const person = { role: "user", content: "Hello", timestamp: 1 } as const;
		const reply = (text: string) =>
			({ role: "assistant", content: [{ type: "text", text }] }) as never;
		const history = markOtherReplies(
			[
				{ turnId: "t1", message: person },
				{ turnId: "t1", message: reply("From the agent") },
				{ turnId: "t2", message: person },
				{ turnId: "t2", message: reply("My own") },
			],
			(turnId) => (turnId === "t1" ? "the workspace agent" : null),
		);
		expect(history[0]).toBe(person);
		expect(history[1]).toMatchObject({
			content: [{ text: "[Reply from the workspace agent]\nFrom the agent" }],
		});
		expect(history[3]).toMatchObject({ content: [{ text: "My own" }] });
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

	test("the agent is told which changes apply at once, which stage and which wait", () => {
		expect(STATIC_RULES).toContain(
			"A new document, sheet or presentation and an edit to one apply at once in Auto",
		);
		expect(STATIC_RULES).toContain(
			"undo it from your reply or from version history",
		);
		expect(STATIC_RULES).toContain(
			"In Ask every time and Ask for changes such a write, and filing, commenting on or accepting a Work Item, is staged instead",
		);
		expect(STATIC_RULES).toContain("never say it is done or saved");
		expect(STATIC_RULES).toContain(
			"Removing content from a file, deleting, sharing, a new app, a web page and anything else that is not staged wait for the person",
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
				{ action: "Edit document “Plan”", staged: true },
			],
		});
		// A staged change is listed as staged, never as waiting for a decision.
		expect(suffix).toContain(
			'<staged_changes note="Changes you staged earlier in this conversation.',
		);
		expect(suffix).toContain("- Edit document “Plan”\n</staged_changes>");
		expect(suffix.slice(suffix.indexOf("<waiting_for_approval"))).not.toContain(
			"Plan",
		);
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

	test("approved workspace memory is recalled as durable memory, not chat history", () => {
		const revision = (
			key: string,
			number: number,
			value: unknown,
			review: MemoryRevision["review"],
			extra: Partial<MemoryRevision> = {},
		): MemoryRevision => ({
			revisionId: `${key}-${number}`,
			key,
			revision: number,
			value,
			hash: `hash-${key}-${number}`,
			writtenAt: `2026-11-26T10:00:0${number}.000Z`,
			provenance: {
				actor: { id: "u1", kind: "user", organizationId: "org_test" },
				source: { surface: "workspace_object", traceId: `turn-${number}` },
			},
			review,
			...extra,
		});
		const approved = revision("language", 1, "German", "approved", {
			reviewedBy: "reviewer",
			reviewedAt: "2026-11-26T10:01:00.000Z",
		});
		const pending = revision("language", 2, "French", "pending");
		const pendingOnly = revision("pending-only", 1, "not durable", "pending");
		const entries: MemoryEntry[] = [
			{ key: "language", current: pending, approved },
			{ key: "pending-only", current: pendingOnly },
			{
				key: "rejected",
				current: revision("rejected", 1, "rejected value", "rejected"),
			},
		];
		const suffix = dynamicPromptSuffix({
			workspaceName: "Programme workspace",
			nowIso: "2026-11-26T10:02:00.000Z",
			workspaceMemory: entries,
			workspaceMemoryQuery: "What language should I use?",
		});
		expect(suffix).toContain("<durable_workspace_memory");
		expect(suffix).toContain('"language": "German"');
		expect(suffix).toContain("approved by");
		expect(suffix).toContain("not this conversation's history");
		expect(suffix).not.toContain("French");
		expect(suffix).not.toContain("pending-only");
		expect(suffix).not.toContain("rejected value");
		expect(staticPromptPrefix()).toContain("earlier chat messages are not");
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
