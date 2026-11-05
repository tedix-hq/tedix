import { describe, expect, it } from "vite-plus/test";
import { checkMigrationSuite } from "./check-migration-suite";

describe("migration suite", () => {
	it("starts all independent checks and waits for every verdict", async () => {
		const calls: {
			command: string;
			args: string[];
			finish: (code: number) => void;
		}[] = [];
		let finished = false;
		const result = checkMigrationSuite(
			(command, args) =>
				new Promise<number>((finish) => calls.push({ command, args, finish })),
		).then((code) => {
			finished = true;
			return code;
		});
		expect(calls).toHaveLength(4);
		expect(
			calls.filter(({ args }) => args.includes("db:migrate:history-check")),
		).toHaveLength(1);
		expect(
			calls.some(
				({ command, args }) =>
					command === "node" && args.includes("scripts/check-migrations.ts"),
			),
		).toBe(true);
		for (const call of calls.slice(0, 3)) call.finish(0);
		await Promise.resolve();
		expect(finished).toBe(false);
		calls[3]!.finish(0);
		expect(await result).toBe(0);
	});

	it.each([0, 1, 2, 3])("fails when check %i fails", async (failed) => {
		let index = 0;
		expect(
			await checkMigrationSuite(async () => (index++ === failed ? 2 : 0)),
		).toBe(1);
		expect(index).toBe(4);
	});

	it("waits for the remaining checks after a launch error", async () => {
		let finish!: (code: number) => void;
		let index = 0;
		let finished = false;
		const result = checkMigrationSuite(async () => {
			if (index++ === 0) throw new Error("executable missing");
			if (index === 4)
				return new Promise<number>((resolve) => {
					finish = resolve;
				});
			return 0;
		}).then((code) => {
			finished = true;
			return code;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		finish(0);
		expect(await result).toBe(1);
	});
});
