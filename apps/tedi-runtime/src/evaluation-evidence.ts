import type { LanguageModelV2CallOptions } from "@ai-sdk/provider";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import type { PlatformClient } from "./brain/platform-client";
import type { PiProviderAttempt } from "./pi-turn-accounting";
import {
	EVALUATION_SYSTEM,
	evaluationNativeSystem,
	evaluationSessionKey,
	type EvaluationAdmission,
} from "./evaluation-context";
import {
	AGENT_PROMPT_VERSION,
	AGENT_RUNTIME_PROMPT,
} from "./runtime-tool-guidance";

export interface EvaluationDispatchEvidence {
	generation?: {
		maxOutputTokens?: number;
		temperature?: number;
		providerOptions?: unknown;
	};
	runId: string;
	sessionKey: string;
	admission: EvaluationAdmission;
	providerAttempt: PiProviderAttempt;
	prompt: LanguageModelV2CallOptions["prompt"];
	tools: LanguageModelV2CallOptions["tools"];
	toolChoice: LanguageModelV2CallOptions["toolChoice"];
	model: { provider: string; model: string };
}

/** Called before doStream. No private persona or credentials belong in this record. */
export async function recordEvaluationEvidence(
	input: EvaluationDispatchEvidence,
	host: {
		tediId: string;
		slug: string;
		platform: Pick<PlatformClient, "recordArtifact" | "recordRuntimeEvent">;
		admitted: EvaluationAdmission | undefined;
		userText: string | undefined;
		runtimeSource?: string;
	},
): Promise<{ artifactId: string; finalInputSha256: string }> {
	if (
		input.providerAttempt.runId !== input.runId ||
		input.sessionKey !== evaluationSessionKey(input.runId) ||
		JSON.stringify(input.admission) !== JSON.stringify(host.admitted) ||
		(await sha256Hex(input.admission.agents)) !==
			input.admission.reviewedAgentsSha256 ||
		input.tools?.length ||
		input.toolChoice?.type !== "none" ||
		input.prompt.filter((message) => message.role === "user").length !== 1 ||
		input.prompt.some(
			(message) => message.role !== "system" && message.role !== "user",
		)
	)
		throw new Error(
			"Evaluation dispatch is not isolated or does not match its admission",
		);
	const system = input.prompt
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n");
	const expected = [
		{ role: "system", content: evaluationNativeSystem(input.admission) },
		{
			role: "user",
			content: [
				{ type: "text", text: wrapUntrustedInput(host.userText ?? "", "mcp") },
			],
		},
	];
	if (
		system !== evaluationNativeSystem(input.admission) ||
		!host.userText ||
		JSON.stringify(input.prompt) !== JSON.stringify(expected)
	)
		throw new Error(
			"Evaluation dispatch differs from the reviewed system and admitted case input",
		);
	const finalInput = {
		prompt: input.prompt,
		tools: input.tools ?? [],
		toolChoice: input.toolChoice,
		...(input.generation ? { generation: input.generation } : {}),
	};
	const manifest = {
		runtimeSource: host.runtimeSource ?? null,
		policy: input.admission.policy,
		workflowRunId: input.admission.workflowRunId,
		workAttemptId: input.admission.workAttemptId,
		workItemId: input.admission.workItemId,
		skillId: input.admission.skillId,
		skillRevision: input.admission.skillRevision,
		workflowSourceSha256: input.admission.workflowSourceSha256,
		executionEpoch: input.admission.executionEpoch,
		components: [
			{
				source: "native-pi-instructions-frame-v1",
				sha256: await sha256Hex(
					"<instructions>\n{instructions}\n</instructions>",
				),
			},
			{
				source: "evaluation-system-v1",
				sha256: await sha256Hex(EVALUATION_SYSTEM),
				content: EVALUATION_SYSTEM,
			},
			{
				source: "platform-runtime",
				version: AGENT_PROMPT_VERSION,
				sha256: await sha256Hex(AGENT_RUNTIME_PROMPT),
				content: AGENT_RUNTIME_PROMPT,
			},
			{
				source: "reviewed-AGENTS.md",
				sha256: input.admission.reviewedAgentsSha256,
				content: input.admission.agents,
			},
		],
		excluded: [
			"persona",
			"SOUL.md",
			"IDENTITY.md",
			"USER.md",
			"TOOLS.md",
			"MEMORY.md",
			"directives",
			"brainDigest",
			"memoryRecall",
			"skillGuidance",
			"retrievedSkills",
			"mcpGuidance",
			"harnessHistory",
			"piHistory",
			"compaction",
		],
		historyMessages: 0,
		toolDescriptors: [],
	};
	const finalInputSha256 = await sha256Hex(JSON.stringify(finalInput));
	const conversationId = buildTediConversationId({
		tediRef: host.slug || host.tediId,
		sessionKey: input.sessionKey,
	});
	const artifactId = `${input.runId}:artifact:v2:evaluation-context:${input.providerAttempt.attemptId}`;
	const content = JSON.stringify({
		version: 1,
		runId: input.runId,
		conversationId,
		providerAttempt: input.providerAttempt,
		model: input.model,
		manifest,
		finalInputSha256,
		finalInput,
	});
	await host.platform.recordArtifact({
		id: artifactId,
		tediId: host.tediId,
		conversationId,
		runId: input.runId,
		kind: "log",
		name: "evaluation-context.json",
		mimeType: "application/json",
		sizeBytes: new TextEncoder().encode(content).byteLength,
		content,
		accessClassification: "runtime_private",
		metadata: {
			subKind: "evaluation_context",
			producer: "native-pi",
			finalInputSha256,
		},
	});
	await host.platform.recordRuntimeEvent({
		id: `${artifactId}:attested`,
		tediId: host.tediId,
		runId: input.runId,
		conversationId,
		kind: "context.injected",
		sequence: 0,
		payload: {
			source: "isolated-evaluation",
			policy: input.admission.policy,
			artifactId,
			finalInputSha256,
			providerAttempt: input.providerAttempt,
			workflowRunId: input.admission.workflowRunId,
			skillRevision: input.admission.skillRevision,
			workflowSourceSha256: input.admission.workflowSourceSha256,
			organizationInstructionsSha256: input.admission.reviewedAgentsSha256,
			historyMessages: 0,
			toolCount: 0,
		},
		runtime: { backend: "cloudflare-agents" },
		createdAt: new Date().toISOString(),
	});
	return { artifactId, finalInputSha256 };
}

export interface EvaluationOutcome {
	providerAttempt: PiProviderAttempt;
	finishReason: string;
	responseId: string | null;
	responseModel: string | null;
	usage: {
		inputTokens: number | null;
		outputTokens: number | null;
		totalTokens: number | null;
	};
}

export async function recordEvaluationOutcome(
	input: EvaluationOutcome,
	host: {
		storage: Pick<DurableObjectStorage, "get">;
		platform: Pick<PlatformClient, "recordRuntimeEvent">;
		tediId: string;
	},
): Promise<void> {
	const prepared = await host.storage.get<{
		artifactId: string;
		finalInputSha256: string;
		conversationId: string;
	}>(
		`evaluation-context:${input.providerAttempt.runId}:${input.providerAttempt.attemptId}`,
	);
	if (!prepared)
		throw new Error(
			"Evaluation model receipt has no persisted context attestation",
		);
	await host.platform.recordRuntimeEvent({
		id: `${prepared.artifactId}:model-settled`,
		tediId: host.tediId,
		runId: input.providerAttempt.runId,
		conversationId: prepared.conversationId,
		kind: "step.completed",
		sequence: 0,
		payload: {
			source: "isolated-evaluation-provider-receipt",
			...prepared,
			...input,
			dispatched: true,
		},
		runtime: { backend: "cloudflare-agents" },
		createdAt: new Date().toISOString(),
	});
}
