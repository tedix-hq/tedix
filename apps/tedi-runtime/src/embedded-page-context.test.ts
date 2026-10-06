import assert from "node:assert/strict";
import { normalizeEmbeddedPageContext } from "./embedded-page-context";

assert.deepEqual(
	normalizeEmbeddedPageContext({
		pathname: "/m/orders?status=9",
		entity: { type: "order", id: "123", label: "Orden 123" },
		event: { name: "order.viewed", metadata: { tab: "details", count: 2 } },
	}),
	{
		pathname: "/m/orders?status=9",
		entity: { type: "order", id: "123", label: "Orden 123" },
		event: { name: "order.viewed", metadata: { tab: "details", count: 2 } },
	},
);
assert.equal(
	normalizeEmbeddedPageContext({ pathname: "https://evil.test/m/orders" }),
	undefined,
);
assert.deepEqual(normalizeEmbeddedPageContext({ pathname: "/admin/users" }), {
	pathname: "/admin/users",
});
assert.deepEqual(
	normalizeEmbeddedPageContext({
		pathname: "/widget",
		title: "Tedi Widget",
		description: "Configure the embedded assistant.",
		sections: ["Distribution", "Capacity automation", "Experience health"],
	}),
	{
		pathname: "/widget",
		title: "Tedi Widget",
		description: "Configure the embedded assistant.",
		sections: ["Distribution", "Capacity automation", "Experience health"],
	},
);
assert.equal(
	normalizeEmbeddedPageContext({ pathname: "/api/private" }),
	undefined,
);
assert.deepEqual(
	normalizeEmbeddedPageContext({
		pathname: "/m/dashboard",
		entity: { type: "order<script>", id: "1" },
		event: { name: "bad name", metadata: { nested: { nope: true } } },
	}),
	{ pathname: "/m/dashboard" },
);
