import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	createPersonalAgentClient,
	type PersonalAgentClient,
} from "@tedix/auth/personal-agent-client";
import { createPersonalAgentSessionVerifier } from "@tedix/auth/personal-agent-session";
import type { DbClient } from "@tedix/db/client";
import type { Tedi } from "@tedix/db/schema/tedis";
import {
	decryptTediSecret,
	generateMasterKey,
} from "@tedix/db/utils/secrets-encryption";
import {
	getPoppyAgentIdentityView,
	loadPoppyAgentPublicDocument,
	setPoppyAgentIdentityEnabled,
} from "./poppy-agent-identity";

const mocks = vi.hoisted(() => {
	const secrets = new Map<string, { id: string; encryptedValue: string }>();
	return {
		secrets,
		tedi: null as unknown,
		getTediSecret: vi.fn(async (_db: unknown, tediId: string, name: string) =>
			secrets.get(`${tediId}:${name}`),
		),
		upsertTediSecret: vi.fn(
			async (
				_db: unknown,
				tediId: string,
				name: string,
				encryptedValue: string,
			) => {
				const key = `${tediId}:${name}`;
				const existing = secrets.get(key);
				const row = {
					id: existing?.id ?? `secret-${secrets.size}`,
					encryptedValue,
				};
				secrets.set(key, row);
				return row;
			},
		),
		deleteTediSecret: vi.fn(async (_db: unknown, secretId: string) => {
			for (const [key, row] of secrets) {
				if (row.id === secretId) {
					secrets.delete(key);
					return true;
				}
			}
			return false;
		}),
		getTediByGlobalSlug: vi.fn(async () => mocks.tedi),
	};
});

vi.mock("@tedix/db/queries/tedi-secrets", () => ({
	getTediSecret: mocks.getTediSecret,
	upsertTediSecret: mocks.upsertTediSecret,
	deleteTediSecret: mocks.deleteTediSecret,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByGlobalSlug: mocks.getTediByGlobalSlug,
}));

const db = {} as DbClient;
const masterKey = generateMasterKey();
const env = {
	API_URL: "https://api.tedix.test",
	SECRETS_MASTER_KEY: masterKey,
};
const tedi = {
	id: "tedi-1",
	slug: "amber-otter",
	name: "amber-otter",
	displayName: "Amber Otter",
	organizationId: "org-1",
	retiredAt: null,
} as unknown as Tedi;

const clientId = "https://api.tedix.test/poppy-agent/amber-otter/client.json";
const jwksUri = "https://api.tedix.test/poppy-agent/amber-otter/jwks.json";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.secrets.clear();
	mocks.tedi = tedi;
});

describe("poppy agent identity", () => {
	it("reports disabled until an admin turns it on, then serves public documents", async () => {
		expect(await getPoppyAgentIdentityView(env, db, tedi)).toEqual({
			enabled: false,
			clientId: null,
			jwksUri: null,
			keyId: null,
			clientName: null,
		});

		const view = await setPoppyAgentIdentityEnabled(env, db, {
			tedi,
			enabled: true,
			actorId: "user-1",
		});
		expect(view).toMatchObject({
			enabled: true,
			clientId,
			jwksUri,
			clientName: "Amber Otter",
		});
		expect(view.keyId).toMatch(/^[A-Za-z0-9_-]+$/);
		// Re-enabling keeps the key so published iss values stay stable.
		const again = await setPoppyAgentIdentityEnabled(env, db, {
			tedi,
			enabled: true,
			actorId: "user-1",
		});
		expect(again.keyId).toBe(view.keyId);
		expect(mocks.upsertTediSecret).toHaveBeenCalledTimes(1);

		const metadata = await loadPoppyAgentPublicDocument(
			env,
			db,
			"amber-otter",
			"client",
		);
		expect(metadata).toMatchObject({
			client_id: clientId,
			client_name: "Amber Otter",
			jwks_uri: jwksUri,
		});
		const jwks = await loadPoppyAgentPublicDocument(
			env,
			db,
			"amber-otter",
			"jwks",
		);
		const keys = (jwks as { keys: Record<string, unknown>[] }).keys;
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", kid: view.keyId });
		expect(keys[0]).not.toHaveProperty("d");
	});

	it("answers null documents for unknown slugs and disabled identities", async () => {
		mocks.tedi = undefined;
		expect(
			await loadPoppyAgentPublicDocument(env, db, "nobody", "client"),
		).toBeNull();
		mocks.tedi = tedi;
		expect(
			await loadPoppyAgentPublicDocument(env, db, "amber-otter", "jwks"),
		).toBeNull();
	});

	it("round-trips: sessions signed with the stored key verify against the served documents", async () => {
		await setPoppyAgentIdentityEnabled(env, db, {
			tedi,
			enabled: true,
			actorId: "user-1",
		});
		const stored = mocks.secrets.get("tedi-1:POPPY_AGENT_SIGNING_KEY")!;
		const plaintext = await decryptTediSecret(
			masterKey,
			tedi.id,
			stored.encryptedValue,
		);
		// The runtime decrypts the same row the same way; here we prove the
		// published documents match the private half that was stored.
		const signer: PersonalAgentClient = createPersonalAgentClient({
			clientId,
			jwksUri,
			signingKey: JSON.parse(plaintext),
			clientName: "Amber Otter",
		});
		const headers = await signer.sessionHeaders({
			audience: "https://company.example",
			url: "https://company.example/api/mcp",
			method: "POST",
			identity: {
				id: "amber-otter",
				name: "Amber Otter",
				userId: "tedi:amber-otter",
				agentId: "tedi:tedi-1",
			},
		});
		const verify = createPersonalAgentSessionVerifier({
			fetchFn: async (url: string) => {
				if (url === clientId)
					return Response.json(
						(await loadPoppyAgentPublicDocument(
							env,
							db,
							"amber-otter",
							"client",
						))!,
					);
				if (url === jwksUri)
					return Response.json(
						(await loadPoppyAgentPublicDocument(
							env,
							db,
							"amber-otter",
							"jwks",
						))!,
					);
				return new Response("not found", { status: 404 });
			},
		});
		const session = await verify({
			request: new Request("https://company.example/api/mcp", {
				method: "POST",
				headers: { "Poppy-Version": "1.0", ...headers },
			}),
			audience: "https://company.example",
		});
		expect(session.clientId).toBe(clientId);
		expect(session.userId).toBe("tedi:amber-otter");
	});

	it("disables by deleting the stored key", async () => {
		await setPoppyAgentIdentityEnabled(env, db, {
			tedi,
			enabled: true,
			actorId: "user-1",
		});
		const view = await setPoppyAgentIdentityEnabled(env, db, {
			tedi,
			enabled: false,
			actorId: "user-1",
		});
		expect(view.enabled).toBe(false);
		expect(mocks.secrets.size).toBe(0);
		expect(
			await loadPoppyAgentPublicDocument(env, db, "amber-otter", "client"),
		).toBeNull();
	});
});
