import { ORPCError } from "@orpc/server";
import type { JsonValue } from "@tedix/api-contract/schemas/common";

/** Generic project edits cannot install, replace or remove standing observer authority. */
export function projectMetadataForUpdate(
	existing: Record<string, JsonValue> | null,
	incoming: Record<string, JsonValue> | undefined,
) {
	if (incoming === undefined) return undefined;
	if (
		Object.hasOwn(incoming, "repositoryObserver") &&
		JSON.stringify(incoming.repositoryObserver) !==
			JSON.stringify(existing?.repositoryObserver)
	)
		throw new ORPCError("FORBIDDEN", {
			message: "Use configure_repository_observer to change observer authority",
		});
	return {
		...incoming,
		...(existing?.repositoryObserver === undefined
			? {}
			: { repositoryObserver: existing.repositoryObserver }),
	};
}
