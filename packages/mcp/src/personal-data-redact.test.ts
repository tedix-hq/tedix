import { describe, expect, it } from "vite-plus/test";
import {
	isPersonalDataField,
	redactPersonalDataText,
	redactPersonalDataValue,
} from "./personal-data-redact";

describe("personal-data field patterns", () => {
	it("marks email, phone and national-identifier field names", () => {
		for (const key of [
			"email",
			"emailAddress",
			"contact_email",
			"phone",
			"phoneNumber",
			"mobile",
			"ssn",
			"social_security_number",
			"nationalId",
			"passportNumber",
			"date_of_birth",
			"taxId",
		]) {
			expect(isPersonalDataField(key), key).toBe(true);
		}
	});

	it("leaves ordinary fields alone", () => {
		for (const key of [
			"id",
			"businessId",
			"gmail_id",
			"name",
			"subject",
			"webUrl",
			"address",
			"notes",
			"count",
		]) {
			expect(isPersonalDataField(key), key).toBe(false);
		}
	});
});

describe("value patterns", () => {
	it("masks email addresses inside free text", () => {
		expect(
			redactPersonalDataText(
				"Reach Jane Doe at jane.doe+work@mail.example.com on Monday",
			),
		).toBe("Reach Jane Doe at [REDACTED] on Monday");
	});

	it("masks phone numbers and leaves dates and short ids", () => {
		expect(redactPersonalDataText("Call +1 (415) 555-0132")).toBe(
			"Call [REDACTED]",
		);
		expect(redactPersonalDataText("Call 415-555-0132 today")).toBe(
			"Call [REDACTED] today",
		);
		expect(redactPersonalDataText("Due 2026-11-07, order 123456")).toBe(
			"Due 2026-11-07, order 123456",
		);
	});

	it("masks national identifiers with separators or check letters", () => {
		expect(redactPersonalDataText("SSN 123-45-6789")).toBe("SSN [REDACTED]");
		expect(redactPersonalDataText("NI AB 12 34 56 C")).toBe("NI [REDACTED]");
		// A bare nine-digit run is an id, not an identifier.
		expect(redactPersonalDataText("ref 123456789")).toBe("ref 123456789");
	});
});

describe("structured payloads", () => {
	it("masks personal-data fields and personal data inside other strings", () => {
		const data = {
			id: "cust_123",
			name: "Jane Doe",
			email: "jane@example.com",
			contact: {
				phone: "+1 (415) 555-0132",
				note: "prefers email jane@example.com",
			},
			ssn: "123-45-6789",
			webUrl: "https://crm.example/customers/cust_123",
			tags: ["vip", "callback 415-555-0132"],
		};
		expect(redactPersonalDataValue(data)).toEqual({
			id: "cust_123",
			name: "Jane Doe",
			email: "[REDACTED]",
			contact: {
				phone: "[REDACTED]",
				note: "prefers email [REDACTED]",
			},
			ssn: "[REDACTED]",
			webUrl: "https://crm.example/customers/cust_123",
			tags: ["vip", "callback [REDACTED]"],
		});
	});

	it("masks array entries of a personal-data field and nulls non-strings", () => {
		const data = {
			phones: ["+14155550132", "+442079460958"],
			phone: { countryCode: "+1", number: "4155550132" },
			ssn: 123456789,
			count: 3,
		};
		expect(redactPersonalDataValue(data)).toEqual({
			phones: ["[REDACTED]", "[REDACTED]"],
			phone: { countryCode: "[REDACTED]", number: "[REDACTED]" },
			ssn: null,
			count: 3,
		});
	});
});
