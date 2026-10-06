import type { BaseContext } from "../../orpc";
import {
	type TediRuntimeEventKind,
	type TediRuntimeEventRow,
	listTediRuntimeEventsForRouter,
} from "@tedix/db/queries/cognitive-runtime";

/** Read the newest canonical event for one run/kind without normalizing it. */
export async function findRuntimeEventRow(
	context: BaseContext,
	input: {
		conversationId?: string;
		kind: TediRuntimeEventKind;
		runId: string;
		tediId: string;
	},
): Promise<TediRuntimeEventRow | null> {
	const rows = await listTediRuntimeEventsForRouter(context.db, {
		tediId: input.tediId,
		runId: input.runId,
		conversationId: input.conversationId,
		kind: input.kind,
		order: "desc",
		limit: 1,
	});
	return rows[0] ?? null;
}
