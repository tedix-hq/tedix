import {
	assertRuntimeTurnScope,
	type RuntimeAdapter,
	type RuntimeTurnScope,
} from "@tedix/context-core/runtime-adapter";
import type {
	ConfiguredConversationTurn,
	ConversationFacet,
} from "./conversation-facet";

type FacetExecution = Pick<ConversationFacet, "runConfiguredConversationTurn">;

/** Only the resolved tenant facet crosses this boundary, never a DO namespace. */
export function cloudflareRuntimeAdapter(
	boundScope: RuntimeTurnScope,
	facet: FacetExecution,
): RuntimeAdapter<
	ConfiguredConversationTurn,
	Awaited<ReturnType<FacetExecution["runConfiguredConversationTurn"]>>
> {
	const scope = Object.freeze({ ...boundScope });
	return {
		id: "cloudflare",
		scope,
		async execute(input) {
			const { configuration } = input;
			assertRuntimeTurnScope(scope, {
				orgId: configuration.aigMetadata.orgId ?? "",
				tediId: configuration.aigMetadata.tediId ?? "",
				runId: configuration.runId,
				sessionKey: configuration.sessionKey,
			});
			// The facet's parent proxy rechecks admission, tool scope and human gates.
			return facet.runConfiguredConversationTurn(input);
		},
	};
}
