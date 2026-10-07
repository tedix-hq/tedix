/**
 * Schema Aggregator
 * Export all Drizzle schema tables and types
 *
 * IMPORTANT: For API-level types (LayoutItem, AppCapabilities, Vertical, etc.),
 * import from @tedix/api-contract/schemas, NOT from this package.
 *
 * This package exports:
 * - Drizzle table definitions
 * - Inferred types from Drizzle tables (App, NewApp, User, etc.)
 * - Database query functions
 */

// Core entities
// Re-export adapter types explicitly (Drizzle inferred types need explicit type export)
export type { AppAdapter, NewAppAdapter } from "./adapters";
export * from "./adapters";
export * from "./analytics";
export * from "./artifact-releases";
export * from "./api-keys";
export * from "./app-adapter-secret-bindings";
export * from "./app-config-versions";
export * from "./app-secrets";
// Re-export app types
export type {
	App,
	AppMetadata,
	AppVisibility,
	McpConfig,
	NewApp,
} from "./apps";
export * from "./apps";
// Business capability map (value-stream capabilities + generic entity links)
export type {
	CapabilityLink,
	NewCapabilityLink,
	NewOrgCapability,
	OrgCapability,
} from "./capabilities";
export * from "./capabilities";
export * from "./catalog";
export * from "./cms-sites";
export * from "./cms-domain-claims";
export * from "./cms-deprovision-operations";
export * from "./cms-restore-fences";
export * from "./configuration";
export * from "./connection-providers";
export * from "./connection-instances";
export * from "./conversation-capabilities";
export * from "./conversation-artifact-pins";
export * from "./docs-sites";
export * from "./os-approval-rules";
export * from "./os-shares";
export * from "./os-workspaces";
export * from "./skill-run-effects";
export * from "./external-agent-identity";
export * from "./graph-projection";
export * from "./items";
// Re-export item converter utilities
export { itemToLayoutItem, layoutItemToItem } from "./items";
export * from "./jobs";
export * from "./learning-feedback";
export * from "./organization-members";
export * from "./organization-purpose";
export * from "./organization-secrets";
// Multi-tenant architecture (organizations first due to FK dependencies)
export * from "./organizations";
export type {
	NewTediPlugin,
	NewTediPluginEvent,
	NewTediPluginInstall,
	TediPlugin,
	TediPluginEvent,
	TediPluginInstall,
} from "./plugins";
export * from "./plugins";
export * from "./principal-identities";
export * from "./provider-installations";
// Work hierarchy v1: thin project container for the work_items tree
export type { NewProject, Project, ProjectStatus } from "./projects";
export * from "./projects";
// Reusable role primitive — persona + standing objectives + tags + profile
export type {
	NewRoleTemplate,
	RoleTemplate,
	RoleTemplateStandingObjective,
} from "./role-templates";
export * from "./role-templates";
export type {
	NewTediEmailAddress,
	NewTediEmailAttachment,
	NewTediEmailEvent,
	NewTediEmailMessage,
	NewTediEmailThread,
	TediEmailAddress,
	TediEmailAttachment,
	TediEmailEvent,
	TediEmailMessage,
	TediEmailThread,
} from "./tedi-email";
export * from "./tedi-email";
export * from "./tedi-secrets";
export type { NewTediSessionState, TediSessionState } from "./tedi-sessions";
export * from "./tedi-sessions";
export type {
	NewTedi,
	NewTediCustomDomain,
	NewTediDevice,
	NewTediRuntimeSnapshot,
	NewTediUsageEvent,
	Tedi,
	TediCustomDomain,
	TediDevice,
	TediRuntimeSnapshot,
	TediUsageEvent,
} from "./tedis";
export * from "./tedis";
// Relations v2 — imported directly in client.ts, not re-exported from barrel
export * from "./templates";
export * from "./tenant-behavioral-evals";
export * from "./tools";
export * from "./user-configs";
export * from "./users";
export * from "./work-agent-sessions";
export * from "./work-item-sources";
export * from "./work-items";
export * from "./work-factory";
export * from "./workstations";

// App eligibility cache

// Tedi approval requests (human-in-the-loop governance queue)
export type { NewTediApprovalRequest, TediApprovalRequest } from "./approvals";
export * from "./approvals";
export * from "./approval-simulations";
// Audit trail events
export type { AuditEvent, NewAuditEvent } from "./audit-events";
export * from "./audit-events";
// Canonical billing entitlements, credits, reservations, usage, and metering
export * from "./billing";
// Cognitive stack (knowledge entries, skill entries, muscle memory)
export * from "./cognitive";
// Cognitive runtime protocol (runtime events and durable artifacts)
export type {
	KernelConversationGrant,
	KernelRuntimeEvent,
	KernelWakeQueue,
	NewKernelConversationGrant,
	NewKernelRuntimeEvent,
	NewKernelWakeQueue,
	NewTediArtifact,
	NewTediRuntimeEvent,
	TediArtifact,
	TediRuntimeEvent,
} from "./cognitive-runtime";
export * from "./cognitive-runtime";
// Content sources
export * from "./content-sources";
// Control plane (runtime profiles, policy packs, workspace template sets)
export * from "./control-plane";
export * from "./control-plane-history";
// Cognitive cron execution ledger (flywheel cron health source of truth)
export * from "./cron-executions";
export * from "./platform-cron-executions";
export * from "./earned-delegation";
// Harness versioning + trace bundles + eval ledger (harness-evolution substrate)
export type {
	HarnessEvalResultRow,
	HarnessEvalRunRow,
	HarnessSubjectEvalResultRow,
	HarnessSubjectEvalRunRow,
	HarnessSubjectTraceBundleRow,
	HarnessSubjectVersionRow,
	HarnessVersionRow,
	NewHarnessEvalResultRow,
	NewHarnessEvalRunRow,
	NewHarnessSubjectEvalResultRow,
	NewHarnessSubjectEvalRunRow,
	NewHarnessSubjectTraceBundleRow,
	NewHarnessSubjectVersionRow,
	NewHarnessVersionRow,
	NewTraceBundleRow,
	TraceBundleRow,
} from "./harness-versions";
export * from "./harness-versions";
// MCP tool-approval grants (isolated MCP-gateway grant layer — NOT the kernel
// write-proposal approval system; see schema file header for the boundary).
export * from "./mcp-consent";
export type {
	McpToolApprovalGrant,
	NewMcpToolApprovalGrant,
} from "./mcp-governance";
export * from "./mcp-governance";
// MCP payment event ledger (x402 requests and settlements)
export type {
	McpPaymentAccount,
	McpPaymentEvent,
	McpPaymentPolicy,
	McpPaymentReservation,
	NewMcpPaymentAccount,
	NewMcpPaymentEvent,
	NewMcpPaymentPolicy,
	NewMcpPaymentReservation,
} from "./mcp-payments";
export * from "./mcp-payments";
// Generic server-side MCP Tasks (config-driven async tools)
export * from "./mcp-tasks";
// MCP telemetry events (from tedi container MCP plugins)
// Memory graph (knowledge graph for tedi long-term memory)
export * from "./memory-graph";
// Ops alerting memory — the platform-health digest's NEW/ESCALATED/RESOLVED
// dedup state (distinct from the cron-darkness work-item dedup).
export * from "./ops-alert-state";
export * from "./site-reconciliation";
// Tedi rationale records (decision journal for Tedix OS timeline)
export type {
	NewTediRationaleRecord,
	TediRationaleRecord,
} from "./rationale-records";
export * from "./rationale-records";
// Runtime submissions ledger (durable submission/attempt lifecycle)
export type {
	NewRuntimeSubmission,
	NewRuntimeSubmissionAttempt,
	RuntimeSubmission,
	RuntimeSubmissionAttempt,
} from "./runtime-submissions";
export * from "./runtime-submissions";
// Tedi growth snapshots (weekly cognitive metrics for Growth Timeline)
export type {
	NewTediGrowthSnapshot,
	TediGrowthSnapshot,
} from "./tedi-growth-snapshots";
export * from "./tedi-growth-snapshots";
// Tedi objectives and tasks (mission directives + execution log)
export type {
	NewTediObjective,
	NewTediTask,
	TediObjective,
	TediTask,
} from "./tedi-objectives";
export * from "./tedi-objectives";
// Per-app CMS bundles (apps/cms-runtime serves these via Worker Loader)
export type { NewTenantBundle, TenantBundle } from "./tenant-bundles";
export * from "./tenant-bundles";
// Platform workflow run ledger
export * from "./workflow-runs";

export * from "./provider-model-rates";

export * from "./provider-executions";

export * from "./release-locks";
