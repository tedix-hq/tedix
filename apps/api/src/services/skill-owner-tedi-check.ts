/**
 * validate_skills check that a skill's owner tedi can serve its `tedi`
 * namespace. A scheduled run executes as the owner, and the skill runtime routes
 * `env.MCP.tedi.*` to the owner's entry in the organization gateway's
 * `aggregateTedis`; a missing entry only showed up at dispatch as
 * MCP_TARGET_UNRESOLVED.
 */

import { getAppsByOrganization } from "@tedix/db/queries/apps";
import type { SkillValidationIssue } from "@tedix/db/queries/cognitive/skill-validation";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type { DbClient } from "@tedix/db/client";
import {
	skillManifestNamespaces,
	skillRunGateway,
	tediNamespaceCheck,
} from "./skill-tedi-move";

export async function ownerTediNamespaceIssues(
	db: DbClient,
	input: {
		organizationId: string;
		content: string;
		ownerTediId: string | null;
	},
): Promise<SkillValidationIssue[]> {
	if (!input.ownerTediId) return [];
	const namespaces = skillManifestNamespaces(input.content);
	if (!namespaces.includes("tedi")) return [];
	const [owner, orgApps] = await Promise.all([
		getTediByIdForOrganization(db, input.ownerTediId, input.organizationId),
		getAppsByOrganization(db, input.organizationId),
	]);
	if (!owner)
		return [
			{
				code: "SKILL_OWNER_TEDI_UNRESOLVED",
				message: `The skill calls the \`tedi\` namespace, but its owner tedi ${input.ownerTediId} is not a tedi of this organization, so every \`tedi\` call would fail with MCP_TARGET_UNRESOLVED. Fix: move the skill to an existing tedi or correct FACTORY.ownerTediId.`,
				path: "capabilities.mcp.tedi",
			},
		];
	const check = tediNamespaceCheck({
		namespaces,
		gateway: skillRunGateway(orgApps),
		target: owner,
	});
	return check.status === "fail"
		? [
				{
					code: "SKILL_OWNER_TEDI_UNRESOLVED",
					message: check.detail,
					path: "capabilities.mcp.tedi",
				},
			]
		: [];
}
