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
 * This script is deliberately idempotent. It locates every managed resource by
 * metadata before creating anything. Usage is sold in Tedix credits
 * (1 credit = EUR 0.01): one-time top-up packs, and a pay-as-you-go credit
 * meter for organizations that opt in. The retired daily-boost packs and the
 * token overage price/meter are archived, never deleted.
 */

import Stripe from "stripe";
import {
	CREDIT_METER_EVENT_NAME,
	CREDIT_TOP_UP_PACKS,
	CREDIT_UNIT_AMOUNT_CENTS,
	loadBillingCatalog,
	RETIRED_PRODUCT_KEY_PREFIX,
	RETIRED_TOKEN_OVERAGE_PRODUCT_KEY,
} from "./stripe-catalog";

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
const meterEventName = CREDIT_METER_EVENT_NAME;
const expectedStripeAccountId = requiredEnv("STRIPE_EXPECTED_ACCOUNT_ID");
const catalogVersion = catalogConfig.catalogVersion;
const planCurrency = catalogConfig.currency;
const managedMetadata = {
	tedix_managed: "true",
	tedix_catalog_version: String(catalogVersion),
};
const paygProductKey = "pay_as_you_go_credits";
const paygLookupKey = "tedix_credits_payg_eur_v1";
const paygMetadata = { ...managedMetadata, tedix_usage: "credits_payg" };
const missingPrices: string[] = [];
/** Resources an apply archives; listed in audit mode. */
const retirements: string[] = [];
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
		(product) => product.metadata.tedix_plan_key === key,
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
			tax_behavior: "exclusive",
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

async function ensureTopUpPrice(input: {
	productId: string;
	credits: number;
	lookupKey: string;
	unitAmount: number;
	validMonths: number;
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
			existing.currency !== "eur" ||
			existing.unit_amount !== input.unitAmount ||
			existing.tax_behavior !== "exclusive")
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
			currency: "eur",
			unit_amount: input.unitAmount,
			tax_behavior: "exclusive",
			lookup_key: input.lookupKey,
			nickname: `${catalogConfig.priceLabel} ${input.credits} credits`,
			metadata: {
				...managedMetadata,
				tedix_credit_top_up: "true",
				credits: String(input.credits),
				validMonths: String(input.validMonths),
			},
		},
		{
			idempotencyKey: `tedix:billing:credit-top-up-price:${input.lookupKey}`,
		},
	);
}

async function ensurePayAsYouGoPrice(
	productId: string,
	meterId: string,
): Promise<Stripe.Price | null> {
	const prices = await stripe.prices.list({
		product: productId,
		active: true,
		limit: 100,
	});
	const existing = prices.data.find(
		(price) => price.lookup_key === paygLookupKey,
	);
	if (
		existing &&
		(existing.currency !== "eur" ||
			existing.unit_amount !== CREDIT_UNIT_AMOUNT_CENTS ||
			existing.recurring?.usage_type !== "metered" ||
			existing.recurring.meter !== meterId ||
			existing.tax_behavior !== "exclusive" ||
			existing.transform_quantity)
	) {
		throw new Error(`Stripe price configuration drift: ${paygLookupKey}`);
	}
	if (existing) return existing;
	if (!apply) {
		missingPrices.push(paygLookupKey);
		return null;
	}
	return stripe.prices.create(
		{
			product: productId,
			currency: "eur",
			billing_scheme: "per_unit",
			unit_amount: CREDIT_UNIT_AMOUNT_CENTS,
			tax_behavior: "exclusive",
			recurring: { interval: "month", meter: meterId, usage_type: "metered" },
			nickname: catalogConfig.payAsYouGo.nickname,
			lookup_key: paygLookupKey,
			metadata: paygMetadata,
		},
		{ idempotencyKey: `tedix:billing:price:${paygLookupKey}` },
	);
}

/**
 * Archive the retired daily-boost packs and the token overage product: their
 * active prices, then the product. A meter only the token overage price used
 * is deactivated. Nothing is deleted, so past invoices keep their references.
 */
async function retireLegacyCatalog(creditMeterId: string): Promise<void> {
	const products = await stripe.products
		.list({ limit: 100, active: true })
		.autoPagingToArray({ limit: 10_000 });
	const retired = products.filter((product) => {
		const key = product.metadata.tedix_plan_key ?? "";
		return (
			key.startsWith(RETIRED_PRODUCT_KEY_PREFIX) ||
			key === RETIRED_TOKEN_OVERAGE_PRODUCT_KEY
		);
	});
	const legacyMeters = new Set<string>();
	for (const product of retired) {
		const prices = await stripe.prices
			.list({ product: product.id, active: true, limit: 100 })
			.autoPagingToArray({ limit: 10_000 });
		for (const price of prices) {
			const meter = price.recurring?.meter;
			if (meter && meter !== creditMeterId) legacyMeters.add(meter);
			retirements.push(`price:${price.id}`);
			if (apply) await stripe.prices.update(price.id, { active: false });
		}
		retirements.push(`product:${product.id}`);
		if (apply) await stripe.products.update(product.id, { active: false });
	}
	for (const meterId of legacyMeters) {
		retirements.push(`meter:${meterId}`);
		if (apply) await stripe.billing.meters.deactivate(meterId);
	}
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
	const paygProduct = await ensureProduct(
		paygProductKey,
		catalogConfig.payAsYouGo.productName,
	);
	const paygPrice = await ensurePayAsYouGoPrice(paygProduct.id, meter.id);
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
	const topUpCatalog = [];
	for (const pack of CREDIT_TOP_UP_PACKS) {
		const product = await ensureProduct(pack.productKey, pack.name);
		const price = await ensureTopUpPrice({
			productId: product.id,
			credits: pack.credits,
			lookupKey: pack.lookupKey,
			unitAmount: pack.unitAmount,
			validMonths: pack.validMonths,
		});
		topUpCatalog.push({
			credits: pack.credits,
			productId: product.id,
			priceId: price?.id ?? null,
			lookupKey: pack.lookupKey,
		});
	}
	await retireLegacyCatalog(meter.id);
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
				payAsYouGoProductId: paygProduct.id,
				payAsYouGoPriceId: paygPrice?.id ?? null,
				webhook: {
					id: webhook.id,
					url: webhook.url,
					enabledEvents: webhook.enabled_events,
				},
				portalConfigurationId: portal.id,
				catalog,
				topUpCatalog,
				missingPrices,
				[apply ? "retired" : "toRetire"]: retirements,
			},
			null,
			2,
		),
	);
}

await main();
