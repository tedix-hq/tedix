#!/usr/bin/env bun

/**
 * Worker HTTP-route authorization lint. Every Hono registration or `pathname`
 * dispatch branch in the apps listed in WORKER_APPS must run one of that app's
 * guard markers, or carry an inline `// authz: public <reason>` annotation.
 * Guard markers that match nothing fail as stale. `--strict` exits 1 on any
 * unguarded route, stale marker, or ingress mismatch.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import ingressPolicy from "./worker-ingress-policy.json";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Reviewed ingress intent for every deployed Worker.
 *
 * `workersDev` and `previewUrls` are the effective production values after
 * Wrangler inheritance and defaults. A policy change is therefore a security
 * review, not a mechanical config refresh.
 */

export type WorkerIngressKind =
	| "public"
	| "application-authenticated"
	| "service-binding-only";

export interface WorkerIngressPolicy {
	app: string;
	kind: WorkerIngressKind;
	workersDev: boolean;
	previewUrls: boolean;
	reason: string;
}

export const WORKER_INGRESS_POLICY =
	ingressPolicy as readonly WorkerIngressPolicy[];

export type SourceFile = {
	/** Repo-relative path. */
	path: string;
	text: string;
};

export type WorkerAppConfig = {
	/** App root, e.g. "apps/tedi" — the report grouping key. */
	app: string;
	/** Directories walked (non-test .ts) for Hono router declarations/routes. */
	honoDirs?: string[];
	/** Exact non-test files for a self-contained Hono entrypoint. */
	honoFiles?: string[];
	/** Exact files scanned for hand-written `url.pathname` dispatch branches. */
	pathnameFiles?: string[];
	/** Bounded earlier lines that may contain an app-wide guard for later branches. */
	upstreamGuardWindowLines?: number;
	/**
	 * Regex source → reason it constitutes authorization for THIS app. Every
	 * marker must still match somewhere in the app's scanned files or the lint
	 * fails it as stale.
	 */
	guards: Record<string, string>;
};

export type RouteClass = "guarded" | "public" | "unguarded";

export type RouteFinding = {
	/** `<repo-relative file>::<label>` — the finding key. */
	key: string;
	app: string;
	file: string;
	line: number;
	label: string;
	classification: RouteClass;
	/** The `// authz: public` reason, when classification is "public". */
	publicReason?: string;
};

export interface WranglerIngressConfig {
	workers_dev?: boolean;
	preview_urls?: boolean;
	env?: { production?: WranglerIngressConfig };
}

export function parseCloudflareIngressConfig(
	source: string,
): WranglerIngressConfig {
	const block = source.match(
		/export const productionIngress\s*=\s*\{([\s\S]*?)\}\s*as const/,
	)?.[1];
	if (!block) {
		throw new Error(
			"cloudflare.config.ts must export literal productionIngress metadata",
		);
	}
	const boolean = (field: "workersDev" | "previewUrls"): boolean => {
		const value = block.match(
			new RegExp(`\\b${field}\\s*:\\s*(true|false)`),
		)?.[1];
		if (value === undefined) {
			throw new Error(`productionIngress.${field} must be a boolean literal`);
		}
		return value === "true";
	};
	return {
		workers_dev: boolean("workersDev"),
		preview_urls: boolean("previewUrls"),
	};
}

export function effectiveProductionIngress(config: WranglerIngressConfig): {
	workersDev: boolean;
	previewUrls: boolean;
} {
	const production = config.env?.production;
	const workersDev = production?.workers_dev ?? config.workers_dev ?? true;
	const previewUrls =
		production?.preview_urls ?? config.preview_urls ?? workersDev;
	return { workersDev, previewUrls };
}

export function validateWorkerIngressInventory(
	policies: readonly WorkerIngressPolicy[],
	configs: ReadonlyMap<string, WranglerIngressConfig>,
): string[] {
	const errors: string[] = [];
	const policyByApp = new Map<string, WorkerIngressPolicy>();
	for (const policy of policies) {
		if (policyByApp.has(policy.app)) {
			errors.push(`duplicate ingress policy for ${policy.app}`);
			continue;
		}
		policyByApp.set(policy.app, policy);
		if (policy.reason.trim() === "") {
			errors.push(`${policy.app} ingress reason must explain the policy`);
		}
		if (
			policy.kind === "service-binding-only" &&
			(policy.workersDev || policy.previewUrls)
		) {
			errors.push(
				`${policy.app} is service-binding-only but permits public or preview ingress`,
			);
		}
	}

	for (const [app, config] of configs) {
		const policy = policyByApp.get(app);
		if (!policy) {
			errors.push(`${app} has wrangler.jsonc but no ingress policy`);
			continue;
		}
		const effective = effectiveProductionIngress(config);
		if (effective.workersDev !== policy.workersDev) {
			errors.push(
				`${app} workers_dev is ${effective.workersDev}, policy requires ${policy.workersDev}`,
			);
		}
		if (effective.previewUrls !== policy.previewUrls) {
			errors.push(
				`${app} preview_urls is ${effective.previewUrls}, policy requires ${policy.previewUrls}`,
			);
		}
	}

	for (const app of policyByApp.keys()) {
		if (!configs.has(app)) errors.push(`${app} ingress policy is stale`);
	}
	return errors.sort();
}

/**
 * The Workers this route lint covers and the auth mechanism each one actually
 * uses (read from their entrypoints, not assumed). Reasons are the review
 * record for WHY each marker counts as a guard.
 */
export const WORKER_APPS: WorkerAppConfig[] = [
	{
		app: "apps/api",
		honoFiles: ["apps/api/src/worker-app.ts"],
		guards: {
			"\\brpcHandler\\.handle\\s*\\(":
				"The oRPC transport constructs an authenticated request context and every authenticated procedure carries the two-plane authorization middleware.",
			"\\bgetOpenApiHandler\\s*\\(\\s*\\)\\.handle\\s*\\(":
				"The OpenAPI transport uses the same authenticated context and contract-first two-plane procedure middleware as RPC.",
			"\\bhandleKernel(?:Acp|WsToken|VoiceCall)\\s*\\(":
				"Kernel HTTP and WebSocket handlers validate scoped tokens or Descope sessions and organization membership before dispatch.",
			"\\bvalidateToken\\s*\\(":
				"Custom media, event-stream, and export routes validate a Descope token before resolving organization-owned data.",
			"\\bverifyMediaToken\\s*\\(":
				"Signed skill-media routes verify a bounded HMAC capability before reading the artifact.",
			"\\bverifyPortableSnapshotTicket\\s*\\(":
				"Portable snapshot routes verify a short-lived HMAC bearer bound to one organization and tedi before scoped D1 reads.",
			"\\bverifyPortableImportTicket\\s*\\(":
				"Portable import routes verify a short-lived, user-issued HMAC bearer bound to a paused destination tedi before scoped D1 writes.",
			"\\bhandleOsShare(?:Redemption|SessionRead)\\s*\\(":
				"OS share routes validate one-time or session capabilities and apply recipient authorization before returning data.",
			"\\bhandle(?:Signed|Session)Artifact\\b":
				"Artifact handlers verify a signed capability or a Descope session plus organization ownership before streaming bytes.",
			"\\bhandle(?:FirecrawlWebhook|DescopeAuditWebhook|StripeWebhook|ChannelIngress)\\s*\\(":
				"External callback handlers verify their provider signature or timestamp-bound channel HMAC before accepting work.",
		},
	},
	{
		app: "apps/cms",
		honoFiles: ["apps/cms/src/index.ts"],
		guards: {
			"\\bhandleMcpRequest\\s*\\(":
				"CMS MCP dispatch authenticates the caller and authorizes the selected organization before constructing tools.",
			"\\bauthenticateRequest\\s*\\(":
				"CMS job and preview routes validate a Descope user or internal credential before organization authorization.",
		},
	},
	{
		app: "apps/docs",
		honoFiles: ["apps/docs/src/index.ts"],
		guards: {
			"\\bhandleMcp\\s*\\(":
				"Docs MCP dispatch calls authorizeDocsRequest before constructing any organization-scoped server.",
			"\\bhandlePreview\\s*\\(":
				"Docs preview dispatch requires scoped preview access or an authorized Docs principal before serving a build.",
		},
	},
	{
		app: "apps/mcp",
		honoDirs: ["apps/mcp/src"],
		pathnameFiles: ["apps/mcp/src/index.ts"],
		upstreamGuardWindowLines: 220,
		guards: {
			"\\benforceMcpAccess\\s*\\(":
				"The MCP access gate: resolves the caller principal and enforces app auth mode, tool scopes, and policies before any MCP dispatch.",
			"\\bhandleExternalAgentSessionExchange\\s*\\(":
				"Self-authenticating credential exchange: rejects anything without an sk_ API key up front and forwards that exact key to apps/api for verification.",
			"\\bhandleInternalSubscriptionPublish\\s*\\(":
				"Self-guarding internal fanout: its first statement rejects every caller that is not an apps/api service binding.",
			"\\bisServiceBinding\\s*\\(":
				"Internal-only routes (__internal/*) accept exclusively Cloudflare service-binding calls from apps/api.",
		},
	},
	{
		app: "apps/os",
		pathnameFiles: [
			"apps/os/src/worker.ts",
			"apps/os/src/auth/session-broker.ts",
		],
		guards: {
			"\\bauthenticateWidgetBridge\\s*\\(":
				"Verifies the host-only broker session JWT and binds it to the host tenant before the widget bridge forwards anything.",
			"\\brefuse\\(\\s*401\\b|\\brefuseApi\\(\\s*url,\\s*401\\b":
				"An explicit 401 refusal in the branch: the route rejects callers that failed the session checks computed above it.",
			"\\bwithBrokerApiSession\\s*\\(":
				"Requires the product broker session cookie (or the one documented bootstrap bearer) before proxying to apps/api, which re-derives all authority.",
			"\\bwithCollabSession\\s*\\(":
				"Requires broker cookie, bearer, or API key for the collab upgrade; the workspace read through apps/api then authorizes the caller per connection.",
		},
	},
	{
		app: "apps/session-broker",
		pathnameFiles: ["apps/session-broker/src/index.ts"],
		guards: {},
	},
	{
		app: "apps/skill-runtime",
		honoDirs: ["apps/skill-runtime/src"],
		guards: {
			"\\bisAuthenticated\\s*\\(":
				"App-wide gate: every route requires an apps/api service binding or the PLATFORM_SERVICE_TOKEN bearer (src/auth.ts).",
		},
	},
	{
		app: "apps/tedi",
		honoDirs: ["apps/tedi/src"],
		guards: {
			"\\bisServiceBinding\\s*\\(":
				"Admin/workstation routes accept exclusively Cloudflare service-binding calls from apps/api (routes/admin/index.ts middleware).",
		},
	},
	{
		app: "apps/artifact-gateway",
		pathnameFiles: ["apps/artifact-gateway/src/index.ts"],
		guards: {},
	},
	{
		app: "apps/cms-runtime",
		pathnameFiles: ["apps/cms-runtime/src/index.ts"],
		guards: {
			"\\bisInternalCmsRequest\\s*\\(":
				"Database, storage, and media admin paths require the CMS_INTERNAL_AUTH_TOKEN bearer before touching tenant storage.",
		},
	},
	{
		app: "apps/docs-runtime",
		pathnameFiles: ["apps/docs-runtime/src/index.ts"],
		guards: {},
	},
	{
		app: "apps/tedi-runtime",
		pathnameFiles: ["apps/tedi-runtime/src/index.ts"],
		guards: {
			"\\bisServiceBinding\\s*\\(":
				"Hook and admin routes accept exclusively service-binding calls from apps/tedi or apps/api.",
			"\\bcreateEmbeddedCapabilityAdapter\\s*\\(":
				"The embedded Cap'n Web mount authenticates every capability token against the origin and tedi before any conversation access.",
		},
	},
	{
		app: "apps/tedi-workstation-egress-broker",
		pathnameFiles: ["apps/tedi-workstation-egress-broker/src/index.ts"],
		guards: {},
	},
	{
		app: "apps/tedi-workstation-runtime",
		pathnameFiles: ["apps/tedi-workstation-runtime/src/index.ts"],
		guards: {},
	},
	{
		app: "apps/widget",
		pathnameFiles: ["apps/widget/src/index.ts"],
		guards: {},
	},
];

/** `// authz: public <reason>` — the reason is mandatory. */
const PUBLIC_ANNOTATION_RE = /\/\/\s*authz:\s*public\b[\s—:–-]*(.*)$/;
/** How many lines above a registration the annotation may sit. */
const ANNOTATION_WINDOW_LINES = 6;

const HONO_DECLARATION_RE =
	/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)(?::[^=]+)?\s*=\s*new\s+Hono\b/g;
const HONO_METHODS = new Set([
	"all",
	"delete",
	"get",
	"on",
	"options",
	"patch",
	"post",
	"put",
	"route",
	"use",
]);
const HONO_CALL_RE =
	/\b([A-Za-z_$][\w$]*)\.(all|delete|get|on|options|patch|post|put|route|use)\(/g;

const PATHNAME_ROUTE_RE =
	/\bpathname\s*(===|!==)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Z][A-Z0-9_]*)|\bpathname\.(startsWith|endsWith)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Z][A-Z0-9_]*)/g;

/** A true assignment `=`, excluding ==/===/!=/<=/>=/=>/+= etc. */
const ASSIGNMENT_RE = /(?<![=!<>+\-*/&|^%])=(?![=>])/;

function isTestFile(path: string): boolean {
	return /\.(?:test|spec)\.ts$|\.d\.ts$/.test(path);
}

function walkTs(absDir: string): string[] {
	if (!existsSync(absDir)) return [];
	return readdirSync(absDir).flatMap((entry) => {
		const full = join(absDir, entry);
		if (statSync(full).isDirectory()) return walkTs(full);
		return full.endsWith(".ts") && !isTestFile(full) ? [full] : [];
	});
}

function lineOf(text: string, index: number): number {
	return text.slice(0, index).split("\n").length;
}

/** Balanced-paren call text starting at the `(` at `open`. */
function callText(source: string, open: number): string {
	let depth = 0;
	const cap = Math.min(source.length, open + 40_000);
	for (let i = open; i < cap; i += 1) {
		const ch = source[i];
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	return source.slice(open + 1, cap);
}

/**
 * The annotation lookup: the registration's own line plus a few lines above
 * it. Returns the reason, or null when there is no (valid) annotation.
 */
function publicAnnotation(
	lines: readonly string[],
	registrationLine: number,
): string | null {
	const zero = registrationLine - 1;
	for (let i = zero; i >= Math.max(0, zero - ANNOTATION_WINDOW_LINES); i -= 1) {
		const match = lines[i]?.match(PUBLIC_ANNOTATION_RE);
		if (!match) continue;
		const reason = (match[1] ?? "").trim();
		return reason === "" ? null : reason;
	}
	return null;
}

/**
 * Is this pathname comparison a dispatch condition? Walk back to the previous
 * statement boundary: dispatch sits inside an `if`/`while` head with no
 * intervening `return` (predicate helper) and no assignment (`const isX = …`).
 */
function isDispatchCondition(text: string, matchIndex: number): boolean {
	let start = matchIndex - 1;
	while (start >= 0) {
		const ch = text[start] ?? "";
		if (ch === "{" || ch === "}" || ch === ";") break;
		start -= 1;
	}
	const slice = text.slice(start + 1, matchIndex);
	if (/\breturn\b/.test(slice)) return false;
	if (ASSIGNMENT_RE.test(slice)) return false;
	return /\b(?:if|while)\s*\(/.test(slice);
}

/**
 * Guard-evidence window for a pathname branch: from the comparison to the end
 * of the balanced block that follows its condition, capped so a runaway brace
 * imbalance cannot swallow the file.
 */
function guardWindow(text: string, matchIndex: number): string {
	const open = text.indexOf("{", matchIndex);
	if (open === -1 || open > matchIndex + 800) {
		// Single-statement branch (`if (…) return handler(…);`): next 12 lines.
		let end = matchIndex;
		for (let i = 0; i < 12 && end !== -1; i += 1) {
			end = text.indexOf("\n", end + 1);
		}
		return text.slice(matchIndex, end === -1 ? text.length : end);
	}
	let depth = 0;
	const cap = Math.min(text.length, open + 24_000);
	let i = open;
	for (; i < cap; i += 1) {
		const ch = text[i];
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	return text.slice(matchIndex, Math.min(i + 1, cap));
}

function guardPreludeWindow(
	text: string,
	matchIndex: number,
	lineCount: number,
): string {
	let start = matchIndex;
	for (let i = 0; i < lineCount && start > 0; i += 1) {
		start = Math.max(0, text.lastIndexOf("\n", start - 1));
	}
	return text.slice(start, matchIndex);
}

function stripQuotes(raw: string): string {
	if (/^["'`]/.test(raw)) return raw.slice(1, -1);
	return raw;
}

type HonoRegistration = {
	router: string;
	method: string;
	call: string;
	file: string;
	line: number;
};

function honoRoute(
	call: string,
	registrationMethod: string,
): {
	method: string;
	path: string;
} | null {
	if (registrationMethod === "on") {
		const match = call.match(
			/^\s*(?:"([^"]*)"|'([^']*)')\s*,\s*(?:"([^"]*)"|'([^']*)')/,
		);
		const method = match?.[1] ?? match?.[2];
		const path = match?.[3] ?? match?.[4];
		return method !== undefined && path !== undefined ? { method, path } : null;
	}
	const match = call.match(/^\s*(?:"([^"]*)"|'([^']*)')/);
	const path = match?.[1] ?? match?.[2];
	return path === undefined
		? null
		: { method: registrationMethod.toUpperCase(), path };
}

export function analyzeWorkerRoutes(
	config: WorkerAppConfig,
	files: SourceFile[],
): { routes: RouteFinding[]; staleGuards: string[] } {
	const guardRes = Object.keys(config.guards).map(
		(source) => new RegExp(source),
	);
	const matchesGuard = (text: string): boolean =>
		guardRes.some((re) => re.test(text));

	const routes: RouteFinding[] = [];
	const honoFiles = files.filter((file) => !isTestFile(file.path));

	// ---- Hono model -----------------------------------------------------------
	const routerFiles = new Map<string, string>();
	for (const file of honoFiles) {
		for (const match of file.text.matchAll(HONO_DECLARATION_RE)) {
			const name = match[1];
			if (name) routerFiles.set(name, file.path);
		}
	}

	const guardedRouters = new Set<string>();
	const mounts: Array<{ parent: string; child: string }> = [];
	const registrations: HonoRegistration[] = [];

	for (const file of honoFiles) {
		for (const match of file.text.matchAll(HONO_CALL_RE)) {
			const [, router = "", method = ""] = match;
			if (!routerFiles.has(router) || !HONO_METHODS.has(method)) continue;
			const open = match.index + match[0].length - 1;
			const call = callText(file.text, open);
			if (method === "use") {
				if (matchesGuard(call)) guardedRouters.add(router);
				continue;
			}
			if (method === "route") {
				const mount = call.match(
					/^\s*(?:"[^"]*"|'[^']*')\s*,\s*([A-Za-z_$][\w$]*)\s*$/,
				);
				if (mount?.[1]) mounts.push({ parent: router, child: mount[1] });
				continue;
			}
			if (honoRoute(call, method) === null) continue;
			registrations.push({
				router,
				method,
				call,
				file: file.path,
				line: lineOf(file.text, match.index),
			});
		}
	}

	// Mount fixpoint: a child of a guarded router is guarded (transitively).
	let grew = true;
	while (grew) {
		grew = false;
		for (const { parent, child } of mounts) {
			if (guardedRouters.has(parent) && !guardedRouters.has(child)) {
				guardedRouters.add(child);
				grew = true;
			}
		}
	}

	const textByPath = new Map(files.map((file) => [file.path, file.text]));
	for (const registration of registrations) {
		const text = textByPath.get(registration.file) ?? "";
		const lines = text.split("\n");
		const route = honoRoute(registration.call, registration.method);
		if (!route) continue;
		const label = `${route.method.toUpperCase()} ${route.path}`;
		const reason = publicAnnotation(lines, registration.line);
		const guarded =
			guardedRouters.has(registration.router) ||
			matchesGuard(registration.call);
		routes.push({
			key: `${registration.file}::${label}`,
			app: config.app,
			file: registration.file,
			line: registration.line,
			label,
			classification:
				reason !== null ? "public" : guarded ? "guarded" : "unguarded",
			...(reason !== null ? { publicReason: reason } : {}),
		});
	}

	// ---- Pathname-branch model ------------------------------------------------
	for (const relPath of config.pathnameFiles ?? []) {
		const text = textByPath.get(relPath);
		if (text === undefined) continue;
		const lines = text.split("\n");
		type Occurrence = { line: number; guarded: boolean; reason: string | null };
		const byLabel = new Map<string, Occurrence[]>();
		for (const match of text.matchAll(PATHNAME_ROUTE_RE)) {
			if (!isDispatchCondition(text, match.index)) continue;
			const comparator = match[3] ?? "";
			const rawTarget = match[2] ?? match[4] ?? "";
			const target = stripQuotes(rawTarget);
			const label =
				comparator === "startsWith"
					? `match ${target}*`
					: comparator === "endsWith"
						? `match *${target}`
						: `match ${target}`;
			const line = lineOf(text, match.index);
			const occurrences = byLabel.get(label) ?? [];
			occurrences.push({
				line,
				guarded:
					matchesGuard(guardWindow(text, match.index)) ||
					(config.upstreamGuardWindowLines !== undefined &&
						matchesGuard(
							guardPreludeWindow(
								text,
								match.index,
								config.upstreamGuardWindowLines,
							),
						)),
				reason: publicAnnotation(lines, line),
			});
			byLabel.set(label, occurrences);
		}
		for (const [label, occurrences] of byLabel) {
			const first = occurrences[0];
			if (!first) continue;
			const reason =
				occurrences.find((occurrence) => occurrence.reason !== null)?.reason ??
				null;
			const guarded = occurrences.some((occurrence) => occurrence.guarded);
			routes.push({
				key: `${relPath}::${label}`,
				app: config.app,
				file: relPath,
				line: first.line,
				label,
				classification:
					reason !== null ? "public" : guarded ? "guarded" : "unguarded",
				...(reason !== null ? { publicReason: reason } : {}),
			});
		}
	}

	// ---- Stale guard markers --------------------------------------------------
	const corpus = files.map((file) => file.text).join("\n");
	const staleGuards = Object.keys(config.guards).filter(
		(source) => !new RegExp(source).test(corpus),
	);

	routes.sort((a, b) => a.key.localeCompare(b.key));
	return { routes, staleGuards };
}

function loadAppFiles(config: WorkerAppConfig): SourceFile[] {
	const paths = new Set<string>();
	for (const dir of config.honoDirs ?? []) {
		for (const abs of walkTs(join(REPO_ROOT, dir))) {
			paths.add(relative(REPO_ROOT, abs));
		}
	}
	for (const file of config.honoFiles ?? []) paths.add(file);
	for (const file of config.pathnameFiles ?? []) paths.add(file);
	return [...paths].sort().flatMap((path) => {
		const abs = join(REPO_ROOT, path);
		if (!existsSync(abs) || !statSync(abs).isFile()) return [];
		return [{ path, text: readFileSync(abs, "utf8") }];
	});
}

export function collectAll(): {
	routes: RouteFinding[];
	staleGuards: Array<{ app: string; marker: string }>;
	ingressErrors: string[];
} {
	const routes: RouteFinding[] = [];
	const staleGuards: Array<{ app: string; marker: string }> = [];
	for (const config of WORKER_APPS) {
		const result = analyzeWorkerRoutes(config, loadAppFiles(config));
		routes.push(...result.routes);
		for (const marker of result.staleGuards) {
			staleGuards.push({ app: config.app, marker });
		}
	}
	routes.sort((a, b) => a.key.localeCompare(b.key));
	const ingressConfigs = new Map<string, WranglerIngressConfig>();
	for (const entry of readdirSync(join(REPO_ROOT, "apps"))) {
		const app = `apps/${entry}`;
		const configPath = join(REPO_ROOT, app, "wrangler.jsonc");
		if (existsSync(configPath)) {
			ingressConfigs.set(
				app,
				parseJsonc(readFileSync(configPath, "utf8")) as WranglerIngressConfig,
			);
			continue;
		}
		const cfConfigPath = join(REPO_ROOT, app, "cloudflare.config.ts");
		if (existsSync(cfConfigPath)) {
			ingressConfigs.set(
				app,
				parseCloudflareIngressConfig(readFileSync(cfConfigPath, "utf8")),
			);
		}
	}
	const ingressErrors = validateWorkerIngressInventory(
		WORKER_INGRESS_POLICY,
		ingressConfigs,
	);
	return { routes, staleGuards, ingressErrors };
}

function appSummary(routes: RouteFinding[]): string {
	const byApp = new Map<string, { g: number; p: number; u: number }>();
	for (const route of routes) {
		const counts = byApp.get(route.app) ?? { g: 0, p: 0, u: 0 };
		if (route.classification === "guarded") counts.g += 1;
		else if (route.classification === "public") counts.p += 1;
		else counts.u += 1;
		byApp.set(route.app, counts);
	}
	return [...byApp.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(
			([app, counts]) =>
				`${app} ${counts.g + counts.p + counts.u} route(s): ${counts.g} guarded, ${counts.p} public, ${counts.u} unguarded`,
		)
		.join("; ");
}

function main(): void {
	const strict = process.argv.includes("--strict");
	const report = process.argv.includes("--report");
	const { routes, staleGuards, ingressErrors } = collectAll();
	const unguarded = routes.filter(
		(route) => route.classification === "unguarded",
	);

	if (report) {
		console.log(
			`worker ingress policy: ${WORKER_INGRESS_POLICY.length} deployed Worker(s), ${ingressErrors.length} error(s)`,
		);
		let currentApp = "";
		for (const route of routes) {
			if (route.app !== currentApp) {
				currentApp = route.app;
				console.log(`\n${currentApp}`);
			}
			const suffix =
				route.classification === "public"
					? `  (public: ${route.publicReason ?? ""})`
					: "";
			console.log(
				`  ${route.classification.padEnd(9)} ${route.file}:${route.line}  ${route.label}${suffix}`,
			);
		}
		console.log(`\nworker-route-authz report: ${appSummary(routes)}`);
		process.exit(0);
	}

	const regressions = unguarded;
	if (
		regressions.length === 0 &&
		staleGuards.length === 0 &&
		ingressErrors.length === 0
	) {
		console.log(`worker-route-authz: OK — ${appSummary(routes)}`);
		process.exit(0);
	}

	const label = strict ? "FAIL" : "WARN";

	if (regressions.length > 0) {
		console.error(
			`${label} worker-route-authz: ${regressions.length} route(s) show no auth guard. Guard the route with the app's auth mechanism, or annotate a deliberately-public route with \`// authz: public <reason>\`:`,
		);
		for (const route of regressions) {
			console.error(`  ${route.file}:${route.line}  ${route.label}`);
		}
	}

	if (staleGuards.length > 0) {
		console.error(
			`${label} worker-route-authz guard marker(s) no longer match anything — remove the marker or restore the guard it named:`,
		);
		for (const { app, marker } of staleGuards) {
			console.error(`  ${app}: /${marker}/`);
		}
	}

	if (ingressErrors.length > 0) {
		console.error(
			`${label} worker ingress policy does not match the deployed Wrangler inventory:`,
		);
		for (const error of ingressErrors) console.error(`  ${error}`);
	}

	process.exit(strict ? 1 : 0);
}

if (import.meta.main) {
	main();
}
