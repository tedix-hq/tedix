#!/usr/bin/env bun
/**
 * Audit or reconcile the complete Tedix Stripe Billing projection.
 *
 * Dry-run (default), from apps/api with STRIPE_TEST_SECRET_KEY (or
 * STRIPE_SECRET_KEY with --live) set in the environment, lists the prices an
 * apply would create:
 *   bun run scripts/billing/reconcile-stripe.ts --catalog /private/billing.json
 *
 * Apply missing resources/configuration:
 *   bun run scripts/billing/reconcile-stripe.ts --catalog /private/billing.json --apply
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
import { loadBillingCatalog } from "./stripe-catalog";

// Validate the complete operator-owned projection before credentials or network.
const catalogConfig = loadBillingCatalog(process.argv.slice(2), process.env);

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
const meterEventName = catalogConfig.meter.eventName;
const expectedStripeAccountId = requiredEnv("STRIPE_EXPECTED_ACCOUNT_ID");
const catalogVersion = catalogConfig.catalogVersion;
const planCurrency = catalogConfig.currency;
const managedMetadata = {
	tedix_managed: "true",
	tedix_catalog_version: String(catalogVersion),
};
const overageLookupKey = `tedix_token_overage_v${catalogVersion}`;
const overageUnitAmount = catalogConfig.overage.unitAmount;
const overageNickname = catalogConfig.overage.nickname;
const overageMetadata = { ...managedMetadata, tedix_usage: "token_overage" };
const missingPrices: string[] = [];
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

const plans = catalogConfig.plans;
const inferenceCapacityPacks = catalogConfig.inferenceCapacity.packs.map(
	(pack) => ({
		...pack,
		lookupKey: `tedix_inference_capacity_${pack.key}_v${catalogConfig.inferenceCapacity.lookupVersion}`,
	}),
);

async function ensureMeter(): Promise<Stripe.Billing.Meter> {
	const meters = await stripe.billing.meters
		.list({ limit: 100 })
		.autoPagingToArray({ limit: 10_000 });
	const existing = meters.find((meter) => meter.event_name === meterEventName);
	if (existing) return existing;
	if (!apply) throw new Error(`Missing Stripe meter: ${meterEventName}`);
	return stripe.billing.meters.create(
		{
			display_name: catalogConfig.meter.displayName,
			event_name: meterEventName,
			default_aggregation: { formula: "sum" },
			customer_mapping: {
				event_payload_key: "stripe_customer_id",
				type: "by_id",
			},
			value_settings: { event_payload_key: "value" },
		},
		{
			idempotencyKey: `tedix:billing:v${catalogVersion}:meter:${meterEventName}`,
		},
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
			(key === "token_overage" &&
				product.name === catalogConfig.overage.productName),
	);
	if (existing) {
		if (existing.name !== name || existing.metadata.tedix_managed !== "true") {
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
}): Promise<Stripe.Price | null> {
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
				price.currency === planCurrency &&
				price.unit_amount === input.unitAmount),
	);
	if (existing) return existing;
	if (!apply) {
		missingPrices.push(lookupKey);
		return null;
	}
	return stripe.prices.create(
		{
			product: input.productId,
			currency: planCurrency,
			unit_amount: input.unitAmount,
			recurring: { interval: input.interval, usage_type: "licensed" },
			lookup_key: lookupKey,
			nickname: `${catalogConfig.priceLabel} ${input.planKey} ${input.interval}`,
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
}): Promise<Stripe.Price | null> {
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
			existing.currency !== planCurrency ||
			existing.unit_amount !== input.unitAmount)
	) {
		throw new Error(`Stripe price configuration drift: ${input.lookupKey}`);
	}
	if (existing) return existing;
	if (!apply) {
		missingPrices.push(input.lookupKey);
		return null;
	}
	return stripe.prices.create(
		{
			product: input.productId,
			currency: planCurrency,
			unit_amount: input.unitAmount,
			lookup_key: input.lookupKey,
			nickname: `${catalogConfig.priceLabel} inference capacity ${input.packKey}`,
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
): Promise<Stripe.Price | null> {
	const prices = await stripe.prices.list({
		product: productId,
		active: true,
		limit: 100,
	});
	const existing = prices.data.find(
		(price) =>
			price.currency === planCurrency &&
			price.unit_amount === overageUnitAmount &&
			price.recurring?.usage_type === "metered" &&
			price.recurring.meter === meterId &&
			price.transform_quantity?.divide_by === catalogConfig.overage.divideBy &&
			price.transform_quantity.round === "up",
	);
	if (!existing) {
		if (!apply) {
			missingPrices.push(overageLookupKey);
			return null;
		}
		return stripe.prices.create(
			{
				product: productId,
				currency: planCurrency,
				billing_scheme: "per_unit",
				unit_amount: overageUnitAmount,
				recurring: {
					interval: "month",
					meter: meterId,
					usage_type: "metered",
				},
				transform_quantity: {
					divide_by: catalogConfig.overage.divideBy,
					round: "up",
				},
				nickname: overageNickname,
				lookup_key: overageLookupKey,
				metadata: overageMetadata,
			},
			{
				idempotencyKey: `tedix:billing:v${catalogVersion}:price:token_overage`,
			},
		);
	}
	if (
		existing.lookup_key !== overageLookupKey ||
		existing.metadata.tedix_managed !== "true"
	) {
		if (!apply) {
			throw new Error(`Stripe overage price needs metadata: ${existing.id}`);
		}
		return stripe.prices.update(existing.id, {
			nickname: overageNickname,
			lookup_key: overageLookupKey,
			metadata: overageMetadata,
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
		] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
	});
}

async function ensurePortalConfiguration(): Promise<Stripe.BillingPortal.Configuration> {
	const configurations = await stripe.billingPortal.configurations
		.list({ limit: 100 })
		.autoPagingToArray({ limit: 10_000 });
	const existing = configurations.find(
		(configuration) => configuration.metadata?.tedix_managed === "true",
	);
	const params: Stripe.BillingPortal.ConfigurationCreateParams = {
		name: catalogConfig.portal.name,
		default_return_url: osUrl,
		business_profile: {
			headline: catalogConfig.portal.headline,
			privacy_policy_url: catalogConfig.portal.privacyPolicyUrl,
			terms_of_service_url: catalogConfig.portal.termsOfServiceUrl,
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
		if (existing.default_return_url === osUrl) return existing;
		if (!apply) {
			throw new Error(`Stripe portal needs reconciliation: ${existing.id}`);
		}
		return stripe.billingPortal.configurations.update(existing.id, params);
	}
	if (!apply) throw new Error("Missing Tedix Billing Portal configuration");
	return stripe.billingPortal.configurations.create(params);
}

async function main() {
	const account = await stripe.accounts.retrieveCurrent();
	if (account.id !== expectedStripeAccountId) {
		throw new Error(
			`Refusing to reconcile Stripe account ${account.id}; expected ${expectedStripeAccountId}`,
		);
	}
	const meter = await ensureMeter();
	const overageProduct = await ensureProduct(
		"token_overage",
		catalogConfig.overage.productName,
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
			monthlyPriceId: monthlyPrice?.id ?? null,
			annualPriceId: annualPrice?.id ?? null,
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
			priceId: price?.id ?? null,
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
				overagePriceId: overagePrice?.id ?? null,
				webhook: {
					id: webhook.id,
					url: webhook.url,
					enabledEvents: webhook.enabled_events,
				},
				portalConfigurationId: portal.id,
				catalog,
				capacityCatalog,
				missingPrices,
			},
			null,
			2,
		),
	);
}

await main();
