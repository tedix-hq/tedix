/**
 * A tedi's own memory. The tedi runtime reads and edits the calling tedi's
 * memory with the narrow `tedi:memory` right; a person who may change tedis
 * reads the history and restores a version.
 */

import { implement } from "@orpc/server";
import { tediMemoryContract } from "@tedix/api-contract/contracts/tedi-memory";
import { TEDI_MEMORY_SCOPE } from "@tedix/api-contract/schemas/tedi-memory";
import {
	listTediMemoryDocumentVersions,
	TEDI_CORE_MEMORY_NAME,
} from "@tedix/db/queries/tedi-memory";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import {
	coreMemoryView,
	editTediCoreMemory,
	readTediCoreMemory,
	readTediMemoryNote,
	writeTediMemoryNote,
	restoreTediCoreMemoryVersion,
	type TediMemoryAuthor,
	type TediMemoryScope,
} from "../../services/tedi-memory";
import { requireOrgId } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";

const os = implement(tediMemoryContract).$context<BaseContext>().use(withAuth);
const readOs = os.use(
	withAuthorization("tedis:read", "mcp:memory.read", TEDI_MEMORY_SCOPE),
);
const writeOs = os.use(
	withAuthorization("tedis:update", "mcp:memory.write", TEDI_MEMORY_SCOPE),
);
/** History and restore are for a person or a key that may change tedis. */
const ownerOs = os.use(withAuthorization("tedis:update", "mcp:memory.write"));

/**
 * The memory this caller may touch. A tedi reaches only its own; everyone
 * else reaches the tedis of their organization. A tedi of another
 * organization looks the same as one that does not exist.
 */
async function memoryScope(
	context: BaseContext,
	tediId: string,
): Promise<TediMemoryScope> {
	const organizationId = requireOrgId(context, "tedi memory");
	if (context.tediId && context.tediId !== tediId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A tedi can only use its own memory",
		);
	if (!(await getTediByIdForOrganization(context.db, tediId, organizationId)))
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	return { organizationId, tediId };
}

function author(
	context: BaseContext,
	origin?: "conversation" | "reflection",
): TediMemoryAuthor {
	if (context.tediId)
		return {
			type: origin === "reflection" ? "reflection" : "tedi",
			id: context.tediId,
		};
	return { type: "user", id: context.userId ?? context.authType ?? "api" };
}

function personOnly(context: BaseContext) {
	if (context.tediId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only a person who may change this tedi can do this",
		);
}

const readCore = readOs.readCore.handler(async ({ input, context }) => {
	const { organizationId, tediId } = await memoryScope(context, input.tediId);
	return readTediCoreMemory(context.db, { organizationId, tediId });
});

const editCore = writeOs.editCore.handler(async ({ input, context }) => {
	const { organizationId, tediId } = await memoryScope(context, input.tediId);
	return editTediCoreMemory(
		context.db,
		{ organizationId, tediId },
		author(context, input.origin),
		input,
	);
});

const readNote = readOs.readNote.handler(async ({ input, context }) => {
	const { organizationId, tediId } = await memoryScope(context, input.tediId);
	const note = await readTediMemoryNote(
		context.db,
		{ organizationId, tediId },
		input.name,
	);
	if (!note) throw createError(ErrorCodes.NOT_FOUND, "No note with that name");
	return note;
});

const writeNote = writeOs.writeNote.handler(async ({ input, context }) => {
	const { organizationId, tediId } = await memoryScope(context, input.tediId);
	return writeTediMemoryNote(
		context.db,
		{ organizationId, tediId },
		author(context, input.origin),
		input,
	);
});

const listCoreVersions = ownerOs.listCoreVersions.handler(
	async ({ input, context }) => {
		personOnly(context);
		const scope = await memoryScope(context, input.tediId);
		const rows = await listTediMemoryDocumentVersions(context.db, {
			...scope,
			kind: "core",
			name: TEDI_CORE_MEMORY_NAME,
			limit: input.limit ?? 20,
		});
		return {
			versions: rows.map((row) => {
				const view = coreMemoryView(scope.tediId, row);
				return {
					version: row.version,
					sections: view.sections,
					usedChars: view.usedChars,
					changedBy: { type: row.authorType, id: row.authorId },
					change: row.changeSummary,
					createdAt: row.createdAt,
				};
			}),
		};
	},
);

const restoreCoreVersion = ownerOs.restoreCoreVersion.handler(
	async ({ input, context }) => {
		personOnly(context);
		const { organizationId, tediId } = await memoryScope(context, input.tediId);
		const result = await restoreTediCoreMemoryVersion(
			context.db,
			{ organizationId, tediId },
			author(context),
			input.version,
		);
		if (!result)
			throw createError(ErrorCodes.NOT_FOUND, "That version is not kept");
		if (result.status === "refused")
			throw createError(ErrorCodes.CONFLICT, result.reason ?? "Not restored");
		return result.memory;
	},
);

export const tediMemoryContractRouter = os.router({
	readCore,
	editCore,
	readNote,
	writeNote,
	listCoreVersions,
	restoreCoreVersion,
});
