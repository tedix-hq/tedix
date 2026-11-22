import { expect, it } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayTrafficFetch } from "./gateway-traffic";

it("counts failed HTTP attempts without storing request secrets and expires old counts", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gateway-traffic-"));
	try {
		writeFileSync(join(directory, "2026-01-01.ndjson"), "old");
		let calls = 0;
		const measured = gatewayTrafficFetch(
			async () => {
				if (++calls === 1) throw new Error("offline");
				return new Response("ok");
			},
			"runner-steps",
			{
				directory,
				now: () => Date.parse("2026-01-20T12:00:00Z"),
				url: "https://example.test/mcp",
			},
		);
		const input = {
			method: "POST",
			headers: { Authorization: "secret" },
			body: "private",
		};
		await expect(measured("https://example.test/mcp", input)).rejects.toThrow(
			"offline",
		);
		await measured("https://example.test/mcp", input);
		await measured("https://example.test/oauth/token", input);
		expect(calls).toBe(3);
		expect(readdirSync(directory)).toEqual(["2026-01-20.ndjson"]);
		const rows = readFileSync(join(directory, "2026-01-20.ndjson"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toEqual(
			Array(2).fill({
				at: "2026-01-20T12:00:00.000Z",
				component: "runner-steps",
				method: "POST",
			}),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
