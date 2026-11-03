import * as z from "zod";
import { ConnectionAllowedResourcesSchema } from "../schemas/connections";
import { resourceCapabilityProfile } from "./provider-capability-profiles";

const resourceTool = z.object({
	transport: z.literal("mcp"),
	mcpToolName: z.string(),
	auth: z.object({ type: z.literal("connection"), connectionId: z.string() }),
});

/**
 * The same decision for discovery/binding (no arguments) and execution/replay.
 * The tenant's stored limits pick the reviewed provider profile; the profile
 * says which tools and targets those limits can govern.
 */
export function resolveConnectionResourceAccess(input: {
	allowedResources: unknown;
	additionalLimits?: unknown[];
	providerId: string;
	config: unknown;
	arguments?: unknown;
}): { allowed: boolean; resourceId?: string } {
	const limits = [
		input.allowedResources,
		...(input.additionalLimits ?? []),
	].filter((limit) => limit !== null);
	if (!limits.length) return { allowed: true };
	const policy = ConnectionAllowedResourcesSchema.safeParse(limits[0]);
	if (!policy.success) return { allowed: false };
	const key = (resource: (typeof policy.data)[number]) =>
		`${resource.resourceType}:${resourceCapabilityProfile(resource.resourceType)?.normalize(resource.resourceId) ?? resource.resourceId.toLowerCase()}`;
	for (const limit of limits.slice(1)) {
		const next = ConnectionAllowedResourcesSchema.safeParse(limit);
		if (!next.success) return { allowed: false };
		const allowed = new Set(next.data.map(key));
		policy.data = policy.data.filter((resource) => allowed.has(key(resource)));
	}
	const config = resourceTool.safeParse(input.config);
	if (
		!policy.data.length ||
		!config.success ||
		config.data.auth.connectionId !== input.providerId
	)
		return { allowed: false };
	const resourceType = policy.data[0]!.resourceType;
	const profile = resourceCapabilityProfile(resourceType);
	const toolName = config.data.mcpToolName;
	if (
		!profile ||
		!policy.data.every((r) => r.resourceType === resourceType) ||
		!Object.hasOwn(profile.tools, toolName) ||
		(profile.endpoint && !profile.endpoint(input.config))
	)
		return { allowed: false };
	if (input.arguments === undefined) return { allowed: true };
	if (!profile.tools[toolName]!.safeParse(input.arguments).success)
		return { allowed: false };
	const target = profile.target(toolName, input.arguments);
	return {
		allowed: Boolean(
			target &&
			policy.data.some(
				(resource) => profile.normalize(resource.resourceId) === target,
			),
		),
		...(target ? { resourceId: target } : {}),
	};
}
