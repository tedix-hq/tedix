import { getTediById } from "@tedix/db/queries/tedis";
import type { TurnMemoryInputSchema } from "@tedix/api-contract/schemas/turn-memory";
import { type BaseContext, createError, ErrorCodes } from "../../orpc";
import { serviceAuthed } from "./events-policy";
import { readTurnMemory } from "../../../services/task-memory-state";

export async function readRuntimeTurnMemory(
	context: BaseContext,
	input: typeof TurnMemoryInputSchema._output,
) {
	const tediHeader = context.headers.get("X-Tedix-Tedi-Id");
	const orgHeader = context.headers.get("X-Tedix-Org-Id");
	if (!tediHeader || tediHeader !== input.tediId || !orgHeader)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Authoritative tedi and organization required",
		);
	const tedi = await getTediById(context.db, input.tediId);
	if (!tedi || tedi.organizationId !== orgHeader)
		throw createError(ErrorCodes.FORBIDDEN, "Tedi organization mismatch");
	return readTurnMemory(
		context.db,
		tedi.organizationId,
		tedi.id,
		input.references,
	);
}

export const getTurnMemoryRoute = serviceAuthed.getTurnMemory.handler(
	({ context, input }) => readRuntimeTurnMemory(context, input),
);
