/**
 * One round for a machine: store the answers it sends, write their change
 * records, and claim its next waiting calls. A machine's poll and its open
 * connection both go through here, so an answer is stored and recorded the
 * same way whichever path brought it.
 */

import type { MachineToolInput } from "@tedix/api-contract/schemas/machines";
import {
	type ClaimMachineToolCallsParams,
	claimMachineToolCalls,
} from "@tedix/db/queries/machines";
import type { DbQueryClient } from "@tedix/db/query-client";
import { writeMachineToolResultRecords } from "./machine-change-records";
import type { PushedMachineToolCall } from "./machine-connections";

export async function runMachineClaimRound(
	db: DbQueryClient,
	params: ClaimMachineToolCallsParams,
): Promise<PushedMachineToolCall[]> {
	const { calls, storedCalls } = await claimMachineToolCalls(db, params);
	await writeMachineToolResultRecords(db, {
		orgId: params.orgId,
		reporterId: params.reporterId,
		calls: storedCalls,
	});
	return calls.map((call) => ({
		callId: call.id,
		tool: call.tool,
		input: JSON.parse(call.input) as MachineToolInput,
	}));
}
