import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneOutput } from "./lane-output";

it("preserves distinct chunks retained by an asynchronous output consumer", () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-output-test-"));
	const chunks: Buffer[] = [];
	const output = laneOutput(join(dir, "stdout.log"), (chunk) =>
		chunks.push(chunk),
	);
	const expected = Buffer.concat([
		Buffer.alloc(65536, "a"),
		Buffer.alloc(65536, "b"),
		Buffer.from("last"),
	]);
	try {
		writeSync(output.fd, expected);
		output.close();
		expect(Buffer.concat(chunks)).toEqual(expected);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
