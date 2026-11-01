import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import { skillRuns, skillWorkflowSources } from "@tedix/db/schema/cognitive";
import { workItems, workAttempts } from "@tedix/db/schema/work-items";
import { createPinnedSkillRun } from "@tedix/db/queries/skill-runs";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	admitEvaluation,
	assertEvaluationWorkflow,
} from "./evaluation-context";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";

const sqlite = new DatabaseSync(":memory:");
for (const table of [skillRuns, skillWorkflowSources, workItems, workAttempts])
	for (const ddl of tableDdl(table, { foreignKeys: false })) sqlite.exec(ddl);
const DB = createD1Facade(sqlite);
const db = createDbClient(DB);
const attemptId = "00000000-0000-4000-8000-000000000001";
const agents = "Preserve organization privacy. Do not bypass approvals.";
const evaluation = {
	policy: "isolated-evaluation-v1",
	reviewedAgentsSha256: await sha256Hex(agents),
} as const;
await db.insert(workItems).values({
	id: "work-1",
	orgId: "org-1",
	title: "Evaluation",
	disposition: "accepted",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
});
await db.insert(workAttempts).values({
	id: attemptId,
	orgId: "org-1",
	workItemId: "work-1",
	executorType: "external_agent",
	executorId: "reviewer-1",
	executorSessionId: "session-1",
	externalSessionKey: "codex:fixture",
	runtimeState: "running",
	attemptNumber: 1,
	startedAt: new Date().toISOString(),
	heartbeatAt: new Date().toISOString(),
	expiresAt: new Date(Date.now() + 300_000).toISOString(),
});
await createPinnedSkillRun(db, {
	runId: "workflow-1",
	skillId: "skill-1",
	tediId: "tedi-1",
	orgId: "org-1",
	workflowInstanceId: "instance-1",
	runtimeEnvironment: "production",
	certification: true,
	skillRevision: 3,
	workflowSource: "export default function workflow() {}",
	workItemId: "work-1",
	params: {
		evaluationAdmission: {
			...evaluation,
			skillRevision: 3,
			workAttemptId: attemptId,
			workExternalSessionKey: "codex:fixture",
		},
	},
});
sqlite.exec("UPDATE skill_runs SET status='running', error=NULL");
let currentAgents = agents;
const env = {
	DB,
	ENVIRONMENT: "production",
	TEDI_STORAGE: { get: async () => ({ text: async () => currentAgents }) },
} as unknown as Cloudflare.Env;
function request(headers: Record<string, string> = {}) {
	return new Request("https://runtime.example/mcp", {
		headers: {
			[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller({
				method: "service",
				principalType: "service",
				principalId: "tedi-1",
				scopes: ["tedi:channel.write"],
			}),
			"X-Tedix-Skill-Run-Id": "workflow-1",
			"X-Tedix-Skill-Id": "skill-1",
			"X-Tedix-Workflow-Execution-Epoch": "0",
			...headers,
		},
	});
}
const input = {
	request: request(),
	evaluation,
	env,
	orgId: "org-1",
	tediId: "tedi-1",
};
const admitted = await admitEvaluation(input);
assert.equal(admitted.agents, agents);
assert.equal(admitted.skillRevision, 3);
assert.equal(
	admitted.workflowSourceSha256,
	await sha256Hex("export default function workflow() {}"),
);
await assertEvaluationWorkflow(env, "org-1", "tedi-1", admitted);
for (const change of [
	{ orgId: "other" },
	{ tediId: "other" },
	{ request: request({ "X-Tedix-Skill-Run-Id": "other" }) },
	{ request: request({ "X-Tedix-Skill-Id": "other" }) },
	{ request: request({ "X-Tedix-Workflow-Execution-Epoch": "1" }) },
])
	await assert.rejects(admitEvaluation({ ...input, ...change }));
currentAgents = "Unreviewed held-out decision";
await assert.rejects(admitEvaluation(input), /reviewed digest/);
await assert.rejects(
	assertEvaluationWorkflow(env, "org-1", "tedi-1", admitted),
	/reviewed digest/,
);
currentAgents = agents;
// A lease valid before backend I/O must be checked again after that I/O.
const expiringDuringRead = {
	...env,
	TEDI_STORAGE: {
		get: async () => {
			sqlite.exec("UPDATE work_attempts SET expires_at='2000-01-01'");
			return { text: async () => agents };
		},
	},
} as unknown as Cloudflare.Env;
for (const invoke of [
	() => admitEvaluation({ ...input, env: expiringDuringRead }),
	() =>
		assertEvaluationWorkflow(expiringDuringRead, "org-1", "tedi-1", admitted),
]) {
	sqlite.exec("UPDATE work_attempts SET expires_at='2999-01-01'");
	await assert.rejects(invoke());
}
sqlite.exec("UPDATE work_attempts SET expires_at='2999-01-01'");
for (const mutation of [
	"UPDATE skill_runs SET status='canceled'",
	"UPDATE skill_runs SET execution_epoch=1",
]) {
	const changedDuringRead = {
		...env,
		TEDI_STORAGE: {
			get: async () => {
				sqlite.exec(mutation);
				return { text: async () => agents };
			},
		},
	} as unknown as Cloudflare.Env;
	for (const invoke of [
		() => admitEvaluation({ ...input, env: changedDuringRead }),
		() =>
			assertEvaluationWorkflow(changedDuringRead, "org-1", "tedi-1", admitted),
	]) {
		sqlite.exec("UPDATE skill_runs SET status='running', execution_epoch=0");
		await assert.rejects(invoke(), /certified/);
	}
}
sqlite.exec("UPDATE skill_runs SET status='running', execution_epoch=0");
for (const [mutation, restore] of [
	[
		"UPDATE skill_runs SET certification=0",
		"UPDATE skill_runs SET certification=1",
	],
	[
		"UPDATE work_attempts SET expires_at='2000-01-01'",
		"UPDATE work_attempts SET expires_at='2999-01-01'",
	],
	[
		"UPDATE work_attempts SET external_session_key='other'",
		"UPDATE work_attempts SET external_session_key='codex:fixture'",
	],
	[
		"UPDATE work_items SET disposition='cancelled'",
		"UPDATE work_items SET disposition='accepted'",
	],
	[
		"UPDATE skill_runs SET execution_epoch=1",
		"UPDATE skill_runs SET execution_epoch=0",
	],
] as const) {
	sqlite.exec(mutation);
	await assert.rejects(admitEvaluation(input));
	await assert.rejects(
		assertEvaluationWorkflow(env, "org-1", "tedi-1", admitted),
	);
	sqlite.exec(restore);
}
sqlite.close();
console.log("evaluation-admission D1 integration OK");
