/** Platform-admin-only read of one Agent-runtime run's ledger outbox state. */

import {
	TediRuntimeOutboxDiagnosticResponseSchema,
	type TediRuntimeOutboxDiagnosticResponse,
} from "@tedix/api-contract/schemas/tedi";
import { agentAdminFetch, assertPlatformAdminOrServiceBinding } from "./crud";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	requireTediAccess,
	sanitizeProvisioningError,
} from "./helpers";

const OUTBOX_DIAG_TIMEOUT_MS = 10_000;

/** Fail closed on transport, status, shape, or a mismatched run identity. */
export function outboxDiagnosticFromAdminFetch(
	result: { ok: boolean; status: number; json: unknown } | { error: string },
	runId: string,
): TediRuntimeOutboxDiagnosticResponse {
	if ("error" in result) {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			`Runtime diagnostic unavailable: ${sanitizeProvisioningError(new Error(result.error))}`,
		);
	}
	if (!result.ok) {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			`Runtime diagnostic returned status ${result.status}`,
		);
	}
	const parsed = TediRuntimeOutboxDiagnosticResponseSchema.safeParse(
		result.json,
	);
	if (!parsed.success || parsed.data.outbox.runId !== runId) {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime diagnostic returned an unexpected payload",
		);
	}
	return parsed.data;
}

export const inspectRuntimeOutboxProcedure = authedTedisOs.inspectRuntimeOutbox
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertPlatformAdminOrServiceBinding(context);
		const tedi = await requireTediAccess(context, input.tediId);
		return outboxDiagnosticFromAdminFetch(
			await agentAdminFetch(context, tedi, "/__admin/agent-diag", {
				method: "GET",
				query: { runId: input.runId },
				timeoutMs: OUTBOX_DIAG_TIMEOUT_MS,
			}),
			input.runId,
		);
	});
