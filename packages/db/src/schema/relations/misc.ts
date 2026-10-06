/**
 * Drizzle Relations v2: misc domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const miscRelations = defineRelationsPart(schema, (_r) => ({
	// =========================================================================
	// AUDIT EVENTS (organizationId is text, no Drizzle .references() FK)
	// =========================================================================

	auditEvents: {},

	// Tenant bundle rows are keyed by slug and have no Drizzle FK by design.
	tenantBundles: {},
	cmsSites: {},
}));
