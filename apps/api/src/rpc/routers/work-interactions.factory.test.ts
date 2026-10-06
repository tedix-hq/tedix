import { describe, expect, it } from "vite-plus/test";
import { workInteractionsContractRouter } from "./work-interactions";

describe("Work interactions router", () => {
	it("mounts the complete structured interaction lifecycle", () => {
		expect(Object.keys(workInteractionsContractRouter)).toEqual([
			"create",
			"respond",
			"delegate",
			"cancel",
			"get",
			"listInbox",
			"listOutbox",
			"listAudit",
		]);
	});
});
