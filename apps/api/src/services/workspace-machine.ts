import { ORPCError } from "@orpc/server";
import {
	WorkspaceMachineInputSchema,
	type WorkspaceMachineResult,
} from "@tedix/api-contract/schemas/workspace-machine";
import { createDbClient } from "@tedix/db/client";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
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
	const deps = { db: createDbClient(env.DB), env };
	try {
		const workspace = await getOsWorkspace(deps.db, request);
		if (!workspace || workspace.status !== "active")
			return refused("This workspace is unavailable.");
		// A shared workspace holds other people's files and messages, and a
		// machine read is not held for approval, so only a private workspace's
		// chat reaches a machine.
		if (workspace.visibility !== "private")
			return refused(
				"A machine can be used only from the chat of a private workspace.",
			);
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
		switch (request.op) {
			case "list":
				return {
					status: "machines",
					machines: await listOrganizationMachines(deps, orgId),
				};
			case "call": {
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
		return refused("The machine request could not be completed. Try again.");
	}
}
