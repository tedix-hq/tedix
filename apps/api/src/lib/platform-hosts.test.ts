import { describe, expect, it } from "vite-plus/test";
import { tediHost } from "./platform-hosts";

describe("tediHost", () => {
	it("defaults to Tedix Cloud's tedi host", () => {
		expect(tediHost({}, "acme")).toBe("acme.tedi.tedix.dev");
	});

	it("uses a configured suffix", () => {
		expect(tediHost({ TEDI_HOST_SUFFIX: "tedi.example.com" }, "acme")).toBe(
			"acme.tedi.example.com",
		);
	});
});
