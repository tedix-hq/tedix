import assert from "node:assert/strict";
import { test } from "node:test";
import {
	localOrigin,
	localPageAllowed,
	localRequestAllowed,
} from "./local-origin";

test("only an explicit flag opens the local profile, on a valid loopback port", () => {
	assert.equal(localOrigin(["tedix://setup"]), undefined);
	assert.equal(localOrigin(["--local"]), "http://localhost:3030");
	assert.equal(localOrigin(["--local=3048"]), "http://localhost:3048");
	for (const port of ["0", "65536", "80/path", "https://os.tedix.dev", ""]) {
		assert.equal(localOrigin([`--local=${port}`]), null);
	}
});

test("onboarding can navigate to a workspace only on the selected local OS port", () => {
	const origin = "http://localhost:3048";
	assert.equal(localPageAllowed(origin + "/onboarding", origin), true);
	assert.equal(
		localPageAllowed("http://personal-123.localhost:3048/chat", origin),
		true,
	);
	assert.equal(
		localPageAllowed("http://personal-123.localhost:8798", origin),
		false,
	);
	assert.equal(
		localPageAllowed("http://personal-123.localhost.example.test:3048", origin),
		false,
	);
});

test("the local renderer can reach loopback but cannot request hosted resources", () => {
	for (const url of [
		"http://localhost:3030/chat",
		"ws://localhost:3048/chat",
		"ws://personal-123.localhost:3048/chat",
		"http://127.0.0.1:8790/health",
		"http://[::1]:3048/",
		"data:text/html,Local",
		"blob:http://localhost:3030/image",
	]) {
		assert.equal(localRequestAllowed(url), true, url);
	}
	for (const url of [
		"https://os.tedix.dev",
		"http://localhost.example.test:3030",
		"http://localhost@tedix.dev",
		"file:///etc/hosts",
		"http://192.168.1.10:3030",
		"not a URL",
	]) {
		assert.equal(localRequestAllowed(url), false, url);
	}
});
