import { getOpenAPIMeta } from "@orpc/openapi";
import { ORPCError, type AnyProcedure } from "@orpc/server";
import type { BaseContext } from "./context";

/**
 * Runs before logging and auth can open the request's lazy D1 session. It also
 * records which procedure matched, for checks that open only named reads.
 * While `CORE_WRITE_FREEZE` is "1", procedures that may write are refused with
 * the retryable unavailable error before any database access.
 */
export function withD1ReadRouting(options: {
	context: BaseContext;
	procedure: AnyProcedure;
	path: readonly string[];
	next: () => Promise<unknown>;
}) {
	const method = getOpenAPIMeta(options.procedure)?.method;
	options.context.dbReadOnly = method === "GET" || method === "HEAD";
	options.context.procedurePath = options.path.join(".");
	if (
		options.context.env.CORE_WRITE_FREEZE === "1" &&
		!options.context.dbReadOnly
	)
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message:
				"Database temporarily unavailable; retry shortly. Writes are paused for maintenance.",
		});
	return options.next();
}
