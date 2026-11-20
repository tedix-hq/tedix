import type {
	WorkspacePersonMemoryInput,
	WorkspacePersonMemoryResult,
} from "@tedix/api-contract/schemas/workspace-person-memory";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import type { WorkspaceScope } from "./env";

export const PERSON_UNAVAILABLE =
	"Personal memory can be read only in a turn the signed-in person sent themself, in their own private workspace that nobody else can open. It is not available to scheduled turns, to turns a tedi or an app started, or in a workspace other people can open.";

export interface PersonService {
	readPersonMemory(
		input: WorkspacePersonMemoryInput,
	): Promise<WorkspacePersonMemoryResult>;
}

/**
 * The person who sent the turn, read only. The store checks first that
 * nobody but that person can open the workspace; the API checks the person
 * and the workspace again when the read is made. Records come back fenced:
 * they are the person's own notes, data and never instructions.
 */
export function workspacePerson(deps: {
	scope: WorkspaceScope;
	/** The signed-in person who sent the turn. */
	userId: string;
	/** Whether nobody but that person can open this workspace, read live. */
	onlyOpenableBySender: () => Promise<boolean>;
	api: PersonService;
}) {
	return {
		async memory(input?: { query?: unknown; limit?: unknown }) {
			if (input?.query !== undefined && typeof input.query !== "string")
				throw new Error("query must be text.");
			if (input?.limit !== undefined && typeof input.limit !== "number")
				throw new Error("limit must be a number.");
			if (!(await deps.onlyOpenableBySender()))
				throw new Error(PERSON_UNAVAILABLE);
			const result = await deps.api.readPersonMemory({
				...deps.scope,
				userId: deps.userId,
				...(input?.query ? { query: input.query } : {}),
				...(input?.limit !== undefined ? { limit: input.limit } : {}),
			});
			if (result.status === "refused") throw new Error(result.message);
			return result.records.map((record) => ({
				id: record.id,
				updatedAt: record.updatedAt,
				text: wrapUntrustedInput(record.content, "personal_memory"),
			}));
		},
	};
}
