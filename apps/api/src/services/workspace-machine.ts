import { ORPCError } from "@orpc/server";
import {
	MACHINE_REQUEST_BUSY,
	WorkspaceMachineInputSchema,
	type WorkspaceMachineResult,
} from "@tedix/api-contract/schemas/workspace-machine";

import {
	COMPUTER_ACCESS_OFF,
	workspaceMachineAccess,
} from "@tedix/api-contract/schemas/workspace-agent-access";
import { workspaceOnlyOpenableBy } from "@tedix/api-contract/utils/os-collaborator-graph";
import { coreDb } from "@tedix/db/core-store/scope";
import { listMachineOwners } from "@tedix/db/queries/machines";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { loadOsWorkspacePermissionRows } from "@tedix/db/queries/os-collaborators";
import {
	isWorkspaceGuestTediAllowed,
	readWorkspaceSessionRole,
} from "@tedix/db/queries/os-workspace-access";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	listOrganizationMachines,
	queueMachineToolCall,
	readMachineToolCallFor,
} from "./machine-tool-calls";

const refused = (message: string): WorkspaceMachineResult => ({
	status: "refused",
	message,
});

/**
 * The workspace agent using a machine for the person who sent a chat turn.
 * Called only by the dedicated WorkerEntrypoint. The store asserts who sent
 * the turn; the person's membership, their build access to the workspace and
 * the guest tedi are read live here on every call, and the machine and tool
 * rules are the ones every other caller gets.
 *
 * The workspace's computer access setting must be on. Where other people can
 * open the workspace, only a machine whose runners all sign in as the sender
 * is listed or called; a machine nobody is known to own is refused there.
 *
 * A call made while the person addressed a tedi is queued under that tedi,
 * like the calls a tedi makes from its own chat. The person is signed in and
 * sent the turn, so the tedi may use the write tools a machine accepts.
 */
export async function useWorkspaceMachine(
	env: CloudflareEnv,
	input: unknown,
): Promise<WorkspaceMachineResult> {
	const parsed = WorkspaceMachineInputSchema.safeParse(input);
	if (!parsed.success)
		return refused(
			"The machine request is invalid: name a machine, one of the machine tools and that tool's input.",
		);
	const request = parsed.data;
	const orgId = request.organizationId;
	const deps = { db: coreDb(env), env };
	try {
		const workspace = await getOsWorkspace(deps.db, request);
		if (!workspace || workspace.status !== "active")
			return refused("This workspace is unavailable.");
		if (!workspaceMachineAccess(workspace)) return refused(COMPUTER_ACCESS_OFF);
		const member = await getMemberByUserId(deps.db, orgId, request.userId);
		if (member?.status !== "active" || !member.userId)
			return refused("An active organization membership is required.");
		const role = await readWorkspaceSessionRole(
			deps.db,
			request.workspaceId,
			request.userId,
		);
		if (role !== "build")
			return refused(
				"You need build access to this workspace to use a machine from its chat.",
			);
		let requester: { type: "user" | "tedi"; id: string; admin: boolean } = {
			type: "user",
			id: member.userId,
			admin: member.role === "owner" || member.role === "admin",
		};
		if (request.tediId) {
			const tedi = await getTediById(deps.db, request.tediId);
			if (
				!tedi ||
				tedi.retiredAt !== null ||
				!(await isWorkspaceGuestTediAllowed(
					deps.db,
					orgId,
					{ actorKind: "user", actorId: request.userId },
					request.tediId,
				))
			)
				return refused("This tedi cannot act for you in this workspace.");
			requester = { type: "tedi", id: request.tediId, admin: false };
		}
		// Where other people can open the chat, only the sender's own computer
		// is ever used: the one their runner reports from under their sign-in.
		const permissions = await loadOsWorkspacePermissionRows(deps.db, {
			...request,
			collaborators: false,
		});
		const shared = !workspaceOnlyOpenableBy({
			userId: request.userId,
			workspace,
			edges: permissions.edges,
			links: permissions.links,
		});
		// A listing also says which machines are the sender's own, so the
		// store knows where a read-only command may run without asking.
		const owners =
			shared || request.op === "list"
				? await listMachineOwners(deps.db, { orgId })
				: new Map<string, string | null>();
		const yours = (machineName: string) =>
			owners.get(machineName.toLowerCase()) === `user:${member.userId}`;
		switch (request.op) {
			case "list": {
				const machines = (await listOrganizationMachines(deps, orgId)).map(
					(machine) => ({
						...machine,
						ownedBySender: yours(machine.machineName),
					}),
				);
				return {
					status: "machines",
					machines: shared
						? machines.filter((machine) => machine.ownedBySender)
						: machines,
				};
			}
			case "call": {
				const name = request.call.machine;
				if (shared && owners.has(name.toLowerCase()) && !yours(name))
					return refused(
						owners.get(name.toLowerCase()) === null
							? `Tedix does not know whose computer ${name} is, so it cannot be used from a workspace other people can open. Its owner can sign in again on it, or use their private workspace.`
							: `${name} is another person's computer. In a workspace other people can open, only the computer of the person who sent the message can be used.`,
					);
				const queued = await queueMachineToolCall(deps, {
					orgId,
					requester,
					tediMayWrite: true,
					input: request.call,
				});
				return {
					status: "queued",
					callId: queued.callId,
					callStatus: queued.status,
				};
			}
			case "read":
				return {
					status: "call",
					call: await readMachineToolCallFor(deps, {
						orgId,
						requester,
						callId: request.callId,
					}),
				};
		}
	} catch (error) {
		// The machine rules refuse in words meant for the caller; anything else exposes no internals.
		if (error instanceof ORPCError && typeof error.message === "string")
			return refused(error.message);
		return refused(MACHINE_REQUEST_BUSY);
	}
}
