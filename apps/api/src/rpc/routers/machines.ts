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
	MACHINE_TOOL_CALL_LIST_DEFAULT_RANGE_MS,
	MACHINE_TOOL_CALL_LIST_MAX_RANGE_MS,
	MACHINES_USE_SCOPE,
	MACHINES_WRITE_SCOPE,
	type MachineToolInput,
} from "@tedix/api-contract/schemas/machines";
import {
	isMachineReporter,
	listMachineToolCallsInRange,
} from "@tedix/db/queries/machines";
import { runMachineClaimRound } from "../../services/machine-claim-round";
import { mintMachineConnectionTicket } from "../../services/machine-connections";
import {
	listOrganizationMachines,
	queueMachineToolCall,
	readMachineToolCallFor,
} from "../../services/machine-tool-calls";
import { isActiveOwnerOrAdmin } from "../org-membership";
import { withOrg } from "../org-scope";
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

const listProcedure = os.list
	.use(withAuthorization("tedis:read", "mcp:work.read", MACHINES_USE_SCOPE))
	.use(withOrg)
	.handler(async ({ context }) => ({
		machines: await listOrganizationMachines(context, context.organizationId),
	}));

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
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const orgId = context.organizationId;
		const requester = await machineToolRequester(context, orgId);
		return queueMachineToolCall(context, {
			orgId,
			requester,
			tediMayWrite: context.tediScopes?.includes(MACHINES_WRITE_SCOPE) ?? false,
			input,
		});
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
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const orgId = context.organizationId;
		const requester = await machineToolRequester(context, orgId);
		return readMachineToolCallFor(context, {
			orgId,
			requester,
			callId: input.callId,
		});
	});

/**
 * An owner's or admin's list of the organization's calls, with their input,
 * so each can be checked against its hash in the change ledger. A person
 * only: a tedi or an external agent is refused.
 */
const listToolCallsProcedure = os.listToolCalls
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler lets only a signed-in active owner or admin of the organization list calls with their input",
			},
			"mcp:observe.read",
		),
	)
	.use(withOrg)
	.handler(async ({ input, context }) => {
		// The same reader as the change ledger: the signed-in person, also
		// when the gateway forwards their call.
		const subject =
			context.authType === "user" ? context.user?.sub : context.descopeUserId;
		if (
			context.tediId ||
			context.externalAgentPrincipalId ||
			typeof subject !== "string" ||
			!(await isActiveOwnerOrAdmin(context, context.organizationId, subject))
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only a signed-in active owner or admin of the organization can list machine tool calls",
			);
		// `until` is exclusive: by default it is just past now, so a call made
		// in this very millisecond is listed too.
		const until = input.until ?? new Date(Date.now() + 1).toISOString();
		const from =
			input.from ??
			new Date(
				Date.parse(until) - MACHINE_TOOL_CALL_LIST_DEFAULT_RANGE_MS,
			).toISOString();
		const span = Date.parse(until) - Date.parse(from);
		if (span <= 0 || span > MACHINE_TOOL_CALL_LIST_MAX_RANGE_MS)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"from must precede until, and the range may cover at most 7 days",
			);
		const rows = await listMachineToolCallsInRange(context.db, {
			orgId: context.organizationId,
			from,
			until,
			...(input.machine === undefined ? {} : { machineName: input.machine }),
			writesOnly: input.writesOnly,
			order: input.order,
			...(input.cursor === undefined
				? {}
				: { after: { createdAt: input.cursor.at, id: input.cursor.id } }),
			limit: input.limit + 1,
		});
		const page = rows.slice(0, input.limit);
		const last = page.at(-1);
		return {
			from,
			until,
			calls: page.map((row) => ({
				callId: row.id,
				machine: row.machineName,
				tool: row.tool,
				input: JSON.parse(row.input) as MachineToolInput,
				status: row.status,
				requestedBy: { type: row.requestedByType, id: row.requestedById },
				createdAt: row.createdAt,
				...(row.claimedAt === null ? {} : { claimedAt: row.claimedAt }),
				...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
				...(row.error === null ? {} : { error: row.error }),
				...(row.resultChars === null ? {} : { resultChars: row.resultChars }),
			})),
			nextCursor:
				rows.length > input.limit && last
					? { at: last.createdAt, id: last.id }
					: null,
		};
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
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const orgId = context.organizationId;
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
		const identity = {
			orgId,
			machineName: input.machineName,
			reporterId: input.reporterId,
		};
		const [calls, connection] = await Promise.all([
			runMachineClaimRound(context.db, {
				...identity,
				limit: input.limit,
				results: input.results,
			}),
			mintMachineConnectionTicket(context.env, identity),
		]);
		return { calls, ...(connection ? { connection } : {}) };
	});

export const machinesContractRouter = os.router({
	list: listProcedure,
	requestToolCall: requestToolCallProcedure,
	readToolCall: readToolCallProcedure,
	listToolCalls: listToolCallsProcedure,
	claimToolCalls: claimToolCallsProcedure,
});
