import { describe, expect, test } from "bun:test";
import {
	InMemoryAccountabilityAdapter,
	InMemoryComplianceAdapter,
} from "@tedix/agent-governance/in-memory";
import { WorkflowManifestSchema } from "./workflow-manifest";
import {
	runWorkflow,
	type WorkflowPorts,
	type WorkflowStepReceipt,
} from "./workflow-runner";

const postsSchema = {
	type: "object",
	required: ["posts"],
	additionalProperties: false,
	properties: {
		posts: {
			type: "array",
			items: {
				type: "object",
				required: ["url", "opportunity"],
				properties: {
					url: { type: "string" },
					opportunity: { type: "string" },
				},
			},
		},
	},
};

// Fictional revision IDs and tools: no tenant data or provider calls.
const opportunity = {
	version: 1,
	skillRevisionId: "sample-reddit-opportunity-research-revision-test",
	steps: [
		{
			id: "search",
			kind: "tool",
			tool: "reddit_search",
			args: { query: "price comparison" },
		},
		{
			id: "enrich",
			kind: "agent",
			inputs: { search: "search" },
			prompt: "Enrich the Reddit posts with buying opportunities.",
			outputSchema: postsSchema,
		},
		{
			id: "notify",
			kind: "tool",
			tool: "email_send",
			inputs: { research: "enrich" },
			args: { recipient: "reviewer@example.test" },
			approval: "required",
		},
	],
};
const instinct = {
	version: 1,
	skillRevisionId: "sample-reddit-instinct-notify-revision-test",
	steps: [
		{
			id: "search",
			kind: "tool",
			tool: "reddit_search",
			args: { query: "shopping advice" },
		},
		{
			id: "enrich",
			kind: "agent",
			inputs: { search: "search" },
			prompt: "Find relevant Reddit posts and explain the buying instinct.",
			outputSchema: postsSchema,
		},
		{
			id: "format",
			kind: "code",
			inputs: { research: "enrich" },
			code: "export default async (env) => env.inputs.read('research')",
		},
		{
			id: "notify",
			kind: "tool",
			tool: "email_send",
			inputs: { research: "format" },
			args: { recipient: "reviewer@example.test" },
			approval: "required",
		},
	],
};

function fixture(
	options: {
		approved?: boolean;
		denied?: boolean;
		ask?: boolean;
		sendResult?: unknown;
	} = {},
) {
	const ledger = new InMemoryAccountabilityAdapter();
	const compliance = new InMemoryComplianceAdapter({
		policies: {
			"tool:email_send": {
				disposition: options.denied
					? "deny"
					: options.ask === false
						? "allow"
						: "ask",
			},
		},
		approvedRequestIds: new Set(options.approved ? ["email-approval"] : []),
	});
	const stored: Array<{ stepId: string; value: unknown }> = [];
	const receipts: WorkflowStepReceipt[] = [];
	const calls: Array<{ kind: string; inputs: Record<string, unknown> }> = [];
	const ports: WorkflowPorts = {
		actor: { id: "test-agent", kind: "agent", organizationId: "test-org" },
		compliance,
		accountability: ledger,
		toolPolicy: async (tool) =>
			tool === "email_send"
				? { riskTier: "external_side_effect", blastRadius: "external_system" }
				: { riskTier: "read", blastRadius: "none" },
		callTool: async (input) => {
			calls.push({ kind: input.tool, inputs: input.inputs });
			return input.tool === "email_send"
				? (options.sendResult ?? { ok: true })
				: { posts: [{ url: "https://example.test/post" }] };
		},
		agentTurn: async (input) => {
			calls.push({ kind: "agent", inputs: input.inputs });
			return {
				posts: [
					{ url: "https://example.test/post", opportunity: "Compare offers" },
				],
			};
		},
		runCode: async (input) => {
			calls.push({ kind: "code", inputs: input.inputs });
			return {
				ok: true,
				result: { subject: "Reddit research" },
				logs: [],
				durationMs: 1,
			};
		},
		writeOutput: async ({ stepId, value }) => {
			stored.push({ stepId, value });
			return {
				outputId: `output-${stepId}`,
				revisionId: `revision-${stored.length}`,
			};
		},
		appendReceipt: async (receipt) => {
			receipts.push(structuredClone(receipt));
		},
		now: () => 100,
	};
	return { ports, ledger, compliance, stored, receipts, calls };
}

describe("workspace step workflows", () => {
	for (const manifest of [opportunity, instinct]) {
		test(`${manifest.skillRevisionId} passes only Output references and records each step`, async () => {
			const f = fixture({ approved: true });
			const result = await runWorkflow(f.ports, {
				runId: "run",
				manifest,
				approvalRequestIds: { notify: "email-approval" },
			});
			expect(result.status).toBe("completed");
			expect(result.receipts.map((r) => r.stepId)).toEqual(
				manifest.steps.map((s) => s.id),
			);
			expect(f.receipts.map((r) => r.status)).toEqual(
				manifest.steps.flatMap(() => ["running", "completed"]),
			);
			expect(f.calls[1]).toEqual({
				kind: "agent",
				inputs: {
					search: { outputId: "output-search", revisionId: "revision-1" },
				},
			});
			expect(f.calls.at(-1)?.inputs).toEqual({
				research: {
					outputId: `output-${manifest === instinct ? "format" : "enrich"}`,
					revisionId: `revision-${manifest.steps.length - 1}`,
				},
			});
			expect(
				result.receipts.every(
					(r) => r.output && r.skillRevisionId === manifest.skillRevisionId,
				),
			).toBe(true);
			expect((await f.ledger.list()).map((r) => r.outcome)).toEqual([
				"applied",
				"applied",
			]);
		});
	}

	for (const sendResult of [
		{ ok: false, error: "provider rejected email" },
		{ ok: false, error: "" },
		{ isError: true },
	]) {
		test(`failed email ${JSON.stringify(sendResult)} fails visibly and stops subsequent steps`, async () => {
			const f = fixture({ approved: true, sendResult });
			const manifest = {
				...opportunity,
				steps: [
					...opportunity.steps,
					{ id: "after", kind: "tool", tool: "must_not_run" },
				],
			};
			const result = await runWorkflow(f.ports, {
				runId: "run",
				manifest,
				approvalRequestIds: { notify: "email-approval" },
			});
			expect(result.status).toBe("failed");
			expect(result.receipts.at(-1)).toMatchObject({
				stepId: "notify",
				status: "failed",
				output: { outputId: "output-notify" },
			});
			expect(result.receipts.at(-1)?.error).toBe(
				"error" in sendResult && sendResult.error
					? sendResult.error
					: "Tool returned a failed result",
			);
			expect(f.stored.at(-1)?.value).toEqual(sendResult);
			expect((await f.ledger.list()).at(-1)?.outcome).toBe("unknown");
			expect(f.compliance.outcomes.at(-1)?.outcome.status).toBe("unknown");
			expect(f.calls.some((c) => c.kind === "must_not_run")).toBe(false);
		});
	}

	test("missing approval holds without sending or writing a fake result", async () => {
		const f = fixture();
		const result = await runWorkflow(f.ports, {
			runId: "run",
			manifest: opportunity,
		});
		expect(result.status).toBe("needs_approval");
		expect(result.receipts.at(-1)).toMatchObject({
			status: "needs_approval",
			decision: { verdict: "needs_approval" },
		});
		expect(f.calls.map((c) => c.kind)).toEqual(["reddit_search", "agent"]);
		expect(f.stored).toHaveLength(2);
		expect((await f.ledger.list()).at(-1)?.outcome).toBe("needs_approval");
	});

	test("required approval cannot be bypassed with a fabricated request ID or permissive policy", async () => {
		const f = fixture({ ask: false });
		const result = await runWorkflow(f.ports, {
			runId: "run",
			manifest: opportunity,
			approvalRequestIds: { notify: "fabricated" },
		});
		expect(result.status).toBe("needs_approval");
		expect(f.calls.map((c) => c.kind)).toEqual(["reddit_search", "agent"]);
	});

	test("policy denial wins over a supplied approval", async () => {
		const f = fixture({ approved: true, denied: true });
		const result = await runWorkflow(f.ports, {
			runId: "run",
			manifest: opportunity,
			approvalRequestIds: { notify: "email-approval" },
		});
		expect(result.status).toBe("failed");
		expect(result.receipts.at(-1)?.decision?.verdict).toBe("deny");
		expect(f.calls.map((c) => c.kind)).toEqual(["reddit_search", "agent"]);
	});

	test("policy approval holds even when the manifest does not require it", async () => {
		const f = fixture();
		const result = await runWorkflow(f.ports, {
			runId: "run",
			manifest: {
				...opportunity,
				steps: [
					{ id: "send", kind: "tool", tool: "email_send", approval: "policy" },
				],
			},
		});
		expect(result.status).toBe("needs_approval");
		expect(f.calls).toHaveLength(0);
	});

	test("agent output must satisfy the posts schema before notification", async () => {
		const f = fixture({ approved: true });
		f.ports.agentTurn = async () => ({ posts: [{ url: 7 }] });
		const result = await runWorkflow(f.ports, {
			runId: "run",
			manifest: opportunity,
		});
		expect(result.status).toBe("failed");
		expect(result.receipts.at(-1)?.stepId).toBe("enrich");
		expect(f.stored).toHaveLength(1);
	});

	test("sandbox failure stops the workflow", async () => {
		const f = fixture({ approved: true });
		f.ports.runCode = async () => ({
			ok: false,
			error: "Sandbox timed out",
			logs: [],
			durationMs: 60_000,
		});
		const result = await runWorkflow(f.ports, {
			runId: "run",
			manifest: instinct,
		});
		expect(result.status).toBe("failed");
		expect(result.receipts.at(-1)).toMatchObject({
			stepId: "format",
			error: "Sandbox timed out",
		});
	});

	test("tool exceptions produce failed step and uncertain governance receipt", async () => {
		const f = fixture();
		f.ports.callTool = async () => {
			throw new Error("connection unavailable");
		};
		const result = await runWorkflow(f.ports, {
			runId: "run",
			manifest: opportunity,
		});
		expect(result.receipts).toHaveLength(1);
		expect(result.receipts[0]).toMatchObject({
			status: "failed",
			error: "connection unavailable",
		});
		expect((await f.ledger.list())[0]?.outcome).toBe("unknown");
	});

	test("Output persistence failure cannot complete a step", async () => {
		const f = fixture();
		f.ports.writeOutput = async () => {
			throw new Error("Output store unavailable");
		};
		const result = await runWorkflow(f.ports, {
			runId: "run",
			manifest: opportunity,
		});
		expect(result.status).toBe("failed");
		expect(result.receipts[0]?.error).toBe("Output store unavailable");
	});

	test("receipt storage failure rejects instead of returning completion", async () => {
		const f = fixture();
		f.ports.appendReceipt = async (receipt) => {
			if (receipt.status !== "running")
				throw new Error("receipt store unavailable");
		};
		await expect(
			runWorkflow(f.ports, { runId: "run", manifest: opportunity }),
		).rejects.toThrow("receipt store unavailable");
	});

	test("invalid manifests fail before execution", async () => {
		for (const steps of [
			[
				{
					id: "first",
					kind: "code",
					inputs: { later: "last" },
					code: "export default () => null",
				},
				{ id: "last", kind: "tool", tool: "search" },
			],
			[
				{ id: "same", kind: "tool", tool: "search" },
				{ id: "same", kind: "tool", tool: "search" },
			],
			[{ id: "bad", kind: "agent", prompt: "Research" }],
			[
				{
					id: "bad",
					kind: "agent",
					prompt: "Research",
					outputSchema: { type: "nonsense" },
				},
			],
			[{ id: "bad", kind: "tool", tool: "search", riskTier: "read" }],
		]) {
			expect(
				WorkflowManifestSchema.safeParse({ ...opportunity, steps }).success,
			).toBe(false);
			const f = fixture();
			await expect(
				runWorkflow(f.ports, {
					runId: "run",
					manifest: { ...opportunity, steps },
				}),
			).rejects.toThrow();
			expect(f.receipts).toHaveLength(0);
			expect(f.calls).toHaveLength(0);
		}
	});
});
