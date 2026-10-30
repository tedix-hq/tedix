import { closeSync, openSync, readSync } from "node:fs";

/** A detached worker must not lose its output destination with its parent. */
export function laneOutput(path: string, receive: (chunk: Buffer) => void) {
	const fd = openSync(path, "wx+", 0o600);
	let offset = 0;
	const drain = () => {
		const buffer = Buffer.alloc(65536);
		let size: number;
		while ((size = readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
			offset += size;
			receive(Buffer.from(buffer.subarray(0, size)));
		}
	};
	const timer = setInterval(drain, 100);
	return {
		fd,
		close() {
			clearInterval(timer);
			try {
				drain();
			} finally {
				closeSync(fd);
			}
		},
	};
}
