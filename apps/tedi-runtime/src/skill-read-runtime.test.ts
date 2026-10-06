/**
 * Native read_skill availability and correlation. The parent DO builds several
 * independent per-turn ToolSets; every one must include read_skill, and each
 * read_skill must capture its own turn's platform context instead of reading
 * mutable DO-wide state at execution time.
 */
import assert from "node:assert/strict";
import {
	chatTurnProbe,
	MCP_FACET_TURN_INPUT,
	mcpFacetTurnProbe,
	tediDo,
} from "../test/tedi-do";

const options = { toolCallId: "t", messages: [] };
type Executable = { execute: (input: unknown, options: unknown) => unknown };

function reader(label: string, reads: string[]) {
	return {
		setEpisodeTrace() {},
		async getSkillForMcp(input: { slug?: string }) {
			reads.push(`${label}:${input.slug}`);
			return { slug: input.slug, body: "procedure" };
		},
	};
}

// --- read_skill captures its ToolSet's platform, not the active turn ---
{
	const reads: string[] = [];
	const agent = tediDo({
		activeTurnBinding: { platform: reader("active", reads) },
		async getPlatformClient() {
			return reader("fallback", reads);
		},
	});
	const bound = agent.skillReadTool({ platform: reader("bound", reads) })
		.read_skill as Executable;
	const unbound = agent.skillReadTool(null).read_skill as Executable;
	await bound.execute({ slug: "deploy" }, options);
	await unbound.execute({ slug: "deploy" }, options);
	assert.deepEqual(reads, ["bound:deploy", "fallback:deploy"]);
}

// --- administrative ToolSets do not borrow another active turn ---
{
	const reads: string[] = [];
	const agent = tediDo({
		env: {},
		state: {},
		activeTurnBinding: { platform: reader("turn", reads) },
		async getPlatformClient() {
			return reader("fallback", reads);
		},
		browserAiTools: () => ({}),
		cronAiTool: () => ({}),
		objectStoreAiTools: () => ({}),
		r2SqlAiTool: () => ({}),
	});
	await (agent.getTools(null).read_skill as Executable).execute(
		{ slug: "deploy" },
		options,
	);
	assert.deepEqual(reads, ["fallback:deploy"]);
}

// --- every facet ToolSet (MCP/workflow setup, SSE, email) includes a
//     binding-aware read_skill ---
{
	const bindings: unknown[] = [];
	const skillReadTool = (binding: unknown) => {
		bindings.push(binding);
		return { read_skill: { marker: "read_skill" } };
	};
	const runtime = {
		bindTurn() {},
		clearTurn() {},
		getSystemInstructions: () => "MCP",
	};
	const platform = { setEpisodeTrace() {} };

	const setup = await mcpFacetTurnProbe({
		mcpRuntime: runtime,
		platform,
		fields: { skillReadTool },
	}).prepareMcpFacetTurn(MCP_FACET_TURN_INPUT);
	assert.ok("read_skill" in setup.tools);

	const sse = chatTurnProbe({
		mcpRuntime: runtime,
		platform,
		async facetTurn() {
			return { assistantText: "ok" };
		},
		fields: { skillReadTool },
	});
	await sse.run({ text: "hello" });
	assert.ok("read_skill" in sse.facetInputs[0]!.tools);

	let emailTools: Record<string, unknown> = {};
	const email = tediDo({
		env: {},
		state: { tediId: "tedi-1", slug: "acme" },
		mcpRuntime: null,
		async getMcpRuntime() {
			return runtime;
		},
		async getPlatformClient() {
			return platform;
		},
		workspaceAiTools: () => ({}),
		browserAiTools: () => ({}),
		durableCodemodeAiTools: () => ({}),
		cronAiTool: () => ({}),
		workstationAiTool: () => ({}),
		objectStoreAiTools: () => ({}),
		r2SqlAiTool: () => ({}),
		skillReadTool,
		effectiveStepCeiling: () => 8,
		async runConversationFacetTurn(input: { tools: Record<string, unknown> }) {
			emailTools = input.tools;
			return { assistantText: "ok", turnError: null };
		},
	});
	await email.completeEmailTurn({
		system: "SYSTEM",
		sessionKey: "email:thread-1",
		runId: "run-1",
		inboundEmail: {},
		payload: { from: "a@example.com", subject: "Hi", threadId: "thread-1" },
		guardedUserText: "hello",
		userTs: 1,
	});
	assert.ok("read_skill" in emailTools);

	assert.equal(bindings.length, 3);
	for (const binding of bindings) {
		assert.equal(
			(binding as { platform?: unknown } | null)?.platform,
			platform,
			"each facet read_skill captures that turn's binding",
		);
	}
}

console.log("skill-read-runtime.test.ts: all assertions passed");
