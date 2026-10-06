import "@orpc/openapi/extensions/route";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	ModelCatalogModelSchema,
	ModelCatalogRoutingSchema,
	ModelCatalogSelectionSchema,
} from "../schemas/model-catalog-projection";
import { ModelProviderIdSchema } from "../schemas/model-catalog";

/**
 * The ONE contract-backed model catalog. Every surface that needs to know which
 * models a caller may route a turn at — OS, CLI (through the projected MCP
 * tool), and MCP itself — reads this, not a hand-maintained list.
 *
 * It is a PROJECTION over the canonical owners, never a second source of truth:
 * the cognition catalog (`COGNITION_MODEL_CATALOG`), the entitlement admission
 * helpers (`getRuntimeEntitlement` / `runtimeEntitlementIsActive`), the AI
 * Gateway admission policy (`resolveAiGatewayAdmissionPolicy`), the tedi's
 * runtime overrides / runtime profile, and the Agent runtime's provider set.
 *
 * Contract guarantees:
 *   - Every model is returned with its full filter chain. A denied model always
 *     carries `deniedBy` — the filter, a stable machine reason, and the input
 *     (source path, whether it was configured, expected vs observed) — so a
 *     caller can act on the denial. An empty or unexplained list is a defect.
 *   - No secret ever crosses this boundary. Provider wiring is projected as the
 *     SET of wired provider ids, derived from `Boolean(env.X)` presence checks;
 *     Azure `modelId`s are deployment names already public in `wrangler.jsonc`.
 *   - The response is unpaginated by design: the catalog is a bounded, static
 *     in-code list (single digits), so there is no page/limit knob to exceed.
 *   - `allowed` and `selectable` answer different questions. Policy/provider
 *     admission controls `allowed`; catalog lifecycle controls `selectable`.
 *     Superseded refs stay in the response so stored selections still resolve.
 */

export const modelCatalogContract = oc
	.route({ tags: ["model-catalog"], prefix: "/model-catalog" })
	.errors(baseErrors)
	.router({
		list: oc
			.route({
				method: "GET",
				path: "/models",
				summary: "List the model catalog with per-model routing verdicts",
				description:
					"Projects the cognition model catalog filtered by provider wiring, provider health, organization runtime entitlement, organization and tedi model-tier policy, Agent-runtime compatibility, and caller authority. Every model is returned with the ordered filter chain that decided it; denied models carry the deciding reason and input. Also returns the distinguishable selections (organization default, tedi inherited, tedi explicit, user conversational preference, utility slots) and the effective chat-slot routing explanation. Pass `tediId` to include the per-tedi filters and selections — without it those filters are ABSENT from the chain rather than silently passing.",
			})
			.input(
				z.object({
					tediId: z
						.string()
						.uuid()
						.optional()
						.describe(
							"Scope the projection to one tedi: adds the per-tedi tier filter, the Agent-runtime compatibility filter, and the tedi/utility selections. Omit for the organization-scope view.",
						),
					includeDenied: z
						.boolean()
						.default(true)
						.describe(
							"Keep denied models in `models` with their explanation. Set false to return only allowed models — the explanation for the omitted ones is then unavailable, so prefer the default.",
						),
				}),
			)
			.output(
				z.object({
					models: z
						.array(ModelCatalogModelSchema)
						.describe(
							"Catalog entries with lifecycle/selectability plus their ordered admission filter chain and verdict. Superseded entries remain resolvable but must not be offered for new selections.",
						),
					selections: z
						.array(ModelCatalogSelectionSchema)
						.describe(
							"The distinguishable model selections that resolve for this scope. Tedi-scoped and utility selections are present only when `tediId` was supplied.",
						),
					routing: ModelCatalogRoutingSchema.describe(
						"The effective routing explanation for the interactive chat slot: which selection won, and whether its ref survives the filter chain",
					),
					wiredProviders: z
						.array(ModelProviderIdSchema)
						.describe(
							"Providers whose credentials/bindings are present in the serving Worker — presence booleans only, never a credential value",
						),
				}),
			),
	});

export type ModelCatalogContract = typeof modelCatalogContract;
