import { describe, expect, it } from "vite-plus/test";
import { buildOsBaseUrl, getPlatformDomain } from "./platform";

describe("platform URL helpers", () => {
	it("routes production to tedix.dev and everything else to tedix.tech", () => {
		expect(getPlatformDomain("production")).toBe("tedix.dev");
		expect(getPlatformDomain("development")).toBe("tedix.tech");
		expect(buildOsBaseUrl("tedix.dev")).toBe("https://os.tedix.dev");
	});
});
