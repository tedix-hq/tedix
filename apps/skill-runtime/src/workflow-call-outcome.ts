import { isRecord } from "@tedix/api-contract/utils/is-record";

export const WORKFLOW_TOOL_REFUSAL_PATTERN =
	"requires approval|approval required|human approval required|not approved|MCP_INPUT_REQUIRED|DESTRUCTIVE_GATE_DENIED|CAPABILITY_NOT_DECLARED|ANNOTATION_VIOLATION|forbidden|unauthorized|Skill run identity|Skill manifest authorization";

/** Inspect durable receipts even when tenant code caught the bridge error. */
export function fullyRefusedWorkflowStep(receipts: unknown[]): string | null {
	const steps = new Map<
		string,
		{
			attempt: number;
			name: string;
			capabilities: Map<string, { refused: number; other: number }>;
		}
	>();
	for (const receipt of receipts) {
		if (
			!isRecord(receipt) ||
			receipt.kind !== "workflow_mcp_call" ||
			!isRecord(receipt.step)
		)
			continue;
		const { id, name } = receipt.step;
		if (
			typeof id !== "string" ||
			typeof name !== "string" ||
			typeof receipt.attempt !== "number"
		)
			continue;
		let group = steps.get(id);
		if (!group || group.attempt < receipt.attempt) {
			group = { attempt: receipt.attempt, name, capabilities: new Map() };
			steps.set(id, group);
		}
		if (group.attempt !== receipt.attempt) continue;
		const capability = JSON.stringify([receipt.namespace, receipt.method]);
		const counts = group.capabilities.get(capability) ?? {
			refused: 0,
			other: 0,
		};
		group.capabilities.set(capability, counts);
		const message =
			isRecord(receipt.error) && typeof receipt.error.message === "string"
				? receipt.error.message
				: "";
		if (
			receipt.status === "failed" &&
			(receipt.refused === true ||
				(receipt.refused === undefined &&
					new RegExp(WORKFLOW_TOOL_REFUSAL_PATTERN, "i").test(message)))
		)
			counts.refused++;
		else counts.other++;
	}
	for (const group of steps.values()) {
		for (const counts of group.capabilities.values()) {
			if (counts.refused > 0 && counts.other === 0) return group.name;
		}
	}
	return null;
}
