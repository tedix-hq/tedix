/**
 * TediMcpAccessHealthWorkflow
 *
 * Durable read/repair path for Descope AIH client drift on tedi ↔ app MCP
 * assignments. Cron runs with `repairInvalid: true` to auto-converge drift
 * fleet-wide; operator calls can still pass `repairInvalid: false` for a
 * validate-only audit.
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createDbClient } from "@tedix/db/client";
import { getAppById } from "@tedix/db/queries/app-records";
import { getAppBySlug, getAppsByOrganization } from "@tedix/db/queries/apps";
import {
	getOrganizationById,
	listOrganizations,
} from "@tedix/db/queries/organizations";
import { getTediById, getTedisByOrganization } from "@tedix/db/queries/tedis";
import {
	runTediMcpAccessBatchOnTargets,
	type TediMcpAccessHealthResult,
	toTediMcpAccessHealth,
} from "../services/tedi-mcp-access";

export type TediMcpAccessHealthWorkflowParams = {
	organizationIds?: string[];
	limit?: number;
	tediId?: string;
	appId?: string;
	appSlug?: string;
	repairInvalid?: boolean;
	dryRun?: boolean;
	includeSkipped?: boolean;
	source?: "cron" | "operator" | "assignment-change";
};

type OrgWorkflowResult =
	| ({
			organizationId: string;
			organizationSlug: string;
	  } & TediMcpAccessHealthResult)
	| {
			organizationId: string;
			organizationSlug: string;
			healthy: false;
			checkedAt: string;
			error: string;
	  };

async function loadOrganizations(
	db: ReturnType<typeof createDbClient>,
	params: TediMcpAccessHealthWorkflowParams,
) {
	if (params.organizationIds?.length) {
		const orgs = [];
		for (const organizationId of params.organizationIds) {
			const org = await getOrganizationById(db, organizationId);
			if (org) orgs.push(org);
		}
		return orgs;
	}
	return listOrganizations(db, { limit: params.limit ?? 50 });
}

export class TediMcpAccessHealthWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	TediMcpAccessHealthWorkflowParams
> {
	async run(
		event: WorkflowEvent<TediMcpAccessHealthWorkflowParams>,
		step: WorkflowStep,
	) {
		const payload = event.payload ?? {};
		const repairInvalid = payload.repairInvalid ?? false;
		const db = createDbClient(this.env.DB);

		const organizations = await step.do("load organizations", async () =>
			loadOrganizations(db, payload),
		);

		const results: OrgWorkflowResult[] = [];
		for (const org of organizations) {
			const result = await step.do(
				`check ${org.slug}`,
				{
					retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
					timeout: "5 minutes",
				},
				async () => {
					try {
						const app = payload.appId
							? await getAppById(db, payload.appId)
							: payload.appSlug
								? await getAppBySlug(db, payload.appSlug.trim())
								: null;
						const apps = app
							? app.organizationId === org.id
								? [app]
								: []
							: await getAppsByOrganization(db, org.id);
						const tedi = payload.tediId
							? await getTediById(db, payload.tediId)
							: null;
						const tedis = tedi
							? tedi.organizationId === org.id
								? [tedi]
								: []
							: await getTedisByOrganization(db, org.id);
						const health = toTediMcpAccessHealth(
							await runTediMcpAccessBatchOnTargets({
								db,
								env: this.env,
								orgId: org.id,
								input: {
									tediId: payload.tediId,
									appId: payload.appId,
									appSlug: payload.appSlug,
									dryRun: payload.dryRun ?? !repairInvalid,
									includeValid: false,
									includeSkipped: payload.includeSkipped ?? false,
								},
								apps,
								tedis,
								repairInvalid,
								createdBy: `workflow:${payload.source ?? "operator"}`,
							}),
						);
						return {
							organizationId: org.id,
							organizationSlug: org.slug,
							...health,
						};
					} catch (error) {
						return {
							organizationId: org.id,
							organizationSlug: org.slug,
							healthy: false as const,
							checkedAt: new Date().toISOString(),
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			);
			results.push(result);
		}

		return {
			checkedAt: new Date().toISOString(),
			source: payload.source ?? "operator",
			repairInvalid,
			dryRun: payload.dryRun ?? !repairInvalid,
			organizations: results.length,
			healthy: results.every((result) => result.healthy),
			totalAssignments: results.reduce(
				(sum, result) =>
					sum + ("totalAssignments" in result ? result.totalAssignments : 0),
				0,
			),
			valid: results.reduce(
				(sum, result) => sum + ("valid" in result ? result.valid : 0),
				0,
			),
			invalid: results.reduce(
				(sum, result) => sum + ("invalid" in result ? result.invalid : 0),
				0,
			),
			skipped: results.reduce(
				(sum, result) => sum + ("skipped" in result ? result.skipped : 0),
				0,
			),
			repaired: results.reduce(
				(sum, result) => sum + ("repaired" in result ? result.repaired : 0),
				0,
			),
			failed: results.reduce(
				(sum, result) => sum + ("failed" in result ? result.failed : 0),
				0,
			),
			results,
		};
	}
}
