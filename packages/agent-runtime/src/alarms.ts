import type {
	AgentAlarm,
	AgentAlarmHandler,
	AgentAlarms,
	AgentJson,
} from "./index";
import type { SqliteAgentStorage } from "./sql-storage";

/** The alarm side of a Durable Object's storage this module uses. */
export interface AlarmHost {
	setAlarm(at: number): Promise<void>;
	deleteAlarm(): Promise<void>;
	getAlarm(): Promise<number | null>;
}

const ALARMS_TABLE = "agent_runtime_alarms";

type AlarmRow = {
	alarm_id: string;
	alarm_at: number;
	alarm_payload: string;
};

function rowToAlarm(row: AlarmRow): AgentAlarm {
	return {
		id: row.alarm_id,
		at: row.alarm_at,
		payload: JSON.parse(row.alarm_payload) as AgentJson,
	};
}

/**
 * Many named alarms over the host's single timer. Every scheduled alarm is a
 * row; the host timer is always armed for the soonest one, and `dispatchDue`
 * delivers everything that has come due and re-arms for the rest.
 */
export class SqliteAgentAlarms implements AgentAlarms {
	private handler: AgentAlarmHandler = async () => {};

	constructor(
		private readonly storage: SqliteAgentStorage,
		private readonly host: AlarmHost,
	) {
		void storage.exec(
			`CREATE TABLE IF NOT EXISTS ${ALARMS_TABLE} (` +
				"alarm_id TEXT PRIMARY KEY, " +
				"alarm_at INTEGER NOT NULL, " +
				"alarm_payload TEXT NOT NULL)",
		);
		void storage.exec(
			`CREATE INDEX IF NOT EXISTS ${ALARMS_TABLE}_at ON ${ALARMS_TABLE} (alarm_at)`,
		);
	}

	onAlarm(handler: AgentAlarmHandler): void {
		this.handler = handler;
	}

	async schedule(at: number | Date, payload: AgentJson): Promise<AgentAlarm> {
		const when = at instanceof Date ? at.getTime() : at;
		if (!Number.isFinite(when)) throw new Error("Alarm time must be finite");
		const alarm: AgentAlarm = {
			id: crypto.randomUUID(),
			at: Math.floor(when),
			payload: payload ?? null,
		};
		await this.storage.exec(
			`INSERT INTO ${ALARMS_TABLE} (alarm_id, alarm_at, alarm_payload) VALUES (?, ?, ?)`,
			[alarm.id, alarm.at, JSON.stringify(alarm.payload)],
		);
		await this.arm();
		return alarm;
	}

	async cancel(id: string): Promise<boolean> {
		const result = await this.storage.exec(
			`DELETE FROM ${ALARMS_TABLE} WHERE alarm_id = ?`,
			[id],
		);
		await this.arm();
		return result.rowsWritten > 0;
	}

	async list(): Promise<AgentAlarm[]> {
		const rows = await this.storage.query<AlarmRow>(
			`SELECT alarm_id, alarm_at, alarm_payload FROM ${ALARMS_TABLE} ORDER BY alarm_at ASC, alarm_id ASC`,
		);
		return rows.map(rowToAlarm);
	}

	async dispatchDue(now = Date.now()): Promise<AgentAlarm[]> {
		const rows = await this.storage.query<AlarmRow>(
			`SELECT alarm_id, alarm_at, alarm_payload FROM ${ALARMS_TABLE} ` +
				"WHERE alarm_at <= ? ORDER BY alarm_at ASC, alarm_id ASC",
			[now],
		);
		const due = rows.map(rowToAlarm);
		for (const alarm of due) {
			// Delete first: a handler that throws must not fire again forever.
			await this.storage.exec(
				`DELETE FROM ${ALARMS_TABLE} WHERE alarm_id = ?`,
				[alarm.id],
			);
			await this.handler(alarm);
		}
		await this.arm();
		return due;
	}

	/** Points the host's one timer at the soonest pending alarm. */
	private async arm(): Promise<void> {
		const [next] = await this.storage.query<{ next_at: number | null }>(
			`SELECT MIN(alarm_at) AS next_at FROM ${ALARMS_TABLE}`,
		);
		if (next?.next_at === null || next?.next_at === undefined) {
			await this.host.deleteAlarm();
			return;
		}
		const current = await this.host.getAlarm();
		if (current !== next.next_at) await this.host.setAlarm(next.next_at);
	}
}
