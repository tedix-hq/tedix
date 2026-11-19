import { describe, expect, it } from "vite-plus/test";
import { actingMemberSubject } from "./acting-member";

describe("acting member for credit caps", () => {
	it.each([
		["a signed-in person", { authType: "user", user: { sub: "u-1" } }, "u-1"],
		[
			"a person whose provider subject differs",
			{ authType: "user", user: { sub: "token-sub" }, descopeUserId: "u-1" },
			"u-1",
		],
		[
			"the person a service binding names",
			{ authType: "service-binding", descopeUserId: "u-1" },
			"u-1",
		],
		["a bare service binding", { authType: "service-binding" }, undefined],
		[
			"a tedi key carrying its own user id",
			{ authType: "tedi", tediId: "t-1", descopeUserId: "u-1" },
			undefined,
		],
		[
			"an external agent",
			{
				authType: "user",
				user: { sub: "u-1" },
				externalAgentPrincipalId: "agent-1",
			},
			undefined,
		],
		["an API key", { authType: "apikey", user: { sub: "u-1" } }, undefined],
	] as const)("%s", (_label, context, expected) => {
		expect(actingMemberSubject(context as never)).toBe(expected);
	});
});
