/**
 * Local index of the Work Items a lead session delegated (`tedix work
 * delegate`). The board holds the items, briefs and settlements; this file only
 * remembers which ids one session registered, so the prompt-context hook can
 * name that session's open delegations without a board-wide search. One small
 * JSON file per session under `~/.tedix/delegations/`; no credentials.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DelegationVia = "subagent" | "session";

export interface Delegation {
	id: string;
	title: string;
	via: DelegationVia;
	/** Name of the delegated session or subagent, when the lead gave one. */
	to?: string;
	workspace: string;
	createdAt: string;
}

const KEY = /^[0-9a-z._-]{1,128}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Newest entries kept per session; the hook shows at most eight. */
const MAX_ENTRIES = 50;

/** `claude-code:<uuid>` and a bare `<uuid>` name the same session file. */
export function delegationKey(session: string): string | undefined {
	const key = session.slice(session.lastIndexOf(":") + 1).toLowerCase();
	return KEY.test(key) ? key : undefined;
}

function ledgerPath(env: NodeJS.ProcessEnv, key: string): string {
	return join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"delegations",
		`${key}.json`,
	);
}

function valid(entry: unknown): entry is Delegation {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	return (
		typeof e.id === "string" &&
		UUID.test(e.id) &&
		typeof e.title === "string" &&
		(e.via === "subagent" || e.via === "session") &&
		(e.to === undefined || typeof e.to === "string") &&
		typeof e.workspace === "string" &&
		typeof e.createdAt === "string"
	);
}

/** This session's delegations, newest first. Never throws. */
export function readDelegations(
	env: NodeJS.ProcessEnv,
	session: string,
): Delegation[] {
	const key = delegationKey(session);
	if (!key) return [];
	try {
		const value: unknown = JSON.parse(
			readFileSync(ledgerPath(env, key), "utf8"),
		);
		return Array.isArray(value) ? value.filter(valid) : [];
	} catch {
		return [];
	}
}

function write(
	env: NodeJS.ProcessEnv,
	key: string,
	entries: Delegation[],
): void {
	const path = ledgerPath(env, key);
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(
		temporary,
		`${JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2)}\n`,
		{ mode: 0o600 },
	);
	renameSync(temporary, path);
}

/** Add or refresh one delegation at the front of the session's list. */
export function recordDelegation(
	env: NodeJS.ProcessEnv,
	session: string,
	entry: Delegation,
): void {
	const key = delegationKey(session);
	if (!key)
		throw new Error(`cannot record a delegation for session ${session}`);
	write(env, key, [
		entry,
		...readDelegations(env, session).filter((e) => e.id !== entry.id),
	]);
}

/** Drop settled ids from the session's list. Never throws. */
export function forgetDelegations(
	env: NodeJS.ProcessEnv,
	session: string,
	ids: readonly string[],
): void {
	const key = delegationKey(session);
	if (!key || !ids.length) return;
	const drop = new Set(ids.map((id) => id.toLowerCase()));
	const current = readDelegations(env, session);
	const kept = current.filter((e) => !drop.has(e.id.toLowerCase()));
	if (kept.length === current.length) return;
	try {
		write(env, key, kept);
	} catch {
		// A stale entry is re-checked against the board on the next read.
	}
}
