import { describe, expect, it } from "vite-plus/test";
import { detectedWorkstationOperationLock } from "./shared";

describe("workstation deploy lock", () => {
	it.each([
		"bunx wrangler deploy --env production",
		"cf deploy --mode production --prebuilt",
		"bun run deploy:production",
	])("locks %s as a deploy", (command) => {
		expect(detectedWorkstationOperationLock(command, false)).toBe("deploy");
	});
});
