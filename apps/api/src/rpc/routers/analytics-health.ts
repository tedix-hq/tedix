import { implement } from "@orpc/server";
import { analyticsContract } from "@tedix/api-contract/contracts/analytics";
import {
	getWidgetLifecycleHealthFromAE,
	getExternalAgentValidationSloFromAE,
	hasAEConfig,
	hasWidgetAEConfig,
} from "../../lib/analytics-engine";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";
import { requireOrgId } from "../org-scope";

const authedAnalyticsOs = implement(analyticsContract)
	.$context<BaseContext>()
	.use(withAuth);

const emptyWidgetLifecycleHealth = (
	from: string,
	to: string,
	status: "no_data" | "query_unavailable" | "unconfigured",
) => ({
	from,
	to,
	status,
	configured: status !== "unconfigured",
	hasData: false,
	latestEventAt: null,
	totalEvents: 0,
	readyEvents: 0,
	sessionAttempts: 0,
	failedSessions: 0,
	messageSubmissions: 0,
	firstTokens: 0,
	completedAnswers: 0,
	cancelledAnswers: 0,
	failedAnswers: 0,
	avgReadyMs: 0,
	avgSessionMs: 0,
	avgFirstTokenMs: 0,
	avgAnswerMs: 0,
});

export const getWidgetLifecycleHealthProcedure =
	authedAnalyticsOs.getWidgetLifecycleHealth
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(
				context,
				"widget lifecycle analytics",
			);
			if (!hasWidgetAEConfig(context.env)) {
				return emptyWidgetLifecycleHealth(input.from, input.to, "unconfigured");
			}
			try {
				return await getWidgetLifecycleHealthFromAE(
					context.env,
					organizationId,
					input.from,
					input.to,
					input.installationId,
				);
			} catch (error) {
				console.error("[Analytics] Widget lifecycle query failed:", error);
				return emptyWidgetLifecycleHealth(
					input.from,
					input.to,
					"query_unavailable",
				);
			}
		});
const emptyExternalAgentValidationSlo = (
	from: string,
	to: string,
	status: "no_data" | "query_unavailable" | "unconfigured",
) => ({
	from,
	to,
	status,
	configured: status !== "unconfigured",
	hasData: false,
	latestValidationAt: null,
	freshnessLagMs: null,
	totalValidations: 0,
	successfulValidations: 0,
	inactiveValidations: 0,
	unavailableValidations: 0,
	availabilityPercent: 0,
	avgLatencyMs: 0,
});

export const getExternalAgentValidationSloProcedure =
	authedAnalyticsOs.getExternalAgentValidationSlo
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(
				context,
				"external-agent validation analytics",
			);
			if (!hasAEConfig(context.env)) {
				return emptyExternalAgentValidationSlo(
					input.from,
					input.to,
					"unconfigured",
				);
			}
			try {
				return await getExternalAgentValidationSloFromAE(
					context.env,
					organizationId,
					input.from,
					input.to,
				);
			} catch (error) {
				console.error(
					"[Analytics] External-agent validation SLO query failed:",
					error,
				);
				return emptyExternalAgentValidationSlo(
					input.from,
					input.to,
					"query_unavailable",
				);
			}
		});
