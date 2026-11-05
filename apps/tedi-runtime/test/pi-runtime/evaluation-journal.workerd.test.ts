import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { beforeAll, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import { skillRuns, skillWorkflowSources } from "@tedix/db/schema/cognitive";
import { workItems, workAttempts } from "@tedix/db/schema/work-items";
import {
	createPinnedSkillRun,
	getSkillRun,
	updateSkillRunStatus,
} from "@tedix/db/queries/skill-runs";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import { admittedTediDo } from "../tedi-do";
import {
	authorizeEvaluation,
	evaluationSessionKey,
	evaluationSystem,
} from "../../src/evaluation-context";
import type { ChatTurnParams } from "../../src/chat-turn-input";
import type { PiSynthesisFixture } from "./worker";

const DB = (env as unknown as { DB: D1Database }).DB;
beforeAll(async () => {
	for (const table of [
		skillRuns,
		skillWorkflowSources,
		workItems,
		workAttempts,
	])
		for (const ddl of tableDdl(table, { foreignKeys: false }))
			await DB.prepare(
				ddl
					.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
					.replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ")
					.replace(
						"CREATE UNIQUE INDEX ",
						"CREATE UNIQUE INDEX IF NOT EXISTS ",
					),
			).run();
});

for (const failure of [
	undefined,
	"artifact",
	"wrong-owner",
	"expired",
] as const) {
	it(`native dispatch without runtime_admission reaches actual context attestation (${failure ?? "success"})`, async () => {
		const id = crypto.randomUUID();
		const db = createDbClient(DB);
		const agents = "Keep organization information private.";
		const request = {
			policy: "isolated-evaluation-v1" as const,
			reviewedAgentsSha256: await sha256Hex(agents),
		};
		const workId = `work-${id}`;
		const attemptId = crypto.randomUUID();
		await db.insert(workItems).values({
			id: workId,
			orgId: "fixture-org",
			title: "Audit fixture",
			disposition: "accepted",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		await db.insert(workAttempts).values({
			id: attemptId,
			orgId: "fixture-org",
			workItemId: workId,
			executorType: "external_agent",
			executorId: "fixture-reviewer",
			executorSessionId: "fixture-session",
			externalSessionKey: "codex:fixture",
			runtimeState: "running",
			attemptNumber: 1,
			startedAt: new Date().toISOString(),
			heartbeatAt: new Date().toISOString(),
			expiresAt:
				failure === "expired" ? "2000-01-01T00:00:00Z" : "2999-01-01T00:00:00Z",
		});
		const params = {
			evaluationAdmission: {
				...request,
				skillRevision: 1,
				workAttemptId: attemptId,
				workExternalSessionKey: "codex:fixture",
			},
		};
		const source = "export default function workflow() {}";
		await createPinnedSkillRun(db, {
			runId: id,
			skillId: `skill-${id}`,
			tediId: "fixture-tedi",
			orgId: "fixture-org",
			workflowInstanceId: id,
			runtimeEnvironment: "production",
			certification: true,
			skillRevision: 1,
			workflowSource: source,
			workItemId: workId,
			params,
		});
		await updateSkillRunStatus(db, id, "running", { error: null });
		const admission = {
			...authorizeEvaluation({
				request,
				run: await getSkillRun(db, id, "fixture-org", "production"),
				orgId: "fixture-org",
				tediId: "fixture-tedi",
				workflowRunId: id,
				executionEpoch: 0,
			}),
			agents,
		};
		const stub = await getAgentByName(
			(
				env as unknown as {
					PI_SYNTHESIS: DurableObjectNamespace<PiSynthesisFixture>;
				}
			).PI_SYNTHESIS,
			id,
		);
		await runInDurableObject(stub, async (facet, ctx) => {
			const parent = admittedTediDo(ctx, {
				tediId: "fixture-tedi",
				orgId: failure === "wrong-owner" ? "other-org" : "fixture-org",
			});
			parent.state.slug = "fixture";
			parent.env = {
				...env,
				DB,
				ENVIRONMENT: "production",
				GIT_SHA: "fixture-source",
				TEDI_STORAGE: { get: async () => ({ text: async () => agents }) },
			};
			expect(
				ctx.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE name='runtime_admission'")
					.toArray(),
			).toEqual([]);
			expect(parent.runtimeAdmission()).toBeNull();
			const platform = {
				recordArtifact: async (artifact: { content: string }) => {
					if (failure === "artifact") throw new Error("artifact unavailable");
					await ctx.storage.put("actual-artifact", artifact);
				},
				recordRuntimeEvent: async (event: { kind: string }) => {
					await ctx.storage.put(`actual-event:${event.kind}`, event);
				},
			};
			parent.getPlatformClient = async () => platform;
			const baseParent = (
				facet as unknown as { parent: () => Promise<object> }
			).parent.bind(facet);
			Object.defineProperty(facet, "parent", {
				value: async () => ({
					...(await baseParent()),
					recordEvaluationContext: async (
						input: Parameters<typeof parent.recordEvaluationContext>[0],
					) => {
						try {
							await parent.recordEvaluationContext(input);
						} catch (error) {
							await ctx.storage.put("attestation-error", String(error));
							throw error;
						}
					},
					recordEvaluationModelReceipt:
						parent.recordEvaluationModelReceipt.bind(parent),
				}),
			});
			const runId = `fixture-tedi:mcp:${id}`;
			const text = "Evaluate only this constant fixture input.";
			const turn: ChatTurnParams = {
				evaluation: admission,
				runId,
				sessionKey: evaluationSessionKey(runId),
				userText: text,
				userTs: 1,
				conversationId: `fixture:${id}`,
				clientRequestId: id,
			};
			let dispatches = 0;
			parent.runWorkflow = async () => {
				dispatches++;
				const stored = await ctx.storage.get<{
					params: ChatTurnParams;
					stage: string;
				}>(`runtime-admission-workflow:${runId}`);
				expect(stored).toEqual({ params: turn, id, stage: "dispatching" });
				await facet.configureSynthesisTurn({
					runId,
					sessionKey: turn.sessionKey,
					system: evaluationSystem(admission),
					evaluation: admission,
					modelRef: "workers-ai/@cf/synthesis-model",
					aigMetadata: { orgId: "fixture-org", tediId: "fixture-tedi" },
				});
				await facet.runSynthesisTurn({ text: wrapUntrustedInput(text, "mcp") });
			};
			const execute = () =>
				parent.dispatchAdmittedChatWorkflow("CHAT_TURN_WORKFLOW", turn, {
					id,
					agentBinding: "TEDI_AGENT",
				});
			if (failure) await expect(execute()).rejects.toThrow();
			else {
				try {
					await execute();
				} catch (error) {
					throw new Error(
						`${String(error)}: ${await ctx.storage.get("attestation-error")}`,
					);
				}
			}
			const inspected = JSON.parse(await facet.inspectToolFree());
			expect(inspected.stats.requests).toBe(failure ? 0 : 1);
			expect(dispatches).toBe(1);
			const journal = await ctx.storage.get<{ stage: string }>(
				`runtime-admission-workflow:${runId}`,
			);
			expect(journal?.stage).toBe(failure ? "uncertain" : "dispatched");
			if (!failure) {
				const artifact = await ctx.storage.get<{ content: string }>(
					"actual-artifact",
				);
				const capture = JSON.parse(artifact!.content);
				expect(capture.finalInput.prompt).toEqual(inspected.stats.prompts[0]);
				expect(capture.finalInput.tools).toEqual([]);
				expect(capture.finalInputSha256).toBe(
					await sha256Hex(JSON.stringify(capture.finalInput)),
				);
				expect(
					await ctx.storage.get("actual-event:step.completed"),
				).toMatchObject({
					payload: {
						dispatched: true,
						finalInputSha256: capture.finalInputSha256,
						outputShape: {
							measurementBoundary: "pi-adapter-final-assistant-message-v1",
							textPartCount: 1,
							reasoningPartCount: 0,
							reasoningChars: 0,
						},
						providerAttempt: capture.providerAttempt,
					},
				});
				const receipt = await ctx.storage.get<{
					payload: { outputShape: { textChars: number } };
				}>("actual-event:step.completed");
				expect(receipt?.payload.outputShape.textChars).toBeGreaterThan(0);
				await execute();
				expect(dispatches).toBe(1);
			} else
				expect(
					await ctx.storage.get("actual-event:step.completed"),
				).toBeUndefined();
		});
	});
}

it("native journal serializes conflicting concurrent submissions without runtime admission", async () => {
	const stub = await getAgentByName(
		(
			env as unknown as {
				PI_SYNTHESIS: DurableObjectNamespace<PiSynthesisFixture>;
			}
		).PI_SYNTHESIS,
		crypto.randomUUID(),
	);
	await runInDurableObject(stub, async (_facet, ctx) => {
		const parent = admittedTediDo(ctx, {
			tediId: "fixture-tedi",
			orgId: "fixture-org",
		});
		let dispatches = 0;
		parent.runWorkflow = async () => {
			dispatches++;
		};
		const turn: ChatTurnParams = {
			runId: "same-run",
			sessionKey: "fixture",
			userText: "original",
			userTs: 1,
			conversationId: "fixture",
			clientRequestId: "request",
		};
		const options = { id: "native-id", agentBinding: "TEDI_AGENT" as const };
		const results = await Promise.allSettled([
			parent.dispatchAdmittedChatWorkflow("CHAT_TURN_WORKFLOW", turn, options),
			parent.dispatchAdmittedChatWorkflow(
				"CHAT_TURN_WORKFLOW",
				{ ...turn, userText: "changed" },
				options,
			),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(dispatches).toBe(1);
		expect(
			await ctx.storage.get("runtime-admission-workflow:same-run"),
		).toEqual({ params: turn, id: "native-id", stage: "dispatched" });
	});
});
