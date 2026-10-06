import { authorizePersonalDerivedSource } from "./personal-resource-delegation-authority";
import {
	type OsDerivedAccessEnvelope,
	OsDerivedAccessEnvelopeSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { getOsWorkspaceResource } from "@tedix/db/queries/os-workspaces/resources";
import type { BaseContext } from "../rpc/orpc";
import { resolveWorkspaceResourceAvailability } from "./os-workspace-resource-availability";

export function parseDerivedAccessEnvelope(
	value: string | null,
): OsDerivedAccessEnvelope | null {
	if (value === null) return null;
	try {
		const parsed = OsDerivedAccessEnvelopeSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Revalidate the exact tenant resources captured on an immutable revision. */
export async function authorizeDerivedOutputSources(
	context: BaseContext,
	input: {
		organizationId: string;
		accessEnvelope: OsDerivedAccessEnvelope;
	},
): Promise<boolean> {
	if (context.organizationId !== input.organizationId) return false;
	try {
		for (const source of input.accessEnvelope.sources) {
			if (source.connectionScope === "user") {
				if (!(await authorizePersonalDerivedSource(context, source)))
					return false;
				continue;
			}
			const resource = await getOsWorkspaceResource(context.db, {
				organizationId: input.organizationId,
				workspaceId: source.workspaceId,
				resourceId: source.workspaceResourceId,
			});
			if (
				!resource ||
				resource.status !== "active" ||
				resource.connectionScope !== source.connectionScope ||
				resource.providerId !== source.providerId ||
				resource.resourceType !== source.resourceType ||
				resource.providerResourceId !== source.providerResourceId
			) {
				return false;
			}
			let parsedScopes: unknown;
			try {
				parsedScopes = JSON.parse(resource.requiredScopes);
			} catch {
				return false;
			}
			if (
				!Array.isArray(parsedScopes) ||
				!parsedScopes.every(
					(scope): scope is string => typeof scope === "string",
				)
			) {
				return false;
			}
			const currentScopes = new Set(parsedScopes);
			if (source.requiredScopes.some((scope) => !currentScopes.has(scope))) {
				return false;
			}
			const availability = await resolveWorkspaceResourceAvailability(context, {
				...resource,
				// Authorization follows the live resource declaration. The immutable
				// envelope proves which source was used, but must not let an older
				// revision bypass scopes added to that resource later.
				requiredScopes: parsedScopes,
			});
			if (availability.status !== "available") return false;
		}
		return true;
	} catch (error) {
		console.error("[OS outputs] source access revalidation failed", {
			organizationId: input.organizationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
