import { readFileSync, writeFileSync } from "node:fs";
import {
	createPersonalAgentClient,
	generatePersonalAgentSigningKey,
	PersonalAgentClientError,
	SIMULATED_PERSONAL_AGENT_IDENTITIES,
	type PersonalAgentClientOptions,
	type PersonalAgentIdentity,
} from "@tedix/auth/personal-agent-client";
import type { CliOptions } from "./shared";

type SigningKey = NonNullable<PersonalAgentClientOptions["signingKey"]>;

export function poppyUsage(): string {
	return `tedix poppy <verb> [options]

Personal Agent side of Poppy 1.0: publish client metadata, discover a company's
/.well-known/poppy.json, and call its MCP or company agent with a signed
Poppy-Session request. No Tedix login is needed; the agent's ES256 key stays a
secret on this machine.

  tedix poppy identities [--json]
      List the simulated agent identities (each name says "Simulated").

  tedix poppy keygen --key-file <path> [--client-id <url>] [--client-name <name>]
      Generate an ES256 signing key, write the private JWK to <path> (mode 0600,
      outside the repository), and print the public client metadata document and
      JWKS to host at <client-id> and its jwks_uri.

  tedix poppy documents --client-id <url> [--key-file <path>] [--client-name <name>]
      Print the client metadata document and JWKS for an existing key. The key
      comes from --key-file, TEDIX_POPPY_AGENT_KEY_FILE, or the inline
      TEDIX_POPPY_AGENT_JWK secret.

  tedix poppy discover --company <host>
      Fetch https://<host>/.well-known/poppy.json and show the listed endpoints.

  tedix poppy call --company <host> --identity <id> [--surface conversations|mcp|tasks]
      [--text "<message>"] [--body '<json>'] [--method GET|POST] [--session <sid>]
      [--unsigned] [--allow-internal] [--json]
      Send one request as a simulated identity. Default surface is the company's
      listed Poppy agent endpoint (conversations), then its MCP, then tasks.
      --unsigned sends the same request without Poppy headers, which the company
      answers as unidentified. Pass the same --session id to continue a session.

Key material is read from --key-file, TEDIX_POPPY_AGENT_KEY_FILE (a path), or
TEDIX_POPPY_AGENT_JWK (inline JWK JSON). It is never printed or committed.`;
}

export interface PoppyCommandContext {
	json: boolean;
	positionals: string[];
	poppy: NonNullable<CliOptions["poppy"]>;
}

function fail(message: string): never {
	throw new Error(message);
}

function identityById(id: string): PersonalAgentIdentity {
	const identity = SIMULATED_PERSONAL_AGENT_IDENTITIES.find((i) => i.id === id);
	if (!identity)
		fail(
			`Unknown identity "${id}". Run \`tedix poppy identities\` for the simulated personas.`,
		);
	return identity;
}

function loadSigningKey(poppy: PoppyCommandContext["poppy"]): {
	key: SigningKey;
	source: string;
} {
	const inline = process.env.TEDIX_POPPY_AGENT_JWK?.trim();
	const file =
		poppy.keyFile?.trim() || process.env.TEDIX_POPPY_AGENT_KEY_FILE?.trim();
	if (file) {
		try {
			return {
				key: JSON.parse(readFileSync(file, "utf8")) as SigningKey,
				source: file,
			};
		} catch {
			fail(`Cannot read the agent key file "${file}".`);
		}
	}
	if (inline) {
		try {
			return {
				key: JSON.parse(inline) as SigningKey,
				source: "TEDIX_POPPY_AGENT_JWK",
			};
		} catch {
			fail("TEDIX_POPPY_AGENT_JWK is not valid JSON.");
		}
	}
	fail(
		"No agent key. Pass --key-file <path>, set TEDIX_POPPY_AGENT_KEY_FILE, or set TEDIX_POPPY_AGENT_JWK.",
	);
}

function optionalSigningKey(
	poppy: PoppyCommandContext["poppy"],
): SigningKey | undefined {
	try {
		return loadSigningKey(poppy).key;
	} catch {
		return undefined;
	}
}

async function makeClient(
	poppy: PoppyCommandContext["poppy"],
	requireKey: boolean,
) {
	return createPersonalAgentClient({
		clientId: poppy.clientId?.trim() || undefined,
		signingKey: requireKey
			? loadSigningKey(poppy).key
			: optionalSigningKey(poppy),
		...(poppy.clientName ? { clientName: poppy.clientName } : {}),
		allowInternalHosts: poppy.allowInternal ?? false,
	});
}

function print(value: unknown) {
	console.log(JSON.stringify(value, null, 2));
}

export async function runPoppyCommand(
	ctx: PoppyCommandContext,
): Promise<number> {
	const [verb, ...rest] = ctx.positionals;
	const poppy = ctx.poppy;
	try {
		switch (verb) {
			case "identities": {
				if (rest.length) fail(poppyUsage());
				if (ctx.json) print(SIMULATED_PERSONAL_AGENT_IDENTITIES);
				else
					for (const identity of SIMULATED_PERSONAL_AGENT_IDENTITIES)
						console.log(
							`${identity.id}\t${identity.name}\tsub=${identity.userId}\tagent=${identity.agentId}`,
						);
				return 0;
			}
			case "keygen": {
				const keyFile = poppy.keyFile?.trim();
				if (!keyFile) fail("keygen needs --key-file <path>.");
				if (poppy.clientId === undefined)
					fail(
						"keygen needs --client-id <url> for the public metadata document.",
					);
				const privateJwk = await generatePersonalAgentSigningKey();
				writeFileSync(keyFile, `${JSON.stringify(privateJwk, null, 2)}\n`, {
					mode: 0o600,
				});
				const client = createPersonalAgentClient({
					clientId: poppy.clientId,
					signingKey: privateJwk,
					...(poppy.clientName ? { clientName: poppy.clientName } : {}),
				});
				const out = {
					keyFile,
					metadata: await client.clientMetadata(),
					jwks: await client.jwks(),
					hosting: `Serve metadata at ${poppy.clientId} and jwks at the jwks_uri (same host).`,
				};
				print(out);
				return 0;
			}
			case "documents": {
				if (rest.length) fail(poppyUsage());
				if (!poppy.clientId?.trim()) fail("documents needs --client-id <url>.");
				const client = await makeClient(poppy, true);
				print({
					metadata: await client.clientMetadata(),
					jwks: await client.jwks(),
				});
				return 0;
			}
			case "discover": {
				const company = poppy.company?.trim() || rest[0];
				if (!company || rest.length > 1) fail(poppyUsage());
				const client = await makeClient(poppy, false);
				print(await client.discoverCompany(company));
				return 0;
			}
			case "call": {
				const company = poppy.company?.trim();
				const identityId = poppy.identity?.trim();
				if (!company || !identityId) fail(poppyUsage());
				if (!poppy.unsigned && !poppy.clientId?.trim())
					fail("A signed call needs --client-id <url>.");
				const identity = identityById(identityId);
				const client = await makeClient(poppy, !poppy.unsigned);
				const discovery = await client.discoverCompany(company);
				const surface = poppy.surface ?? "auto";
				if (!["auto", "conversations", "mcp", "tasks"].includes(surface))
					fail(`Unknown surface "${surface}".`);
				const url =
					surface === "mcp"
						? discovery.mcpUrl
						: surface === "tasks"
							? discovery.tasksUrl
							: (discovery.agentUrl ?? discovery.mcpUrl ?? discovery.tasksUrl);
				if (!url) fail(`The company document lists no ${surface} endpoint.`);
				const method = (poppy.method ?? "POST").toUpperCase();
				if (method !== "GET" && method !== "POST")
					fail("--method is GET or POST.");
				let body: unknown;
				if (method === "POST") {
					if (poppy.body !== undefined) {
						try {
							body = JSON.parse(poppy.body);
						} catch {
							fail("--body is not valid JSON.");
						}
					} else if (surface === "mcp") {
						body = {
							jsonrpc: "2.0",
							id: 1,
							method: "tools/list",
							params: {},
						};
					} else {
						const text = (poppy.text ?? rest.join(" ")).trim();
						body = {
							id: crypto.randomUUID(),
							message: {
								author: { type: "agent" },
								text: text || `Hello from ${identity.name}.`,
							},
						};
					}
				}
				const response = await client.call({
					url,
					method,
					...(body !== undefined ? { body } : {}),
					identity,
					audience: discovery.audience,
					sessionId: poppy.sessionId,
					signed: !poppy.unsigned,
				});
				const text = await response.text();
				const result = {
					identity: identity.id,
					name: identity.name,
					signed: !poppy.unsigned,
					url,
					status: response.status,
					body: text.length > 8000 ? `${text.slice(0, 8000)}…` : text,
				};
				print(result);
				return response.ok ? 0 : 1;
			}
			default:
				fail(poppyUsage());
		}
	} catch (error) {
		if (error instanceof PersonalAgentClientError)
			fail(`Poppy client error: ${error.code}`);
		throw error;
	}
}
