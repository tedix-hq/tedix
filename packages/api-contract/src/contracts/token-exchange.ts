import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ExchangeInternalTokenInputSchema,
	ExchangeInternalTokenOutputSchema,
	RevokeExchangedTokenInputSchema,
	RevokeExchangedTokenOutputSchema,
} from "../schemas/token-exchange";

/** Internal RFC 8693 token exchange broker (pilot, off unless enabled). */
export const tokenExchangeContract = oc
	.route({ tags: ["internal"], prefix: "/token-exchange" })
	.errors(baseErrors)
	.router({
		exchange: oc
			.route({
				method: "POST",
				path: "/exchange",
				summary: "Exchange a delegated call for a short-lived internal token",
				description:
					"MCP edge only, over the service binding. Issues a token for one API procedure that keeps the originating subject, nests the acting tedi and the MCP edge in act, and carries only the scope that procedure needs.",
			})
			.input(ExchangeInternalTokenInputSchema)
			.output(ExchangeInternalTokenOutputSchema),
		revoke: oc
			.route({
				method: "POST",
				path: "/revoke",
				summary: "Revoke an exchanged token and every token exchanged from it",
			})
			.input(RevokeExchangedTokenInputSchema)
			.output(RevokeExchangedTokenOutputSchema),
	});

export type TokenExchangeContract = typeof tokenExchangeContract;
