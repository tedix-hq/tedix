import { DurableObject } from "cloudflare:workers";
import {
	assertExchangeSessionBrokerCodeInput,
	assertSessionBrokerIntent,
	readSessionBrokerOrigins,
	type ExchangeSessionBrokerCodeInput,
	type SessionBrokerExchangeResult,
	type SessionBrokerIntent,
	type SessionBrokerSurface,
} from "@tedix/auth/session-broker";

type IntentRow = {
	code_expires_at: number | null;
	code_hash: string | null;
	grant_kind: "session" | "logout" | null;
	granted_tenant_id: string | null;
	intent_json: string;
	reauth_started_at: number | null;
	session_expires_at: number | null;
	session_jwt: string | null;
	status: "failed" | "granted" | "pending" | "consumed";
	subject: string | null;
};

export type StoreSessionGrantInput = {
	codeExpiresAt: number;
	codeHash: string;
	sessionExpiresAt: number;
	sessionJwt: string;
	subject: string;
	tenantId: string | null;
};

export type StoreLogoutGrantInput = {
	codeExpiresAt: number;
	codeHash: string;
};

function parseIntent(
	row: IntentRow,
	installationOsOrigin?: string,
	now?: number,
): SessionBrokerIntent {
	return assertSessionBrokerIntent(
		JSON.parse(row.intent_json) as SessionBrokerIntent,
		now,
		installationOsOrigin,
	);
}

/**
 * One short-lived, single-use browser handoff. This object is intentionally
 * separate from the refresh-rotation owner: one session JWT is usable only for
 * the authorization-code TTL and an alarm clears an unexchanged grant, while
 * the rotation owner never persists credentials at all.
 */
export class SessionIntentOwner extends DurableObject<Cloudflare.Env> {
	private get osOrigin(): string | undefined {
		return readSessionBrokerOrigins(
			this.env as Cloudflare.Env & {
				OS_URL?: string;
				SESSION_BROKER_URL?: string;
			},
		).osOrigin;
	}
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => {
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS session_intent (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					intent_json TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'consumed', 'failed')),
					code_hash TEXT,
					code_expires_at INTEGER,
					grant_kind TEXT CHECK (grant_kind IN ('session', 'logout')),
					granted_tenant_id TEXT,
					session_jwt TEXT,
					subject TEXT,
					session_expires_at INTEGER,
					updated_at INTEGER NOT NULL
				)
			`);
			const columns = new Set(
				ctx.storage.sql
					.exec<{ name: string }>("PRAGMA table_info(session_intent)")
					.toArray()
					.map((column) => column.name),
			);
			if (!columns.has("grant_kind")) {
				ctx.storage.sql.exec(
					"ALTER TABLE session_intent ADD COLUMN grant_kind TEXT",
				);
			}
			if (!columns.has("granted_tenant_id")) {
				ctx.storage.sql.exec(
					"ALTER TABLE session_intent ADD COLUMN granted_tenant_id TEXT",
				);
			}
			if (!columns.has("reauth_started_at")) {
				this.ctx.storage.sql.exec(
					"ALTER TABLE session_intent ADD COLUMN reauth_started_at INTEGER",
				);
			}
			return Promise.resolve();
		});
	}

	async initialize(intent: SessionBrokerIntent): Promise<boolean> {
		assertSessionBrokerIntent(intent, undefined, this.osOrigin);
		const existing = this.readRow();
		if (existing) return false;
		this.ctx.storage.sql.exec(
			`INSERT INTO session_intent
				(singleton, intent_json, status, updated_at)
			 VALUES (1, ?, 'pending', ?)`,
			JSON.stringify(intent),
			Date.now(),
		);
		await this.ctx.storage.setAlarm(intent.expiresAt * 1000);
		return true;
	}

	async readPending(
		now = Math.floor(Date.now() / 1000),
	): Promise<SessionBrokerIntent | null> {
		const row = this.readRow();
		if (!row || row.status !== "pending") return null;
		try {
			return parseIntent(row, this.osOrigin, now);
		} catch {
			await this.fail();
			return null;
		}
	}

	/**
	 * Reserve the intent's sole interactive reauthentication attempt. The
	 * intent remains pending, preserving its tenant, callback, redirect, and
	 * state bindings while the browser visits the central Tedix login surface.
	 */
	async beginReauthentication(now = Date.now()): Promise<boolean> {
		const changed = this.ctx.storage.sql.exec(
			`UPDATE session_intent SET reauth_started_at = ?, updated_at = ?
			 WHERE singleton = 1 AND status = 'pending'
			   AND reauth_started_at IS NULL`,
			now,
			now,
		).rowsWritten;
		return changed === 1;
	}

	/**
	 * Consume a completed Outbound App handoff exactly once. The provider code is
	 * handled by Descope; this only binds the final browser return to the intent
	 * that originated at the product surface.
	 */
	async consumeOutbound(
		now = Math.floor(Date.now() / 1000),
	): Promise<SessionBrokerIntent | null> {
		const intent = this.ctx.storage.transactionSync(() => {
			const row = this.readRow();
			if (!row || row.status !== "pending") return null;
			let parsed: SessionBrokerIntent;
			try {
				parsed = parseIntent(row, this.osOrigin, now);
			} catch {
				return null;
			}
			if (parsed.operation !== "outbound_connect") return null;
			const changed = this.ctx.storage.sql.exec(
				`UPDATE session_intent SET status = 'consumed', updated_at = ?
				 WHERE singleton = 1 AND status = 'pending'`,
				Date.now(),
			).rowsWritten;
			return changed === 1 ? parsed : null;
		});
		if (intent) await this.ctx.storage.deleteAlarm();
		return intent;
	}

	async storeSessionGrant(input: StoreSessionGrantInput): Promise<boolean> {
		if (
			!input.codeHash.startsWith("sha256-") ||
			!input.sessionJwt ||
			!input.subject ||
			!Number.isInteger(input.codeExpiresAt) ||
			!Number.isInteger(input.sessionExpiresAt)
		) {
			return false;
		}
		const changed = this.ctx.storage.sql.exec(
			`UPDATE session_intent SET
				status = 'granted', code_hash = ?, code_expires_at = ?,
				grant_kind = 'session', granted_tenant_id = ?, session_jwt = ?,
				subject = ?, session_expires_at = ?, updated_at = ?
			 WHERE singleton = 1 AND status = 'pending'`,
			input.codeHash,
			input.codeExpiresAt,
			input.tenantId,
			input.sessionJwt,
			input.subject,
			input.sessionExpiresAt,
			Date.now(),
		).rowsWritten;
		if (changed !== 1) return false;
		await this.ctx.storage.setAlarm(input.codeExpiresAt * 1000);
		return true;
	}

	async storeLogoutGrant(input: StoreLogoutGrantInput): Promise<boolean> {
		if (
			!input.codeHash.startsWith("sha256-") ||
			!Number.isInteger(input.codeExpiresAt)
		) {
			return false;
		}
		const changed = this.ctx.storage.sql.exec(
			`UPDATE session_intent SET
				status = 'granted', code_hash = ?, code_expires_at = ?,
				grant_kind = 'logout', granted_tenant_id = NULL,
				session_jwt = NULL, subject = NULL, session_expires_at = NULL,
				updated_at = ?
			 WHERE singleton = 1 AND status = 'pending'`,
			input.codeHash,
			input.codeExpiresAt,
			Date.now(),
		).rowsWritten;
		if (changed !== 1) return false;
		await this.ctx.storage.setAlarm(input.codeExpiresAt * 1000);
		return true;
	}

	async fail(): Promise<void> {
		this.ctx.storage.sql.exec(
			`UPDATE session_intent SET status = 'failed', code_hash = NULL,
				code_expires_at = NULL, grant_kind = NULL, granted_tenant_id = NULL,
				session_jwt = NULL, subject = NULL,
				session_expires_at = NULL, updated_at = ?
			 WHERE singleton = 1 AND status IN ('pending', 'granted')`,
			Date.now(),
		);
		await this.ctx.storage.deleteAlarm();
	}

	async exchange(
		input: ExchangeSessionBrokerCodeInput,
		surface: SessionBrokerSurface,
		codeHash: string,
		now = Math.floor(Date.now() / 1000),
	): Promise<SessionBrokerExchangeResult | null> {
		assertExchangeSessionBrokerCodeInput(input, surface, this.osOrigin);
		const result: SessionBrokerExchangeResult | null =
			this.ctx.storage.transactionSync(() => {
				const row = this.readRow();
				if (
					!row ||
					row.status !== "granted" ||
					row.code_hash !== codeHash ||
					(row.code_expires_at ?? 0) <= now
				) {
					return null;
				}
				const grantKind = row.grant_kind;
				let intent: SessionBrokerIntent;
				try {
					intent = parseIntent(row, this.osOrigin);
				} catch {
					return null;
				}
				const grantedTenantId = row.granted_tenant_id;
				if (
					intent.surface !== surface ||
					intent.intentId !== input.intentId ||
					intent.stateHash !== input.stateHash ||
					intent.targetOrigin !== input.targetOrigin ||
					intent.tenantId !== input.tenantId
				) {
					return null;
				}
				if (intent.operation === "logout") {
					if (grantKind !== "logout") return null;
				} else if (
					grantKind !== "session" ||
					!row.session_jwt ||
					!row.subject ||
					!row.session_expires_at ||
					(intent.operation === "issue_session" &&
						(!grantedTenantId || grantedTenantId !== intent.tenantId))
				) {
					return null;
				}
				const changed = this.ctx.storage.sql.exec(
					`UPDATE session_intent SET status = 'consumed', code_hash = NULL,
					code_expires_at = NULL, grant_kind = NULL, granted_tenant_id = NULL,
					session_jwt = NULL, subject = NULL,
					session_expires_at = NULL, updated_at = ?
					WHERE singleton = 1 AND status = 'granted' AND code_hash = ?`,
					Date.now(),
					codeHash,
				).rowsWritten;
				if (changed !== 1) return null;
				if (intent.operation === "logout") return { kind: "logout" };
				return {
					expiresAt: row.session_expires_at!,
					kind: "session",
					sessionJwt: row.session_jwt!,
					subject: row.subject!,
					tenantId: grantedTenantId,
				};
			});
		if (result) await this.ctx.storage.deleteAlarm();
		return result;
	}

	async alarm(): Promise<void> {
		await this.fail();
	}

	private readRow(): IntentRow | null {
		return (
			this.ctx.storage.sql
				.exec<IntentRow>("SELECT * FROM session_intent WHERE singleton = 1")
				.toArray()[0] ?? null
		);
	}
}
