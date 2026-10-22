import { matchesGlob } from "node:path";

// This list is the whole advisory policy. New consumers require an explicit update.
export const HIGH_RISK_PATHS = Object.freeze([
	"packages/db/src/schema/**",
	"packages/db/migrations/**",
	"packages/auth/**",
	"packages/mcp-shared/src/auth/**",
	"packages/worker-kit/src/request-auth.ts",
	"apps/session-broker/**",
	"apps/os/src/auth/**",
	"apps/os/src/worker.ts",
	"apps/api/src/{kernel/edge-auth,lib/mcp-grant,lib/descope-management,lib/fleet-authority,rpc/orpc,rpc/step-up,rpc/tedi-access,rpc/app-scope,rpc/org-scope,rpc/context,rpc/mcp-host-context,rpc/tedi-console-auth}.ts",
	"apps/api/src/rpc/routers/{external-agent-*,mcp-credentials,mcp-governance,organizations-mcp-authorizations,organizations-descope-membership,descope-aih*}.ts",
	"apps/mcp/src/{index,auth-*,external-agent-*,interaction-event-auth,tedi-profile-auth}.ts",
	"apps/mcp/src/mcp/{handler,*auth*,owner-host-session}.ts",
	"**/wrangler.jsonc",
	"**/cloudflare.config.ts",
	"scripts/ci/**",
	".github/**",
	"scripts/secrets/**",
	"packages/db/src/{utils/secrets-encryption,queries/*secrets}.ts",
	"packages/api-contract/src/contracts/{secrets,tedi-secrets}.ts",
	"apps/api/src/{adapters/registry,personal-agent-inbound-routes,oauth-cimd-callback,jobs/tedi-access-key-rotation,workflows/mcp-scan-workflow}.ts",
	"apps/api/src/lib/{workspace-file-routes,tedi-provisioning,artifact-url,skill-media-url}.ts",
	"apps/api/src/services/{runtime-entitlement-admission,provider-installation-gateway,provider-worker-readiness,tedi-mcp-access,master-key-fingerprints}.ts",
	"apps/api/src/services/provider-events/{subscriptions,mcp-events}.ts",
	"apps/api/src/http/{exports-and-renders,skill-media-routes,artifact-routes}.ts",
	"apps/api/src/rpc/routers/{*secrets,os-workspaces,os-workspace-files,tedi-app-assignments,seo,tedi-console,personal-agent-inbound}.ts",
	"apps/api/src/rpc/routers/tedis/{repair,update,gateway,create,identity-provisioning,embedded-host-delegation,runtime-admin,access-key,portable-export-access,portable-import-access}.ts",
	"apps/api/src/rpc/routers/{cognitive-runtime/events-artifacts,cognitive-skill-runs/artifacts,work-items/owned-channel,catalog/install-scan,catalog/source-administration,kernel-runtime/turn-delegation,connections/discovery-user}.ts",
	"apps/mcp/src/mcp/platform-operator-tools.ts",
	"apps/tedi-runtime/src/{index,admin-agent-diag,billing-reservation-client,repo-load,llm,runtime-request-handler,platform-client-factory,master-key-fingerprint,runtime-repository}.ts",
	"apps/tedi/src/{index,types,resolve,routes/master-key-fingerprint}.ts",
]);

export function isHighRisk(files) {
	return files.some((file) =>
		HIGH_RISK_PATHS.some((glob) => matchesGlob(file, glob)),
	);
}
