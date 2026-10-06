/**
 * Join keys for the workflow-definition surface.
 *
 * Deliberately a zero-dependency leaf: consumers (including the OS browser
 * bundle and the Vite-config-time local fixture lane) need the key without
 * pulling the zod contract module in behind it.
 */

/**
 * `definitionId` prefix for a revisioned skill projected as a workflow
 * definition. Shared so producer and consumer cannot drift — the OS built this
 * join key by hand once and matched nothing in production, silently blanking
 * the definition-drift evidence on run detail.
 */
export const DYNAMIC_SKILL_DEFINITION_PREFIX = "dynamic-skill:";

/** The `definitionId` under which skill `skillId` appears in workflow health. */
export function dynamicSkillDefinitionId(skillId: string): string {
	return `${DYNAMIC_SKILL_DEFINITION_PREFIX}${skillId}`;
}
