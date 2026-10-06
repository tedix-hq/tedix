import { LOCAL_DEMO_PROJECT_ID } from "@tedix/auth/local-demo";
import { describe, expect, test } from "vite-plus/test";
import {
	isLocalOsBuildLane,
	LOCAL_OS_BUILD_SENTINELS,
	MissingOsBuildConfigError,
	OS_BUILD_VARIABLES,
	PUBLIC_OVERLAY_PLACEHOLDER,
	readWorkerVars,
	resolveOsBuildConfig,
} from "./build-config";

const cloudLike = {
	API_URL: "https://api.example.test",
	DESCOPE_PROJECT_ID: "P2example000000000000000000",
	DESCOPE_BASE_URL: "https://auth.example.test",
	OS_URL: "https://os.example.test",
	SESSION_BROKER_URL: "https://auth.example.test",
};

describe("Tedix OS build configuration", () => {
	test("fails closed with every missing variable named when nothing is set", () => {
		let error: unknown;
		try {
			resolveOsBuildConfig({
				environment: {},
				localLane: false,
				workerVars: null,
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(MissingOsBuildConfigError);
		const message = (error as Error).message;
		for (const name of OS_BUILD_VARIABLES) {
			expect(message).toContain(`TEDIX_BUILD_${name}`);
		}
		expect(message).toContain("apps/os/README.md");
		expect((error as MissingOsBuildConfigError).missing).toEqual([
			...OS_BUILD_VARIABLES,
		]);
	});

	test("TEDIX_BUILD_* wins over the sentinel and over Worker vars", () => {
		expect(
			resolveOsBuildConfig({
				environment: {
					TEDIX_BUILD_API_URL: " https://api.override.test ",
					TEDIX_BUILD_DESCOPE_PROJECT_ID: cloudLike.DESCOPE_PROJECT_ID,
					TEDIX_BUILD_DESCOPE_BASE_URL: cloudLike.DESCOPE_BASE_URL,
					TEDIX_BUILD_OS_URL: cloudLike.OS_URL,
					TEDIX_BUILD_SESSION_BROKER_URL: cloudLike.SESSION_BROKER_URL,
				},
				localLane: true,
				workerVars: { API_URL: "https://api.worker.test" },
			}),
		).toEqual({ ...cloudLike, API_URL: "https://api.override.test" });
	});

	test("the local lane never reads Worker vars", () => {
		expect(
			resolveOsBuildConfig({
				environment: {},
				localLane: true,
				workerVars: cloudLike,
			}),
		).toEqual(LOCAL_OS_BUILD_SENTINELS);
		expect(LOCAL_OS_BUILD_SENTINELS.DESCOPE_PROJECT_ID).toBe(
			LOCAL_DEMO_PROJECT_ID,
		);
	});

	test("a deployed installation resolves from Worker vars", () => {
		expect(
			resolveOsBuildConfig({
				environment: { TEDIX_BUILD_API_URL: "" },
				localLane: false,
				workerVars: { ...cloudLike, GIT_SHA: "unknown" },
			}),
		).toEqual(cloudLike);
	});

	test("rejects a split or malformed browser authentication topology", () => {
		for (const vars of [
			{ ...cloudLike, SESSION_BROKER_URL: "https://other.example.test" },
			{ ...cloudLike, OS_URL: "https://os.example.test/path" },
			{ ...cloudLike, OS_URL: cloudLike.SESSION_BROKER_URL },
			{ ...cloudLike, OS_URL: "https://os.tedix.dev" },
		]) {
			expect(() =>
				resolveOsBuildConfig({
					environment: {},
					localLane: false,
					workerVars: vars,
				}),
			).toThrow();
		}
	});

	test("the OSS export placeholder counts as unset", () => {
		expect(() =>
			resolveOsBuildConfig({
				environment: {},
				localLane: false,
				workerVars: {
					API_URL: PUBLIC_OVERLAY_PLACEHOLDER,
					DESCOPE_PROJECT_ID: PUBLIC_OVERLAY_PLACEHOLDER,
					DESCOPE_BASE_URL: cloudLike.DESCOPE_BASE_URL,
					OS_URL: PUBLIC_OVERLAY_PLACEHOLDER,
					SESSION_BROKER_URL: PUBLIC_OVERLAY_PLACEHOLDER,
				},
			}),
		).toThrow(
			/TEDIX_BUILD_API_URL, TEDIX_BUILD_DESCOPE_PROJECT_ID, TEDIX_BUILD_OS_URL, TEDIX_BUILD_SESSION_BROKER_URL not set/,
		);
	});

	test("the committed managed config names the existing identity vars", async () => {
		const vars = await readWorkerVars("production");
		for (const name of OS_BUILD_VARIABLES.slice(0, 3)) {
			expect(typeof vars[name]).toBe("string");
			expect(vars[name]).not.toBe("");
		}
		expect(vars).not.toHaveProperty("TEDIX_PROVIDER_COHORT_API_KEY");
	});

	test("only the isolated local lanes may build on sentinels", () => {
		expect(
			isLocalOsBuildLane(
				{ TEDIX_BUILD_LOCAL_DEMO_ENABLED: "true" },
				"fixtures",
				"build",
			),
		).toBe(true);
		expect(isLocalOsBuildLane({}, "local-worker", "build")).toBe(true);
		expect(isLocalOsBuildLane({}, "fixtures", "serve")).toBe(true);
		expect(isLocalOsBuildLane({}, "fixtures", "build")).toBe(false);
		expect(isLocalOsBuildLane({}, "remote-worker", "serve")).toBe(false);
		expect(isLocalOsBuildLane({}, "live-api", "serve")).toBe(false);
	});
});
