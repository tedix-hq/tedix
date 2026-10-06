/**
 * Drizzle Relations v2: mcp domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const mcpRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// MCP PAYMENTS (inline x402 gating — served on the request hot path)
	//
	// Reservations and events are linked twice and neither link is a db FK:
	// an event joins its reservation on the x402 requirement id (unique on the
	// reservation side via `uniq_mcp_payment_reservation_requirement`), and a
	// reservation names the event that settled it (`settled_event_id` ->
	// `mcp_payment_events.id`, the primary key). Both are ORM-level relations
	// in the existing workItems.parent / kernelConversations precedent, and
	// because there are two legs between the same pair of tables all four
	// sides carry paired aliases.
	// =========================================================================

	mcpPaymentAccounts: {
		organization: r.one.organizations({
			from: r.mcpPaymentAccounts.organizationId,
			to: r.organizations.id,
		}),
		// Nullable: a null tediId is an org-wide account, not one tedi's.
		tedi: r.one.tedis({
			from: r.mcpPaymentAccounts.tediId,
			to: r.tedis.id,
		}),
		reservations: r.many.mcpPaymentReservations({
			from: r.mcpPaymentAccounts.id,
			to: r.mcpPaymentReservations.accountId,
		}),
	},

	// Targeting rows: narrower nulls widen the scope (org > tedi > app > tool),
	// so tediId being null is a whole-organization budget policy.
	mcpPaymentPolicies: {
		organization: r.one.organizations({
			from: r.mcpPaymentPolicies.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.mcpPaymentPolicies.tediId,
			to: r.tedis.id,
		}),
		reservations: r.many.mcpPaymentReservations({
			from: r.mcpPaymentPolicies.id,
			to: r.mcpPaymentReservations.policyId,
		}),
	},

	mcpPaymentReservations: {
		organization: r.one.organizations({
			from: r.mcpPaymentReservations.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.mcpPaymentReservations.tediId,
			to: r.tedis.id,
		}),
		// Both nullable and ON DELETE SET NULL: the reservation outlives the
		// account/policy that was evaluated when it was taken.
		account: r.one.mcpPaymentAccounts({
			from: r.mcpPaymentReservations.accountId,
			to: r.mcpPaymentAccounts.id,
		}),
		policy: r.one.mcpPaymentPolicies({
			from: r.mcpPaymentReservations.policyId,
			to: r.mcpPaymentPolicies.id,
		}),
		// ORM-level: the settling event id is a plain column backed by the
		// events primary key, with no `.references()` on the ledger side.
		settledEvent: r.one.mcpPaymentEvents({
			from: r.mcpPaymentReservations.settledEventId,
			to: r.mcpPaymentEvents.id,
			alias: "mcpPaymentSettledEvent",
		}),
		// Every request/settlement/rejection emitted for this requirement.
		events: r.many.mcpPaymentEvents({
			from: r.mcpPaymentReservations.requirementId,
			to: r.mcpPaymentEvents.requirementId,
			alias: "mcpPaymentRequirementEvent",
		}),
	},

	mcpPaymentEvents: {
		// Every FK here is ON DELETE SET NULL: the ledger is append-only and
		// outlives the app/org/tedi it records.
		organization: r.one.organizations({
			from: r.mcpPaymentEvents.organizationId,
			to: r.organizations.id,
		}),
		app: r.one.apps({
			from: r.mcpPaymentEvents.appId,
			to: r.apps.id,
		}),
		tedi: r.one.tedis({
			from: r.mcpPaymentEvents.tediId,
			to: r.tedis.id,
		}),
		// ORM-level: `tool_row_id` is the app_tools primary key captured at
		// call time, deliberately kept FK-free so pruning a tool row cannot
		// rewrite payment history.
		toolRow: r.one.appTools({
			from: r.mcpPaymentEvents.toolRowId,
			to: r.appTools.id,
		}),
		// ORM-level: joins on the x402 requirement id, unique on the
		// reservation side via `uniq_mcp_payment_reservation_requirement`.
		reservation: r.one.mcpPaymentReservations({
			from: r.mcpPaymentEvents.requirementId,
			to: r.mcpPaymentReservations.requirementId,
			alias: "mcpPaymentRequirementEvent",
		}),
		// The reservation(s) this exact event settled, by `settled_event_id`.
		settledReservations: r.many.mcpPaymentReservations({
			from: r.mcpPaymentEvents.id,
			to: r.mcpPaymentReservations.settledEventId,
			alias: "mcpPaymentSettledEvent",
		}),
	},

	// Operator-issued pre-authorizations for destructive `tools/call`.
	// `subjectId` is intentionally polymorphic — a normalized caller actor id
	// that may be a tedi, user, or m2m client id depending on `authType` — so
	// it gets no relation. `toolId` holds an `{appSlug}:{toolId}` scope
	// pattern, not a tool row id, so it gets none either.
	mcpToolApprovalGrants: {
		organization: r.one.organizations({
			from: r.mcpToolApprovalGrants.organizationId,
			to: r.organizations.id,
		}),
	},
}));
