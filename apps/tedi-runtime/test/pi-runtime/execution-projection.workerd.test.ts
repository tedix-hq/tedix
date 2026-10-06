import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { ComputerTurnFixture } from "./computer-turn-fixture";
import { expect, it } from "vite-plus/test";
import { convertToModelMessages, dynamicTool, jsonSchema } from "ai";
import { computerExecutionModelOutput } from "../../src/computer-execution-model-output";
import { describeFacetTools } from "../../src/facet-tool-descriptors";
import {
	ComputerEnvironmentController,
	createComputerEnvironmentTools,
} from "../../src/computer-environment";

it.each(["exec", "read_execution", "cancel_execution"])(
	"projects %s through persisted facet descriptors without changing retained results",
	async (name) => {
		const values = new Map<string, unknown>();
		const jobReceipt = (id: string) => {
			const job = {
				id,
				processId: id,
				terminal: true,
				exitCode: 1,
				stdoutTail: "head" + "x".repeat(10_000) + "tail",
				stderrTail: "failure",
				artifactRefs: ["r2://retained/stdout.log"],
				artifactRowPersistence: {
					status: "failed",
					error: "Index unavailable",
				},
				command: "original command",
				context: { runId: "original-run", workItemId: "original-work" },
				evidence: { command: "original command", exitCode: 1 },
			};
			// Exact /process/wait success envelope: the job is repeated at root.
			return { ...job, ok: true, found: true, waitedMs: 0, job };
		};
		const computer = new ComputerEnvironmentController(
			{
				get: async <T>(key: string) => values.get(key) as T | undefined,
				put: async <T>(key: string, value: T) => {
					values.set(key, value);
				},
				delete: async (key: string) => values.delete(key),
			},
			"fixture-computer",
			{
				open: async () => ({ ok: true, leaseId: "fixture-lease" }),
				close: async () => ({ ok: true }),
				status: async () => ({ ok: true, ready: true }),
				files: async () => ({}),
				start: async () => ({ ok: true }),
				wait: async (_environment, id) => jobReceipt(id),
				read: async (_environment, id) => jobReceipt(id),
				cancel: async (_environment, id) => jobReceipt(id),
			},
		);
		await computer.open("shell");
		const tools = createComputerEnvironmentTools({}, computer);
		const invoke = async (toolName: string, input: Record<string, unknown>) =>
			(await tools[toolName]!.execute!(input, {
				toolCallId: `call-${toolName}`,
				messages: [],
				context: undefined,
			})) as Record<string, unknown>;
		const executed = await invoke("exec", { command: "original command" });
		const output =
			name === "exec"
				? executed
				: await invoke(name, { executionId: executed.executionId });
		expect(output.job).toBeDefined();
		expect(output.command).toBe("original command");
		const [descriptor] = JSON.parse(
			JSON.stringify(describeFacetTools({ [name]: tools[name]! })),
		);
		expect(descriptor.computerExecutionOutput).toBe(true);
		const messages = [
			{
				id: "message",
				role: "assistant" as const,
				parts: [
					{
						type: "dynamic-tool" as const,
						toolName: name,
						toolCallId: "exact-call",
						state: "output-available" as const,
						input: {},
						output,
					},
				],
			},
		];
		const retained = JSON.stringify(messages);
		const modelMessages = await convertToModelMessages(messages, {
			tools: {
				[descriptor.name]: dynamicTool({
					inputSchema: jsonSchema(descriptor.inputSchema),
					...(descriptor.computerExecutionOutput
						? { toModelOutput: computerExecutionModelOutput }
						: {}),
				}),
			},
		});
		const result = modelMessages.find((message) => message.role === "tool");
		expect(result).toBeDefined();
		expect(result!.content).toEqual([
			{
				type: "tool-result",
				toolCallId: "exact-call",
				toolName: name,
				output: computerExecutionModelOutput({ output }),
			},
		]);
		expect(JSON.stringify(messages)).toBe(retained);
		const preview = JSON.parse(computerExecutionModelOutput({ output }).value);
		expect(preview).toMatchObject({
			executionId: output.executionId,
			terminal: true,
			exitCode: 1,
			artifactRefs: output.artifactRefs,
			artifactRowPersistence: output.artifactRowPersistence,
		});
		expect(preview.job).toBeUndefined();
		expect(preview.context).toBeUndefined();
		expect(preview.command).toBeUndefined();
		expect(preview.stdout.length).toBeLessThan(4_100);
	},
);

// Real DO storage survives eviction before a detached receipt exists. Native
// process transport is scripted; this does not claim a provider restart test.
it.each(["start", "wait"] as const)(
	"retains interrupted %s through DO eviction until original result collection",
	async (stage) => {
		const namespace = (
			env as unknown as {
				COMPUTER_TURN: DurableObjectNamespace<ComputerTurnFixture>;
			}
		).COMPUTER_TURN;
		const name = `retention-${stage}-${crypto.randomUUID()}`;
		const first = await getAgentByName(namespace, name);
		const initial = await first.interruptBeforeDetach(stage);
		expect(initial.result).toMatchObject({ outcome: "unknown" });
		expect(initial.pending).toBe(true);
		expect(initial.starts).toBe(1);
		await abortAllDurableObjects();
		const recovered = await getAgentByName(namespace, name);
		const retained = await recovered.inspectRetention(false);
		expect(retained.id).toBe(initial.id);
		expect(retained.pending).toBe(true);
		expect(retained.starts).toBe(1);
		const collected = await recovered.inspectRetention(true);
		expect(collected.result).toMatchObject({
			executionId: initial.id,
			terminal: true,
			stdout: "original result",
		});
		expect(collected.pending).toBe(false);
		expect(collected.starts).toBe(1);
	},
);

it("recovers a native child Fiber through the root lifecycle after real DO eviction", async () => {
	const namespace = (
		env as unknown as {
			PI_PLATFORM: DurableObjectNamespace<
				import("./platform-fixtures").PiPlatformFixture
			>;
		}
	).PI_PLATFORM;
	const name = crypto.randomUUID();
	const parent = await getAgentByName(namespace, name);
	await parent.startPendingChildFiber();
	await expect
		.poll(async () => (await parent.inspectPendingChildFiber()).started)
		.toBe(true);
	await abortAllDurableObjects();
	const recovered = await getAgentByName(namespace, name);
	await expect
		.poll(
			async () => (await recovered.inspectPendingChildFiber()).recoveryAttempts,
		)
		.toBeGreaterThan(0);
	expect((await recovered.inspectRootRecovery()).facetRuns).toBe(1);
	expect((await recovered.inspectRootRecovery()).alarm).not.toBeNull();
	await recovered.allowPendingChildRecovery();
	const { runDurableObjectAlarm } = await import("cloudflare:test");
	expect(await runDurableObjectAlarm(recovered)).toBe(true);
	await expect
		.poll(async () => (await recovered.inspectPendingChildFiber()).pending)
		.toBe(0);
	expect(
		(await recovered.inspectPendingChildFiber()).recoveredCheckpoint,
	).toEqual({ checkpoint: "before-interruption" });
	expect((await recovered.inspectRootRecovery()).facetRuns).toBe(0);
}, 30_000);
