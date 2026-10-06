import assert from "node:assert/strict";
import { skillRuntimeHealth } from "../src/health";

const health = skillRuntimeHealth({
	ENVIRONMENT: "production",
	GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
	WORKER_VERSION: {
		id: "version-id",
		tag: "version-tag",
		timestamp: "2026-08-20T12:00:00.000Z",
	},
});

assert.deepEqual(health, {
	ok: true,
	service: "skill-runtime",
	env: "production",
	deployedSha: "0123456789abcdef0123456789abcdef01234567",
	workerVersion: {
		id: "version-id",
		tag: "version-tag",
		timestamp: "2026-08-20T12:00:00.000Z",
	},
});
