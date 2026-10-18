import { isRecord } from "@tedix/api-contract/utils/is-record";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	credentialDirectory,
	type CredentialStoreOpts,
} from "./credential-store";
import { withFileLockSync } from "./local-file-lock";
import { looksLikeUuid } from "./shared";

export interface SessionScope {
	workspace: string;
	organization?: string;
	projectId?: string;
	workItemId?: string;
	heldUntil?: number;
	at: number;
}
const MAX_AGE = 2 * 60 * 60_000;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

/** An explicit harness selection wins; conflicting inherited host ids are ignored. */
export function scopeSession(env: NodeJS.ProcessEnv): string | undefined {
	const explicit = /^(?:codex|claude-code|chatgpt):(.+)$/.exec(
		env.TEDIX_AGENT_SESSION ?? "",
	)?.[1];
	if (explicit)
		return looksLikeUuid(explicit) ? explicit.toLowerCase() : undefined;
	const ids = [
		...new Set(
			[env.CODEX_THREAD_ID, env.CODEX_SESSION_ID, env.CLAUDE_CODE_SESSION_ID]
				.filter(Boolean)
				.map((id) => id!.toLowerCase()),
		),
	];
	return ids.length === 1 && looksLikeUuid(ids[0]!) ? ids[0] : undefined;
}
/** A read of another executor's Attempt must not become this chat's held Work. */
export function scopeFromWorkResult(
	value: unknown,
	session: string | undefined,
): Pick<SessionScope, "projectId" | "workItemId" | "heldUntil"> {
	if (!isRecord(value)) return {};
	const item = isRecord(value.workItem) ? value.workItem : {};
	const attempt = isRecord(value.attempt) ? value.attempt : value;
	const owned =
		session &&
		typeof attempt.externalSessionKey === "string" &&
		attempt.externalSessionKey.endsWith(`:${session}`);
	const workItemId = attempt.workItemId ?? item.id;
	const expiry =
		typeof attempt.expiresAt === "string" ? Date.parse(attempt.expiresAt) : 0;
	return {
		...(looksLikeUuid(String(item.projectId))
			? { projectId: String(item.projectId) }
			: {}),
		...(owned && looksLikeUuid(String(workItemId))
			? {
					workItemId: String(workItemId),
					heldUntil:
						attempt.runtimeState === "running" && expiry > Date.now()
							? expiry
							: 0,
				}
			: {}),
	};
}

function path(session: string, options?: CredentialStoreOpts): string {
	return join(
		credentialDirectory(options),
		"session-scopes",
		`${createHash("sha256").update(session).digest("hex")}.json`,
	);
}
export function readSessionScopes(
	session: string | undefined,
	options?: CredentialStoreOpts,
	now = Date.now(),
): SessionScope[] {
	if (!session || !looksLikeUuid(session)) return [];
	try {
		const rows: unknown = JSON.parse(
			readFileSync(path(session, options), "utf8"),
		);
		if (!Array.isArray(rows)) return [];
		return rows
			.filter(
				(r): r is SessionScope =>
					r &&
					NAME.test(r.workspace) &&
					(r.organization === undefined || NAME.test(r.organization)) &&
					(r.projectId === undefined || looksLikeUuid(r.projectId)) &&
					(r.workItemId === undefined || looksLikeUuid(r.workItemId)) &&
					Number.isFinite(r.at) &&
					r.at <= now &&
					now - r.at <= MAX_AGE,
			)
			.sort((a, b) => b.at - a.at)
			.slice(0, 8);
	} catch {
		return [];
	}
}
/** Successful user calls only: hook reads must never reinforce their own scope. */
export function recordSessionScope(
	input: Omit<SessionScope, "at">,
	env = process.env,
	options?: CredentialStoreOpts,
): void {
	const session = scopeSession(env);
	if (!session || env.TEDIX_HOOK_READ === "1") return;
	try {
		const dir = join(credentialDirectory(options), "session-scopes");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path(session, options);
		withFileLockSync(`${file}.lock`, () => {
			const rows = readSessionScopes(session, options);
			const same = rows.find(
				(r) =>
					r.workspace === input.workspace &&
					r.organization === input.organization,
			);
			const update =
				input.heldUntil === 0 &&
				same?.workItemId &&
				same.workItemId !== input.workItemId
					? { workspace: input.workspace, organization: input.organization }
					: input;
			const next = [
				{ ...same, ...update, at: Date.now() },
				...rows.filter((r) => r !== same),
			].slice(0, 8);
			const temporary = `${file}.${process.pid}.tmp`;
			writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
			renameSync(temporary, file);
		});
	} catch {
		/* Correlation is optional; never change command success. */
	}
}
