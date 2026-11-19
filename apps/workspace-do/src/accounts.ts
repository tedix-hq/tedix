import {
	WorkspaceConnectionReadInputSchema,
	type WorkspaceConnectionDecisionInput,
	type WorkspaceConnectionDecisionResult,
	type WorkspaceConnectionReadInput,
	type WorkspaceConnectionReadResult,
} from "@tedix/api-contract/schemas/workspace-connection-read";
import type { TenantDataPort } from "./data-port-tenant";
import { boundedEventText } from "./event-ledger";
import { MAX_TOOL_RESULT_CHARS } from "./turn-loop";
import type { WorkspaceScope } from "./env";
import type { ConnectionRequest } from "./bindings";

export interface AccountService {
	readLinkedAccount(
		input: WorkspaceConnectionReadInput,
	): Promise<WorkspaceConnectionReadResult>;
	decideLinkedAccountApproval(
		input: WorkspaceConnectionDecisionInput,
	): Promise<WorkspaceConnectionDecisionResult>;
}

export class AccountReadHeld extends Error {
	constructor(readonly approvalId: string) {
		super(
			"Approval required. The connected account read will continue after the person's decision.",
		);
	}
}

export async function listLinkedAccounts(
	data: Pick<TenantDataPort, "listResources">,
) {
	return (await data.listResources())
		.filter((source) => source.connectedForYou === true)
		.map(({ id, name, service }) => ({ resourceId: id, name, service }));
}

export function workspaceAccounts(deps: {
	scope: WorkspaceScope;
	conversationId: string;
	userId: string;
	data: Pick<TenantDataPort, "listResources" | "describeAccount">;
	api: AccountService;
	requestConnection?: (request: ConnectionRequest) => void;
	approvalRequestId?: string;
}) {
	return {
		list: () => listLinkedAccounts(deps.data),
		describe: (resourceId: string) => {
			if (typeof resourceId !== "string" || !resourceId)
				throw new Error("Name the source by its resourceId.");
			return deps.data.describeAccount(resourceId);
		},
		async read(resourceId: string, toolName: string, args: unknown) {
			const parsed = WorkspaceConnectionReadInputSchema.safeParse({
				...deps.scope,
				conversationId: deps.conversationId,
				actor: { kind: "user", id: deps.userId },
				resourceId,
				toolName,
				args,
				...(deps.approvalRequestId
					? { approvalRequestId: deps.approvalRequestId }
					: {}),
			});
			if (!parsed.success)
				throw new Error(
					"Supply a resourceId, a tool name, and a JSON object of arguments.",
				);
			const result = await deps.api.readLinkedAccount(parsed.data);
			switch (result.status) {
				case "ok": {
					const json = JSON.stringify(result.result);
					return json.length <= MAX_TOOL_RESULT_CHARS
						? result.result
						: {
								truncated: true,
								preview: boundedEventText(
									json,
									MAX_TOOL_RESULT_CHARS / 2 - 200,
								),
							};
				}
				case "refused":
					throw new Error(result.message);
				case "approval_required":
					if (deps.approvalRequestId)
						throw new Error(
							"The approved read is still held by the connection policy.",
						);
					throw new AccountReadHeld(result.approvalId);
				case "not_connected": {
					const resource = (await deps.data.listResources()).find(
						(item) => item.id === resourceId,
					);
					if (resource?.providerId === result.providerId)
						deps.requestConnection?.({
							resourceId,
							resourceName: resource.name,
							service: resource.service,
							providerId: result.providerId,
							connectionScope:
								result.scope === "user" ? "personal" : "organization",
						});
					throw new Error(
						"Connect the account before reading from this source.",
					);
				}
			}
		},
	};
}
