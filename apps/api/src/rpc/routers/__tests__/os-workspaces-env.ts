/**
 * Shared D1 fixture and router clients for the os-workspaces router suites.
 * The vi.mock blocks stay in each test file because vitest hoists them per file.
 */
import {
	osWorkspaceCollaborators,
	osWorkspaceAccessEdges,
	osWorkspaceShareLinks,
	osWorkspaceShareKeys,
} from "@tedix/db/schema/os-collaborators";
import { connectionInstances } from "@tedix/db/schema";
import {
	kernelConversations,
	kernelRuntimeRuns,
	kernelConversationGrants,
} from "@tedix/db/schema/cognitive-runtime";
/**
 * Tedix OS workspace-domain router: tenant binding, creator accountability,
 * revision optimistic concurrency surfacing, and the blueprint publish gate —
 * exercised end to end against a real D1 facade (`createD1Facade` rejects the
 * two Drizzle idioms that break on production D1).
 */

import { organizationMembers } from "@tedix/db/schema/organization-members";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { providerInstallations } from "@tedix/db/schema/provider-installations";
import { osShareLinks, osShareSessions } from "@tedix/db/schema/os-shares";
import {
	skillRunArtifacts,
	skillRuns,
	skillWorkflowSources,
} from "@tedix/db/schema/cognitive";
import {
	osBlueprintRevisions,
	osBlueprints,
	osCollaborationProposals,
	osGadgetCode,
	osGadgetExecutions,
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
// The same digest the export path records, so a lineage assertion compares
// against the real producer rather than a hand-copied constant.
import { bindTestContexts } from "../../test-context";
import { osWorkspacesContractRouter } from "../os-workspaces";

export function createEnv(): CloudflareEnv {
	const sqlite = new DatabaseSync(":memory:");
	// The router binds the caller's organization into every predicate, so the
	// fixture keeps FKs off. The gallery join reads organizations.id/name only;
	// a minimal hand-made parent table (with display names) covers it.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			connectionInstances,
			providerInstallations,
			organizationMembers,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
			osWorkspaceShareKeys,
			kernelRuntimeRuns,
			kernelConversations,
			kernelConversationGrants,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osGadgetCode,
			osGadgetExecutions,
			osBlueprints,
			osBlueprintRevisions,
			osOutputs,
			osOutputRevisions,
			osWorkspaceResources,
			osCollaborationProposals,
			osShareLinks,
			osShareSessions,
			skillRuns,
			skillWorkflowSources,
			skillRunArtifacts,
			userConfigs,
			auditEvents,
		),
	);
	sqlite.exec(`
		INSERT INTO connection_instances (id,owner_user_id,provider_id,label,token_ids,token_sub,created_at,updated_at) VALUES ('00000000-0000-4000-8000-000000000003','user-1','google-drive','Personal','["grant"]','subject','2026-01-01','2026-01-01'), ('00000000-0000-4000-8000-000000000004','user-1','github','Personal','["grant"]','subject','2026-01-01','2026-01-01');
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT DEFAULT 'example', type TEXT DEFAULT 'organization', descope_tenant_id TEXT, logo_url TEXT, metadata TEXT);
		INSERT INTO organizations (id, name)
			VALUES ('org-1', 'First Org'), ('org-2', 'Second Org');
		INSERT INTO organization_members (id, organization_id, descope_user_id, email, name, role, status) VALUES ('member-1', 'org-1', 'user-1', 'member@example.test', 'Member', 'member', 'active');
	`);
	return {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		SECRETS_MASTER_KEY: "test-gadget-export-secret",
		AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
		TEDIX_BILLING_SETTLEMENT_MODE: "external",
		TEDI_SERVICE: { fetch: async () => Response.json({ closed: true }) },
		DB: createD1Facade(sqlite),
	} as unknown as CloudflareEnv;
}

export const { userContext, apiKeyContext } = bindTestContexts({
	url: "https://api.tedix.test/rpc/os-workspaces",
	user: { permissions: ["settings:manage"] },
	apiKey: { scopes: ["apps:read", "apps:write"] },
});

export function clients() {
	const env = createEnv();
	return {
		/** The shared D1 facade, so a test can assert on the ROW, not just the wire. */
		env,
		org1: createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
		}),
		org2: createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-2" }),
		}),
		machine: createRouterClient(osWorkspacesContractRouter, {
			context: apiKeyContext({ env, organizationId: "org-1" }),
		}),
		machineAgent: createRouterClient(osWorkspacesContractRouter, {
			context: {
				...apiKeyContext({ env, organizationId: "org-1" }),
				externalAgentSessionId: "codex:session-1",
				externalAgentPrincipalId: "external-agent-1",
			},
		}),
	};
}
