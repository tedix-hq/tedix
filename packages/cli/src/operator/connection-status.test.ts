import { describe, expect, it } from "bun:test";
import { CONNECTION_STATUS_COPY } from "./connection-status.ts";

describe("connection status copy", () => {
	it("has copy for every status", () => {
		expect(CONNECTION_STATUS_COPY.connected).toBe("Connected");
		expect(CONNECTION_STATUS_COPY.reconnecting).toBe("Reconnecting…");
		expect(CONNECTION_STATUS_COPY.lost).toBe("Connection lost");
	});
});
