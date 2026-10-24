#!/usr/bin/env bun
/**
 * Post-deploy smoke check for Tedix Cloud.
 *
 * A deploy is verified when every surface reports the target commit. That does
 * not prove the paths behind `tedix work` still answer: a catalog schema change
 * once left every surface on the right commit while each Work command failed.
 * This check runs those paths read-only, right after a deploy:
 *
 *   1. each `--health` URL answers 200 with `status: "ok"`;
 *   2. get_info reports the expected organization and a usable native catalog;
 *   3. native catalog search and describe both resolve the Work list tool;
 *   4. a one-row Work list runs through the CLI's own native resolution;
 *   5. Code Mode `discover.search` returns tools.
 *
 * Credential: in GitHub Actions (`id-token: write`), the job's OIDC assertion
 * is exchanged at the gateway's `POST /external-agents/session` for a
 * short-lived MCP credential of a read-only external-agent principal bound to
 * the job's exact `repo:` subject (docs/engineering/platform/auth.md, workload
 * identity). Repositories with immutable subject claims (GitHub's default for
 * repositories created after 15 July 2026) send
 * `repo:<owner>@<owner_id>/<repo>@<repo_id>:environment:<name>`; read the prefix
 * from `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`. Elsewhere, TEDIX_MCP_BEARER_TOKEN may carry a credential issued
 * for `--mcp-url`. Connect serves only human multi-organization logins, so a
 * non-human check targets the organization gateway that Connect routes to.
 *
 * Usage:
 *   bun scripts/release/postdeploy-smoke.ts --health <url> [--health <url>]... \
 *     [--mcp-url <gateway>/mcp --organization <uuid> [--principal <uuid>]] \
 *     [--session-key <harness:id>] [--report <file>]
 *
 * Without --mcp-url only the health checks run. Exits 1 when a check fails.
 */

import { writeFileSync } from "node:fs";
import { McpNativeBootstrapSchema } from "../../packages/api-contract/src/schemas/mcp-native-transport.ts";

/** Must equal TEDIX_EXTERNAL_AGENT_WORKLOAD_AUDIENCE in @tedix/auth (tested). */
export const WORKLOAD_AUDIENCE =
	"https://api.tedix.dev/external-agent/session-exchange";
export const WORK_LIST_CALLABLE = "work.list_work_item_cli_rows";
export const SMOKE_SCOPES = ["mcp:work.read", "mcp:observe.read"];
const DEFAULT_SESSION_KEY = "github-actions:tedix-postdeploy-smoke";
const CALL_TIMEOUT_MS = 30_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SmokeClient {
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
	runCode(source: string): Promise<unknown>;
	/** One-row Work list through the CLI's native resolution path. */
	listWork(): Promise<unknown>;
}

export interface CheckResult {
	name: string;
	ok: boolean;
	ms: number;
	detail: string;
	failureClass: "product" | "infra" | null;
}

export interface SmokeOptions {
	health: string[];
	expectedShas?: Record<string, string>;
	shaFields?: Record<string, string>;
	mcpUrl?: string;
	organization?: string;
	principal?: string;
	sessionKey: string;
	report?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.replace(/\s+/g, " ").slice(0, 500);
}

/** Transport and credential failures cannot justify reverting product code. */
export function failureClass(
	error: unknown,
	checkName = "",
): "product" | "infra" {
	const text = [
		message(error),
		isRecord(error) ? String(error.code ?? "") : "",
		isRecord(error) && error.cause ? message(error.cause) : "",
	].join(" ");
	// Durations, ports and record ids are not HTTP status evidence.
	const status = Number(
		(isRecord(error) ? (error.status ?? error.statusCode) : undefined) ??
			text.match(/\b(?:HTTP|status(?: code)?)\s*[:=]?\s*([45]\d{2})\b/i)?.[1],
	);
	if (
		[401, 403, 429].includes(status) ||
		/unauthorized|forbidden|too many requests/i.test(text)
	)
		return "infra";
	if (status >= 500 && status < 600) return "product";
	if (
		/timeout|timed out|abort|fetch failed|failed to fetch|unable to connect|connection|network|DNS|TLS|certificate|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|EHOST|ENET|EPIPE|CERT_|socket/i.test(
			text,
		)
	)
		return "infra";
	return checkName === "workload credential" ? "infra" : "product";
}

export function parseArgs(argv: string[]): SmokeOptions {
	const options: SmokeOptions = {
		health: [],
		sessionKey: DEFAULT_SESSION_KEY,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--"))
			throw new Error(`${flag} needs a value`);
		i++;
		if (flag === "--health") options.health.push(value);
		else if (flag === "--mcp-url") options.mcpUrl = value;
		else if (flag === "--organization") options.organization = value;
		else if (flag === "--principal") options.principal = value;
		else if (flag === "--session-key") options.sessionKey = value;
		else if (flag === "--report") options.report = value;
		else if (flag === "--health-sha") {
			const match = value.match(/^(https?:\/\/.+)=(\w{40})$/);
			if (!match || !/^[a-f0-9]{40}$/.test(match[2]!))
				throw new Error("--health-sha needs URL=full-sha");
			(options.expectedShas ??= {})[match[1]!] = match[2]!;
		} else if (flag === "--health-sha-field") {
			const match = value.match(/^(https?:\/\/.+)=([a-zA-Z][a-zA-Z0-9]*)$/);
			if (!match) throw new Error("--health-sha-field needs URL=field");
			(options.shaFields ??= {})[match[1]!] = match[2]!;
		} else throw new Error(`Unknown option ${flag}`);
	}
	if (options.mcpUrl && !options.organization)
		throw new Error("--mcp-url needs --organization");
	if (!options.health.length && !options.mcpUrl)
		throw new Error("Nothing to check: pass --health and/or --mcp-url");
	for (const [flag, entries] of [
		["--health-sha", options.expectedShas],
		["--health-sha-field", options.shaFields],
	] as const) {
		for (const url of Object.keys(entries ?? {})) {
			if (!options.health.includes(url))
				throw new Error(`${flag} URL is not in --health: ${url}`);
		}
	}
	return options;
}

/** A healthy surface answers 200 and, when it reports a status, "ok". */
export function healthProblem(
	status: number,
	body: string,
	expectedSha?: string,
	shaField = "deployedSha",
): string | null {
	if (status !== 200) return `HTTP ${status}`;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return expectedSha ? "health SHA is missing" : null;
	}
	if (isRecord(parsed) && "status" in parsed && parsed.status !== "ok")
		return `status ${JSON.stringify(parsed.status)}`;
	if (expectedSha && (!isRecord(parsed) || parsed[shaField] !== expectedSha))
		return `health SHA mismatch: expected ${expectedSha}, got ${isRecord(parsed) ? parsed[shaField] : "missing"}`;
	return null;
}

/** get_info must name the organization and expose a usable native catalog. */
export function checkBootstrap(info: unknown, organizationId: string) {
	if (!isRecord(info))
		throw new Error("get_info returned no structured result");
	const bootstrap = McpNativeBootstrapSchema.parse({
		nativeContext: info.nativeContext,
		nativeCatalog: info.nativeCatalog,
	});
	if (!bootstrap.nativeContext) throw new Error("nativeContext is missing");
	if (bootstrap.nativeContext.organizationId !== organizationId)
		throw new Error(
			`nativeContext is for organization ${bootstrap.nativeContext.organizationId}, expected ${organizationId}`,
		);
	const { status, search, describe } = bootstrap.nativeCatalog;
	if (status !== "usable" || !search || !describe)
		throw new Error(`nativeCatalog is ${status}`);
	if (search.endpoint !== "catalog/search")
		throw new Error(`search descriptor endpoint is ${search.endpoint}`);
	if (describe.endpoint !== "catalog/describe")
		throw new Error(`describe descriptor endpoint is ${describe.endpoint}`);
	for (const descriptor of [search, describe]) {
		const freshness = descriptor.schemaFreshness;
		if (
			!freshness.source ||
			!freshness.sourceRef ||
			!freshness.sourceHash ||
			!freshness.syncedAt
		)
			throw new Error(`${descriptor.name} has no schema provenance`);
	}
	return { search: search.name, describe: describe.name };
}

/** Search must return exactly one authorized, canonical row for the callable. */
export function checkSearchResult(result: unknown, callable: string) {
	if (!isRecord(result) || !Array.isArray(result.results))
		throw new Error("catalog search returned no results array");
	const rows = result.results.filter(
		(row) => isRecord(row) && row.callable === callable,
	);
	if (rows.length !== 1)
		throw new Error(`catalog search found ${rows.length} rows for ${callable}`);
	const row = rows[0] as Record<string, unknown>;
	if (row.authorized !== true || row.aliasOf)
		throw new Error(`${callable} is not an authorized canonical row`);
	if (!isRecord(row.native) || typeof row.native.name !== "string")
		throw new Error(`${callable} has no native descriptor`);
	return row.native.name;
}

/** Describe must agree with search and return the input schema. */
export function checkDescribeResult(
	result: unknown,
	callable: string,
	nativeName: string,
) {
	if (!isRecord(result)) throw new Error("catalog describe returned nothing");
	if (result.callable !== callable)
		throw new Error(`catalog describe answered for ${String(result.callable)}`);
	if (result.authorized !== true || result.aliasOf)
		throw new Error(`${callable} is not authorized in describe`);
	if (!isRecord(result.native) || result.native.name !== nativeName)
		throw new Error("describe and search disagree on the native tool");
	if (!isRecord(result.parameters))
		throw new Error("describe returned no input schema");
}

export function checkWorkList(value: unknown) {
	if (
		!isRecord(value) ||
		!Array.isArray(value.data) ||
		!isRecord(value.pagination) ||
		typeof value.pagination.total !== "number"
	)
		throw new Error("Work list returned an unexpected shape");
	return `${value.data.length} row(s) of ${value.pagination.total}`;
}

export function checkDiscover(value: unknown) {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error("discover.search returned no tools");
	return `${value.length} tool(s)`;
}

async function timed(
	name: string,
	run: () => Promise<string>,
): Promise<CheckResult> {
	const started = Date.now();
	try {
		const detail = await run();
		return {
			name,
			ok: true,
			ms: Date.now() - started,
			detail,
			failureClass: null,
		};
	} catch (error) {
		return {
			name,
			ok: false,
			ms: Date.now() - started,
			detail: message(error),
			failureClass: failureClass(error, name),
		};
	}
}

export async function checkHealth(
	urls: string[],
	fetchFn: FetchLike = fetch,
	expectedShas: Record<string, string> = {},
	shaFields: Record<string, string> = {},
): Promise<CheckResult[]> {
	return Promise.all(
		urls.map((url) =>
			timed(`health ${url}`, async () => {
				const response = await fetchFn(url, {
					redirect: "manual",
					headers: { "cache-control": "no-store" },
					signal: AbortSignal.timeout(15_000),
				});
				const problem = healthProblem(
					response.status,
					await response.text(),
					expectedShas[url],
					shaFields[url],
				);
				if (problem) throw new Error(problem);
				return "ok";
			}),
		),
	);
}

/** Read-only gateway checks; a failed bootstrap skips the checks that need it. */
export async function checkGateway(
	client: SmokeClient,
	organizationId: string,
): Promise<CheckResult[]> {
	let catalog: { search: string; describe: string } | undefined;
	const results = [
		await timed("get_info native bootstrap", async () => {
			catalog = checkBootstrap(
				await client.callTool("get_info", {}),
				organizationId,
			);
			return `search=${catalog.search} describe=${catalog.describe}`;
		}),
	];
	if (catalog) {
		const { search, describe } = catalog;
		const dot = WORK_LIST_CALLABLE.indexOf(".");
		let nativeName = "";
		results.push(
			await timed("native catalog search", async () => {
				nativeName = checkSearchResult(
					await client.callTool(search, {
						query: WORK_LIST_CALLABLE.slice(dot + 1),
						namespace: WORK_LIST_CALLABLE.slice(0, dot),
						limit: 100,
						includeOutputSchema: true,
					}),
					WORK_LIST_CALLABLE,
				);
				return nativeName;
			}),
		);
		if (nativeName)
			results.push(
				await timed("native catalog describe", async () => {
					checkDescribeResult(
						await client.callTool(describe, { callable: WORK_LIST_CALLABLE }),
						WORK_LIST_CALLABLE,
						nativeName,
					);
					return "ok";
				}),
			);
	}
	results.push(
		await timed("work list", async () =>
			checkWorkList(await client.listWork()),
		),
		await timed("code mode discover.search", async () =>
			checkDiscover(
				await client.runCode(
					'async () => await discover.search({ query: "list work items", limit: 5 })',
				),
			),
		),
	);
	return results;
}

/** The job's OIDC assertion for the Tedix workload exchange audience. */
export async function githubWorkloadAssertion(
	env: Record<string, string | undefined>,
	fetchFn: FetchLike = fetch,
): Promise<string> {
	if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
		throw new Error(
			"No GitHub Actions OIDC token: the job needs `permissions: id-token: write`",
		);
	const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
	url.searchParams.set("audience", WORKLOAD_AUDIENCE);
	const response = await fetchFn(url, {
		headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	const body = (await response.json().catch(() => null)) as {
		value?: unknown;
	} | null;
	if (!response.ok || typeof body?.value !== "string")
		throw new Error(
			`GitHub OIDC token request failed: HTTP ${response.status}`,
		);
	return body.value;
}

export function sessionExchangeBody(options: {
	organizationId: string;
	principalId: string;
	sessionKey: string;
	mcpUrl: string;
}) {
	// Reopening the same session must repeat the same immutable tuple.
	return {
		organizationId: options.organizationId,
		principalId: options.principalId,
		externalSessionKey: options.sessionKey,
		harness: "github-actions",
		harnessVersion: "postdeploy-smoke-1",
		modelProvider: "none",
		modelId: "none",
		modelVersion: "none",
		metadata: { source: "postdeploy-smoke" },
		scopes: SMOKE_SCOPES,
		mcpServerUrl: options.mcpUrl,
		clientName: "tedix postdeploy smoke",
	};
}

/** Exchange the workload assertion for a short-lived gateway credential. */
export async function exchangeWorkloadCredential(
	assertion: string,
	body: ReturnType<typeof sessionExchangeBody>,
	fetchFn: FetchLike = fetch,
): Promise<string> {
	const response = await fetchFn(
		new URL("/external-agents/session", body.mcpServerUrl),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${assertion}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		},
	);
	const payload = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	const token = isRecord(payload?.credential)
		? payload.credential.accessToken
		: undefined;
	if (!response.ok || typeof token !== "string") {
		const code =
			typeof payload?.code === "string"
				? payload.code
				: typeof payload?.error === "string"
					? payload.error
					: "no credential";
		throw new Error(
			`Workload credential exchange failed: HTTP ${response.status} (${code})`,
		);
	}
	return token;
}

async function gatewayClient(
	mcpUrl: string,
	organizationId: string,
	token: string,
): Promise<SmokeClient & { close(): Promise<void> }> {
	const { TedixHomeClient } =
		await import("../../packages/cli/src/home-client.ts");
	const { callConfiguredNativeTool } =
		await import("../../packages/cli/src/work-native.ts");
	const client = new TedixHomeClient({
		url: mcpUrl,
		headers: { Authorization: `Bearer ${token}` },
		timeoutMs: CALL_TIMEOUT_MS,
	});
	return {
		callTool: (name, args) => client.callTool(name, args),
		runCode: (source) => client.runCode(source),
		listWork: () =>
			callConfiguredNativeTool(
				{
					client,
					mcpUrl,
					organizationId,
					workspace: "postdeploy-smoke",
				},
				WORK_LIST_CALLABLE,
				{ limit: 1, view: "board" },
			),
		close: () => client.close(),
	};
}

export async function runSmoke(
	options: SmokeOptions,
	env: Record<string, string | undefined> = process.env,
): Promise<CheckResult[]> {
	const results = await checkHealth(
		options.health,
		fetch,
		options.expectedShas,
		options.shaFields,
	);
	if (!options.mcpUrl || !options.organization) return results;
	const mcpUrl = options.mcpUrl;
	const organization = options.organization;
	let token = env.TEDIX_MCP_BEARER_TOKEN?.trim();
	const credential = await timed("workload credential", async () => {
		if (token) return "TEDIX_MCP_BEARER_TOKEN";
		if (!options.principal)
			throw new Error("--principal is required for the workload exchange");
		const assertion = await githubWorkloadAssertion(env);
		if (env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${assertion}`);
		token = await exchangeWorkloadCredential(
			assertion,
			sessionExchangeBody({
				organizationId: organization,
				principalId: options.principal,
				sessionKey: options.sessionKey,
				mcpUrl,
			}),
		);
		if (env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${token}`);
		return "exchanged";
	});
	results.push(credential);
	if (!credential.ok || !token) return results;
	const client = await gatewayClient(mcpUrl, organization, token);
	try {
		results.push(...(await checkGateway(client, organization)));
	} finally {
		await client.close().catch(() => undefined);
	}
	return results;
}

if (import.meta.main) {
	const options = parseArgs(process.argv.slice(2));
	const results = await runSmoke(options);
	const ok = results.every((result) => result.ok);
	for (const result of results)
		console.log(
			`${result.ok ? "ok  " : "FAIL"} ${result.name} (${result.ms} ms): ${result.detail}`,
		);
	if (process.env.GITHUB_ACTIONS === "true")
		for (const result of results.filter((r) => !r.ok))
			console.log(
				`::error title=Post-deploy smoke failed: ${result.name}::${result.detail}`,
			);
	if (options.report)
		writeFileSync(
			options.report,
			`${JSON.stringify({ ok, checkedAt: new Date().toISOString(), results }, null, 2)}\n`,
		);
	process.exit(ok ? 0 : 1);
}
