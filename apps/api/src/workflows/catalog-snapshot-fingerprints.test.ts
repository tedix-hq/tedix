import { describe, expect, it } from "vite-plus/test";
import type { CatalogSnapshotItem } from "@tedix/api-contract/schemas/catalog-snapshot";
import {
	FINGERPRINT_VERSION,
	SEEN_PART_SIZE,
	fingerprintListing,
	listingKey,
	packFingerprints,
	seenPartCount,
	usableFingerprints,
} from "./catalog-snapshot-fingerprints";

const item: CatalogSnapshotItem = {
	source: "chatgpt",
	sourceAppId: "a",
	name: "A",
	connectorType: "MCP",
	developerType: "THIRD_PARTY",
};

describe("catalog listing fingerprints", () => {
	it("is the same for the same listing and differs when any field changes", async () => {
		const first = await fingerprintListing(item);
		expect(await fingerprintListing({ ...item })).toBe(first);
		expect(await fingerprintListing({ ...item, name: "B" })).not.toBe(first);
		expect(
			await fingerprintListing({ ...item, rawData: { feed: { id: 1 } } }),
		).not.toBe(first);
	});

	it("keys a listing by store and store id", () => {
		expect(listingKey(item)).toBe("chatgpt:a");
		expect(listingKey({ ...item, source: "claude" })).toBe("claude:a");
	});

	it("reads back what it stored for the same feed marker", () => {
		const stored = JSON.parse(packFingerprints("feed", { "chatgpt:a": "x" }));
		expect(usableFingerprints(stored, "feed")).toEqual({ "chatgpt:a": "x" });
	});

	it("treats another version, another feed marker or junk as no fingerprints", () => {
		const stored = JSON.parse(packFingerprints("feed", { "chatgpt:a": "x" }));
		expect(usableFingerprints(stored, "other")).toEqual({});
		expect(
			usableFingerprints(
				{ ...stored, version: FINGERPRINT_VERSION + 1 },
				"feed",
			),
		).toEqual({});
		expect(usableFingerprints(null, "feed")).toEqual({});
		expect(usableFingerprints("text", "feed")).toEqual({});
		expect(
			usableFingerprints({ version: FINGERPRINT_VERSION }, "feed"),
		).toEqual({});
	});

	it("plans one seen part per started block of unchanged listings", () => {
		expect(seenPartCount(0)).toBe(0);
		expect(seenPartCount(1)).toBe(1);
		expect(seenPartCount(SEEN_PART_SIZE)).toBe(1);
		expect(seenPartCount(SEEN_PART_SIZE + 1)).toBe(2);
	});
});
