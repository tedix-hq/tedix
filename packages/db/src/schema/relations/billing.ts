/**
 * Drizzle Relations v2: billing domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const billingRelations = defineRelationsPart(schema, (r) => ({
	// BILLING
	// =========================================================================

	billingPlanVersions: {
		accounts: r.many.billingAccounts({
			from: r.billingPlanVersions.id,
			to: r.billingAccounts.planVersionId,
		}),
		usagePeriods: r.many.billingUsagePeriods({
			from: r.billingPlanVersions.id,
			to: r.billingUsagePeriods.planVersionId,
		}),
		usageReservations: r.many.billingUsageReservations({
			from: r.billingPlanVersions.id,
			to: r.billingUsageReservations.planVersionId,
		}),
		serviceCreditReservations: r.many.billingServiceCreditReservations({
			from: r.billingPlanVersions.id,
			to: r.billingServiceCreditReservations.planVersionId,
		}),
	},

	// One row per organization: organizationId is the primary key.
	billingAccounts: {
		organization: r.one.organizations({
			from: r.billingAccounts.organizationId,
			to: r.organizations.id,
		}),
		planVersion: r.one.billingPlanVersions({
			from: r.billingAccounts.planVersionId,
			to: r.billingPlanVersions.id,
		}),
	},

	billingServiceRateCards: {
		reservations: r.many.billingServiceCreditReservations({
			from: r.billingServiceRateCards.id,
			to: r.billingServiceCreditReservations.rateCardId,
		}),
	},

	billingServiceCreditControls: {
		organization: r.one.organizations({
			from: r.billingServiceCreditControls.organizationId,
			to: r.organizations.id,
		}),
	},

	billingServiceCreditReservations: {
		organization: r.one.organizations({
			from: r.billingServiceCreditReservations.organizationId,
			to: r.organizations.id,
		}),
		planVersion: r.one.billingPlanVersions({
			from: r.billingServiceCreditReservations.planVersionId,
			to: r.billingPlanVersions.id,
		}),
		rateCard: r.one.billingServiceRateCards({
			from: r.billingServiceCreditReservations.rateCardId,
			to: r.billingServiceRateCards.id,
		}),
		tedi: r.one.tedis({
			from: r.billingServiceCreditReservations.tediId,
			to: r.tedis.id,
		}),
	},

	billingUsageReservations: {
		organization: r.one.organizations({
			from: r.billingUsageReservations.organizationId,
			to: r.organizations.id,
		}),
		planVersion: r.one.billingPlanVersions({
			from: r.billingUsageReservations.planVersionId,
			to: r.billingPlanVersions.id,
		}),
		tedi: r.one.tedis({
			from: r.billingUsageReservations.tediId,
			to: r.tedis.id,
		}),
		charges: r.many.billingUsageCharges({
			from: r.billingUsageReservations.id,
			to: r.billingUsageCharges.reservationId,
			alias: "reservationCharge",
		}),
	},

	billingUsagePeriods: {
		organization: r.one.organizations({
			from: r.billingUsagePeriods.organizationId,
			to: r.organizations.id,
		}),
		planVersion: r.one.billingPlanVersions({
			from: r.billingUsagePeriods.planVersionId,
			to: r.billingPlanVersions.id,
		}),
		charges: r.many.billingUsageCharges({
			from: r.billingUsagePeriods.id,
			to: r.billingUsageCharges.usagePeriodId,
			alias: "periodCharge",
		}),
	},

	billingUsageCharges: {
		organization: r.one.organizations({
			from: r.billingUsageCharges.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.billingUsageCharges.tediId,
			to: r.tedis.id,
		}),
		reservation: r.one.billingUsageReservations({
			from: r.billingUsageCharges.reservationId,
			to: r.billingUsageReservations.id,
			alias: "reservationCharge",
		}),
		usagePeriod: r.one.billingUsagePeriods({
			from: r.billingUsageCharges.usagePeriodId,
			to: r.billingUsagePeriods.id,
			alias: "periodCharge",
		}),
	},
}));
