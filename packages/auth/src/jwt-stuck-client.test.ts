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

/** One entry per SDK client the module creates: true means it never answers. */
let stuckClients: boolean[] = [];
let clientsCreated = 0;

vi.mock("@descope/node-sdk", () => ({
	default: () => {
		const stuck = stuckClients[clientsCreated] ?? false;
		clientsCreated += 1;
		return {
			validateSession: () =>
				stuck
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
});
