import assert from "node:assert/strict";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	evaluationInstructionsFromIdentity,
	authorizeEvaluation,
	evaluationNativeSystem,
} from "./evaluation-context";
import {
	recordEvaluationEvidence,
	type EvaluationDispatchEvidence,
} from "./evaluation-evidence";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import type { readIdentityFilesWithDiagnostics } from "./workspace";

type Identity = Awaited<ReturnType<typeof readIdentityFilesWithDiagnostics>>;
const healthy = (): Identity => ({
	files: [],
	diagnostics: {
		checkedAt: new Date().toISOString(),
		tediId: "tedi-1",
		artifacts: {
			bound: true,
			configured: true,
			repoName: "tedi-1",
			repoFound: true,
			cloneOk: true,
		},
		files: [
			{
				path: "AGENTS.md",
				source: "missing",
				key: null,
				chars: 0,
				artifact: { attempted: true, repoFound: true, fileFound: false },
				r2: { attempted: true, fileFound: false },
			},
		],
		provisionedFiles: [],
		missingFiles: ["AGENTS.md"],
		usedR2Fallback: false,
	},
});
const observed = await evaluationInstructionsFromIdentity(
	healthy(),
	"tedi-1",
	"runtime-fixture",
);
assert.equal(observed.presence, "absent");
assert.equal(observed.content, "");
assert.equal(observed.sha256, await sha256Hex(""));
const proof = {
	version: 1,
	tediId: "tedi-1",
	path: "AGENTS.md",
	artifacts: {
		configured: true,
		repoFound: true,
		cloneOk: true,
		attempted: true,
		fileFound: false,
	},
	r2: { attempted: true, fileFound: false },
};
assert.deepEqual(observed.backendProof, proof);
assert.equal(
	observed.backendProofSha256,
	await sha256Hex(JSON.stringify(proof)),
);
const later = healthy();
later.diagnostics.checkedAt = "2999-01-01T00:00:00Z";
assert.equal(
	(await evaluationInstructionsFromIdentity(later, "tedi-1"))
		.backendProofSha256,
	observed.backendProofSha256,
);
for (const mutate of [
	(x: Identity) => {
		x.diagnostics.artifacts.bound = false;
	},
	(x: Identity) => {
		x.diagnostics.artifacts.configured = false;
	},
	(x: Identity) => {
		x.diagnostics.artifacts.cloneOk = false;
	},
	(x: Identity) => {
		x.diagnostics.artifacts.repoFound = false;
	},
	(x: Identity) => {
		x.diagnostics.artifacts.error = "unavailable";
	},
	(x: Identity) => {
		x.diagnostics.lastReadError = "unavailable";
	},
	(x: Identity) => {
		x.diagnostics.files[0]!.artifact.attempted = false;
	},
	(x: Identity) => {
		x.diagnostics.files[0]!.artifact.fileFound = undefined;
	},
	(x: Identity) => {
		x.diagnostics.files[0]!.artifact.fileFound = true;
	},
	(x: Identity) => {
		x.diagnostics.files[0]!.artifact.error = "denied";
	},
	(x: Identity) => {
		x.diagnostics.files[0]!.r2.attempted = false;
	},
	(x: Identity) => {
		x.diagnostics.files[0]!.r2.fileFound = undefined;
	},
	(x: Identity) => {
		x.diagnostics.files[0]!.r2.fileFound = true;
	},
	(x: Identity) => {
		x.diagnostics.files[0]!.r2.error = "unavailable";
	},
	(x: Identity) => {
		x.diagnostics.tediId = "other";
	},
	(x: Identity) => {
		x.files = [{ key: "AGENTS.md", text: "   " }];
	},
]) {
	const changed = healthy();
	mutate(changed);
	await assert.rejects(
		evaluationInstructionsFromIdentity(changed, "tedi-1"),
		/unavailable/,
	);
}
const present = healthy();
present.files = [{ key: "AGENTS.md", text: "Preserve privacy." }];
assert.equal(
	(await evaluationInstructionsFromIdentity(present, "tedi-1")).presence,
	"present",
);
const request = {
	policy: "isolated-evaluation-v1" as const,
	reviewedAgentsSha256: observed.sha256,
	reviewedAgentsPresence: "absent" as const,
	reviewedAgentsProofSha256: observed.backendProofSha256!,
};
const run = {
	id: "workflow-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	executionEpoch: 0,
	certification: true,
	workItemId: "work-1",
	skillId: "skill-1",
	skillRevision: 3,
	workflowSourceHash: "a".repeat(64),
	status: "running",
	workflowRetiredAt: null,
	params: {
		evaluationAdmission: {
			...request,
			skillRevision: 3,
			workAttemptId: "00000000-0000-4000-8000-000000000001",
		},
	},
} as unknown as NonNullable<Parameters<typeof authorizeEvaluation>[0]["run"]>;
const scope = {
	request,
	run,
	orgId: "org-1",
	tediId: "tedi-1",
	workflowRunId: "workflow-1",
	executionEpoch: 0,
};
assert.equal(authorizeEvaluation(scope).reviewedAgentsPresence, "absent");
for (const changed of [
	{ ...request, reviewedAgentsProofSha256: undefined },
	{ ...request, reviewedAgentsProofSha256: "f".repeat(64) },
	{
		policy: request.policy,
		reviewedAgentsSha256: request.reviewedAgentsSha256,
	},
])
	assert.throws(
		() => authorizeEvaluation({ ...scope, request: changed }),
		/certified/,
	);

const absentAdmission = {
	...authorizeEvaluation(scope),
	agents: "",
	agentsProof: observed.backendProof,
};
const userText = "Reply with the bounded evaluation marker.";
const evidence: EvaluationDispatchEvidence = {
	runId: "child-1",
	sessionKey: "workflow:synth:evaluation:child-1",
	admission: absentAdmission,
	providerAttempt: { runId: "child-1", attemptId: "attempt-1" },
	prompt: [
		{ role: "system", content: evaluationNativeSystem(absentAdmission) },
		{
			role: "user",
			content: [{ type: "text", text: wrapUntrustedInput(userText, "mcp") }],
		},
	],
	tools: [],
	toolChoice: { type: "none" },
	model: { provider: "fixture", model: "judge" },
};
const writes: unknown[] = [];
const host = {
	tediId: "tedi-1",
	slug: "fixture",
	admitted: absentAdmission,
	userText,
	instructionsObservation: observed,
	platform: {
		recordArtifact: async (value: unknown) => {
			writes.push(value);
		},
		recordRuntimeEvent: async (value: unknown) => {
			writes.push(value);
		},
	},
};
await recordEvaluationEvidence(evidence, host);
const artifact = JSON.parse((writes[0] as { content: string }).content);
assert.equal(
	artifact.manifest.organizationInstructionsObservation.checkedAt,
	observed.checkedAt,
);
assert.deepEqual(
	artifact.manifest.organizationInstructionsObservation.backendProof,
	proof,
);
assert.equal(
	artifact.manifest.organizationInstructionsObservation.backendProofSha256,
	observed.backendProofSha256,
);
assert.equal(
	artifact.manifest.components.find(
		(x: { source: string }) => x.source === "reviewed-AGENTS.md",
	).presence,
	"absent",
);
for (const instructionsObservation of [
	undefined,
	{ ...observed, presence: "present" as const },
	{ ...observed, content: "new unreviewed instructions" },
	{ ...observed, backendProofSha256: "f".repeat(64) },
	{ ...observed, checkedAt: "" },
]) {
	writes.length = 0;
	await assert.rejects(
		recordEvaluationEvidence(evidence, { ...host, instructionsObservation }),
		/absence/,
	);
	assert.equal(writes.length, 0);
}
