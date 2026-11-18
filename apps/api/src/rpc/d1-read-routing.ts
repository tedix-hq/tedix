import { getOpenAPIMeta } from "@orpc/openapi";
import type { AnyProcedure } from "@orpc/server";
import type { BaseContext } from "./context";

/** Runs before logging and auth can open the request's lazy D1 session. */
export function withD1ReadRouting(options: {
	context: BaseContext;
	procedure: AnyProcedure;
	next: () => Promise<unknown>;
}) {
	const method = getOpenAPIMeta(options.procedure)?.method;
	options.context.dbReadOnly = method === "GET" || method === "HEAD";
	return options.next();
}
