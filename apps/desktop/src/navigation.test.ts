import assert from "node:assert/strict";
import { test } from "node:test";
import { isOsPage, mainPageAllowed } from "./navigation";

test("OS links stay in the main view; editors and other sites cannot replace it", () => {
	for (const url of [
		"https://os.tedix.dev/login",
		"https://example.os.tedix.dev/",
	]) {
		assert.equal(isOsPage(url), true, url);
		assert.equal(mainPageAllowed(url), true, url);
	}
	for (const url of [
		"https://example.cms.tedix.dev/admin",
		"https://tedix.dev/",
		"https://os.tedix.dev.example.test/",
		"http://example.os.tedix.dev/",
		"not a URL",
	]) {
		assert.equal(isOsPage(url), false, url);
		assert.equal(mainPageAllowed(url), false, url);
	}
	assert.equal(mainPageAllowed("https://auth.tedix.dev/login"), true);
	assert.equal(isOsPage("https://auth.tedix.dev/login"), false);
});
