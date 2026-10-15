/** Session delivery receipts contain hashes only, never document or prompt text. */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./context-cache";
import { isObject, type JsonObject } from "./hook-io";

export interface ContextDelivery {
	preferences?: string;
	lessons?: string;
}

export function contextHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function path(env: NodeJS.ProcessEnv, session: string): string {
	return join(
		cacheDir(env),
		`delivery-${contextHash(session).slice(0, 32)}.json`,
	);
}

export function readDelivery(
	env: NodeJS.ProcessEnv,
	session: string,
	scope: string,
): ContextDelivery {
	try {
		const saved: unknown = JSON.parse(readFileSync(path(env, session), "utf8"));
		if (!isObject(saved) || saved.scope !== scope) return {};
		return Object.fromEntries(
			["preferences", "lessons"].flatMap((key) =>
				typeof saved[key] === "string" && /^[a-f0-9]{64}$/.test(saved[key])
					? [[key, saved[key]]]
					: [],
			),
		);
	} catch {
		return {};
	}
}

export function writeDelivery(
	env: NodeJS.ProcessEnv,
	session: string,
	scope: string,
	hashes: ContextDelivery,
): void {
	try {
		mkdirSync(cacheDir(env), { recursive: true, mode: 0o700 });
		const destination = path(env, session);
		const temporary = `${destination}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ scope, ...hashes }), {
			mode: 0o600,
		});
		renameSync(temporary, destination);
	} catch {}
}

/** Clear/compact removes model context even if the host retains the chat id. */
export function clearDelivery(env: NodeJS.ProcessEnv, session: string): void {
	try {
		rmSync(path(env, session), { force: true });
	} catch {}
}

export function deliveryHashes(data: JsonObject): ContextDelivery {
	const hashes: ContextDelivery = {};
	for (const key of ["preferences", "lessons"] as const) {
		if (isObject(data[key]) && data[key].unavailable !== true)
			hashes[key] = contextHash(data[key]);
	}
	return hashes;
}
