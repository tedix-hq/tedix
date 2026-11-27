import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { RemovableHost } from "./agent-host-remove";
import { TEDIX_CONNECT_MCP_URL } from "./oauth-provider";
import { TedixHomeClient } from "./home-client";

type Grant = {
	accessToken: string;
	refreshToken: string;
	clientSecret?: string;
};
type Store = { read: () => unknown; write: (value: unknown) => void };
type GrantFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function grant(value: unknown): Grant | undefined {
	if (!isRecord(value)) return;
	const tokens = isRecord(value.token_response)
		? value.token_response
		: isRecord(value.tokens)
			? value.tokens
			: value;
	const accessToken =
		tokens.access_token ?? tokens.accessToken ?? tokens.access;
	if (typeof accessToken !== "string") return;
	let claims: Record<string, unknown>;
	try {
		claims = JSON.parse(
			Buffer.from(accessToken.split(".")[1]!, "base64url").toString(),
		);
	} catch {
		return;
	}
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (
		!audiences.includes(TEDIX_CONNECT_MCP_URL) ||
		claims.token_type !== "access_token" ||
		!claims.tedixConsentRevision ||
		!claims.dci
	)
		return;
	const refreshToken =
		tokens.refresh_token ?? tokens.refreshToken ?? tokens.refresh;
	if (typeof refreshToken !== "string" || !refreshToken)
		throw new Error(
			"The agent's Tedix refresh token is missing; its connection was kept.",
		);
	const clientSecret = value.client_secret ?? value.clientSecret;
	return {
		accessToken,
		refreshToken,
		...(typeof clientSecret === "string" ? { clientSecret } : {}),
	};
}

function visit(value: unknown, found: Grant[], remove = false): unknown {
	const current = grant(value);
	if (current) {
		found.push(current);
		return remove ? undefined : value;
	}
	if (Array.isArray(value))
		return value.flatMap((child) => {
			const kept = visit(child, found, remove);
			return kept === undefined ? [] : [kept];
		});
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, child]) => {
			const kept = visit(child, found, remove);
			return kept === undefined ? [] : [[key, kept]];
		}),
	);
}

function fileStore(path: string): Store {
	return {
		read: () => JSON.parse(readFileSync(path, "utf8")),
		write: (value) => {
			if (value === undefined) {
				rmSync(path);
				return;
			}
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
				mode: 0o600,
			});
			renameSync(temporary, path);
		},
	};
}

function namedStores(parent: Store, container?: string): Store[] {
	const document = parent.read();
	const entries =
		container && isRecord(document) ? document[container] : document;
	if (!isRecord(entries)) return [];
	return Object.entries(entries)
		.filter(
			([name, entry]) =>
				/^(?:plugin:tedix:tedix|tedix)(?:[|:]|$)/.test(name) ||
				(isRecord(entry) && entry.server_name === "tedix"),
		)
		.map(([name]) => ({
			read: () => {
				const fresh = parent.read();
				const values = container && isRecord(fresh) ? fresh[container] : fresh;
				return isRecord(values) ? values[name] : undefined;
			},
			write: (value) => {
				const fresh = parent.read();
				const values = container && isRecord(fresh) ? fresh[container] : fresh;
				if (!isRecord(values))
					throw new Error(
						"The agent's credential store changed during removal.",
					);
				if (value === undefined) delete values[name];
				else values[name] = value;
				parent.write(fresh);
			},
		}));
}

function keychainStore(service: string, account?: string): Store | undefined {
	const selector = ["-s", service, ...(account ? ["-a", account] : [])];
	if (!account) {
		const attributes = spawnSync(
			"/usr/bin/security",
			["find-generic-password", ...selector],
			{ encoding: "utf8" },
		);
		if (attributes.status === 44) return;
		const encoded = attributes.stdout.match(
			/"acct"<blob>=("(?:[^"\\]|\\.)*")/,
		)?.[1];
		if (attributes.status !== 0 || !encoded)
			throw new Error(
				"Could not identify the agent's Keychain account; its connection was kept.",
			);
		selector.push("-a", JSON.parse(encoded));
	}
	const read = () => {
		const result = spawnSync(
			"/usr/bin/security",
			["find-generic-password", ...selector, "-w"],
			{ encoding: "utf8" },
		);
		if (result.status === 44) return undefined;
		if (result.status !== 0)
			throw new Error(
				"Could not read the agent's Tedix sign-in from Keychain; its connection was kept.",
			);
		return JSON.parse(result.stdout);
	};
	if (read() === undefined) return;
	return {
		read,
		write: (value) => {
			const result =
				value === undefined
					? spawnSync(
							"/usr/bin/security",
							["delete-generic-password", ...selector],
							{ stdio: "pipe" },
						)
					: spawnSync(
							"/usr/bin/security",
							[
								"add-generic-password",
								"-U",
								...selector,
								"-w",
								JSON.stringify(value),
							],
							{ stdio: "pipe" },
						);
			if (result.status !== 0)
				throw new Error(
					"Tedix sign-in ended on the server, but the agent's local sign-in could not be cleared.",
				);
		},
	};
}

async function hostStores(
	host: RemovableHost,
	env: NodeJS.ProcessEnv,
	activeOnly = false,
	includeKeychain = true,
): Promise<Store[]> {
	const root = homedir();
	const data = env.XDG_DATA_HOME || join(root, ".local", "share");
	const stores: Store[] = [];
	const addFile = (path: string) => {
		if (!existsSync(path)) return;
		const store = fileStore(path);
		if (host === "claude") stores.push(...namedStores(store, "mcpOAuth"));
		else if (host === "codex" || host === "opencode")
			stores.push(...namedStores(store));
		else stores.push(store);
	};
	if (host === "codex") {
		addFile(join(env.CODEX_HOME || join(root, ".codex"), ".credentials.json"));
		if (process.platform === "darwin") {
			const hash = createHash("sha256")
				.update(
					JSON.stringify({
						headers: {},
						type: "http",
						url: TEDIX_CONNECT_MCP_URL,
					}),
				)
				.digest("hex")
				.slice(0, 16);
			const store = includeKeychain
				? keychainStore("Codex MCP Credentials", `tedix|${hash}`)
				: undefined;
			if (store) stores.push(store);
		}
	} else if (host === "claude") {
		addFile(
			join(env.CLAUDE_CONFIG_DIR || join(root, ".claude"), ".credentials.json"),
		);
		if (process.platform === "darwin") {
			const suffix = env.CLAUDE_CONFIG_DIR
				? `-${createHash("sha256").update(env.CLAUDE_CONFIG_DIR).digest("hex").slice(0, 8)}`
				: "";
			const store = includeKeychain
				? keychainStore(`Claude Code-credentials${suffix}`)
				: undefined;
			if (store) stores.push(...namedStores(store, "mcpOAuth"));
		}
	} else if (host === "cursor") {
		// Cursor keeps MCP sign-ins inside the app; no documented file store.
	} else if (host === "devin") {
		const directory = join(data, "devin", "mcp", "oauth");
		if (existsSync(directory))
			for (const entry of readdirSync(directory, {
				recursive: true,
				withFileTypes: true,
			}))
				if (entry.isFile() && entry.name.endsWith(".json"))
					addFile(join(entry.parentPath, entry.name));
	} else {
		addFile(join(data, "opencode", "mcp-auth.json"));
		const directory = join(data, "opencode");
		if (existsSync(directory)) {
			const { Database } = await import("bun:sqlite");
			const path = resolve(directory, env.OPENCODE_DB || "opencode.db");
			for (const file of existsSync(path) ? [path] : []) {
				const db = new Database(file, { readonly: true });
				try {
					if (
						!db
							.query("SELECT name FROM sqlite_master WHERE name = 'credential'")
							.get()
					)
						continue;
					const integration = `mcp_${createHash("sha1").update(`tedix\0${TEDIX_CONNECT_MCP_URL}`).digest("hex").slice(0, 16)}`;
					const rows = db
						.query<{ id: string; value: string }, [string]>(
							"SELECT id, value FROM credential WHERE integration_id = ? AND active = 1",
						)
						.all(integration);
					// OpenCode 2 uses its active database credential, not a legacy file.
					if (activeOnly && rows.length) stores.length = 0;
					for (const row of rows) {
						stores.push({
							read: () => {
								const current = new Database(path, { readonly: true });
								try {
									const value = current
										.query<{ value: string }, [string]>(
											activeOnly
												? "SELECT value FROM credential WHERE id = ? AND active = 1"
												: "SELECT value FROM credential WHERE id = ?",
										)
										.get(row.id);
									return value ? JSON.parse(value.value) : {};
								} finally {
									current.close();
								}
							},
							write: () => {
								const current = new Database(path);
								try {
									if (
										current
											.query(
												"DELETE FROM credential WHERE id = ? AND value = ?",
											)
											.run(row.id, row.value).changes !== 1
									)
										throw new Error(
											"The agent renewed its Tedix sign-in during removal; its local connection was kept. Try Remove again.",
										);
								} finally {
									current.close();
								}
							},
						});
					}
				} finally {
					db.close();
				}
			}
		}
	}
	return stores;
}

/** Read with the agent's existing credential, without renewing it or requesting consent. */
export async function readAgentHostProfile(
	host: "devin" | "opencode",
	options: {
		env?: NodeJS.ProcessEnv;
		fetcher?: GrantFetch;
		stores?: Store[];
	} = {},
): Promise<unknown> {
	const stores =
		options.stores ??
		(await hostStores(host, options.env ?? process.env, true));
	const tokens = () => {
		const found: Grant[] = [];
		for (const store of stores) visit(store.read(), found);
		return [...new Set(found.map((item) => item.accessToken))];
	};
	const before = tokens();
	if (before.length !== 1)
		throw new Error(
			`Could not identify one Tedix sign-in for ${host}. Check its connection inside the agent.`,
		);
	const client = new TedixHomeClient({
		url: TEDIX_CONNECT_MCP_URL,
		headers: { Authorization: `Bearer ${before[0]}` },
		timeoutMs: 30_000,
		fetch: options.fetcher,
	});
	try {
		const result = await client.rawRequest(
			"tools/call",
			{ name: "get_profile", arguments: {} },
			{ signal: AbortSignal.timeout(30_000) },
		);
		if (JSON.stringify(tokens()) !== JSON.stringify(before))
			throw new Error(`The Tedix sign-in in ${host} changed. Check again.`);
		return result;
	} finally {
		await client.close();
	}
}

export type AgentHostGrantClaim = {
	/** The grant revision this installation's token carries. */
	revision: string;
	/** The OAuth client id (`azp`); per-install for DCR, shared for CIMD. */
	clientId: string;
	/** Descope consent id (`dci`) when the token carries one. */
	consentId: string;
};

function signInClaims(accessToken: string): AgentHostGrantClaim | undefined {
	try {
		const claims = JSON.parse(
			Buffer.from(accessToken.split(".")[1]!, "base64url").toString(),
		) as Record<string, unknown>;
		const revision = claims.tedixConsentRevision;
		if (typeof revision !== "string" || !revision) return;
		const clientId = claims.azp;
		const consentId = claims.dci;
		return {
			revision,
			clientId: typeof clientId === "string" ? clientId : "",
			consentId: typeof consentId === "string" ? consentId : "",
		};
	} catch {
		return;
	}
}

/**
 * The Tedix sign-ins this Mac's agent host currently holds, read from the
 * tokens it stores. `includeKeychain: false` reads only file and database
 * stores, for callers that must never raise a Keychain prompt.
 */
export async function readAgentHostGrantClaims(
	host: RemovableHost,
	options: { env?: NodeJS.ProcessEnv; includeKeychain?: boolean } = {},
): Promise<AgentHostGrantClaim[]> {
	const stores = await hostStores(
		host,
		options.env ?? process.env,
		false,
		options.includeKeychain ?? true,
	);
	const claims = new Map<string, AgentHostGrantClaim>();
	for (const store of stores) {
		const found: Grant[] = [];
		visit(store.read(), found);
		for (const token of found) {
			const claim = signInClaims(token.accessToken);
			if (claim) claims.set(`${claim.clientId}:${claim.revision}`, claim);
		}
	}
	return [...claims.values()];
}

/** Server confirmation precedes local cleanup, so a failed revoke remains retryable. */
export async function revokeAgentHostGrants(
	host: RemovableHost,
	options: {
		env?: NodeJS.ProcessEnv;
		fetcher?: GrantFetch;
		stores?: Store[];
	} = {},
): Promise<number> {
	const stores =
		options.stores ?? (await hostStores(host, options.env ?? process.env));
	let count = 0;
	for (const store of stores) {
		const found: Grant[] = [];
		visit(store.read(), found);
		if (!found.length) continue;
		for (const token of found) {
			const response = await (options.fetcher ?? fetch)(
				`${TEDIX_CONNECT_MCP_URL}/revoke`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(token),
					redirect: "error",
					signal: AbortSignal.timeout(30_000),
				},
			);
			if (
				!response.ok ||
				((await response.json()) as { revoked?: boolean }).revoked !== true
			)
				throw new Error(
					"Could not end the agent's Tedix sign-in on the server; its local connection was kept. Try Remove again.",
				);
			count++;
		}
		const fresh: Grant[] = [];
		const cleaned = visit(store.read(), fresh, true);
		if (JSON.stringify(fresh) !== JSON.stringify(found))
			throw new Error(
				"The agent renewed its Tedix sign-in during removal; its local connection was kept. Try Remove again.",
			);
		store.write(cleaned);
	}
	return count;
}
