import { describe, expect, it } from "vite-plus/test";
import { buildAccountProfileUrl } from "./account-profile-routing";

describe("account profile routing", () => {
	it("routes profiles to the apex without losing the local lane", () => {
		expect(
			buildAccountProfileUrl(new URL("https://acme.os.tedix.dev/work")),
		).toBe("https://os.tedix.dev/account/profile");
		expect(
			buildAccountProfileUrl(new URL("https://acme.os.tedix.tech/work")),
		).toBe("https://os.tedix.tech/account/profile");
		expect(
			buildAccountProfileUrl(new URL("http://acme.localhost:3030/work")),
		).toBe("http://acme.localhost:3030/account/profile");
	});
});
