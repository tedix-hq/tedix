/**
 * Machines and their tool calls. A runner names its machine in its health
 * reports and lists the tools the machine accepts; a member or a tedi queues
 * a call for that machine; the machine's runner claims the call and returns a
 * bounded result. A machine lists the write tools only when its owner switched
 * them on in the runner's settings on that machine; nothing here can.
 */

import { implement } from "@orpc/server";
import { machinesContract } from "@tedix/api-contract/contracts/machines";
import {
	isMachineWriteTool,
	MACHINES_USE_SCOPE,
	MACHINES_WRITE_SCOPE,
	type MachineToolCall,
	type MachineToolInput,
	parseMachineToolInput,
} from "@tedix/api-contract/schemas/machines";
import {
	claimMachineToolCalls,
	createMachineToolCall,
	isMachineReporter,
	listMachines,
	readMachineToolCall,
} from "@tedix/db/queries/machines";
import type { MachineToolCallRow } from "@tedix/db/schema/machines";
import { requireOrgId } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";
import { machineReporterAccount } from "./machines-principal";
import {
	assertTediAccess,
	verifiedActiveUserMembership,
} from "./work-items-principal";

const os = implement(machinesContract).$context<BaseContext>().use(withAuth);

/**
 * Who may queue and read a call: a signed-in member, or a tedi whose call the
 * tedi runtime sent with the machine scope. A tedi reaching the API any other
 * way is refused, so the runtime's own rule for when a tedi is offered these
 * tools cannot be bypassed.
 */
async function machineToolRequester(context: BaseContext, orgId: string) {
	if (context.tediId) {
		if (
			context.authType !== "service-binding" ||
			!context.tediScopes?.includes(MACHINES_USE_SCOPE)
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"A tedi can use a machine only from a chat that offers it the machine tools",
			);
		await assertTediAccess(context, context.tediId, orgId);
		return { type: "tedi" as const, id: context.tediId, admin: false };
	}
	if (
		context.authType === "user" &&
		typeof context.user?.sub === "string" &&
		!context.externalAgentPrincipalId
	) {
		const membership = await verifiedActiveUserMembership(context, orgId);
		return {
			type: "user" as const,
			id: membership.userId,
			admin: membership.role === "owner" || membership.role === "admin",
		};
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Using a machine needs a signed-in member of the organization",
	);
}

function toCall(row: MachineToolCallRow): MachineToolCall {
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

const listProcedure = os.list
	.use(withAuthorization("tedis:read", "mcp:work.read", MACHINES_USE_SCOPE))
	.handler(async ({ context }) => {
		const machines = await listMachines(context.db, {
			orgId: requireOrgId(context),
		});
		return {
			// Runners do not report their version yet.
			machines: machines.map((machine) => ({ ...machine, cliVersion: null })),
		};
	});

const requestToolCallProcedure = os.requestToolCall
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires an active member of the organization, or a tedi sent by the tedi runtime with the machine scope",
			},
			"mcp:work.write",
			MACHINES_USE_SCOPE,
		),
	)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const requester = await machineToolRequester(context, orgId);
		if (
			requester.type === "tedi" &&
			isMachineWriteTool(input.tool) &&
			!context.tediScopes?.includes(MACHINES_WRITE_SCOPE)
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"A tedi can change files or run commands on a machine only from a chat with a signed-in person",
			);
		const wanted = input.machine.toLowerCase();
		const machine = (await listMachines(context.db, { orgId })).find(
			(candidate) => candidate.machineName.toLowerCase() === wanted,
		);
		if (!machine)
			throw createError(
				ErrorCodes.NOT_FOUND,
				`No machine named "${input.machine}" reports to this organization`,
			);
		if (!machine.online)
			throw createError(
				ErrorCodes.CONFLICT,
				`${machine.machineName} is offline: its runner last reported at ${machine.lastSeenAt}`,
			);
		if (!machine.machineTools.includes(input.tool))
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`${machine.machineName} does not accept ${input.tool}`,
			);
		const checked = parseMachineToolInput(input.tool, input.input);
		if (!checked.ok)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`${input.tool}: ${checked.message}`,
			);
		const call = await createMachineToolCall(context.db, {
			id: crypto.randomUUID(),
			orgId,
			machineName: machine.machineName,
			tool: input.tool,
			input: JSON.stringify(checked.input),
			requestedBy: { type: requester.type, id: requester.id },
		});
		if (!call)
			throw createError(
				ErrorCodes.CONFLICT,
				`Too many calls are waiting for ${machine.machineName}; try again in a minute`,
			);
		return { callId: call.id, status: call.status };
	});

const readToolCallProcedure = os.readToolCall
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler returns a call only to the one who queued it or to an organization admin",
			},
			"mcp:work.read",
			MACHINES_USE_SCOPE,
		),
	)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const requester = await machineToolRequester(context, orgId);
		const call = await readMachineToolCall(context.db, {
			orgId,
			id: input.callId,
		});
		const own =
			call?.requestedByType === requester.type &&
			call.requestedById === requester.id;
		// One answer for "no such call" and "not yours": a call id tells nothing.
		if (!call || (!own && !requester.admin))
			throw createError(ErrorCodes.NOT_FOUND, "Machine tool call not found");
		return toCall(call);
	});

const claimToolCallsProcedure = os.claimToolCalls
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Only the account that reports this machine's health under this reporter id may claim its calls; the handler checks it",
			},
			"mcp:work.write",
		),
	)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const account = await machineReporterAccount(context, orgId);
		if (
			!account ||
			!(await isMachineReporter(context.db, {
				orgId,
				reporterId: input.reporterId,
				machineName: input.machineName,
				reportedBy: account,
			}))
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the runner that reports this machine's health may claim its calls. Send a health report with this machine name from the same sign-in first",
			);
		const { calls } = await claimMachineToolCalls(context.db, {
			orgId,
			machineName: input.machineName,
			reporterId: input.reporterId,
			limit: input.limit,
			results: input.results,
		});
		return {
			calls: calls.map((call) => ({
				callId: call.id,
				tool: call.tool,
				input: JSON.parse(call.input) as MachineToolInput,
			})),
		};
	});

export const machinesContractRouter = os.router({
	list: listProcedure,
	requestToolCall: requestToolCallProcedure,
	readToolCall: readToolCallProcedure,
	claimToolCalls: claimToolCallsProcedure,
});
