/**
 * Change records for machine tool calls and run steering that reach the API
 * without passing the MCP gateway: a tedi's calls arrive over the tedi
 * runtime's service binding, so the gateway never sees them. They go into the
 * same ledger the gateway writes (`gateway_change_records`), built the same
 * way, so one reader and the same sealing job cover both.
 *
 * What a record holds, and where (the ledger has no free-form metadata):
 * - `resource`: `machine:<machine name>` or `work_item:<id>`;
 * - `operation`: the machine tool, or `steer_run`;
 * - `actor`: the tedi or member who asked for the call or sent the message;
 * - `source.traceId`: the call id or the message id, so the records of one
 *   call can be read together;
 * - `decision.reason`: a fixed code (`queued`, a refusal code, `result_stored`
 *   with the reporter id, or the steering kind);
 * - `argsHash`: a hash of the tool input, the stored result, or the message.
 *
 * Only hashes: no command, path, file content, output or message text is ever
 * written here. Reads that were accepted write nothing, as in the gateway.
 */

import type {
	GatewayChangeRecordBody,
	GatewayChangeRecordInput,
} from "@tedix/api-contract/schemas/audit";
import {
	isMachineWriteTool,
	type MachineToolName,
} from "@tedix/api-contract/schemas/machines";
import { hashArguments, hashValue } from "@tedix/agent-governance/hash";
import { appendGatewayChangeRecord } from "@tedix/db/queries/gateway-change-records";
import type { StoredMachineToolCallResult } from "@tedix/db/queries/machines";
import type { DbQueryClient } from "@tedix/db/query-client";
import { safeErrorMetadata } from "../lib/safe-log-metadata";

type Decision = GatewayChangeRecordBody["decision"];

export interface MachineToolRequester {
	type: "user" | "tedi";
	id: string;
}

/** Why a machine tool call was refused after its requester was known. */
export type MachineToolRefusal =
	| "write_scope_missing"
	| "unknown_machine"
	| "machine_offline"
	| "tool_not_accepted"
	| "invalid_input"
	| "queue_full";

const REFUSAL_GATES: Record<MachineToolRefusal, Decision["gate"]> = {
	write_scope_missing: "tool_scope",
	unknown_machine: "edge_access",
	machine_offline: "edge_access",
	tool_not_accepted: "tool_scope",
	invalid_input: "tool_scope",
	queue_full: "risk_rate_limit",
};

/**
 * Running a command can do anything the machine's account can; the other
 * write tools change files inside one workspace. The machine is outside
 * Tedix, so every machine effect counts as an external system's.
 */
function machineToolRisk(tool: MachineToolName) {
	return {
		riskTier: !isMachineWriteTool(tool)
			? ("read" as const)
			: tool === "run_command"
				? ("high_impact_write" as const)
				: ("bounded_write" as const),
		blastRadius: "external_system" as const,
	};
}

/**
 * A record id that is the same for the same call or message and phase, so a
 * repeated write stores nothing new. The ledger wants a UUID: this is the
 * SHA-256 of the key, shaped as a version 8 UUID.
 */
export async function changeRecordId(
	orgId: string,
	phase: string,
	key: string,
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${orgId}\n${phase}\n${key}`),
		),
	).slice(0, 16);
	digest[6] = (digest[6]! & 0x0f) | 0x80;
	digest[8] = (digest[8]! & 0x3f) | 0x80;
	const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function actorOf(orgId: string, requester: MachineToolRequester) {
	return { id: requester.id, kind: requester.type, organizationId: orgId };
}

/** A write tool call that passed every check and is about to be queued. */
export async function buildMachineToolQueuedRecord(params: {
	orgId: string;
	callId: string;
	machineName: string;
	tool: MachineToolName;
	/** The checked input, exactly as it is stored for the machine. */
	input: unknown;
	requester: MachineToolRequester;
}): Promise<GatewayChangeRecordInput> {
	return {
		id: await changeRecordId(
			params.orgId,
			"machine_tool_queued",
			params.callId,
		),
		resource: `machine:${params.machineName}`,
		operation: params.tool,
		actor: actorOf(params.orgId, params.requester),
		source: { surface: "api", traceId: params.callId },
		decision: {
			verdict: "allow",
			gate: "tool_scope",
			reason: "queued",
			...machineToolRisk(params.tool),
		},
		// The machine has not run it yet; the result record settles it.
		outcome: "unknown",
		argsHash: await hashValue(params.input),
	};
}

export async function buildMachineToolRefusedRecord(params: {
	orgId: string;
	callId: string;
	/** The machine's reported name when it was found, else the asked-for name. */
	machineName: string;
	tool: MachineToolName;
	/** The input as sent; it may not be valid. */
	input: unknown;
	requester: MachineToolRequester;
	reason: MachineToolRefusal;
}): Promise<GatewayChangeRecordInput> {
	return {
		id: await changeRecordId(
			params.orgId,
			"machine_tool_refused",
			params.callId,
		),
		resource: `machine:${params.machineName}`,
		operation: params.tool,
		actor: actorOf(params.orgId, params.requester),
		source: { surface: "api", traceId: params.callId },
		decision: {
			verdict: "deny",
			gate: REFUSAL_GATES[params.reason],
			reason: params.reason,
			...machineToolRisk(params.tool),
		},
		outcome: "denied",
		argsHash: await hashArguments(params.input),
	};
}

/** The machine's answer to a write tool call, as stored. */
export async function buildMachineToolResultRecord(params: {
	orgId: string;
	reporterId: string;
	call: StoredMachineToolCallResult;
}): Promise<GatewayChangeRecordInput> {
	const { call } = params;
	return {
		id: await changeRecordId(params.orgId, "machine_tool_result", call.id),
		resource: `machine:${call.machineName}`,
		operation: call.tool,
		actor: actorOf(params.orgId, {
			type: call.requestedByType,
			id: call.requestedById,
		}),
		source: { surface: "api", traceId: call.id },
		decision: {
			verdict: "allow",
			gate: "tool_scope",
			reason: `result_stored reporter:${params.reporterId}`,
			...machineToolRisk(call.tool),
		},
		outcome: call.status === "done" ? "applied" : "not_applied",
		argsHash: await hashValue({
			ok: call.status === "done",
			result: call.result,
			error: call.error,
		}),
	};
}

/** A tedi's follow-up, interrupt or stop, accepted for a run in progress. */
export async function buildRunSteeringRecord(params: {
	orgId: string;
	workItemId: string;
	messageId: string;
	tediId: string;
	kind: "follow_up" | "stop";
	interrupt: boolean;
	body: string;
}): Promise<GatewayChangeRecordInput> {
	return {
		id: await changeRecordId(params.orgId, "run_steering", params.messageId),
		resource: `work_item:${params.workItemId}`,
		operation: "steer_run",
		actor: { id: params.tediId, kind: "tedi", organizationId: params.orgId },
		source: { surface: "api", traceId: params.messageId },
		decision: {
			verdict: "allow",
			gate: "tool_scope",
			reason:
				params.kind === "stop"
					? "stop"
					: params.interrupt
						? "interrupt"
						: "follow_up",
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		},
		outcome: "applied",
		argsHash: await hashValue({
			kind: params.kind,
			interrupt: params.interrupt,
			body: params.body,
		}),
	};
}

async function logFailure(what: string, error: unknown) {
	console.warn(
		`[machine-change-records] ${what} not recorded`,
		await safeErrorMetadata(error),
	);
}

/**
 * Write the queued record. It throws when the write fails, so the caller can
 * refuse the call before it is ever queued.
 */
export async function writeMachineToolQueuedRecord(
	db: DbQueryClient,
	params: Parameters<typeof buildMachineToolQueuedRecord>[0],
): Promise<void> {
	if (!isMachineWriteTool(params.tool)) return;
	await appendGatewayChangeRecord(
		db,
		params.orgId,
		await buildMachineToolQueuedRecord(params),
	);
}

/** Write a refusal record; a failure is logged and never thrown. */
export async function writeMachineToolRefusedRecord(
	db: DbQueryClient,
	params: Parameters<typeof buildMachineToolRefusedRecord>[0],
): Promise<void> {
	try {
		await appendGatewayChangeRecord(
			db,
			params.orgId,
			await buildMachineToolRefusedRecord(params),
		);
	} catch (error) {
		await logFailure("machine tool refusal", error);
	}
}

/** Write one record per stored write tool result; failures are logged only. */
export async function writeMachineToolResultRecords(
	db: DbQueryClient,
	params: {
		orgId: string;
		reporterId: string;
		calls: StoredMachineToolCallResult[];
	},
): Promise<void> {
	await Promise.all(
		params.calls
			.filter((call) => isMachineWriteTool(call.tool))
			.map(async (call) => {
				try {
					await appendGatewayChangeRecord(
						db,
						params.orgId,
						await buildMachineToolResultRecord({
							orgId: params.orgId,
							reporterId: params.reporterId,
							call,
						}),
					);
				} catch (error) {
					await logFailure("machine tool result", error);
				}
			}),
	);
}

/** Write the steering record; a failure is logged and never thrown. */
export async function writeRunSteeringRecord(
	db: DbQueryClient,
	params: Parameters<typeof buildRunSteeringRecord>[0],
): Promise<void> {
	try {
		await appendGatewayChangeRecord(
			db,
			params.orgId,
			await buildRunSteeringRecord(params),
		);
	} catch (error) {
		await logFailure("run steering", error);
	}
}
