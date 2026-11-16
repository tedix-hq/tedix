import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const now = Math.floor(Date.now() / 1000);
const claims = { sub: "U_example", iss: "P_example", exp: now + 600 };

/**
 * One entry per SDK client the module creates: true means it never answers,
 * a string means every call is rejected with that SDK error.
 */
let stuckClients: (boolean | string)[] = [];
let clientsCreated = 0;

/** The SDK's wrapping of what workerd says about an ended request's promise. */
const ENDED_REQUEST_ERROR =
	"session validation failed. Error: Error: This promise was created by a request that has since ended, so it can never settle. With the handle_cross_request_promise_resolution compatibility flag, a promise can only settle in the request that created it, and settling it after that request ends is dropped.";

vi.mock("@descope/node-sdk", () => ({
	default: () => {
		const stuck = stuckClients[clientsCreated] ?? false;
		clientsCreated += 1;
		return {
			validateSession: () =>
				typeof stuck === "string"
					? Promise.reject(new Error(stuck))
					: stuck
						? new Promise(() => {})
						: Promise.resolve({ jwt: "token", token: claims }),
		};
	},
}));

const { TokenValidationError, VALIDATION_BUDGET_MS, validateToken } =
	await import("./jwt");

describe("validateToken with a client that stopped answering", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		clientsCreated = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("replaces the stuck client and serves later calls from the new one", async () => {
		stuckClients = [true, false];
		const first = validateToken("token", { projectId: "P_replace" });
		await vi.advanceTimersByTimeAsync(VALIDATION_BUDGET_MS);
		expect((await first).sub).toBe("U_example");
		expect(clientsCreated).toBe(2);

		const second = await validateToken("token", { projectId: "P_replace" });
		expect(second.sub).toBe("U_example");
		expect(clientsCreated).toBe(2);
	});

	it("fails as retryable instead of hanging when the new client is stuck too", async () => {
		stuckClients = [true, true];
		const outcome = validateToken("token", {
			projectId: "P_unavailable",
		}).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(VALIDATION_BUDGET_MS * 2);
		const error = await outcome;
		expect(error).toBeInstanceOf(TokenValidationError);
		expect((error as InstanceType<typeof TokenValidationError>).code).toBe(
			"KEYS_UNAVAILABLE",
		);
	});

	it("replaces a client whose key refresh belongs to an ended request", async () => {
		stuckClients = [ENDED_REQUEST_ERROR, false];
		const first = await validateToken("token", { projectId: "P_ended" });
		expect(first.sub).toBe("U_example");
		expect(clientsCreated).toBe(2);

		const second = await validateToken("token", { projectId: "P_ended" });
		expect(second.sub).toBe("U_example");
		expect(clientsCreated).toBe(2);
	});

	it("answers retryable, never invalid, when the new client is rejected the same way", async () => {
		stuckClients = [ENDED_REQUEST_ERROR, ENDED_REQUEST_ERROR];
		const error = await validateToken("token", {
			projectId: "P_ended_twice",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TokenValidationError);
		expect((error as InstanceType<typeof TokenValidationError>).code).toBe(
			"KEYS_UNAVAILABLE",
		);
		expect(clientsCreated).toBe(2);
	});

	it("keeps the client and rejects the token on an ordinary verification failure", async () => {
		stuckClients = [
			"session validation failed. Error: JWSSignatureVerificationFailed: signature verification failed",
			false,
		];
		const error = await validateToken("token", {
			projectId: "P_bad_signature",
		}).catch((caught: unknown) => caught);
		expect((error as InstanceType<typeof TokenValidationError>).code).toBe(
			"SIGNATURE_INVALID",
		);
		expect(clientsCreated).toBe(1);
	});
});
