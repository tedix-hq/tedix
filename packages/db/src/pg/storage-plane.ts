/**
 * Storage-plane selection for the Work-plane query modules.
 *
 * The clean-cut port (epic 00290527, decision a515d1f2) keeps every query
 * module in two parallel copies: the shipping D1 plane under
 * `../queries/**` and the Postgres plane under `./queries/**`. A caller
 * resolves this file's module map against its configured plane and imports the
 * concrete leaf module from the returned path — the selection happens at the
 * call site boundary, not inside the modules, so each plane stays a pure
 * per-dialect implementation with no runtime dispatch inside query code.
 *
 * The config is deliberately a string union rather than an environment lookup:
 * wiring (Worker binding vs `PG_CONNECTION`-style secret) is an application
 * decision; this package only names the planes and their query surface.
 */

import type { DbQueryClient } from "../query-client";
import type { PgQueryClient } from "./client";

export type StoragePlane = "d1" | "postgres";

export interface StoragePlaneConfig {
	plane: StoragePlane;
}

/** The query-module namespaces this story ported, keyed by plane. */
export interface WorkPlaneModules {
	crud: string;
	attempts: string;
	admissions: string;
	approvals: string;
	interactions: string;
	projections: string;
	comments: string;
	laneHandoffs: string;
	interactionDigests: string;
	topApprovals: string;
	audit: string;
	decisionGraph: string;
	decisionGraphWriters: string;
	osOutputs: string;
	osWorkspaces: string;
	canonicalParty: string;
	kernelRuntimeSupport: string;
	connectionAccessRequests: string;
	personalConnectionGrants: string;
}

const D1_MODULES: WorkPlaneModules = {
	crud: "../queries/work-items/crud",
	attempts: "../queries/work-items/attempts",
	admissions: "../queries/work-items/admissions",
	approvals: "../queries/work-items/approvals",
	interactions: "../queries/work-items/interactions",
	projections: "../queries/work-items/projections",
	comments: "../queries/work-items/comments",
	laneHandoffs: "../queries/work-items/lane-handoffs",
	interactionDigests: "../queries/work-items/interaction-digests",
	topApprovals: "../queries/approvals",
	audit: "../queries/audit",
	decisionGraph: "../queries/decision-graph",
	decisionGraphWriters: "../queries/decision-graph-writers",
	osOutputs: "../queries/os-workspaces/outputs",
	osWorkspaces: "../queries/os-workspaces/workspaces",
	canonicalParty: "../queries/external-agent-identity/canonical-party",
	kernelRuntimeSupport: "../queries/kernel-runtime-support",
	connectionAccessRequests: "../queries/connection-access-requests",
	personalConnectionGrants: "../queries/personal-connection-grants",
};

const PG_MODULES: WorkPlaneModules = {
	crud: "./queries/work-items/crud",
	attempts: "./queries/work-items/attempts",
	admissions: "./queries/work-items/admissions",
	approvals: "./queries/work-items/approvals",
	interactions: "./queries/work-items/interactions",
	projections: "./queries/work-items/projections",
	comments: "./queries/work-items/comments",
	laneHandoffs: "./queries/work-items/lane-handoffs",
	interactionDigests: "./queries/work-items/interaction-digests",
	topApprovals: "./queries/approvals",
	audit: "./queries/audit",
	decisionGraph: "./queries/decision-graph",
	decisionGraphWriters: "./queries/decision-graph-writers",
	osOutputs: "./queries/os-workspaces/outputs",
	osWorkspaces: "./queries/os-workspaces/workspaces",
	canonicalParty: "./queries/external-agent-identity/canonical-party",
	kernelRuntimeSupport: "./queries/kernel-runtime-support",
	connectionAccessRequests: "./queries/connection-access-requests",
	personalConnectionGrants: "./queries/personal-connection-grants",
};

/** Module paths for the configured plane, relative to this file. */
export function storagePlaneModules(
	config: StoragePlaneConfig,
): WorkPlaneModules {
	return config.plane === "postgres" ? PG_MODULES : D1_MODULES;
}

/** The client type the configured plane's query functions expect. */
export type StoragePlaneClient<C extends StoragePlaneConfig> =
	C["plane"] extends "postgres" ? PgQueryClient : DbQueryClient;
