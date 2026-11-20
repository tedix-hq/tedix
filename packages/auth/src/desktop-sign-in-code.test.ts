import { expect, it } from "vite-plus/test";
import {
	openDesktopSignInCode,
	sealDesktopSignInCode,
} from "./desktop-sign-in-code";
import { base64UrlEncode } from "./utils";

const newAppKey = () =>
	crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
		"deriveBits",
	]);

it("a sign-in code opens only in the app instance it was made for", async () => {
	const app = await newAppKey();
	const otherApp = await newAppKey();
	const code = await sealDesktopSignInCode(
		base64UrlEncode(
			new Uint8Array(await crypto.subtle.exportKey("raw", app.publicKey)),
		),
		"one-time-token",
	);
	expect(code).not.toContain("one-time-token");
	await expect(openDesktopSignInCode(app.privateKey, code)).resolves.toBe(
		"one-time-token",
	);
	await expect(
		openDesktopSignInCode(otherApp.privateKey, code),
	).rejects.toThrow();
});
