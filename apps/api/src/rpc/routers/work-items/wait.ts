import { call } from "@orpc/server";
import {
	InteractionWaitCursorSchema,
	WorkItemWaitCursorSchema,
} from "@tedix/api-contract/schemas/work-wait";
import { readWorkWaitPage } from "@tedix/db/queries/work-items/wait";
import { createError, ErrorCodes, withAuthorization } from "../../orpc";
import { assertWorkItemAccess, authOs } from "./policy-helpers";

const readerOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Work waits verify organization access; request waits reuse the canonical participant-checked readers",
		},
		"mcp:work.read",
	),
);

export const waitProcedure = readerOs.wait.handler(
	async ({ input, context, signal }) => {
		const workCursor =
			input.cursor && "workItemId" in input.cursor ? input.cursor : undefined;
		const requestCursor =
			input.cursor && "interactionId" in input.cursor
				? input.cursor
				: undefined;
		if (
			input.id
				? input.cursor && (!workCursor || workCursor.workItemId !== input.id)
				: input.cursor &&
					(!requestCursor ||
						requestCursor.interactionId !== input.interactionId)
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Wait cursor belongs to another target",
			);
		if (
			workCursor?.interaction &&
			workCursor.interaction.id !== input.interactionId
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Wait cursor belongs to another Interaction",
			);
		const deadline = Date.now() + input.timeoutMs;
		let cursor = input.cursor;
		while (true) {
			signal?.throwIfAborted();
			const page = input.id
				? await (async () => {
						const item = await assertWorkItemAccess(context, input.id!);
						return readWorkWaitPage(context.db, {
							orgId: item.orgId,
							workItemId: item.id,
							interactionId: input.interactionId,
							cursor: cursor
								? WorkItemWaitCursorSchema.parse(cursor)
								: undefined,
						});
					})()
				: await (async () => {
						// Reuse the participant checks, tenant scope and delivery policy of reads.
						const { getProcedure, listUndeliveredProcedure } =
							await import("../work-interactions");
						const detail = await call(
							getProcedure,
							{ requestId: input.interactionId! },
							{ context },
						);
						const prior = cursor
							? InteractionWaitCursorSchema.parse(cursor)
							: undefined;
						const sessionId = detail.request.metadata?.sessionId;
						const answers =
							typeof sessionId === "string"
								? await call(
										listUndeliveredProcedure,
										{ sessionId, limit: 50 },
										{ context },
									)
								: { data: [] };
						const next = {
							interactionId: detail.request.id,
							version: detail.request.version,
							state: detail.effectiveState,
							draftId: detail.latestDraft?.id ?? null,
						};
						const changed = prior
							? JSON.stringify(prior) !== JSON.stringify(next)
							: next.state !== "open" || next.draftId !== null;
						return {
							cursor: next,
							changes: [
								...(changed
									? [
											{
												kind: "event" as const,
												id: next.interactionId,
												type: `interaction.${next.state}`,
											},
										]
									: []),
								...answers.data.map((answer) => ({
									kind: "response" as const,
									id: answer.responseId,
									type: "answer",
								})),
							],
						};
					})();
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
