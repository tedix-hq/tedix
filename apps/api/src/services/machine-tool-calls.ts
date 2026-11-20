/**
 * Queueing and reading machine tool calls, for whoever has already been
 * identified as the requester: the HTTP route identifies a signed-in member
 * or a tedi sent by the tedi runtime; the workspace store's entrypoint
 * identifies the person who sent a chat turn. Every rule about the machine
 * and the tool lives here, so both paths apply the same ones.
 */

import {
	machineCallNeedsPerson,
	type MachineToolCall,
	parseMachineToolInput,
	type RequestMachineToolCallInputSchema,
} from "@tedix/api-contract/schemas/machines";
import {
	createMachineToolCall,
	listMachines,
	readMachineToolCall,
} from "@tedix/db/queries/machines";
import type { MachineToolCallRow } from "@tedix/db/schema/machines";
import type * as z from "zod";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import {
	type MachineToolRefusal,
	type MachineToolRequester,
	writeMachineToolQueuedRecord,
	writeMachineToolRefusedRecord,
} from "./machine-change-records";
import { machineConnected, pushMachineToolCalls } from "./machine-connections";

type Deps = Pick<BaseContext, "db" | "env">;

export function toMachineToolCall(row: MachineToolCallRow): MachineToolCall {
	return {
		callId: row.id,
		machine: row.machineName,
		tool: row.tool,
		status: row.status,
		...(row.result === null ? {} : { result: row.result }),
		...(row.error === null ? {} : { error: row.error }),
		createdAt: row.createdAt,
		...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
	};
}

/** The organization's machines; one with an open connection is online, whatever its last report. */
export async function listOrganizationMachines(deps: Deps, orgId: string) {
	const machines = await listMachines(deps.db, { orgId });
	return Promise.all(
		machines.map(async (machine) =>
			machine.online
				? machine
				: {
						...machine,
						online: await machineConnected(deps.env, {
							orgId,
							machineName: machine.machineName,
						}),
					},
		),
	);
}

/**
 * Queue one call for a machine. Refused when a tedi asks for a write tool or
 * a read under the owner's home folder outside a chat with a signed-in person, or when the machine is unknown,
 * offline or does not accept the tool. Every refusal is recorded in the change
 * ledger; a failed record write is logged and the original error still thrown.
 */
export async function queueMachineToolCall(
	deps: Deps,
	params: {
		orgId: string;
		requester: MachineToolRequester;
		/** A tedi may use the write tools only in a chat with a signed-in person. */
		tediMayWrite: boolean;
		input: z.infer<typeof RequestMachineToolCallInputSchema>;
	},
) {
	const { orgId, requester, input } = params;
	const callId = crypto.randomUUID();
	const refuse = async (
		reason: MachineToolRefusal,
		error: Error,
		machineName = input.machine,
	) => {
		await writeMachineToolRefusedRecord(deps.db, {
			orgId,
			callId,
			machineName,
			tool: input.tool,
			input: input.input,
			requester,
			reason,
		});
		return error;
	};
	if (
		requester.type === "tedi" &&
		machineCallNeedsPerson(input.tool, input.input) &&
		!params.tediMayWrite
	)
		throw await refuse(
			"write_scope_missing",
			createError(
				ErrorCodes.FORBIDDEN,
				"A tedi can read a person's folders, change files or run commands on a machine only from a chat with a signed-in person",
			),
		);
	const wanted = input.machine.toLowerCase();
	const machine = (await listMachines(deps.db, { orgId })).find(
		(candidate) => candidate.machineName.toLowerCase() === wanted,
	);
	if (!machine)
		throw await refuse(
			"unknown_machine",
			createError(
				ErrorCodes.NOT_FOUND,
				`No machine named "${input.machine}" reports to this organization`,
			),
		);
	if (
		!machine.online &&
		!(await machineConnected(deps.env, {
			orgId,
			machineName: machine.machineName,
		}))
	)
		throw await refuse(
			"machine_offline",
			createError(
				ErrorCodes.CONFLICT,
				`${machine.machineName} is offline: its runner last reported at ${machine.lastSeenAt}`,
			),
			machine.machineName,
		);
	if (!machine.machineTools.includes(input.tool))
		throw await refuse(
			"tool_not_accepted",
			createError(
				ErrorCodes.BAD_REQUEST,
				`${machine.machineName} does not accept ${input.tool}`,
			),
			machine.machineName,
		);
	const checked = parseMachineToolInput(input.tool, input.input);
	if (!checked.ok)
		throw await refuse(
			"invalid_input",
			createError(ErrorCodes.BAD_REQUEST, `${input.tool}: ${checked.message}`),
			machine.machineName,
		);
	// A write tool's record is written before the call exists: if the
	// write fails, the request fails and nothing is queued for the
	// machine. Its outcome stays "unknown" until the result record.
	await writeMachineToolQueuedRecord(deps.db, {
		orgId,
		callId,
		machineName: machine.machineName,
		tool: input.tool,
		input: checked.input,
		requester,
	});
	const call = await createMachineToolCall(deps.db, {
		id: callId,
		orgId,
		machineName: machine.machineName,
		tool: input.tool,
		input: JSON.stringify(checked.input),
		requestedBy: { type: requester.type, id: requester.id },
	});
	if (!call)
		throw await refuse(
			"queue_full",
			createError(
				ErrorCodes.CONFLICT,
				`Too many calls are waiting for ${machine.machineName}; try again in a minute`,
			),
			machine.machineName,
		);
	// With an open connection the machine gets the call now; else at its next poll.
	await pushMachineToolCalls(deps.env, {
		orgId,
		machineName: machine.machineName,
	});
	return { callId: call.id, status: call.status };
}

/** A call, for the one who queued it or an organization admin. */
export async function readMachineToolCallFor(
	deps: Deps,
	params: {
		orgId: string;
		requester: MachineToolRequester & { admin: boolean };
		callId: string;
	},
) {
	const call = await readMachineToolCall(deps.db, {
		orgId: params.orgId,
		id: params.callId,
	});
	const own =
		call?.requestedByType === params.requester.type &&
		call.requestedById === params.requester.id;
	// One answer for "no such call" and "not yours": a call id tells nothing.
	if (!call || (!own && !params.requester.admin))
		throw createError(ErrorCodes.NOT_FOUND, "Machine tool call not found");
	return toMachineToolCall(call);
}
