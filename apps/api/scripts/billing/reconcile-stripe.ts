#!/usr/bin/env bun
/**
 * Audit or reconcile the complete Tedix Stripe Billing projection.
 *
 * Dry-run (default), from apps/api with STRIPE_TEST_SECRET_KEY (or
 * STRIPE_SECRET_KEY with --live) set in the environment:
 *   bun run scripts/billing/reconcile-stripe.ts
 *
 * Apply missing resources/configuration:
 *   bun run scripts/billing/reconcile-stripe.ts --apply
 *
 * Installation coordinates come from the environment: STRIPE_EXPECTED_ACCOUNT_ID
 * (the Stripe account the projection must live in), TEDIX_API_URL (webhook
 * origin) and TEDIX_OS_URL (billing portal return origin).
 *
 * This script is deliberately idempotent. It adopts the existing Tedix token
 * meter/overage price when their immutable configuration matches, and locates
 * every managed resource by metadata before creating anything.
 */

import Stripe from "stripe";

const stripeEnvironment = process.argv.includes("--live") ? "live" : "test";
const secretKey =
	stripeEnvironment === "live"
		? process.env.STRIPE_SECRET_KEY
		: process.env.STRIPE_TEST_SECRET_KEY;
if (!secretKey) {
	throw new Error(
		`Missing ${stripeEnvironment === "live" ? "STRIPE_SECRET_KEY" : "STRIPE_TEST_SECRET_KEY"}`,
	);
}
if (
	(stripeEnvironment === "test" && !secretKey.startsWith("sk_test_")) ||
	(stripeEnvironment === "live" && !secretKey.startsWith("sk_live_"))
) {
	throw new Error(`Stripe key does not match --${stripeEnvironment} mode`);
}

const apply = process.argv.includes("--apply");
const stripe = new Stripe(secretKey, {
	httpClient: Stripe.createFetchHttpClient(),
});

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing ${name}: set it in the environment`);
	}
	return value;
}

const apiUrl = requiredEnv("TEDIX_API_URL");
const webhookUrl = `${apiUrl}/webhooks/stripe${stripeEnvironment === "test" ? "/test" : ""}`;
const osUrl = requiredEnv("TEDIX_OS_URL");
const meterEventName = "token_usage";
const expectedStripeAccountId = requiredEnv("STRIPE_EXPECTED_ACCOUNT_ID");
const catalogVersion = 3;
const managedMetadata = {
	tedix_managed: "true",
	tedix_catalog_version: String(catalogVersion),
};
const requiredWebhookEvents: Stripe.WebhookEndpointCreateParams.EnabledEvent[] =
	[
		"checkout.session.completed",
		"charge.refunded",
		"customer.subscription.created",
		"customer.subscription.updated",
		"customer.subscription.deleted",
		"invoice.paid",
		"invoice.payment_failed",
	];

const plans = [
	{
		key: "growth",
		name: "Tedix Growth",
		monthlyAmount: 24_900,
		annualAmount: 239_900,
		overage: true,
	},
	{
		key: "business",
		name: "Tedix Business",
		monthlyAmount: 49_900,
		annualAmount: 479_900,
		overage: true,
	},
	{
		key: "enterprise",
		name: "Tedix Enterprise",
		monthlyAmount: 99_900,
		annualAmount: 959_900,
		overage: false,
	},
] as const;

const inferenceCapacityPacks = [
	{
		key: "daily_5m",
		name: "Tedix 5M Daily Inference Boost",
		unitAmount: 2_500,
		lookupKey: "tedix_inference_capacity_daily_5m_v1",
	},
] as const;

async function ensureMeter(): Promise<Stripe.Billing.Meter> {
	const meters = await stripe.billing.meters
		.list({ limit: 100 })
		.autoPagingToArray({ limit: 10_000 });
	const existing = meters.find((meter) => meter.event_name === meterEventName);
	if (existing) return existing;
	if (!apply) throw new Error(`Missing Stripe meter: ${meterEventName}`);
	return stripe.billing.meters.create(
		{
			display_name: "Tedix Token Usage",
			event_name: meterEventName,
			default_aggregation: { formula: "sum" },
			customer_mapping: {
				event_payload_key: "stripe_customer_id",
				type: "by_id",
			},
			value_settings: { event_payload_key: "value" },
		},
		{ idempotencyKey: `tedix:billing:v${catalogVersion}:meter:token_usage` },
	);
}

async function ensureProduct(
	key: string,
	name: string,
): Promise<Stripe.Product> {
	const products = await stripe.products
		.list({ limit: 100 })
		.autoPagingToArray({ limit: 10_000 });
	const existing = products.find(
		(product) =>
			product.metadata.tedix_plan_key === key ||
			(key === "token_overage" && product.name === "Tedix Token Overage"),
	);
	if (existing) {
		if (
			existing.name !== name ||
			existing.metadata.tedix_managed !== "true" ||
			existing.metadata.tedix_catalog_version !== String(catalogVersion)
		) {
			if (!apply) {
				throw new Error(`Stripe product needs reconciliation: ${existing.id}`);
			}
			return stripe.products.update(existing.id, {
				name,
				metadata: { ...managedMetadata, tedix_plan_key: key },
			});
		}
		return existing;
	}
	if (!apply) throw new Error(`Missing Stripe product: ${key}`);
	return stripe.products.create(
		{
			name,
			metadata: { ...managedMetadata, tedix_plan_key: key },
		},
		{
			idempotencyKey: `tedix:billing:v${catalogVersion}:product:${key}`,
		},
	);
}

async function ensureLicensedPrice(input: {
	productId: string;
	planKey: string;
	interval: "month" | "year";
	unitAmount: number;
}): Promise<Stripe.Price> {
	const lookupKey = `tedix_${input.planKey}_${input.interval}_v${catalogVersion}`;
	const prices = await stripe.prices.list({
		product: input.productId,
		active: true,
		limit: 100,
	});
	const existing = prices.data.find(
		(price) =>
			price.lookup_key === lookupKey ||
			(price.recurring?.interval === input.interval &&
				price.recurring.usage_type === "licensed" &&
				price.currency === "usd" &&
				price.unit_amount === input.unitAmount),
	);
	if (existing) return existing;
	if (!apply) throw new Error(`Missing Stripe price: ${lookupKey}`);
	return stripe.prices.create(
		{
			product: input.productId,
			currency: "usd",
			unit_amount: input.unitAmount,
			recurring: { interval: input.interval, usage_type: "licensed" },
			lookup_key: lookupKey,
			nickname: `Tedix ${input.planKey} ${input.interval}`,
			metadata: {
				...managedMetadata,
				tedix_plan_key: input.planKey,
				tedix_interval: input.interval,
			},
		},
		{
			idempotencyKey: `tedix:billing:v${catalogVersion}:price:${lookupKey}`,
		},
	);
}

async function ensureInferenceCapacityPrice(input: {
	productId: string;
	packKey: string;
	lookupKey: string;
	unitAmount: number;
}): Promise<Stripe.Price> {
	const prices = await stripe.prices.list({
		product: input.productId,
		active: true,
		limit: 100,
	});
	const existing = prices.data.find(
		(price) => price.lookup_key === input.lookupKey,
	);
	if (
		existing &&
		(existing.type !== "one_time" ||
			existing.currency !== "usd" ||
			existing.unit_amount !== input.unitAmount)
	) {
		throw new Error(`Stripe price configuration drift: ${input.lookupKey}`);
	}
	if (existing) return existing;
	if (!apply) throw new Error(`Missing Stripe price: ${input.lookupKey}`);
	return stripe.prices.create(
		{
			product: input.productId,
			currency: "usd",
			unit_amount: input.unitAmount,
			lookup_key: input.lookupKey,
			nickname: `Tedix inference capacity ${input.packKey}`,
			metadata: {
				...managedMetadata,
				tedix_inference_capacity_pack_key: input.packKey,
			},
		},
		{
			idempotencyKey: `tedix:billing:v${catalogVersion}:inference-capacity-price:${input.packKey}`,
		},
	);
}

async function ensureOveragePrice(
	productId: string,
	meterId: string,
): Promise<Stripe.Price> {
	const prices = await stripe.prices.list({
		product: productId,
		active: true,
		limit: 100,
	});
	const existing = prices.data.find(
		(price) =>
			price.currency === "usd" &&
			price.unit_amount === 5 &&
			price.recurring?.usage_type === "metered" &&
			price.recurring.meter === meterId &&
			price.transform_quantity?.divide_by === 1_000 &&
			price.transform_quantity.round === "up",
	);
	if (!existing) {
		if (!apply) throw new Error("Missing compatible Tedix overage price");
		return stripe.prices.create(
			{
				product: productId,
				currency: "usd",
				billing_scheme: "per_unit",
				unit_amount: 5,
				recurring: {
					interval: "month",
					meter: meterId,
					usage_type: "metered",
				},
				transform_quantity: { divide_by: 1_000, round: "up" },
				nickname: "Tedix token overage - $0.05/1K tokens",
				lookup_key: `tedix_token_overage_v${catalogVersion}`,
				metadata: { ...managedMetadata, tedix_usage: "token_overage" },
			},
			{
				idempotencyKey: `tedix:billing:v${catalogVersion}:price:token_overage`,
			},
		);
	}
	if (
		existing.lookup_key !== `tedix_token_overage_v${catalogVersion}` ||
		existing.metadata.tedix_managed !== "true" ||
		existing.metadata.tedix_catalog_version !== String(catalogVersion)
	) {
		if (!apply) {
			throw new Error(`Stripe overage price needs metadata: ${existing.id}`);
		}
		return stripe.prices.update(existing.id, {
			nickname: "Tedix token overage - $0.05/1K tokens",
			lookup_key: `tedix_token_overage_v${catalogVersion}`,
			metadata: { ...managedMetadata, tedix_usage: "token_overage" },
		});
	}
	return existing;
}

async function ensureWebhook(): Promise<Stripe.WebhookEndpoint> {
	const endpoints = await stripe.webhookEndpoints
		.list({ limit: 100 })
		.autoPagingToArray({ limit: 10_000 });
	const existing = endpoints.find((endpoint) => endpoint.url === webhookUrl);
	if (!existing) {
		throw new Error(
			`Missing ${webhookUrl}; create it in Stripe so its signing secret can be stored before running this script`,
		);
	}
	const enabled = new Set(existing.enabled_events);
	const missing = requiredWebhookEvents.filter((event) => !enabled.has(event));
	if (missing.length === 0) return existing;
	if (!apply) {
		throw new Error(`Stripe webhook is missing events: ${missing.join(", ")}`);
	}
	return stripe.webhookEndpoints.update(existing.id, {
		enabled_events: [
			...new Set([...existing.enabled_events, ...requiredWebhookEvents]),
		],
	});
}

async function ensurePortalConfiguration(): Promise<Stripe.BillingPortal.Configuration> {
	const configurations = await stripe.billingPortal.configurations
		.list({ limit: 100 })
		.autoPagingToArray({ limit: 10_000 });
	const existing = configurations.find(
		(configuration) => configuration.metadata.tedix_managed === "true",
	);
	const params: Stripe.BillingPortal.ConfigurationCreateParams = {
		name: "Tedix Billing Portal",
		default_return_url: osUrl,
		business_profile: {
			headline: "Manage your Tedix subscription",
			privacy_policy_url: "https://tedix.dev/privacy",
			terms_of_service_url: "https://tedix.dev/terms",
		},
		features: {
			customer_update: {
				enabled: true,
				allowed_updates: ["address", "email", "name", "tax_id"],
			},
			invoice_history: { enabled: true },
			payment_method_update: { enabled: true },
			subscription_cancel: {
				enabled: true,
				mode: "at_period_end",
				proration_behavior: "none",
				cancellation_reason: {
					enabled: true,
					options: [
						"too_expensive",
						"missing_features",
						"switched_service",
						"unused",
						"other",
					],
				},
			},
			subscription_update: { enabled: false },
		},
		metadata: managedMetadata,
	};
	if (existing) {
		if (
			existing.default_return_url === osUrl &&
			existing.metadata.tedix_catalog_version === String(catalogVersion)
		) {
			return existing;
		}
		if (!apply) {
			throw new Error(`Stripe portal needs reconciliation: ${existing.id}`);
		}
		return stripe.billingPortal.configurations.update(existing.id, params);
	}
	if (!apply) throw new Error("Missing Tedix Billing Portal configuration");
	return stripe.billingPortal.configurations.create(params);
}

async function main() {
	const account = await stripe.accounts.retrieve();
	if (account.id !== expectedStripeAccountId) {
		throw new Error(
			`Refusing to reconcile Stripe account ${account.id}; expected ${expectedStripeAccountId}`,
		);
	}
	const meter = await ensureMeter();
	const overageProduct = await ensureProduct(
		"token_overage",
		"Tedix Token Overage",
	);
	const overagePrice = await ensureOveragePrice(overageProduct.id, meter.id);
	const catalog = [];
	for (const plan of plans) {
		const product = await ensureProduct(plan.key, plan.name);
		const monthlyPrice = await ensureLicensedPrice({
			productId: product.id,
			planKey: plan.key,
			interval: "month",
			unitAmount: plan.monthlyAmount,
		});
		const annualPrice = await ensureLicensedPrice({
			productId: product.id,
			planKey: plan.key,
			interval: "year",
			unitAmount: plan.annualAmount,
		});
		catalog.push({
			planKey: plan.key,
			productId: product.id,
			monthlyPriceId: monthlyPrice.id,
			annualPriceId: annualPrice.id,
			overagePriceId: plan.overage ? overagePrice.id : null,
		});
	}
	const capacityCatalog = [];
	for (const pack of inferenceCapacityPacks) {
		const product = await ensureProduct(
			`inference_capacity_${pack.key}`,
			pack.name,
		);
		const price = await ensureInferenceCapacityPrice({
			productId: product.id,
			packKey: pack.key,
			lookupKey: pack.lookupKey,
			unitAmount: pack.unitAmount,
		});
		capacityCatalog.push({
			packKey: pack.key,
			productId: product.id,
			priceId: price.id,
			lookupKey: pack.lookupKey,
		});
	}
	const webhook = await ensureWebhook();
	const portal = await ensurePortalConfiguration();

	console.log(
		JSON.stringify(
			{
				mode: apply ? "applied" : "audit",
				stripeEnvironment,
				accountId: account.id,
				catalogVersion,
				meterId: meter.id,
				overageProductId: overageProduct.id,
				overagePriceId: overagePrice.id,
				webhook: {
					id: webhook.id,
					url: webhook.url,
					enabledEvents: webhook.enabled_events,
				},
				portalConfigurationId: portal.id,
				catalog,
				capacityCatalog,
			},
			null,
			2,
		),
	);
}

await main();
