import { describe, expect, it } from "vite-plus/test";
import { buildDeliveryUrl, extractImageId } from "./cf-images";

const IMAGE_ID = "12345678-abcd-4abc-8def-1234567890ab";
const PATH = `/fake-account-hash/${IMAGE_ID}/public`;
const credentialedUrl = new URL(
	buildDeliveryUrl("fake-account-hash", IMAGE_ID),
);
credentialedUrl.username = "user";
credentialedUrl.password = "password";

describe("extractImageId", () => {
	it.each([
		[
			"default variant",
			buildDeliveryUrl("fake-account-hash", IMAGE_ID),
			IMAGE_ID,
		],
		[
			"named variant",
			`https://imagedelivery.net${PATH.replace("public", "avatar")}`,
			IMAGE_ID,
		],
		[
			"flexible variant",
			buildDeliveryUrl("fake-account-hash", IMAGE_ID, "w=64,format=auto"),
			IMAGE_ID,
		],
		[
			"uppercase hex ID",
			buildDeliveryUrl("fake-account-hash", IMAGE_ID.toUpperCase()),
			IMAGE_ID.toUpperCase(),
		],
		[
			"UUID-like ID",
			buildDeliveryUrl("fake-account-hash", "abcdef0123456789"),
			"abcdef0123456789",
		],
		[
			"query and fragment",
			`https://imagedelivery.net${PATH}?download=1#image`,
			IMAGE_ID,
		],
		["case-insensitive hostname", `https://IMAGEDELIVERY.NET${PATH}`, IMAGE_ID],
		["default HTTPS port", `https://imagedelivery.net:443${PATH}`, IMAGE_ID],
	])("accepts %s", (_label, url, expected) => {
		expect(extractImageId(url)).toBe(expected);
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["empty string", ""],
		[
			"foreign host with embedded delivery path",
			`https://example.test/path/imagedelivery.net${PATH}`,
		],
		["suffix lookalike", `https://imagedelivery.net.example.test${PATH}`],
		["prefix lookalike", `https://fakeimagedelivery.net${PATH}`],
		["subdomain", `https://images.imagedelivery.net${PATH}`],
		["hostname in userinfo", `https://imagedelivery.net@example.test${PATH}`],
		[
			"userinfo with embedded delivery path",
			`https://imagedelivery.net@example.test/imagedelivery.net${PATH}`,
		],
		["userinfo on delivery host", credentialedUrl.href],
		[
			"query-only match",
			`https://example.test/?image=https://imagedelivery.net${PATH}`,
		],
		[
			"fragment-only match",
			`https://example.test/#https://imagedelivery.net${PATH}`,
		],
		["legacy R2 URL", `https://legacy.r2.dev${PATH}`],
		["HTTP", `http://imagedelivery.net${PATH}`],
		["nonstandard port", `https://imagedelivery.net:8443${PATH}`],
		["trailing dot hostname", `https://imagedelivery.net.${PATH}`],
		["protocol-relative URL", `//imagedelivery.net${PATH}`],
		["relative URL", `imagedelivery.net${PATH}`],
		["invalid hostname", `https://[imagedelivery.net${PATH}`],
		["invalid port", `https://imagedelivery.net:invalid${PATH}`],
		["missing authority slash", `https:/imagedelivery.net${PATH}`],
		[
			"backslash separator",
			`https://imagedelivery.net\\fake-account-hash/${IMAGE_ID}/public`,
		],
		["embedded newline", `https://image\ndelivery.net${PATH}`],
		["missing hash", `https://imagedelivery.net//${IMAGE_ID}/public`],
		[
			"missing variant",
			`https://imagedelivery.net/fake-account-hash/${IMAGE_ID}`,
		],
		[
			"empty variant",
			`https://imagedelivery.net/fake-account-hash/${IMAGE_ID}/`,
		],
		["extra path prefix", `https://imagedelivery.net/extra${PATH}`],
		["extra path suffix", `https://imagedelivery.net${PATH}/extra`],
		["short ID", buildDeliveryUrl("fake-account-hash", "abcdef")],
		[
			"non-hex ID",
			buildDeliveryUrl("fake-account-hash", "not-a-cloudflare-image-id"),
		],
	])("rejects %s", (_label, url) => {
		expect(extractImageId(url)).toBeNull();
	});
});
