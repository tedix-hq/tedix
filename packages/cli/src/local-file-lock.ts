import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface LocalFileLock {
	release: () => void;
}
interface Claim {
	pid: number;
	ticket: number;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Lamport bakery mutex: every contender owns a unique claim, so neither
 * crash recovery nor release can unlink a successor's lock. Ticket zero marks
 * choosing; contenders wait until that owner publishes its ordered ticket.
 * PID reuse conservatively blocks instead of stealing a potentially live lock.
 */
export function beginFileLock(directory: string): {
	ready: () => boolean;
	release: () => void;
} {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const id = `${process.pid}-${randomUUID()}`;
	const path = join(directory, `${id}.json`);
	const publish = (ticket: number) => {
		const temp = `${path}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify({ pid: process.pid, ticket }), {
				mode: 0o600,
				flag: "wx",
			});
			renameSync(temp, path);
		} finally {
			rmSync(temp, { force: true });
		}
	};
	const claims = (): Array<{ name: string; claim: Claim }> => {
		const result: Array<{ name: string; claim: Claim }> = [];
		for (const name of readdirSync(directory)) {
			if (!name.endsWith(".json")) continue;
			const claimPath = join(directory, name);
			let claim: Claim;
			try {
				claim = JSON.parse(readFileSync(claimPath, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (
				!Number.isSafeInteger(claim.pid) ||
				claim.pid <= 0 ||
				!Number.isSafeInteger(claim.ticket) ||
				claim.ticket < 0
			)
				throw new Error("Invalid credential lock claim");
			if (!alive(claim.pid)) {
				rmSync(claimPath, { force: true });
				continue;
			}
			result.push({ name, claim });
		}
		return result;
	};
	let released = false;
	const release = () => {
		if (!released) {
			released = true;
			rmSync(path, { force: true });
		}
	};
	try {
		publish(0);
		const ticket =
			Math.max(0, ...claims().map(({ claim }) => claim.ticket)) + 1;
		publish(ticket);
		return {
			release,
			ready: () =>
				!released &&
				claims().every(
					({ name, claim }) =>
						name === `${id}.json` ||
						(claim.ticket !== 0 &&
							(claim.ticket > ticket ||
								(claim.ticket === ticket && name > `${id}.json`))),
				),
		};
	} catch (error) {
		release();
		throw error;
	}
}

export function withFileLockSync<T>(directory: string, operation: () => T): T {
	const lock = beginFileLock(directory);
	const deadline = Date.now() + 10_000;
	try {
		while (!lock.ready()) {
			if (Date.now() >= deadline)
				throw new Error(
					"Timed out waiting for credential storage lock; retry the command.",
				);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
		return operation();
	} finally {
		lock.release();
	}
}
