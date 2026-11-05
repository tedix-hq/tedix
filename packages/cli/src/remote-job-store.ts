import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	RemoteJobRecordSchema,
	type RemoteJobKey,
	type RemoteJobRecord,
	type RemoteJobStore,
} from "./remote-job";

/** Local recovery receipts, not an OS result or a replacement Work queue. */
export function fileRemoteJobStore(directory: string): RemoteJobStore {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	function path(job: RemoteJobKey) {
		const key = JSON.stringify([job.organizationId, job.jobId]);
		return join(
			directory,
			`${createHash("sha256").update(key).digest("hex")}.json`,
		);
	}
	function read(job: RemoteJobKey) {
		const file = path(job);
		if (!existsSync(file)) return undefined;
		return RemoteJobRecordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
	}
	return {
		read,
		update(job, change) {
			const file = path(job);
			// A leftover lock means an interrupted write. Never guess that it is safe to take over.
			const lock = `${file}.lock`;
			const fd = openSync(lock, "wx", 0o600);
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				const next: RemoteJobRecord = RemoteJobRecordSchema.parse(
					change(read(job)),
				);
				if (
					next.job.organizationId !== job.organizationId ||
					next.job.jobId !== job.jobId
				)
					throw new Error("Store identity mismatch");
				const output = openSync(temporary, "wx", 0o600);
				try {
					writeFileSync(output, JSON.stringify(next));
					fsyncSync(output);
				} finally {
					closeSync(output);
				}
				renameSync(temporary, file);
				const parent = openSync(directory, "r");
				try {
					fsyncSync(parent);
				} finally {
					closeSync(parent);
				}
				return next;
			} finally {
				closeSync(fd);
				rmSync(temporary, { force: true });
				rmSync(lock);
			}
		},
	};
}
