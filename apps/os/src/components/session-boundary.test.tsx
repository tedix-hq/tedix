import { describe, expect, it } from "vite-plus/test";
import {
	isOsBrokerSessionRenewalDue,
	OS_BROKER_RENEWAL_WINDOW_SECONDS,
} from "@/auth/broker-session.shared";
import {
	buildOsAuthReturnUrl,
	shouldResumeOsBroker,
} from "@/shared/session-status";

describe("OS auth return URL", () => {
	it("removes a stale broker error without dropping the requested route", () => {
		expect(
			buildOsAuthReturnUrl(
				"https://os.tedix.dev/cli/login?return_to=%2Fcanvas&error=session_unavailable",
			),
		).toBe("https://os.tedix.dev/cli/login?return_to=%2Fcanvas");
	});
});

describe("OS broker resumption", () => {
	it("keeps an unauthenticated user on the signup flow", () => {
		expect(shouldResumeOsBroker({ authenticated: false }, false)).toBe(false);
	});

	it("renews only an authenticated product session without a broker error", () => {
		expect(
			shouldResumeOsBroker(
				{ authenticated: true, renewalRequired: true },
				false,
			),
		).toBe(true);
		expect(
			shouldResumeOsBroker(
				{ authenticated: true, renewalRequired: true },
				true,
			),
		).toBe(false);
	});
});

describe("OS broker renewal", () => {
	it("renews OS and CLI product sessions inside the server-owned window", () => {
		const now = 1_700_000_000;
		expect(
			isOsBrokerSessionRenewalDue(now + OS_BROKER_RENEWAL_WINDOW_SECONDS, now),
		).toBe(true);
		expect(isOsBrokerSessionRenewalDue(now - 1, now)).toBe(true);
	});

	it("does not pre-renew sufficiently fresh sessions", () => {
		const now = 1_700_000_000;
		expect(
			isOsBrokerSessionRenewalDue(
				now + OS_BROKER_RENEWAL_WINDOW_SECONDS + 1,
				now,
			),
		).toBe(false);
	});
});
