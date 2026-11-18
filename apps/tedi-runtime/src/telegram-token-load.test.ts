/**
 * The API strips `botToken` from `tedis.channels` and stores it encrypted in
 * `tedi_secrets`; the runtime must read it from there.
 * Run: `bun run src/telegram-token-load.test.ts`.
 */

import assert from "node:assert/strict";
import { encryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import { runtimeParentTurns } from "./runtime-parent-turns";

const masterKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));

function host(channels: unknown, encrypted: string | null, key = masterKey) {
	return {
		env: {
			SECRETS_MASTER_KEY: key,
			DB: {
				prepare: (sql: string) => ({
					bind: () => ({
						first: async () =>
							sql.includes("FROM tedi_secrets")
								? encrypted === null
									? null
									: { encrypted_value: encrypted }
								: { channels: JSON.stringify(channels) },
					}),
				}),
			},
		},
	} as never;
}

const load = (h: never) =>
	runtimeParentTurns.loadTelegramChannel.call(h, "tedi-1");

{
	// channels column has no token: it comes from the encrypted secret.
	const enc = await encryptTediSecret(masterKey, "tedi-1", "123:SECRET");
	const got = await load(
		host({ telegram: { enabled: true, botUsername: "bot" } }, enc),
	);
	assert.equal(got?.botToken, "123:SECRET");
	assert.equal(got?.enabled, true);
	assert.equal(got?.botUsername, "bot");
}
{
	// no secret stored: stays tokenless (Worker-wide fallback applies).
	const got = await load(host({ telegram: { enabled: true } }, null));
	assert.equal(got?.botToken, undefined);
}
{
	// no telegram config: null, secret is not consulted.
	assert.equal(await load(host({}, "x")), null);
}
console.log("telegram-token-load ok");
