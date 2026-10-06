/** Exact-session native Pi metadata, restricted to platform administrators. */
import {
	TediRuntimeRecoveryDiagnosticResponseSchema,
	type TediRuntimeRecoveryDiagnosticResponse,
} from "@tedix/api-contract/schemas/tedi";
import { agentAdminFetch, assertPlatformAdminOrServiceBinding } from "./crud";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	requireTediAccess,
} from "./helpers";

export function recoveryDiagnosticFromAdminFetch(
	result: { ok: boolean; status: number; json: unknown } | { error: string },
	sessionKey: string,
	operationId?: string,
): TediRuntimeRecoveryDiagnosticResponse {
	if ("error" in result || !result.ok)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime recovery diagnostic unavailable",
		);
	const parsed = TediRuntimeRecoveryDiagnosticResponseSchema.safeParse(
		result.json,
	);
	if (
		!parsed.success ||
		parsed.data.sessionKey !== sessionKey ||
		(operationId === undefined
			? parsed.data.operation !== null
			: parsed.data.operation?.operationId !== operationId) ||
		(parsed.data.operation !== null &&
			parsed.data.operation.conversationId !== parsed.data.conversationId) ||
		parsed.data.tasks.some(
			(task) => task.conversationId !== parsed.data.conversationId,
		) ||
		parsed.data.submissions.some(
			(row) => row.conversationId !== parsed.data.conversationId,
		) ||
		parsed.data.taskCount < parsed.data.tasks.length ||
		parsed.data.submissionCount < parsed.data.submissions.length
	)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime recovery diagnostic returned an unexpected payload",
		);
	return parsed.data;
}

export const inspectRuntimeRecoveryProcedure =
	authedTedisOs.inspectRuntimeRecovery
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			assertPlatformAdminOrServiceBinding(context);
			const tedi = await requireTediAccess(context, input.tediId);
			return recoveryDiagnosticFromAdminFetch(
				await agentAdminFetch(context, tedi, "/__admin/pi-recovery", {
					method: "GET",
					query: {
						sessionKey: input.sessionKey,
						operationId: input.operationId,
					},
					timeoutMs: 10_000,
				}),
				input.sessionKey,
				input.operationId,
			);
		});
