import { describe, expect, it } from "vite-plus/test";
import { turnFailure } from "./workspace-chat-failure";

describe("turnFailure", () => {
	it.each([
		['410: {"message":"AiError: Model has been deprecated"}', "not available"],
		["429 Too Many Requests", "busy or out of credits"],
		["Request timed out after 120000ms", "took too long"],
		["TypeError: fetch failed", "could not be finished"],
		[
			"Connection error.: D1 DB is overloaded. Too many resources consumed within a 10 second window.",
			"one of its own services was busy",
		],
	])("turns %s into a plain sentence and keeps the detail", (error, says) => {
		const failure = turnFailure(error);
		expect(failure.message).toContain(says);
		expect(failure.detail).toBe(error);
	});

	it("keeps a reason already written for a person", () => {
		const reason =
			"This month's Tedix credits are used up. Buy a top-up or turn on pay-as-you-go. (monthly_credit_limit_reached)";
		expect(turnFailure(reason)).toEqual({ message: reason });
	});
});
