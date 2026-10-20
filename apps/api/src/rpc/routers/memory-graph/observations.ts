import {
	consolidateMemory,
	listMemoryObservations,
} from "@tedix/db/queries/memory-graph/observations";
import { FactSchema } from "@tedix/api-contract/schemas/memory-graph";
import { AUTHZ, ErrorCodes, createError, type BaseContext } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authed } from "./policy-operations";
import { browseMemory } from "@tedix/db/queries/memory-graph/browse";

export const browse = authed.browse
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		if (context.authType === "tedi" && !context.tediId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Authenticated tedi identity is required",
			);
		const result = await browseMemory(context.db, {
			...input,
			orgId: requireOrgId(context),
			tediId: context.tediId,
		});
		return {
			...result,
			facts: result.facts.map((fact) =>
				FactSchema.parse({
					...fact,
					summary:
						fact.summary?.trim().replace(/\s+/g, " ") ===
						fact.content.trim().replace(/\s+/g, " ")
							? null
							: fact.summary,
				}),
			),
		};
	});

function observationScope<T extends { tediId?: string }>(
	input: T,
	context: BaseContext,
): T {
	if (context.authType === "tedi" && !context.tediId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Authenticated tedi identity is required",
		);
	if (!context.tediId) return input;
	if (input.tediId && input.tediId !== context.tediId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A tedi may only access its own private observations",
		);
	return { ...input, tediId: context.tediId };
}

export const listObservations = authed.listObservations
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => ({
		facts: (
			await listMemoryObservations(
				context.db,
				requireOrgId(context),
				observationScope(input, context),
			)
		).map((fact) => FactSchema.parse(fact)),
	}));
export const consolidateObservations = authed.consolidateObservations
	.use(AUTHZ.memoryWrite)
	.handler(async ({ input, context }) =>
		consolidateMemory(
			context.db,
			requireOrgId(context),
			observationScope(input, context),
		),
	);
