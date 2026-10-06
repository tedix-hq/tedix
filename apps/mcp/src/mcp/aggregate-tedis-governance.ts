import { governanceContract } from "@tedix/api-contract/contracts/governance";
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import { READ_ONLY, type TediToolSpec } from "./aggregate-tedis-shared";

// Governance one-pager (flywheel P5 #3). Org-scoped read: the decision-rights
// matrix and event feed are org-wide, so the selected tedi's id is never
// injected — mirroring get_skill_portfolio_balance / capability reads.
const GET_GOVERNANCE_OVERVIEW_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(procedureInputSchema(governanceContract.overview));

export const GOVERNANCE_TOOLS: TediToolSpec[] = [
	{
		name: "get_governance_overview",
		remoteName: "get_governance_overview",
		description:
			"Weill & Ross governance-on-one-page for this organization's AI labor: the decision-rights matrix (five domains — ai_principles, architecture, infrastructure, application_needs, investment — every cell citing its enforcing function or marked ungoverned honestly) plus live per-tedi governance state: autonomy gates with streaks, pace-layer portfolio, pending approvals, review-flagged skills, 24h cron ledger, and the last 10 queryable governance events. Read-only, org-wide.",
		inputSchema: GET_GOVERNANCE_OVERVIEW_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "governance/overview",
		includeTediIdParam: false,
	},
];
