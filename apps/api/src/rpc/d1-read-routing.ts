import { getOpenAPIMeta } from "@orpc/openapi";
import type { AnyProcedure } from "@orpc/server";
import type { BaseContext } from "./context";

/**
 * Runs before logging and auth can open the request's lazy D1 session. It also
 * records which procedure matched, for checks that open only named reads.
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
	return options.next();
}
