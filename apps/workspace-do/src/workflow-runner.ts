import * as z from "zod";
import type {
	AccountabilityAdapter,
	Actor,
	BlastRadius,
	ComplianceAdapter,
	ComplianceDecision,
	RiskTier,
} from "@tedix/agent-governance/types";
import {
	CallRefusedError,
	guardedCall,
} from "@tedix/agent-governance/wrap-binding";
import {
	WorkflowManifestSchema,
	WorkflowOutputRefSchema,
	type WorkflowOutputRef,
	type WorkflowStep,
} from "./workflow-manifest";
import type { SandboxRunResult } from "./runtime";

export interface WorkflowStepReceipt {
	runId: string;
	skillRevisionId: string;
	stepId: string;
	kind: WorkflowStep["kind"];
	status: "running" | "completed" | "failed" | "needs_approval";
	startedAt: number;
	finishedAt?: number;
	inputs: Record<string, WorkflowOutputRef>;
	output?: WorkflowOutputRef;
	changeRecordId?: string;
	decision?: ComplianceDecision;
	error?: string;
}

export interface WorkflowPorts {
	actor: Actor;
	compliance: ComplianceAdapter;
	accountability: AccountabilityAdapter;
	/** Trusted catalog policy, never a risk classification supplied by the manifest. */
	toolPolicy(tool: string): Promise<{
		riskTier: RiskTier;
		blastRadius: BlastRadius;
		destructive?: boolean;
	}>;
	callTool(input: {
		tool: string;
		args: Record<string, unknown>;
		inputs: Record<string, WorkflowOutputRef>;
	}): Promise<unknown>;
	/** One agent turn, with no undeclared tool loop. Reads inputs at their pinned revisions. */
	agentTurn(input: {
		prompt: string;
		outputSchema: Record<string, unknown>;
		inputs: Record<string, WorkflowOutputRef>;
	}): Promise<unknown>;
	/** Runs only through the workspace's no-network sandbox and governed input bindings. */
	runCode(input: {
		code: string;
		inputs: Record<string, WorkflowOutputRef>;
	}): Promise<SandboxRunResult>;
	writeOutput(input: {
		runId: string;
		skillRevisionId: string;
		stepId: string;
		value: unknown;
	}): Promise<WorkflowOutputRef>;
	/** Append durably; failures propagate so a run cannot claim completion without receipts. */
	appendReceipt(receipt: WorkflowStepReceipt): Promise<void>;
	now?: () => number;
}

export interface WorkflowRunResult {
	status: "completed" | "failed" | "needs_approval";
	receipts: WorkflowStepReceipt[];
}

function failure(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return;
	const result = value as Record<string, unknown>;
	if (result.ok === false || result.isError === true) {
		return typeof result.error === "string" && result.error.length > 0
			? result.error
			: "Tool returned a failed result";
	}
}

export async function runWorkflow(
	ports: WorkflowPorts,
	input: {
		runId: string;
		manifest: unknown;
		approvalRequestIds?: Record<string, string>;
	},
): Promise<WorkflowRunResult> {
	const manifest = WorkflowManifestSchema.parse(input.manifest);
	const outputs = new Map<string, WorkflowOutputRef>();
	const receipts: WorkflowStepReceipt[] = [];
	const now = ports.now ?? Date.now;
	for (const step of manifest.steps) {
		const inputs = Object.fromEntries(
			Object.entries(step.inputs).map(([name, id]) => [name, outputs.get(id)!]),
		);
		const receipt: WorkflowStepReceipt = {
			runId: input.runId,
			skillRevisionId: manifest.skillRevisionId,
			stepId: step.id,
			kind: step.kind,
			status: "running",
			startedAt: now(),
			inputs,
		};
		await ports.appendReceipt({ ...receipt });
		try {
			let value: unknown;
			let failed: string | undefined;
			if (step.kind === "tool") {
				const policy = await ports.toolPolicy(step.tool);
				const call = {
					resource: `tool:${step.tool}`,
					operation: step.tool,
					args: { args: step.args, inputs },
					actor: ports.actor,
					source: { surface: "workspace_workflow", traceId: input.runId },
					...policy,
					approvalRequestId: input.approvalRequestIds?.[step.id],
				};
				await guardedCall(
					call,
					async () => {
						const result = await ports.callTool({
							tool: step.tool,
							args: step.args,
							inputs,
						});
						receipt.output = WorkflowOutputRefSchema.parse(
							await ports.writeOutput({
								runId: input.runId,
								skillRevisionId: manifest.skillRevisionId,
								stepId: step.id,
								value: result,
							}),
						);
						const error = failure(result);
						// A failed send can have an uncertain external effect; guardedCall records unknown.
						if (error) throw new Error(error);
						return result;
					},
					{
						accountability: ports.accountability,
						compliance: {
							check: async (description) => {
								const decision = await ports.compliance.check(description);
								// A manifest may tighten policy, but cannot supply or approve its own receipt.
								if (
									step.approval === "required" &&
									decision.gate !== "destructive_approval" &&
									decision.verdict === "allow"
								) {
									return {
										...decision,
										verdict: "needs_approval",
										gate: "destructive_approval",
										reason: "step_requires_approval",
										approvalRoute: "human",
									};
								}
								return decision;
							},
							record: (description, decision, outcome) =>
								ports.compliance.record(description, decision, outcome),
						},
						onRecorded: (record) => {
							receipt.changeRecordId = record.id;
							receipt.decision = record.decision;
						},
					},
				);
			} else if (step.kind === "agent") {
				value = await ports.agentTurn({
					prompt: step.prompt,
					outputSchema: step.outputSchema,
					inputs,
				});
				z.fromJSONSchema(
					step.outputSchema as Parameters<typeof z.fromJSONSchema>[0],
				).parse(value);
			} else {
				const result = await ports.runCode({ code: step.code, inputs });
				if (!result.ok) throw new Error(result.error ?? "Sandbox failed");
				value = result.result;
				failed = failure(value);
			}
			if (step.kind !== "tool")
				receipt.output = WorkflowOutputRefSchema.parse(
					await ports.writeOutput({
						runId: input.runId,
						skillRevisionId: manifest.skillRevisionId,
						stepId: step.id,
						value,
					}),
				);
			if (failed) throw new Error(failed);
			receipt.status = "completed";
			outputs.set(step.id, receipt.output!);
		} catch (error) {
			receipt.status = "failed";
			receipt.error = error instanceof Error ? error.message : String(error);
			if (error instanceof CallRefusedError) {
				receipt.decision = error.decision;
				receipt.changeRecordId = error.record.id;
				if (error.decision.verdict === "needs_approval")
					receipt.status = "needs_approval";
			}
		}
		receipt.finishedAt = now();
		await ports.appendReceipt({ ...receipt });
		receipts.push(receipt);
		if (receipt.status !== "completed")
			return {
				status:
					receipt.status === "needs_approval" ? "needs_approval" : "failed",
				receipts,
			};
	}
	return { status: "completed", receipts };
}
