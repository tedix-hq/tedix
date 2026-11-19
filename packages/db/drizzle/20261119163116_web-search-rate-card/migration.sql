-- Web search draws Tedix credits through the service rate card (Work-Item
-- b035a564-f807-4db6-8f42-8e197bda081e). One search costs 2 credits (EUR
-- 0.02): a basic Tavily search costs USD 0.008, which is EUR 0.0072 at the
-- pinned ECB rate (USD 1.1181 per EUR), doubled and rounded up like AI use.
-- The provider cost ceiling is the USD micros one search may cost before the
-- service's provider-spend limit counts it as unexpected.
INSERT INTO billing_service_rate_cards (
	id, service_key, operation_key, version, status, provider,
	provider_endpoint, credit_cost, customer_value_micros,
	provider_cost_ceiling_micros, effective_at, metadata
) VALUES (
	'web-search-v1', 'web_search', 'search', 1, 'active',
	'tavily', 'https://api.tavily.com/search',
	2, 10000, 16000, '2026-11-19T00:00:00.000Z',
	'{"pricingVersion":"web-search-v1","providerPricingCheckedAt":"2026-11-19","providers":["tavily","firecrawl","ai-gateway"]}'
);
