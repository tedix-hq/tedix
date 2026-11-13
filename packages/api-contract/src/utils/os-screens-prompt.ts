/**
 * The block every agent prompt carries so a reply can send people to the
 * right Tedix OS screen. Names and paths follow the OS navigation; keep them
 * in step with `apps/os/src/lib/os-navigation.ts`. Home's route planner has a
 * fixed prompt budget, so this stays one short paragraph.
 */
export const OS_SCREENS_PROMPT = `## Where things are in Tedix
Name the screen and path when pointing someone there: Work (/work) for tasks and approvals, Chat (/chat), Workspaces (/workspaces), Documents (/outputs), Team (/team) for tedis, Skills (/skills) with each skill's schedules on its Schedule tab, Apps (/apps), Accounts (/admin/connections), Memory (/brain), Activity log (/audit), Usage & billing (/compute), Settings (/admin).`;
