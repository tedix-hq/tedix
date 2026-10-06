import { SkillWorkflowConnectionRecoverySchema } from "@tedix/api-contract/schemas/cognitive";
import { getRunArtifact } from "@tedix/db/queries/skill-run-artifacts";
import type { DbClient } from "@tedix/db/client";

export function connectionRecoveryPath(epoch: number, type: string): string {
	if (
		!Number.isInteger(epoch) ||
		epoch < 0 ||
		!/^connection_recovery_[0-9a-f]{24}$/.test(type)
	) {
		throw new Error("Invalid connection recovery identity");
	}
	return `epochs/${epoch}/controls/${type}.json`;
}

export async function requirePendingConnectionRecovery(
	db: DbClient,
	input: {
		runId: string;
		executionEpoch: number;
		type: string;
		payload: unknown;
	},
) {
	const artifact = await getRunArtifact(
		db,
		input.runId,
		connectionRecoveryPath(input.executionEpoch, input.type),
	);
	const record = SkillWorkflowConnectionRecoverySchema.parse(
		JSON.parse(artifact?.contentInline ?? "null"),
	);
	const payload = input.payload as Record<string, unknown> | null;
	if (
		record.status !== "waiting" ||
		record.executionEpoch !== input.executionEpoch ||
		record.eventType !== input.type ||
		payload?.connectionVerified !== true ||
		payload.eventType !== input.type
	)
		throw new Error("Unverified or stale connection recovery");
	return record;
}
