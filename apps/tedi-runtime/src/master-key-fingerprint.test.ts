/**
 * The fleet fingerprint route answers only over a service binding and never
 * echoes the key; a public request falls through to the tedi path (404 here,
 * since the hostname carries no slug).
 */
import assert from "node:assert/strict";
import { masterKeyFingerprints } from "@tedix/db/utils/secrets-encryption";
import { edgeFetch, tediRequest } from "../test/tedi-edge";
import {
	describeMasterKey,
	MASTER_KEY_FINGERPRINT_PATH,
} from "./master-key-fingerprint";

const NEXT = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";
const PREVIOUS = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
const WINDOW = `${NEXT},${PREVIOUS}`;

function fleetRequest(serviceBinding: boolean) {
	return new Request(`https://tedi-runtime${MASTER_KEY_FINGERPRINT_PATH}`, {
		headers: serviceBinding ? { "X-Service-Binding": "true" } : {},
	});
}

// Service binding: both window entries, in order, and no key material.
{
	const { response, forwarded } = await edgeFetch(fleetRequest(true), {
		env: { SECRETS_MASTER_KEY: WINDOW },
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		worker: string;
		fingerprints: string[];
		error?: string;
	};
	assert.equal(body.worker, "tedi-runtime");
	assert.deepEqual(body.fingerprints, await masterKeyFingerprints(WINDOW));
	assert.equal(body.error, undefined);
	const text = JSON.stringify(body);
	assert.ok(!text.includes(NEXT) && !text.includes(PREVIOUS));
	assert.equal(forwarded.length, 0);
}

// Unset secret: reported, not thrown.
{
	const { response } = await edgeFetch(fleetRequest(true), {
		env: { SECRETS_MASTER_KEY: undefined },
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		worker: "tedi-runtime",
		fingerprints: [],
		error: "unset",
	});
}

// Public caller on the fleet host: no slug resolves, so the edge rejects it
// before any route and never answers with fingerprints.
{
	const { response, forwarded } = await edgeFetch(fleetRequest(false), {
		env: { SECRETS_MASTER_KEY: WINDOW },
	});
	assert.equal(response.status, 400);
	assert.ok(!(await response.text()).includes("fingerprints"));
	assert.equal(forwarded.length, 0);
}

// Public caller on a tedi host: the fleet route is skipped and the request
// takes the ordinary tedi path, where the DO knows no such route (404).
{
	const { response } = await edgeFetch(
		tediRequest(MASTER_KEY_FINGERPRINT_PATH),
		{
			env: { SECRETS_MASTER_KEY: WINDOW },
			doResponse: () => new Response("Not Found", { status: 404 }),
		},
	);
	assert.equal(response.status, 404);
	assert.ok(!(await response.text()).includes("fingerprints"));
}

// Malformed key: an error entry rather than a thrown handler.
{
	const entry = await describeMasterKey("tedi-runtime", "not-base64!");
	assert.deepEqual(entry.fingerprints, []);
	assert.match(entry.error ?? "", /not valid base64/);
}

console.log("master-key-fingerprint: ok");
