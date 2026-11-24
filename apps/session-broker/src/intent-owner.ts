import { assertFreshCustomHost } from "./custom-host";
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
import {
	type SessionIntentRow,
	beginSessionIntentReauthentication,
	consumeGrantedSessionIntent,
	consumePendingSessionIntent,
	failSessionIntent,
	grantSessionIntentLogout,
	grantSessionIntentSession,
	insertPendingSessionIntent,
	readSessionIntent,
} from "@tedix/db/queries/durable-sqlite/session-intent";
import {
	type SessionIntentStoreDb,
	openSessionIntentStore,
} from "@tedix/db/session-intent-store/store";

type IntentRow = SessionIntentRow;

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
		JSON.parse(row.intentJson) as SessionBrokerIntent,
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
	private db!: SessionIntentStoreDb;
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => {
			this.db = openSessionIntentStore(ctx.storage);
			return Promise.resolve();
		});
	}

	async initialize(intent: SessionBrokerIntent): Promise<boolean> {
		assertSessionBrokerIntent(intent, undefined, this.osOrigin);
		const existing = this.readRow();
		if (existing) return false;
		insertPendingSessionIntent(this.db, {
			intentJson: JSON.stringify(intent),
			nowMs: Date.now(),
		});
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
		return beginSessionIntentReauthentication(this.db, now);
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
			return consumePendingSessionIntent(this.db, Date.now()) ? parsed : null;
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
		const changed = grantSessionIntentSession(this.db, {
			codeHash: input.codeHash,
			codeExpiresAt: input.codeExpiresAt,
			tenantId: input.tenantId,
			sessionJwt: input.sessionJwt,
			subject: input.subject,
			sessionExpiresAt: input.sessionExpiresAt,
			nowMs: Date.now(),
		});
		if (!changed) return false;
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
		const changed = grantSessionIntentLogout(this.db, {
			codeHash: input.codeHash,
			codeExpiresAt: input.codeExpiresAt,
			nowMs: Date.now(),
		});
		if (!changed) return false;
		await this.ctx.storage.setAlarm(input.codeExpiresAt * 1000);
		return true;
	}

	async fail(): Promise<void> {
		failSessionIntent(this.db, Date.now());
		await this.ctx.storage.deleteAlarm();
	}

	async exchange(
		input: ExchangeSessionBrokerCodeInput,
		surface: SessionBrokerSurface,
		codeHash: string,
		now = Math.floor(Date.now() / 1000),
	): Promise<SessionBrokerExchangeResult | null> {
		assertExchangeSessionBrokerCodeInput(input, surface, this.osOrigin);
		const pending = this.readRow();
		if (!pending || pending.status !== "granted") return null;
		try {
			const boundIntent = parseIntent(pending, this.osOrigin, now);
			await assertFreshCustomHost(this.env.API_SERVICE, boundIntent);
		} catch {
			await this.fail();
			return null;
		}
		const result: SessionBrokerExchangeResult | null =
			this.ctx.storage.transactionSync(() => {
				const row = this.readRow();
				if (
					!row ||
					row.status !== "granted" ||
					row.codeHash !== codeHash ||
					(row.codeExpiresAt ?? 0) <= now
				) {
					return null;
				}
				const grantKind = row.grantKind;
				let intent: SessionBrokerIntent;
				try {
					intent = parseIntent(row, this.osOrigin);
				} catch {
					return null;
				}
				const grantedTenantId = row.grantedTenantId;
				if (
					intent.surface !== surface ||
					intent.intentId !== input.intentId ||
					intent.stateHash !== input.stateHash ||
					intent.targetOrigin !== input.targetOrigin ||
					intent.tenantId !== input.tenantId ||
					intent.customHost?.organizationId !==
						input.customHost?.organizationId ||
					intent.customHost?.tenantId !== input.customHost?.tenantId
				) {
					return null;
				}
				if (intent.operation === "logout") {
					if (grantKind !== "logout") return null;
				} else if (
					grantKind !== "session" ||
					!row.sessionJwt ||
					!row.subject ||
					!row.sessionExpiresAt ||
					(intent.operation === "issue_session" &&
						(!grantedTenantId || grantedTenantId !== intent.tenantId))
				) {
					return null;
				}
				if (
					!consumeGrantedSessionIntent(this.db, { codeHash, nowMs: Date.now() })
				)
					return null;
				if (intent.operation === "logout") return { kind: "logout" };
				return {
					expiresAt: row.sessionExpiresAt!,
					kind: "session",
					sessionJwt: row.sessionJwt!,
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
		return readSessionIntent(this.db);
	}
}
