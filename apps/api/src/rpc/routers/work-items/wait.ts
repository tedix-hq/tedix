import { readWorkWaitPage } from "@tedix/db/queries/work-items/wait";
import { createError, ErrorCodes, withAuthorization } from "../../orpc";
import { assertWorkItemAccess, authOs } from "./policy-helpers";

const readerOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The handler verifies Work Item organization access before every read",
		},
		"mcp:work.read",
	),
);

export const waitProcedure = readerOs.wait.handler(
	async ({ input, context, signal }) => {
		if (input.cursor && input.cursor.workItemId !== input.id)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Wait cursor belongs to another Work Item",
			);
		const deadline = Date.now() + input.timeoutMs;
		let cursor = input.cursor;
		while (true) {
			signal?.throwIfAborted();
			const item = await assertWorkItemAccess(context, input.id);
			const page = await readWorkWaitPage(context.db, {
				orgId: item.orgId,
				workItemId: item.id,
				cursor,
			});
			cursor = page.cursor;
			if (page.changes.length) return { reason: "changed" as const, ...page };
			const remaining = deadline - Date.now();
			if (remaining <= 0) return { reason: "timeout" as const, ...page };
			await new Promise<void>((resolve, reject) => {
				const abort = () => {
					clearTimeout(timer);
					reject(signal?.reason);
				};
				const timer = setTimeout(
					() => {
						signal?.removeEventListener("abort", abort);
						resolve();
					},
					Math.min(1000, remaining),
				);
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
			});
		}
	},
);
