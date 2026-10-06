import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

describe("Tedix brand lockup", () => {
	it("uses the locally bundled Comfortaa wordmark font", () => {
		const styles = readFileSync("src/styles.css", "utf8");
		expect(styles).toContain(
			'font-family: "Comfortaa Variable", ui-rounded, sans-serif;',
		);
	});
});
