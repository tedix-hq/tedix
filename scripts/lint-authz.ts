#!/usr/bin/env bun

/**
 * `apps/api` router authorization lints (`bun run lint:authz`): two-plane
 * coverage and tenant scope, both below. `--strict` makes any finding exit 1
 * (what `lint:repo` runs); `--report` prints each lint's grouped report.
 */

/**
 * AUTHORIZATION-PLANE COVERAGE: every authenticated procedure needs both planes,
 * `withPermission` (user RBAC) and `createScopeMiddleware` (API-key/M2M scopes),
 * via `withAuthorization`, `withExactApiKeyScope`, or a verified HAND_ROLLED_AUTHZ
 * entry. Guards are inherited across the builder alias graph, including imports.
 * Stale exemptions fail.
 */

/**
 * TENANT SCOPE: a handler that fetches a record by a caller-supplied id must bind
 * the caller's organization to it (pass the org into the fetch, assert ownership
 * with the context, or compare `record.organizationId` explicitly).
 * `requireOrgId(context)` alone binds nothing. Global resolvers and trusted
 * cross-tenant handlers are listed below with a reason and stale-checked.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(
	fileURLToPath(new URL(".", import.meta.url)),
	"..",
);

const ROUTERS_DIR = join(REPO_ROOT, "apps/api/src/rpc/routers");
const ORPC_PATH = join(REPO_ROOT, "apps/api/src/rpc/orpc.ts");

/**
 * Routers that authorize per principal class inside handler bodies rather than
 * with middleware. Every entry must actually branch on `context.authType` AND
 * consult `context.apiKey?.scopes` — the lint verifies this and rejects stale
 * entries, so adding a file here cannot quietly hide a real gap.
 */
export const HAND_ROLLED_AUTHZ: Record<string, string> = {
	"external-agent-identity.ts":
		"External-agent identity is credential-bound and principal-shaped: governance, verified service binding, and exact bound API-key/session checks intentionally differ by operation; MCP credential issuance binds the authenticated principal and limits grants to the target Descope resource's approved exact scopes.",
	"images.ts":
		"Image mutations authorize against the input entity discriminator: organization, app, and tedi images require different RBAC permissions and machine scopes, while the platform backfill requires platform:admin on both planes.",
	"work-items/coordination-git.ts":
		"Board coordination and Git settlement use the principal-shaped authOs policy in policy-helpers: external agents, tedis and operators get different verbs, and the claim CAS is enforced in the write predicate.",
	"work-items/creation-reads.ts":
		"Board creation and reads use the principal-shaped authOs policy in policy-helpers, which branches on context.authType and inspects API-key scopes before handlers run.",
	"work-items/lifecycle-marketing.ts":
		"Board lifecycle and marketing writes use the principal-shaped authOs policy in policy-helpers, plus operation-specific CMO and evidence gates in handler bodies.",
};

/** A procedure's effective guard state, accumulated up its builder chain. */
type Guards = {
	rbac: boolean;
	scope: boolean;
	authed: boolean;
	handRolledRbac: boolean;
};

type Finding = {
	/** `<router-relative path>::<exported const name>` — the finding key. */
	key: string;
	file: string;
	line: number;
	kind: "rbac-only" | "scope-only" | "no-plane";
	detail: string;
};

type InlineHandler = {
	name: string;
	chain: string;
	lineOffset: number;
};

/**
 * Top-level `const NAME = …` / `export const NAME = …` blocks. The lazy body
 * plus lookahead stops each block at the next top-level declaration, which is
 * what lets a multi-line `.use(…).use(…).handler(…)` chain be read whole.
 *
 * The final alternative must be a real end-of-input assertion. `\Z` is a
 * Perl/Python-ism that JavaScript does not support — it compiles to a literal
 * "Z", so the LAST block in every file fails to match and its procedure becomes
 * invisible to the lint. `$(?![\s\S])` is the portable form ( `$` alone is
 * end-of-LINE here because the regex is `m`-flagged).
 */
const BLOCK_RE =
	/^(?:export )?const\s+(\w+)(?::[^=]+)?\s*=\s*([\s\S]*?)(?=^(?:export )?const |^export (?:function|async|type|interface|default)|$(?![\s\S]))/gm;

/**
 * Extract procedures declared directly inside `os.router({ ... })` objects.
 * The top-level block parser otherwise sees only the router builder and misses
 * each nested `.handler(...)` chain — which previously hid real single-plane
 * procedures in MCP health/eval and runtime routers.
 */
function collectInlineHandlers(rhs: string): InlineHandler[] {
	const lines = rhs.split("\n");
	const handlers: InlineHandler[] = [];
	for (let handlerLine = 0; handlerLine < lines.length; handlerLine++) {
		if (!lines[handlerLine]?.includes(".handler(")) continue;
		for (
			let propertyLine = handlerLine;
			propertyLine >= Math.max(0, handlerLine - 12);
			propertyLine--
		) {
			const property = lines[propertyLine]?.match(/^\s*(\w+)\s*:\s*(.*)$/);
			if (!property) continue;
			const expression = [
				property[2],
				...lines.slice(propertyLine + 1, handlerLine + 1),
			].join("\n");
			const handlerAt = expression.indexOf(".handler(");
			if (handlerAt < 0) continue;
			const chain = expression.slice(0, handlerAt).trim();
			if (!/^\w+(?:\.\w+)+/.test(chain)) continue;
			handlers.push({
				name: property[1]!,
				chain,
				lineOffset: propertyLine,
			});
			break;
		}
	}
	return handlers;
}

const WITH_PERMISSION_RE = /withPermission\(/;
const DIRECT_SCOPE_RE = /createScopeMiddleware\(|withAuthorization\(/;
const EXACT_API_KEY_SCOPE_RE = /withExactApiKeyScope\(/;
const AUTHED_RE = /withAuth|requireAuth/;
const HAND_ROLLED_AUTHZ_MARKER_RE = /HAND_ROLLED_AUTHZ:\s*[^\n]{12,}/;
const HANDLER_OWNED_USER_AUTHZ_SHAPE_RE =
	/withAuthorization\(\s*\{\s*handlerOwnedUserAuthorization:/;
const HANDLER_OWNED_USER_AUTHZ_RATIONALE_RE =
	/withAuthorization\(\s*\{\s*handlerOwnedUserAuthorization:\s*"[^"\n]{12,}"\s*,?\s*\}/;
const SCOPE_ONLY_AUTHZ_NAMES = new Set(
	[
		...readFileSync(ORPC_PATH, "utf8").matchAll(
			/(\w+):\s*withAuthorization\(\s*null\b/g,
		),
	].map((match) => match[1]!),
);

function authzReferences(chain: string): string[] {
	return [...chain.matchAll(/AUTHZ\.(\w+)/g)].map((match) => match[1]!);
}

function hasRbacGuard(chain: string): boolean {
	if (EXACT_API_KEY_SCOPE_RE.test(chain)) return true;
	if (WITH_PERMISSION_RE.test(chain)) return true;
	if (
		authzReferences(chain).some((name) => !SCOPE_ONLY_AUTHZ_NAMES.has(name))
	) {
		return true;
	}
	if (HANDLER_OWNED_USER_AUTHZ_SHAPE_RE.test(chain)) return false;
	return [...chain.matchAll(/withAuthorization\(\s*([^,\s)]+)/g)].some(
		(match) => match[1] !== "null",
	);
}

function hasScopeGuard(chain: string): boolean {
	return (
		DIRECT_SCOPE_RE.test(chain) ||
		EXACT_API_KEY_SCOPE_RE.test(chain) ||
		authzReferences(chain).length > 0
	);
}

function hasInlineHandRolledRbac(chain: string): boolean {
	if (HANDLER_OWNED_USER_AUTHZ_RATIONALE_RE.test(chain)) return true;
	const usesScopeOnlyAuthz = authzReferences(chain).some((name) =>
		SCOPE_ONLY_AUTHZ_NAMES.has(name),
	);
	return (
		(/withAuthorization\(\s*null\b/.test(chain) || usesScopeOnlyAuthz) &&
		HAND_ROLLED_AUTHZ_MARKER_RE.test(chain)
	);
}

function isTestFile(path: string): boolean {
	return (
		path.includes(".test.") || path.includes(".spec.") || path.endsWith(".d.ts")
	);
}

function walkTs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return walkTs(full);
		return full.endsWith(".ts") && !isTestFile(full) ? [full] : [];
	});
}

/** Resolve a relative import specifier to a file on disk. */
function resolveImport(fromFile: string, spec: string): string | null {
	const base = resolve(dirname(fromFile), spec);
	for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

type Analysis = {
	/** `<abs file>::<const name>` → right-hand side source text. */
	defs: Map<string, string>;
	/** abs file → (local imported name → abs source file). */
	imports: Map<string, Map<string, string>>;
	/** abs file → source text. */
	sources: Map<string, string>;
	/**
	 * Parse a not-yet-seen file on demand. Builder chains leave the routers
	 * directory — `authOs` is defined in `../orpc.ts` — so guard resolution must
	 * be able to follow an import anywhere in the repo, not just the walked set.
	 */
	ingest: (file: string) => void;
};

function analyze(files: string[]): Analysis {
	const defs = new Map<string, string>();
	const imports = new Map<string, Map<string, string>>();
	const sources = new Map<string, string>();

	function ingest(file: string): void {
		if (sources.has(file)) return;
		if (!existsSync(file) || !statSync(file).isFile()) return;
		const src = readFileSync(file, "utf8");
		sources.set(file, src);
		for (const match of src.matchAll(BLOCK_RE)) {
			defs.set(`${file}::${match[1]}`, match[2]);
		}
		const localToFile = new Map<string, string>();
		for (const match of src.matchAll(
			/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g,
		)) {
			const target = resolveImport(file, match[2]);
			if (!target) continue;
			for (const raw of match[1].split(",")) {
				// `foo as bar` binds locally as `bar`.
				const local = raw
					.trim()
					.split(/\s+as\s+/)
					.pop()
					?.trim();
				if (local) localToFile.set(local, target);
			}
		}
		imports.set(file, localToFile);
	}

	for (const file of files) ingest(file);
	return { defs, imports, sources, ingest };
}

/**
 * Effective guards for a builder identifier, following the alias chain across
 * relative imports. Memoized, depth-bounded, and cycle-guarded.
 */
function resolveGuards(
	analysis: Analysis,
	memo: Map<string, Guards>,
	file: string,
	name: string,
	depth = 0,
): Guards {
	const key = `${file}::${name}`;
	const cached = memo.get(key);
	if (cached) return cached;

	const none: Guards = {
		rbac: false,
		scope: false,
		authed: false,
		handRolledRbac: false,
	};
	if (depth > 8) return none;

	let rhs = analysis.defs.get(key);
	let owner = file;
	if (rhs === undefined) {
		const source = analysis.imports.get(file)?.get(name);
		if (source) {
			analysis.ingest(source);
			const imported = analysis.defs.get(`${source}::${name}`);
			if (imported !== undefined) {
				rhs = imported;
				owner = source;
			}
		}
	}
	if (rhs === undefined) return none;

	// Seed the memo before recursing so an import cycle terminates.
	memo.set(key, none);

	const chain = rhs.split(".handler(")[0];
	const parentName = chain.match(/^\s*(\w+)/)?.[1];
	const parent =
		parentName && parentName !== name
			? resolveGuards(analysis, memo, owner, parentName, depth + 1)
			: undefined;

	const guards: Guards = {
		rbac: (parent?.rbac ?? false) || hasRbacGuard(chain),
		scope: (parent?.scope ?? false) || hasScopeGuard(chain),
		authed: (parent?.authed ?? false) || AUTHED_RE.test(chain),
		handRolledRbac:
			(parent?.handRolledRbac ?? false) || hasInlineHandRolledRbac(chain),
	};
	memo.set(key, guards);
	return guards;
}

/** Does this file authorize per principal class in its handler bodies? */
export function hasHandRolledAuthz(src: string): boolean {
	return (
		/context\.authType|\bauthType\b/.test(src) &&
		(/apiKey\?\.scopes/.test(src) ||
			/hasRequiredScope\(/.test(src) ||
			/resolveExternalAgentMcpClientScopes\(/.test(src))
	);
}

function hasHandRolledAuthzFile(file: string): boolean {
	const src = readFileSync(file, "utf8");
	if (hasHandRolledAuthz(src)) return true;

	// Decomposed capability modules import the already-guarded implementer from
	// a sibling policy module. Follow that exact authOs import for stale checking
	// while keeping the disposition itself file-specific.
	for (const match of src.matchAll(
		/import\s*\{[^}]*\bauthOs\b[^}]*\}\s*from\s*["'](\.[^"']+)["']/gs,
	)) {
		const policyFile = join(dirname(file), `${match[1]}.ts`);
		if (
			existsSync(policyFile) &&
			hasHandRolledAuthz(readFileSync(policyFile, "utf8"))
		) {
			return true;
		}
	}
	return false;
}

/**
 * `routersDir` and `handRolled` are injectable so the unit test can drive the
 * analysis over a temp fixture tree instead of the real router directory.
 */
export function collectAuthzFindings(
	routersDir: string = ROUTERS_DIR,
	handRolled: Record<string, string> = HAND_ROLLED_AUTHZ,
): {
	findings: Finding[];
	staleAllowlist: string[];
	totals: { procedures: number; both: number };
} {
	const files = walkTs(routersDir);
	const analysis = analyze(files);
	const memo = new Map<string, Guards>();
	const findings: Finding[] = [];
	let procedures = 0;
	let both = 0;

	for (const file of files) {
		const src = analysis.sources.get(file) ?? "";
		const rel = relative(routersDir, file);
		const exempt = rel in handRolled;

		for (const match of src.matchAll(BLOCK_RE)) {
			const [, name, rhs] = match;
			if (rhs.includes(".router({")) {
				for (const inline of collectInlineHandlers(rhs)) {
					const baseName = inline.chain.match(/^\s*(\w+)/)?.[1];
					if (!baseName) continue;
					const base = resolveGuards(analysis, memo, file, baseName);
					const authed = base.authed || AUTHED_RE.test(inline.chain);
					if (!authed) continue;
					procedures += 1;
					const rbac = base.rbac || hasRbacGuard(inline.chain);
					const scope = base.scope || hasScopeGuard(inline.chain);
					const handRolledRbac =
						base.handRolledRbac || hasInlineHandRolledRbac(inline.chain);
					if ((rbac || handRolledRbac) && scope) {
						both += 1;
						continue;
					}
					if (exempt) continue;
					const kind: Finding["kind"] = rbac
						? "rbac-only"
						: scope
							? "scope-only"
							: "no-plane";
					const blockLine = src.slice(0, match.index ?? 0).split("\n").length;
					findings.push({
						key: `${rel}::${name}.${inline.name}`,
						file: rel,
						line: blockLine + inline.lineOffset,
						kind,
						detail:
							kind === "rbac-only"
								? "has withPermission but no scope guard — reachable by any API key in the tenant regardless of its scopes"
								: kind === "scope-only"
									? "has a scope guard but no withPermission — reachable by any authenticated user regardless of role"
									: "has neither plane — unguarded for every principal class that reaches it",
					});
				}
				continue;
			}
			if (!rhs.includes(".handler(")) continue;
			const chain = rhs.split(".handler(")[0];
			const baseName = chain.match(/^\s*(\w+)/)?.[1];
			if (!baseName) continue;

			const base = resolveGuards(analysis, memo, file, baseName);
			// Public procedures have no principal class to confine.
			if (!base.authed) continue;
			procedures += 1;

			const rbac = base.rbac || hasRbacGuard(chain);
			const scope = base.scope || hasScopeGuard(chain);
			const handRolledRbac =
				base.handRolledRbac || hasInlineHandRolledRbac(chain);
			if ((rbac || handRolledRbac) && scope) {
				both += 1;
				continue;
			}
			// A router that authorizes in its handlers covers both classes itself.
			if (exempt) continue;

			const line = src.slice(0, match.index ?? 0).split("\n").length;
			const kind: Finding["kind"] = rbac
				? "rbac-only"
				: scope
					? "scope-only"
					: "no-plane";
			const detail =
				kind === "rbac-only"
					? "has withPermission but no scope guard — reachable by any API key in the tenant regardless of its scopes"
					: kind === "scope-only"
						? "has a scope guard but no withPermission — reachable by any authenticated user regardless of role"
						: "has neither plane — unguarded for every principal class that reaches it";

			findings.push({ key: `${rel}::${name}`, file: rel, line, kind, detail });
		}
	}

	const staleAllowlist = Object.keys(handRolled).filter((rel) => {
		const abs = join(routersDir, rel);
		if (!existsSync(abs)) return true;
		return !hasHandRolledAuthzFile(abs);
	});

	findings.sort((a, b) => a.key.localeCompare(b.key));
	return { findings, staleAllowlist, totals: { procedures, both } };
}

function coverageMain(): number {
	const strict = process.argv.includes("--strict");
	const report = process.argv.includes("--report");
	const { findings, staleAllowlist, totals } = collectAuthzFindings();

	// In the steady state this reports zero. If a regression appears, group the
	// CURRENT gaps by router so the missing plane is immediately actionable.
	if (report) {
		const byFile = new Map<string, Finding[]>();
		for (const f of findings) {
			const list = byFile.get(f.file);
			if (list) list.push(f);
			else byFile.set(f.file, [f]);
		}
		const ordered = [...byFile.entries()].sort(
			(a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
		);
		console.log(
			`authz-coverage report: ${findings.length} gap(s) across ${ordered.length} router(s) — ${totals.both} of ${totals.procedures} authenticated procedures carry both planes\n`,
		);
		for (const [file, list] of ordered) {
			const counts = (kind: Finding["kind"]) =>
				list.filter((f) => f.kind === kind).length;
			const parts = (["rbac-only", "scope-only", "no-plane"] as const).flatMap(
				(kind) => {
					const n = counts(kind);
					return n > 0 ? [`${kind} ${n}`] : [];
				},
			);
			console.log(`${file}  (${list.length}: ${parts.join(", ")})`);
			for (const f of [...list].sort((a, b) => a.line - b.line)) {
				console.log(
					`  :${f.line}  ${f.key.split("::")[1]}  — needs ${
						f.kind === "rbac-only"
							? "createScopeMiddleware"
							: f.kind === "scope-only"
								? "withPermission"
								: "withPermission + createScopeMiddleware"
					}`,
				);
			}
			console.log("");
		}
		return 0;
	}

	const regressions = findings;
	if (regressions.length === 0 && staleAllowlist.length === 0) {
		console.log(
			`authz-coverage: OK — ${totals.procedures} authenticated procedures, ${totals.both} carry both planes, no gaps`,
		);
		return 0;
	}

	const label = strict ? "FAIL" : "WARN";

	if (regressions.length > 0) {
		console.error(
			`${label} authz-plane coverage: ${regressions.length} procedure(s) carry only one authorization plane. Authorization is two planes — add the missing guard rather than removing the other (apps/api/AGENTS.md):`,
		);
		for (const f of regressions) {
			console.error(`  ${f.file}:${f.line}  ${f.key.split("::")[1]}`);
			console.error(`    ${f.kind}: ${f.detail}`);
		}
	}

	if (staleAllowlist.length > 0) {
		console.error(
			`${label} HAND_ROLLED_AUTHZ is stale: ${staleAllowlist.length} entr(y|ies) no longer show handler-body authz (an authType branch plus direct scope inspection). Remove the exemption or restore the guards:`,
		);
		for (const rel of staleAllowlist) console.error(`  ${rel}`);
	}

	return strict ? 1 : 0;
}

// ── Tenant scope ────────────────────────────────────────────────────────────

/** Every non-test .ts under the routers tree. */
function walkRouterFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return walkRouterFiles(full);
		const isTest = /\.(?:test|spec)\.ts$|\.d\.ts$/.test(full);
		return full.endsWith(".ts") && !isTest ? [full] : [];
	});
}

/**
 * Fetch helpers that resolve their own tenant scope internally, so a caller
 * supplying only an id is still safe. Each entry must say why.
 */
export const SCOPED_BY_CONSTRUCTION: Record<string, string> = {
	getCatalogOsBlueprint:
		"Cross-org gallery read BY DESIGN: the query predicate fences to visibility='catalog' AND status='published', so only blueprints an org explicitly published to the shared gallery resolve; the caller's org never grants access — catalog visibility does. Verified in queries/os-workspaces/blueprints.ts.",
	getOsOutputMutationReceiptForInstance:
		"Resolves an output receipt only beneath the supplied OS instance; callers first validate that parent instance with requireInstance against the caller organization.",
	requireTediAccess:
		"Resolves the tedi AND asserts the caller's organization owns it; returns the tedi only on success.",
	getApiKeyById:
		"Callers compare the returned key's organizationId before use; the key id is not a tenant-visible handle.",
	resolveTediTenantId:
		"Resolves the tedi's organization and throws FORBIDDEN unless it equals context.organizationId (connections.ts) — also rejects a tedi access key whose tediId differs. Verified by reading the body, not the name.",
	findUniqueInboundTediEmailMessageIdentityByHeader:
		"Service-binding-only email outcome receipt: exact globally unique tedi UUID and RFC Message-ID are both query predicates, direction is inbound, and the helper returns metadata only after rejecting duplicate mailbox matches. There is no end-user organization context on this internal call.",
};

/**
 * Resolvers whose records are intentionally global or whose external identity
 * key is already bound by the provider API. Keeping these call-specific avoids
 * exempting the rest of a handler if it later adds a tenant-owned lookup.
 */
export const NON_TENANT_BY_CONSTRUCTION: Record<string, string> = {
	getConnectionInstance:
		"Personal account slots intentionally span workspaces. The direct query requires an owner predicate (personal user with organizationId IS NULL, or exact organizationId), providerId and instance id together; callers derive the owner from the authenticated user or the existing authorized credential-resolution principal. Verified by connection-instances D1 ownership tests; Organization callers derive the organization from the authorized tenant context.",
	fetchConnectionToken:
		"Descope outbound credentials are keyed by the authenticated caller user id, not a Tedix D1 tenant row.",
	fetchConnectionTokenByScopes:
		"Descope outbound credentials are keyed by the authenticated caller user id and requested scopes.",
	fetchTenantConnectionToken:
		"Native tenant token lookup is keyed by Descope tenantId rather than Tedix D1 id. Callers derive that tenant from an organization resolved inside the authenticated tenant context; the default fetch rejects Tedix named slot selectors. Exact tenant disconnect tests cover this boundary.",
	fetchNamedTenantConnectionToken:
		"Native Descope tenant account lookup requires exact tenantId, provider and opaque selector and validates those on the response. The tenant is derived from the authorized organization row; callers first authorize the exact organization/provider/slot. Scoped fallback retains the same selector.",
	fetchPersonalConnectionToken:
		"Native Descope personal account lookup requires userId, provider and opaque externalIdentifier, validates all three on the response, and rejects tenant-associated grants. Callers authorize the exact owner/provider slot first; scoped fallback retains the same selector.",
	getAdaptiveConnectUrl:
		"Connection providers are project-global; any optional target tenant is separately bound to the caller organization.",
	getCatalogAppById:
		"app_catalog is the platform-global catalog layer, not an organization-owned app instance.",
	getCatalogAppChanges:
		"Catalog changelog rows belong to the platform-global app_catalog layer.",
	getConnectionProviderIssuerPin:
		"Connection provider issuer pins are project-global security metadata.",
	getConnectionProviderById:
		"Connection provider templates are project-global configuration; initiateConnection first proves the exact provider is referenced by the caller organization before reading its issuer pin.",
	getGraphReadState:
		"The helper derives organization scope from context; the caller id appears only in a read-mode option.",
	getLatestDriftReports:
		"Drift reports belong to the platform-global app_catalog layer.",
	loadDescopeMcpServer:
		"Descope MCP servers and Resources are project-global provider records; callers separately bind them to a tenant-owned app through an exact canonical audience or stored D1 ownership reference.",
	loadExistingStaticOAuthProvider:
		"Descope outbound-app definitions are project-global provider records; initiateConnection first proves the exact provider is referenced by the caller organization before loading it.",
	getPluginById:
		"tedi_plugins is the global marketplace registry; per-tenant installs are scoped separately.",
	getTemplateById:
		"app_templates is a global registry; mutations require platform-admin and apply binds the destination organization.",
	getToolTestsForApp:
		"Catalog tool tests belong to the platform-global app_catalog layer.",
	resolveTediRuntimeBackend:
		"The current helper returns the single certified runtime kind and does not resolve tenant data.",
	resolveConnectionProviderTemplate:
		"Connection provider templates are project-global configuration; tenant selection is enforced on credential use.",
	resolveDelegatedChildRunRef:
		"Pure resolver over an already organization-scoped parent run; it performs no record lookup and only validates a child selector against that parent metadata.",
};

/**
 * Exact handlers that intentionally operate across tenants behind a stronger
 * trust boundary. Entries are stale-checked: when the raw finding disappears,
 * strict mode requires deleting the disposition too.
 */
export const REVIEWED_NON_TENANT_HANDLERS: Record<string, string> = {
	"kernel-runtime/execution-proposals.ts::getRepoCommitApprovalStatusRoute":
		"Service-binding-only runtime callback intentionally resolves the approval named by its trusted tedi caller, then requires the row tediId and repo-commit payload kind to match.",
	"organizations.ts::syncFromDescopeContract":
		"Service-binding-only Descope projection sync creates or updates the tenant named by the trusted auth callback.",
	"tedis/connections.ts::initiateAppConnectionProcedure":
		"Service-binding-only provisioning path resolves the tedi selected by the trusted control-plane caller.",
	"tenant-membership.ts::removeTenantMembershipContract":
		"Platform-admin-only cross-organization membership removal intentionally resolves any Descope tenant.",
	...Object.fromEntries(
		[
			"db.ts::claimSkillWorkflowAdmissionFence",
			"db.ts::clearSkillRunRestartIntent",
			"db.ts::finalizeAbortedSkillRunRestart",
			"db.ts::getSkillRun",
			"db.ts::getSkillRunArtifactInlineContent",
			"db.ts::getSkillRunArtifactStorageRow",
			"db.ts::listSkillRunArtifactInlineContent",
			"db.ts::loadSkillRunSnapshot",
			"db.ts::reconcileSkillRun",
			"db.ts::releaseSkillWorkflowAdmissionFence",
			"db.ts::reserveSkillRunExecutionEpoch",
			"db.ts::touchSkillRunReconciled",
			"db.ts::updateSkillRunAfterControl",
			"workflow-restart.ts::backfillWorkflowArtifactSha256",
			"workflow-restart.ts::getWorkflowExecutionEpochOutcome",
			"workflow-restart.ts::hasWorkflowExecutionEpochStarted",
			"workflow-restart.ts::isWorkflowInstanceRetired",
		].map((key) => [
			`apps/skill-runtime/src/${key}`,
			"skill-runtime is internal-only (isAuthenticated: apps/api service binding or PLATFORM_SERVICE_TOKEN). It addresses runs by the server-minted run id that apps/api resolved from an organization-scoped skill_runs read before calling; its own workflows reuse the id they were created with.",
		]),
	),
};

/** A direct caller-supplied id accessor: `input.id` / `input.memberId`. */
const INPUT_ID_RE = /\binput\.(?:id|\w*[iI]d)\b/;

/**
 * Handlers idiomatically destructure first (`const { memberId } = input`), after
 * which the id reaches the fetch as a bare local and `input.` never appears in
 * the argument list. Missing this is not academic: it is why the first version
 * of this lint scored 0 findings on the pre-fix `acceptInvitation`, the very
 * privilege-escalation bug that motivated writing it.
 */
const DESTRUCTURE_RE = /const\s*\{([^}]*)\}\s*=\s*input\b/g;
const ID_NAME_RE = /^(?:id|\w*[iI]d)$/;

function callerIdNames(body: string): string[] {
	const names: string[] = [];
	DESTRUCTURE_RE.lastIndex = 0;
	let match: RegExpExecArray | null = DESTRUCTURE_RE.exec(body);
	while (match !== null) {
		for (const raw of (match[1] ?? "").split(",")) {
			// `memberId: renamed` binds the RIGHT-hand name in scope.
			const name = (raw.includes(":") ? raw.split(":")[1] : raw)?.trim() ?? "";
			if (name && ID_NAME_RE.test(name)) names.push(name);
		}
		match = DESTRUCTURE_RE.exec(body);
	}
	return names;
}

/** A by-id resolution: `getXById(...)`, `findXById(...)`, `loadX(...)` etc. */
const BY_ID_CALL_RE =
	/(?<!\.)\b((?:get|find|load|read|fetch|resolve)[A-Za-z0-9_]*(?:ById|ByKey|BySlug)?)\s*\(/g;

/**
 * Tokens that bind an organization when they appear in the FETCH's arguments.
 * `requireOrgId(` is included because passing its result straight into the
 * fetch is the documented way its return value binds — distinct from calling it
 * as a bare statement, which binds nothing and is the original defect.
 */
const ORG_TOKEN_RE =
	/\b(?:orgId|organizationId|organization_id|ownerOrgId)\b|\brequireOrgId\s*\(/;

/** An assertion that inspects a record against the context. */
const ASSERT_RE =
	/\bassert[A-Z]\w*\s*\(\s*context\b|\bassert[A-Z]\w*\s*\([^)]*\bcontext\b|\brequire[A-Z]\w*(?:Access|Identity|Ownership|Owned|For\w*)\w*\s*\([^)]*\bcontext\b/;

/**
 * An explicit record-vs-organization comparison, e.g.
 * `member.organizationId !== organizationId`. Deliberately accepts ANY org-ish
 * identifier on the right, not just `context.organizationId`: handlers commonly
 * take the org from input, validate the caller's access to it
 * (`requireOrganizationAccess(context, organizationId)`), then compare the
 * record against that local. Demanding `context` on one side made
 * `members.ts::getMemberContract` — which is correctly guarded — a false
 * positive.
 *
 * This lint asks only "is the record bound to an organization at all". Whether
 * the caller is entitled to THAT organization is a different question, owned by
 * requireOrganizationAccess and the two authorization planes that
 * `lint:authz` measures. Conflating them would make both checks mushy.
 */
const EXPLICIT_COMPARE_RE =
	/\.(?:organizationId|orgId)\s*(?:!==|===|!=|==)\s*[^;{]*\b(?:organizationId|orgId|context|caller)\b/;

/**
 * Binding through a PARENT that was itself org-checked, e.g.
 *   await requireAppForOrg(db, orgId, appId);        // app belongs to caller
 *   const adapter = await getAdapterById(db, adapterId);
 *   if (adapter.appId !== appId) throw FORBIDDEN;    // record belongs to app
 * The record is bound to the organization by transitivity, and this is a common
 * and correct shape for nested resources.
 *
 * Both halves are required. The guard alone proves nothing about the fetched
 * record, and the comparison alone proves nothing about the parent. Note that
 * `requireOrgId` does NOT match this pattern by design — it names no parent and
 * checks only the caller, which is precisely the control-plane defect.
 */
const PARENT_SCOPE_RE =
	/\b(?:require|assert|get|resolve)\w*(?:ForOrg|OrgScoped|Access|Ownership|Owned)\w*\s*\(/;
const PARENT_SCOPE_CALL_RE =
	/\b(?:require|assert|get|resolve)\w*(?:For\w+|OrgScoped|Access|Context|Identity|Ownership|Owned)\w*\s*\(/g;
const PARENT_LINK_RE = /\.\w*[iI]d\s*(?:!==|===|!=|==)\s*\w/;

/**
 * Identifiers a parent-scope guard has already validated, e.g. `appId` after
 * `requireAppForOrg(db, orgId, appId)`. A fetch keyed on one of these is bound
 * without any further comparison, because the key itself was org-checked —
 * `getAdaptersByAppId(db, appId)` returns only children of a verified parent.
 */
function validatedIdentifiers(body: string): Set<string> {
	const validated = new Set<string>();
	PARENT_SCOPE_CALL_RE.lastIndex = 0;
	let match: RegExpExecArray | null = PARENT_SCOPE_CALL_RE.exec(body);
	while (match !== null) {
		const args = argsOf(body, match.index + match[0].length - 1);
		for (const token of args.match(/\b\w+\b/g) ?? []) {
			if (ID_NAME_RE.test(token)) validated.add(token);
		}
		match = PARENT_SCOPE_CALL_RE.exec(body);
	}
	return validated;
}

export type TenantScopeFinding = {
	/** `<router-relative file>::<const name>` — the finding key. */
	key: string;
	file: string;
	line: number;
	call: string;
};

const TENANT_BLOCK_RE =
	/^(?:export )?const (\w+)(?::[^=]+)? =\s([\s\S]*?)(?=^(?:export )?const |^export (?:function|async|type|interface|default)|$(?![\s\S]))/gm;

/**
 * Extract the argument text of `name(` starting at `open`, balancing parens so
 * a nested call (`eq(t.id, input.id)`) is captured whole rather than truncated
 * at its first `)`.
 */
function argsOf(source: string, open: number): string {
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	return "";
}

export function analyzeHandler(body: string): { call: string } | null {
	if (!body.includes(".handler(")) return null;
	const destructured = callerIdNames(body);
	if (!INPUT_ID_RE.test(body) && destructured.length === 0) return null;
	const validated = validatedIdentifiers(body);
	const callerIdRe =
		destructured.length > 0
			? new RegExp(
					`\\binput\\.(?:id|\\w*[iI]d)\\b|\\b(?:${destructured.join("|")})\\b`,
				)
			: INPUT_ID_RE;

	// Binding evidence anywhere in the handler is enough — the assertion or
	// comparison usually happens on the line AFTER the fetch.
	if (ASSERT_RE.test(body)) return null;
	if (EXPLICIT_COMPARE_RE.test(body)) return null;
	if (PARENT_SCOPE_RE.test(body) && PARENT_LINK_RE.test(body)) return null;

	// A drizzle where-clause that pins the org counts as binding.
	if (/\.where\([\s\S]*?(?:organizationId|orgId)[\s\S]*?\)/.test(body)) {
		return null;
	}

	BY_ID_CALL_RE.lastIndex = 0;
	let match: RegExpExecArray | null = BY_ID_CALL_RE.exec(body);
	while (match !== null) {
		const name = match[1] ?? "";
		const open = match.index + match[0].length - 1;
		const args = argsOf(body, open);
		const takesCallerId = callerIdRe.test(args);
		const bindsOrg = ORG_TOKEN_RE.test(args);
		// The fetch key was itself validated by a parent-scope guard.
		const keyedOnValidated = (args.match(/\b\w+\b/g) ?? []).some((token) =>
			validated.has(token),
		);
		if (
			takesCallerId &&
			!bindsOrg &&
			!keyedOnValidated &&
			!Object.hasOwn(SCOPED_BY_CONSTRUCTION, name) &&
			!Object.hasOwn(NON_TENANT_BY_CONSTRUCTION, name)
		) {
			return { call: `${name}(${args.replace(/\s+/g, " ").trim()})` };
		}
		match = BY_ID_CALL_RE.exec(body);
	}
	return null;
}

/**
 * `requireOrgId` may be DEFINED only in rpc/org-scope.ts. Local copies have
 * shipped 32 times; 17 of them threw UNAUTHORIZED (401) where the canonical
 * copy throws FORBIDDEN (403), which bounces a valid session to /login. The
 * 32nd copy lived in cognitive-shared.ts behind 57 call sites — a reviewer
 * sees the familiar name and assumes the canonical behavior. A machine does
 * not.
 */
const LOCAL_REQUIRE_ORG_ID_RE =
	/(?:^|\n)[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+requireOrgId\b|(?:^|\n)[ \t]*(?:export[ \t]+)?const[ \t]+requireOrgId[ \t]*=/;

export function scanForLocalRequireOrgId(
	path: string,
	source: string,
): TenantScopeFinding[] {
	if (/[/\\]org-scope\.ts$/.test(path)) return [];
	const match = LOCAL_REQUIRE_ORG_ID_RE.exec(source);
	if (!match) return [];
	return [
		{
			key: `${relative(ROUTERS_DIR, path)}::requireOrgId-local-definition`,
			file: relative(REPO_ROOT, path),
			line: source.slice(0, match.index).split("\n").length + 1,
			call: "local requireOrgId definition — import it from rpc/org-scope.ts (FORBIDDEN, not UNAUTHORIZED)",
		},
	];
}

export function scanFile(path: string, source: string): TenantScopeFinding[] {
	const findings: TenantScopeFinding[] = [
		...scanForLocalRequireOrgId(path, source),
	];
	TENANT_BLOCK_RE.lastIndex = 0;
	let block: RegExpExecArray | null = TENANT_BLOCK_RE.exec(source);
	while (block !== null) {
		const [, name = "", body = ""] = block;
		const hit = analyzeHandler(body);
		if (hit) {
			findings.push({
				key: `${relative(ROUTERS_DIR, path)}::${name}`,
				file: relative(REPO_ROOT, path),
				line: source.slice(0, block.index).split("\n").length,
				call: hit.call.length > 120 ? `${hit.call.slice(0, 117)}…` : hit.call,
			});
		}
		block = TENANT_BLOCK_RE.exec(source);
	}
	return findings;
}

/**
 * Raw-D1 store code outside the routers: all of apps/mcp/src plus the
 * apps/skill-runtime storage owners approved in db-access-exceptions.json.
 * These are plain functions, not `.handler(` procedures, so the unit is a
 * top-level function and the caller-supplied ids are its `*Id` parameters.
 */
const MCP_DIR = join(REPO_ROOT, "apps/mcp/src");
const DB_ACCESS_EXCEPTIONS = join(
	REPO_ROOT,
	"scripts/db-access-exceptions.json",
);

function storeFiles(): string[] {
	const manifest = JSON.parse(
		readFileSync(DB_ACCESS_EXCEPTIONS, "utf8"),
	) as Record<string, Record<string, unknown>>;
	const skillRuntimeOwners = Object.values(manifest)
		.flatMap((section) => Object.keys(section))
		.filter((path) => path.startsWith("apps/skill-runtime/"))
		.map((path) => join(REPO_ROOT, path));
	return [...walkRouterFiles(MCP_DIR), ...new Set(skillRuntimeOwners)];
}

const FUNCTION_RE = /^(?:export )?(?:async )?function (\w+)\s*(?:<[^>]*>)?\(/gm;
const ORG_NAME_RE = /^(?:org|organization|ownerOrg|tenant)Id$/;
/** An org predicate in a drizzle where-clause, a raw SQL string, or a row compare. */
const STORE_ORG_BINDING_RE =
	/\b(?:organization_id|org_id)\s*=|eq\(\s*\w+\.(?:organizationId|orgId)\b|\.(?:organizationId|orgId)\s*(?:!==|===|!=|==)/;

/**
 * A store function that looks a row up by one of its id parameters (drizzle
 * `eq(t.col, id)` or a raw `.bind(…id…)`) with no organization predicate or
 * row-vs-org comparison anywhere in its body.
 */
export function analyzeStoreFunction(
	params: string,
	body: string,
): { call: string } | null {
	const ids = (params.match(/\b\w+\b/g) ?? []).filter(
		(name) => ID_NAME_RE.test(name) && !ORG_NAME_RE.test(name),
	);
	if (ids.length === 0 || STORE_ORG_BINDING_RE.test(body)) return null;
	const idAlt = [...new Set(ids)].join("|");
	const drizzle = new RegExp(
		`eq\\(\\s*\\w+\\.\\w+\\s*,\\s*(?:${idAlt})\\s*\\)`,
	);
	// A raw statement only looks a row up when it filters; a bare INSERT does not.
	const raw = new RegExp(`\\.bind\\([^)]*\\b(?:${idAlt})\\b[^)]*\\)`);
	const lookup =
		drizzle.exec(body) ?? (/\bWHERE\b/.test(body) ? raw.exec(body) : null);
	return lookup ? { call: lookup[0].replace(/\s+/g, " ") } : null;
}

export function scanStoreFile(
	path: string,
	source: string,
): TenantScopeFinding[] {
	const findings: TenantScopeFinding[] = [];
	for (const match of source.matchAll(FUNCTION_RE)) {
		const open = match.index + match[0].length - 1;
		const params = argsOf(source, open);
		const rest = source.slice(open);
		const end = rest.search(/^}/m);
		const body = end === -1 ? rest : rest.slice(0, end);
		const hit = analyzeStoreFunction(params, body);
		if (!hit) continue;
		const file = relative(REPO_ROOT, path);
		findings.push({
			key: `${file}::${match[1] ?? ""}`,
			file,
			line: source.slice(0, match.index).split("\n").length,
			call: hit.call.length > 120 ? `${hit.call.slice(0, 117)}…` : hit.call,
		});
	}
	return findings;
}

function collectRaw(): TenantScopeFinding[] {
	return [
		...walkRouterFiles(ROUTERS_DIR).flatMap((path) =>
			scanFile(path, readFileSync(path, "utf8")),
		),
		...storeFiles().flatMap((path) =>
			scanStoreFile(path, readFileSync(path, "utf8")),
		),
	].sort((a, b) => a.key.localeCompare(b.key));
}

function tenantScopeMain(): number {
	const argv = process.argv.slice(2);
	const strict = argv.includes("--strict");
	const rawFindings = collectRaw();
	const findings = rawFindings.filter(
		(finding) => !Object.hasOwn(REVIEWED_NON_TENANT_HANDLERS, finding.key),
	);
	const rawKeys = new Set(rawFindings.map((finding) => finding.key));
	const staleReviewed = Object.keys(REVIEWED_NON_TENANT_HANDLERS).filter(
		(key) => !rawKeys.has(key),
	);

	if (argv.includes("--report")) {
		for (const finding of findings) {
			console.log(`${finding.file}:${finding.line}  ${finding.key}`);
			console.log(`    ${finding.call}`);
		}
		console.log(
			`\ntenant-scope report: ${findings.length} finding(s), ${rawFindings.length - findings.length} exact reviewed non-tenant handler(s)`,
		);
		return 0;
	}

	const fresh = findings;

	if (!strict) {
		console.log(`tenant-scope: ${findings.length} unscoped by-id read(s)`);
		return 0;
	}

	if (fresh.length === 0 && staleReviewed.length === 0) {
		console.log(
			`tenant-scope: OK — ${Object.keys(REVIEWED_NON_TENANT_HANDLERS).length} exact reviewed non-tenant handler(s)`,
		);
		return 0;
	}

	if (fresh.length > 0) {
		console.error(
			"tenant-scope: handler resolves a record from a caller-supplied id without binding the caller's organization:",
		);
		for (const finding of fresh) {
			console.error(`- ${finding.file}:${finding.line}  ${finding.key}`);
			console.error(`    ${finding.call}`);
		}
		console.error(
			"\nBind the organization: pass it into the fetch, assert it on the result\n" +
				"(assertOwnedControlPlaneRecord(context, record, …)), or compare explicitly.\n" +
				"requireOrgId(context) alone is NOT a guard — it checks the caller, not the record.\n" +
				"If the fetch helper scopes itself, add it to SCOPED_BY_CONSTRUCTION with the reason;\n" +
				"if the resolver is truly global, use NON_TENANT_BY_CONSTRUCTION with the ownership reason.",
		);
	}
	if (staleReviewed.length > 0) {
		console.error(
			"\ntenant-scope: reviewed non-tenant handler disposition(s) no longer reproduce — remove them:",
		);
		for (const key of staleReviewed) console.error(`- ${key}`);
	}
	return 1;
}

if (import.meta.main) {
	const coverage = coverageMain();
	const tenantScope = tenantScopeMain();
	process.exit(Math.max(coverage, tenantScope));
}
