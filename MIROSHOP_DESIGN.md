# MiroShop AI — Master Design & Implementation Plan
> Version 1.5 | Last updated: 2026-03-29 | Engine: MiroFish (github.com/666ghj/MiroFish)

---

## Table of Contents
0. [Positioning: What This App IS and IS NOT](#0-positioning-what-this-app-is-and-is-not)
1. [System Overview](#1-system-overview)
2. [Technical Architecture](#2-technical-architecture)
3. [Value Architecture & Retention](#3-value-architecture--retention)
4. [Shop-Type Adaptive Agent System](#4-shop-type-adaptive-agent-system)
5. [Token Economics & Cost Control](#5-token-economics--cost-control)
6. [Failure Mode Matrix](#6-failure-mode-matrix)
7. [The Structured Friction Engine (MiroFish)](#7-the-structured-friction-engine-mirofish)
8. [Weekly Retention Engine](#8-weekly-retention-engine)
9. [Tiered Simulation Quality](#9-tiered-simulation-quality)
10. [UI/UX Specification](#10-uiux-specification)
11. [Monetization Strategy](#11-monetization-strategy)
12. [Inter-Service API Contracts](#12-inter-service-api-contracts)
13. [Repository Structure](#13-repository-structure)
14. [Implementation Phases](#14-implementation-phases)
15. [Critical Implementation Decisions](#15-critical-implementation-decisions)
16. [Risks & Mitigations](#16-risks--mitigations)

### Critical Gaps Addressed in v1.4
- **Gap 1:** [Progressive Reporting — Latency & Time-to-Value](#gap-1-progressive-reporting--latency--time-to-value)
- **Gap 2:** [Visual Intelligence — Vision Model Integration](#gap-2-visual-intelligence--vision-model-integration)
- **Gap 3:** [Phase 0 — Pre-Launch Landing Page Validation](#gap-3-phase-0--pre-launch-landing-page-validation)
- **Gap 4:** [Anti-Churn — Ad-Creative Sandbox & Competitor Delta](#gap-4-anti-churn--ad-creative-sandbox--competitor-delta)

### Real-World Friction Points Addressed in v1.5
- **Gap 5:** [Response Diversity & Anti-Templating Strategy](#gap-5-response-diversity--anti-templating-strategy)
- **Gap 6:** [Mobile-First Dashboard & Digest](#gap-6-mobile-first-dashboard--digest)
- **Gap 7:** [Scraping Resilience — Proxy Rotation Layer](#gap-7-scraping-resilience--proxy-rotation-layer)
- **Gap 8:** [Expectation Management UI — The Traffic Gap](#gap-8-expectation-management-ui--the-traffic-gap)

---

## 0. Positioning: What This App IS and IS NOT

This section is **non-negotiable**. It governs every product decision, every UI copy choice, every agent prompt, and every API response label. Getting this wrong risks Shopify banning the app.

### What This App IS NOT

- **NOT a prediction tool.** We do not predict the future. We do not claim "your product will convert at X%". Shopify bans apps that make sales predictions or revenue forecasts because they mislead merchants.
- **NOT a guarantee.** We do not say "if you do X, you will sell Y more units."
- **NOT a market research tool.** We are not surveying real humans or scraping real consumer data.

### What This App IS

**A decision-support tool powered by swarm intelligence.**

We simulate a panel of dedicated, niche-specific AI agents that represent the *type* of customers who shop at that store. These agents debate each other — honestly, critically, and without being "too nice" — and surface the friction points, objections, and concerns that real customers are likely to have.

The output is not a prediction. It is **structured customer intelligence** that helps the merchant make a more informed decision.

### The Mental Model to Communicate to Merchants

> "Imagine hiring a focus group of 50 people who are exactly your kind of customers — cigar enthusiasts, dog owners, sneaker collectors — and asking them to honestly critique your product listing before you spend money on ads. That's what MiroShop does. Automatically. Every week."

### Language Rules (applied everywhere: UI, emails, agent prompts, API field names)

| ❌ BANNED (prediction language) | ✅ USE INSTEAD (decision language) |
|--------------------------------|----------------------------------|
| "Will convert at 62%" | "62 out of 100 simulated customers said they'd buy" |
| "Predicted revenue uplift" | "Potential friction removed" |
| "Sales forecast" | "Customer readiness audit" |
| "This product will sell" | "Your simulated customers responded positively" |
| "Purchase Probability Index" | **"Customer Confidence Score"** |
| "Conversion rate prediction" | "Customer panel response rate" |
| "Your product will perform better" | "Your simulated panel raised fewer objections" |
| "ROI prediction" | "Decision confidence" |
| "Market success rate" | "Panel buy rate" |

### Why Agents MUST NOT Just Agree

This is not just a technical requirement — it is the **core value proposition**.

If agents agree with everything, merchants get false confidence and make bad decisions. That destroys trust and causes churn. The entire point of "Structured Friction" (MiroFish's core mechanism) is to force honest pushback:

- **Price too high?** The Budget Optimizer says so — bluntly.
- **No social proof?** The Brand Loyalist refuses to buy.
- **Missing specs?** The Research Analyst walks away.
- **Bad first image?** The Impulse Decider bounces immediately.

An agent that always agrees is useless. An agent that argues, objects, and demands better — that's what makes a merchant's listing stronger.

The system must enforce disagreement through prompt design:
1. Each archetype has hardcoded rejection thresholds (price >15% above baseline = Budget Optimizer rejects)
2. If a cluster reaches >80% agreement, the Research Analyst is injected as a mandatory dissenter
3. The debate is not done until at least one archetype raises a concrete, specific objection
4. The report leads with objections first, positives second

---

## 1. System Overview

MiroShop AI is a **decision-support tool** for Shopify merchants, powered by swarm intelligence. It deploys a panel of 50 AI agents specifically calibrated to the merchant's store type — cigar shop agents for cigar shops, dog owner agents for pet shops — who debate and critique products the way real customers would.

**What makes it different from every other Shopify app:**
- Agents are *dedicated* to the merchant's shop. They are not generic. A cigar shop's agents understand tobacco grades, ring gauge, aging, and pricing norms. A pet shop's agents know ingredient quality, vet recommendations, and brand trust signals.
- Agents are designed to **disagree**. The system injects friction, challenges positivity, and forces objections. Merchants get honest feedback, not flattery.
- It runs **automatically every week** without the merchant doing anything. They open their email Monday morning and see how their products are performing — which ones need attention, which improved, what changed.

**The core loop:** Surface friction → Merchant fixes it → Score improves → Merchant sees the improvement → Trust in the tool grows → Merchant upgrades.

**Infrastructure:**
- Orchestration: Cloudflare Workers (Hono.js)
- Persistence: Neon.tech (serverless PostgreSQL)
- Inference Engine: Hetzner VPS — **MiroFish** (Flask) + Ollama (Llama-3-8B) + OASIS (CAMEL-AI)
- Vision Model: Ollama (Moondream2) — co-hosted on same Hetzner VPS
- Queue: Upstash Redis
- Email: Resend
- Agent Memory: Zep Cloud (knowledge graph) — see Decision 8

---

## 2. Technical Architecture

### 2.1 Orchestration Layer — Cloudflare Workers
- Framework: Hono.js
- Handles: Shopify HMAC verification, OAuth 2.0 app installation, session management
- Connects to Neon via `@neondatabase/serverless` (WebSocket proxy)
- Triggers Hetzner FastAPI via `fetch` with bearer token authentication
- Rate limiting per store via Upstash Redis

### 2.2 Persistence Layer — Neon.tech

```sql
-- stores
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
shopify_domain        TEXT UNIQUE NOT NULL
access_token          TEXT NOT NULL           -- encrypted at rest
plan_tier             TEXT NOT NULL DEFAULT 'free'  -- 'free' | 'pro' | 'enterprise'
monthly_mt_used       INT NOT NULL DEFAULT 0
monthly_mt_budget     INT NOT NULL DEFAULT 30
billing_cycle_start   TIMESTAMPTZ
classification_status TEXT DEFAULT 'pending'  -- 'ok' | 'fallback' | 'manual'
created_at            TIMESTAMPTZ DEFAULT now()

-- simulations
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
store_id              UUID REFERENCES stores(id) ON DELETE CASCADE
product_id            TEXT NOT NULL
product_data          JSONB NOT NULL          -- snapshot at run time
status                TEXT NOT NULL DEFAULT 'queued'  -- 'queued'|'running'|'completed'|'failed'|'cancelled'
purchase_probability  NUMERIC(5,2)            -- 0.00 - 100.00
friction_price        NUMERIC(5,2)
friction_trust        NUMERIC(5,2)
friction_logistics    NUMERIC(5,2)
agent_mode            TEXT NOT NULL DEFAULT 'single'  -- 'single' | 'swarm'
estimated_mt_cost     INT
actual_mt_cost        INT
created_at            TIMESTAMPTZ DEFAULT now()
completed_at          TIMESTAMPTZ

-- agent_logs
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
simulation_id         UUID REFERENCES simulations(id) ON DELETE CASCADE
agent_index           INT NOT NULL            -- 0-49
cluster_id            INT NOT NULL            -- 1-5
archetype             TEXT NOT NULL           -- 'budget_optimizer' etc.
phase                 TEXT NOT NULL           -- 'vibe_check' | 'watercooler' | 'consensus'
vote                  TEXT NOT NULL           -- 'buy' | 'reject'
reasoning             TEXT NOT NULL
confidence            NUMERIC(3,2)
round                 INT NOT NULL DEFAULT 1
created_at            TIMESTAMPTZ DEFAULT now()

-- store_agent_contexts (niche persona blocks, generated once, reused)
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
store_id              UUID REFERENCES stores(id) ON DELETE CASCADE
archetype_id          INT NOT NULL            -- 1-5
context_text          TEXT NOT NULL           -- ~100 tokens of niche-specific context
created_at            TIMESTAMPTZ DEFAULT now()
UNIQUE(store_id, archetype_id)

-- token_usage (for real-time cost tracking)
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
store_id              UUID REFERENCES stores(id)
simulation_id         UUID REFERENCES simulations(id)
tokens_used           INT NOT NULL
mt_used               NUMERIC(6,2) NOT NULL
created_at            TIMESTAMPTZ DEFAULT now()

-- weekly_scans
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
store_id              UUID REFERENCES stores(id) ON DELETE CASCADE
week_start            DATE NOT NULL
shop_health_score     NUMERIC(5,2)
products_scanned      INT
status                TEXT NOT NULL DEFAULT 'pending'  -- 'pending'|'completed'|'failed'
created_at            TIMESTAMPTZ DEFAULT now()

-- simulation_phases (Gap 1: progressive reporting — each phase emits partial results)
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
simulation_id         UUID REFERENCES simulations(id) ON DELETE CASCADE
phase                 TEXT NOT NULL           -- 'vibe_check' | 'watercooler' | 'consensus'
status                TEXT NOT NULL DEFAULT 'pending'  -- 'pending'|'running'|'completed'
customer_confidence   NUMERIC(5,2)            -- partial score available after each phase
agent_count_buy       INT
agent_count_reject    INT
top_objection         TEXT                    -- surfaced immediately for Vibe Check
completed_at          TIMESTAMPTZ
created_at            TIMESTAMPTZ DEFAULT now()

-- visual_analyses (Gap 2: vision model results per product image)
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
simulation_id         UUID REFERENCES simulations(id) ON DELETE CASCADE
image_url             TEXT NOT NULL
visual_quality_score  INT NOT NULL            -- 0-100
issues                JSONB NOT NULL          -- ["plain white background", "no lifestyle context"]
dominant_constraint   TEXT                    -- the single most critical visual issue
created_at            TIMESTAMPTZ DEFAULT now()

-- phase0_leads (Gap 3: pre-Shopify landing page captures)
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
email                 TEXT NOT NULL
product_url           TEXT NOT NULL
shop_url              TEXT
status                TEXT NOT NULL DEFAULT 'queued'  -- 'queued'|'processing'|'emailed'|'failed'
simulation_id         UUID REFERENCES simulations(id)
source                TEXT DEFAULT 'landing_page'
created_at            TIMESTAMPTZ DEFAULT now()

-- ad_creative_checks (Gap 4: ad copy panel checks)
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
store_id              UUID REFERENCES stores(id) ON DELETE CASCADE
product_id            TEXT NOT NULL
ad_copy               TEXT NOT NULL           -- the headline/body text submitted
ad_platform           TEXT NOT NULL           -- 'facebook' | 'google' | 'tiktok'
simulation_id         UUID REFERENCES simulations(id)
customer_confidence   NUMERIC(5,2)
key_objections        JSONB
created_at            TIMESTAMPTZ DEFAULT now()

-- competitor_deltas (Gap 4: competitor comparison per weekly scan)
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
store_id              UUID REFERENCES stores(id) ON DELETE CASCADE
competitor_url        TEXT NOT NULL
competitor_product_data JSONB               -- scraped/fetched product data snapshot
competitor_confidence NUMERIC(5,2)
our_confidence        NUMERIC(5,2)
delta                 NUMERIC(5,2)            -- our_confidence - competitor_confidence
gap_analysis          JSONB                   -- where we lose: price/trust/logistics
week_start            DATE NOT NULL
created_at            TIMESTAMPTZ DEFAULT now()
```

### 2.3 Inference Engine — Hetzner VPS (Built on MiroFish)

**Repository:** https://github.com/666ghj/MiroFish (cloned and extended — do NOT rewrite from scratch)

MiroFish is a Python Flask multi-agent swarm intelligence engine that uses:
- **OASIS (camel-oasis 0.2.5)** — the underlying agent simulation engine (originally built for Twitter/Reddit simulations, repurposed for product debates)
- **Zep Cloud** — persistent knowledge graph and agent memory
- **OpenAI-compatible LLM client** — points to local Ollama endpoint

#### MiroFish Services We Reuse Directly

| MiroFish Service | File | How MiroShop Uses It |
|-----------------|------|---------------------|
| `OasisProfileGenerator` | `services/oasis_profile_generator.py` | Generates 50 niche-specific agent personas from store classification |
| `SimulationConfigGenerator` | `services/simulation_config_generator.py` | Configures debate round parameters per tier |
| `ReportAgent` | `services/report_agent.py` | ReACT-loop analysis that writes the friction report |
| `LLMClient` | `utils/llm_client.py` | OpenAI-compatible wrapper pointing to Ollama |
| `SimulationIPC` | `services/simulation_ipc.py` | Inter-agent communication during debates |
| `ZepGraphMemoryUpdater` | `services/zep_graph_memory_updater.py` | Persists agent actions to knowledge graph |

#### MiroShop Extensions (New Code on Top of MiroFish)

| New Service | Purpose |
|-------------|---------|
| `ShopifyIngestionService` | Converts Shopify product JSON into MiroFish seed material format |
| `NicheClassifier` | Classifies store niche → generates 5 archetype context blocks |
| `DebateOrchestrator` | Implements Vibe Check → Watercooler → Consensus pipeline |
| `TokenBudgetMiddleware` | MT tracking, pre-sim checks, kill switches |
| `CallbackService` | Posts async results back to Cloudflare Worker |

#### MiroFish Components We Replace/Skip

| MiroFish Component | Why Replaced |
|-------------------|-------------|
| Flask frontend (Vue.js) | Replaced by Shopify Polaris embedded app |
| Graph construction from PDFs | Product data comes from Shopify API, not uploaded files |
| Twitter/Reddit OASIS scripts | Replaced by custom debate simulation script |

#### LLM Configuration for Ollama

```python
# .env on Hetzner
LLM_API_BASE=http://localhost:11434/v1   # Ollama OpenAI-compatible endpoint
LLM_API_KEY=ollama                        # Ollama doesn't need a real key
LLM_MODEL=llama3:8b-instruct
LLM_TEMPERATURE=0.7
```

**Concurrency:** Max 2 simultaneous simulations (controlled by Redis queue)

---

## 3. Value Architecture & Retention

### Core Value Loop
```
Scan → Score → Alert → Act → Improve → Re-scan (next week)
```

When a merchant acts on a recommendation (rewrites a description, adjusts price) and sees their score improve the following Monday, that feedback loop creates retention no other Shopify app can replicate.

### Free Tier Conversion Pressure
- 3 simulations per month — enough to prove value, not enough to be satisfied
- Weekly auto-scan of **1 product only** — other products grayed out with "Upgrade to track all"
- Reports show PPI score + **2 friction points** only — Pro unlocks all 5 categories + agent quotes + trends
- Token estimate shown before every simulation: "This will use 7 of your 16 remaining monthly tokens"
- The first simulation must deliver a genuine "aha moment" in under 90 seconds

### Merchant Success Timeline

| Milestone | State |
|-----------|-------|
| **Week 1** | Ran first simulation, saw surprising friction points they hadn't considered, made one listing change based on a recommendation |
| **Month 1** | Used all 3 free sims, receiving weekly email, saw score change after their edit — attribution established |
| **Month 3 (Pro)** | All products tracked weekly, Shop Health Score trending up, using Monday digest as a core operational tool |

---

## 4. Shop-Type Adaptive Agent System

### 4.1 Store Classification Pipeline

Runs once at app install (~0.5 MT). Refreshed when catalog changes >20% or merchant manually overrides.

**Data sources (priority order):**
1. `product_type` field — aggregate top 3 most frequent across catalog
2. Collection names — "Premium Cigars", "Dog Food", "Engagement Rings"
3. Vendor/brand tags
4. Store name and meta description from Shopify API
5. Top 10 product titles by inventory count

**LLM returns structured JSON (~200 tokens input, ~50 output):**
```json
{
  "primary_niche": "premium cigars",
  "niche_category": "tobacco_and_smoking",
  "customer_profile_summary": "Adult enthusiasts valuing craftsmanship, origin, aging, and ritual",
  "typical_price_sensitivity": "low",
  "purchase_frequency": "recurring_monthly",
  "gift_purchase_likelihood": "high"
}
```

**Fallbacks:**
1. LLM fails or confidence <0.5 → Use "General Retail" profile, mark `classification_status: 'fallback'`
2. Retry on next simulation
3. Merchant can self-select from ~30 common niches in settings (manual override)

### 4.2 The Five Universal Psychographic Archetypes

These five roles generalize across **any** retail niche — they are structural positions in a purchase decision, not personality types.

| # | Archetype | Core Behavior | What They Reveal |
|---|-----------|--------------|-----------------|
| 1 | **Budget Optimizer** | Compares price/value, hunts deals, abandons on high shipping, price-per-unit sensitive | Pricing friction, value communication gaps |
| 2 | **Brand Loyalist** | Buys on reputation, reviews, social proof — resistant to switching, will pay premium for trust | Trust signal gaps, review quality, brand storytelling |
| 3 | **Research Analyst** | Reads every spec, compares alternatives, checks ingredients/materials — needs full info before buying | Missing specs, unclear descriptions, information gaps |
| 4 | **Impulse Decider** | Emotional response, visual appeal, urgency cues — short attention span, influenced by imagery and scarcity | Weak imagery, missing urgency cues, UX friction |
| 5 | **Gift Seeker** | Buying for someone else — needs gifting cues, size guides, return policies, packaging info | Missing gift wrap options, unclear returns, size guide gaps |

**Examples across niches:**
- Cigar shop: Research Analyst checks wrapper type, ring gauge, origin, tasting notes, aging duration
- Pet shop: Research Analyst checks ingredient quality, vet recommendations; Budget Optimizer compares price/lb
- Jewelry: Gift Seeker dominates; Impulse Decider responds to lifestyle photography; Brand Loyalist needs reviews

### 4.3 Niche Context Injection

Each archetype receives a 3-layer prompt:
```
BASE PROMPT         (~150 tokens, universal, hardcoded)
+ NICHE CONTEXT     (~100 tokens, generated once per store, stored in DB)
+ PRODUCT CONTEXT   (~200 tokens, per simulation, from Shopify product data)
```

The 5 niche context blocks are generated at classification time in a single LLM call and stored in `store_agent_contexts`. **Reused for every simulation at zero additional LLM cost.**

**Example niche context for "premium cigars":**
- Budget Optimizer: *"You compare price per cigar, box deals vs. singles, and shipping costs for temperature-sensitive products. You know Nicaraguan fillers are generally cheaper than Cuban-seed alternatives."*
- Research Analyst: *"You evaluate wrapper type, binder, filler origin, ring gauge, length, strength rating, and aging duration. You check whether tasting notes are provided and whether the description matches known profiles for that blend."*

Regeneration trigger: store reclassified (catalog >20% change) or manual niche override.

---

## 5. Token Economics & Cost Control

### 5.1 The MiroShop Token (MT)
1 MT = 1,000 LLM tokens (input + output combined). This abstraction insulates merchants from model-specific pricing and lets the operator adjust the exchange rate without changing tier definitions.

### 5.2 Per-Simulation Cost Breakdown

| Component | LLM tokens | MT |
|-----------|-----------|-----|
| Store classification (one-time at install) | ~500 | 0.5 MT |
| Niche context generation (one-time at install) | ~2,000 | 2 MT |
| Per-agent vibe check (5 agents × ~800 tokens) | ~4,000 | 4 MT |
| Debate round (1 round, ~1,500 tokens) | ~1,500 | 1.5 MT |
| Report synthesis | ~1,000 | 1 MT |
| **Free tier total per simulation** | **~7,000** | **~7 MT** |
| **Pro tier total (25 agents, 5 rounds)** | **~35,000** | **~35 MT** |
| **Enterprise total (50 agents, 10 rounds)** | **~60,000** | **~60 MT** |

### 5.3 Tier Monthly Budgets

| Tier | Monthly MT | Simulations (approx) | Auto-scan products | Overage policy |
|------|-----------|----------------------|-------------------|----------------|
| **Free** | 30 MT | 3 lightweight | 1 | Hard stop. No exceptions. |
| **Pro ($29/mo)** | 500 MT | ~8 full / ~70 lite | 25 | Warn at 80%, hard stop at 100%. $5/100 MT add-on packs. |
| **Enterprise ($99/mo)** | 2,000 MT | ~33 full | Unlimited | Warn at 80%, 10% grace buffer, operator alert at 100%. |

### 5.4 Pre-Simulation Token Estimate

Shown to merchant in UI **before** they confirm a simulation. No LLM call required.

```
estimated_cost_mt = base_cost_per_tier + (description_length / 500 × 0.5 MT)
```

UI display: *"This simulation will use approximately **7 of your 16 remaining** monthly tokens."*

### 5.5 Hard Kill Switches

Pre-simulation middleware check (runs before ANY job is queued):
```
1. Estimate simulation cost (formula above)
2. Check: monthly_mt_used + estimated_cost > monthly_mt_budget
   → REJECT with HTTP 429: "Monthly token budget exhausted. Resets on [date]."
3. Check: global_daily_spend > OPERATOR_DAILY_BUDGET_LIMIT
   → REJECT ALL stores + trigger PagerDuty alert to operator
```

Operator kill switch: `GLOBAL_KILL_SWITCH=true` environment variable stops all queue processing instantly.

### 5.6 Abuse Prevention

| Threat | Detection | Response |
|--------|-----------|----------|
| Account farming | Same IP creating >3 stores/24h; same Shopify partner ID across stores | Rate-limit: 2 store creations/IP/day; flag for manual review |
| Reinstall to reset budget | Track budget by `shop_id` (Shopify immutable ID), not `installation_id` | Budget follows the shop, not the install |
| Token stuffing (huge descriptions) | Input validation before LLM ingestion | Truncate product descriptions to 2,000 chars silently; log if original >5,000 |
| Abnormal request patterns | >10 sim requests/min from one store | Auto-throttle to 1/min per store; alert operator |

### 5.7 Real-Time Cost Tracking

- Redis counter `mt:store:{id}:month:{YYYY-MM}` — incremented after every LLM call (fast path, no DB round-trip on hot path)
- Redis counter `mt:global:day:{YYYY-MM-DD}` — operator-wide daily spend
- Hourly Cron reconciles Redis to Neon DB (source of truth)

**Operator alerts:**

| Threshold | Alert Level |
|-----------|-------------|
| Global daily spend >50% by noon | Warning |
| Global daily spend >80% | Critical |
| Global monthly spend >90% | Critical |
| Single store consuming >20% of global daily budget | Anomaly — investigate |

---

## 6. Failure Mode Matrix

| # | Failure | Detection | Immediate Response | Recovery | Severity |
|---|---------|-----------|-------------------|----------|----------|
| 1 | **Ollama inference engine down** | Health ping every 30s; 3 failures = down | Pause queue; return 503 to new requests with "Simulations temporarily unavailable" | systemd auto-restart; PagerDuty if still down after 5 min; jobs retry ×3 then marked failed + merchant notified | CRITICAL |
| 2 | **LLM produces malformed output** | JSON parse / Pydantic validation failure | Retry prompt ×2 with stricter "You MUST respond in valid JSON" suffix | >2 agents fail → abort sim, refund MT, notify merchant. Skip one agent → run with N-1, note in report. | HIGH |
| 3 | **LLM hallucination (plausible but wrong)** | Sanity-check agent (Pro+) cross-references consensus against Shopify product data | Flag low-confidence sections with visual "Low confidence" badge in report | Log pattern for prompt tuning; build regression test suite of known-bad outputs | MEDIUM |
| 4 | **Store classification fails** | LLM returns unparseable output or confidence <0.5 | Use "General Retail" fallback immediately; mark `classification_status: 'fallback'` | Retry on next simulation; offer manual niche dropdown in settings | LOW |
| 5 | **Shopify API rate limit** | HTTP 429 received; parse `Retry-After` header | Exponential backoff from `Retry-After`; use KV-cached product data (1h TTL) if available | Queue resumes after backoff; no data loss | MEDIUM |
| 6 | **Neon connection pool exhausted** | Connection timeout errors; pool >90% utilization | New sims return 503; queue consumer pauses 30s | Auto-recovers as connections release; alert operator if sustained >5 min | HIGH |
| 7 | **Hetzner VPS down entirely** | External uptime monitor (BetterStack) 3 failures = down | Worker returns static maintenance page; queue pauses | Hetzner auto-restart + Terraform/Ansible reprovisioning; Redis AOF-persisted = no queue loss; Neon external = no data loss | CRITICAL |
| 8 | **Redis queue corruption** | Unparseable job payloads on dequeue | Move corrupted entries to dead-letter queue; continue valid entries | Rebuild queue from `simulations` table in Neon (all pending sims have a DB record) | HIGH |
| 9 | **Callback delivery fails permanently** | 5 retries with backoff over 24h all fail | Mark `delivery_failed`; results remain in Neon (pull model always works) | Email merchant: "Your simulation results are ready — view in dashboard." Results never lost. | MEDIUM |
| 10 | **Free tier budget exhausted** | `monthly_mt_used >= monthly_mt_budget` | Hard stop; show upgrade prompt in UI | Resets on billing cycle. `shop_id` tracking prevents reinstall-reset exploit. | LOW |
| 11 | **50+ stores simulate simultaneously** | Queue depth >30 pending jobs | Jobs wait in queue (queue is serial per Ollama) | Priority order: Enterprise → Pro → Free. Queue depth >100 → pause Free tier submissions. | MEDIUM |
| 12 | **Shopify OAuth token revoked mid-sim** | HTTP 401 from Shopify during product fetch | Abort sim; refund MT; mark `auth_status: 'revoked'` | Re-auth flow on next merchant visit; email: "Please reconnect MiroShop to your store" | HIGH |
| 13 | **Merchant uninstalls during active sim** | `app/uninstalled` webhook received | Mark sim `cancelled`; stop processing remaining agents | Retain data 30 days (GDPR). Restore on reinstall. | LOW |
| 14 | **Weekly scan fails silently** | Watchdog job runs 2h after scheduled scan; checks expected records exist in DB | Re-trigger missing scans immediately; alert operator if >10% of stores missed | Email merchant: "We couldn't complete your scan this week — retrying tomorrow." Never fail silently. | HIGH |

---

## 7. The Structured Friction Engine (Built on MiroFish)

### 7.1 MiroFish Integration Flow

MiroFish's existing 5-stage pipeline maps to MiroShop as follows:

```
MIROFISH STAGE               → MIROSHOP MAPPING
─────────────────────────────────────────────────────────────────
Stage 1: Graph Construction  → ShopifyIngestionService converts
                               product JSON + market baseline into
                               Zep knowledge graph seed material.
                               Entity types = the 5 archetypes.

Stage 2: Environment Setup   → OasisProfileGenerator creates 50
                               agent profiles using store's niche
                               context blocks as enrichment data.
                               sentiment_bias set per archetype.

Stage 3: Simulation          → DebateOrchestrator runs a CUSTOM
                               OASIS script (not Twitter/Reddit)
                               that implements the 3-phase debate.

Stage 4: Report Generation   → ReportAgent (ReACT loop) reads
                               agent_logs and Zep graph to produce
                               the friction report. Custom tools
                               added for MiroShop-specific analysis.

Stage 5: Deep Interaction    → What-If Sandbox: SimulationIPC
                               queries agents with price/shipping
                               override parameters for delta sims.
```

### 7.2 Enforcing Genuine Disagreement (Anti-Sycophancy Rules)

These rules are enforced at the prompt and orchestrator level. They are non-negotiable.

**Rule 1 — Hardcoded rejection thresholds per archetype:**

| Archetype | Automatic rejection trigger |
|-----------|---------------------------|
| Budget Optimizer | Price >15% above market baseline |
| Brand Loyalist | Fewer than 3 visible reviews OR no recognizable brand signal |
| Research Analyst | Missing key spec (size/weight/ingredients/material depending on niche) |
| Impulse Decider | First product image is plain white background with no lifestyle context |
| Gift Seeker | No mention of gift wrapping, returns policy, or delivery timeframe |

If a rejection threshold is triggered, the agent **must** vote "no buy" regardless of other factors. This is injected as a hard rule in the system prompt: *"If [condition], you MUST vote 'no buy' and explain why. This is not negotiable."*

**Rule 2 — Mandatory dissenter injection:**

If any cluster reaches >80% "buy" consensus after the Vibe Check, the Research Analyst archetype is re-prompted with: *"Your peers are too optimistic. Your job is to find the flaw they missed. Look harder. There is always something wrong."*

**Rule 3 — Debate is not done until a concrete objection exists:**

The Consensus phase checks: does the final report contain at least one specific, actionable objection per friction category (Price, Trust, Logistics)? If any category has zero objections, a follow-up agent prompt is triggered: *"You haven't identified any [Price/Trust/Logistics] concerns. Look again. What would make a [archetype] hesitate?"*

**Rule 4 — Report structure: objections first:**

The friction report always leads with what's wrong, not what's right. The "positive signals" section comes last, is shorter, and is clearly labeled as secondary. Merchants must see their problems before they see their strengths.

**Rule 5 — No generic feedback:**

Agent reasoning must reference specific product data. "The price seems high" is rejected. "At $42.99 this is 18% above the $36.50 average for 5-packs in this category, which will cause Budget Optimizers to comparison-shop" is accepted. The orchestrator validates reasoning length (>50 words) and presence of a specific data reference before accepting an agent's output.

### 7.3 The Recursive Debate Algorithm (Custom OASIS Script)

```
Step 1 — INGESTION
  ShopifyIngestionService: fetch product JSON → build Zep graph entities
  NicheClassifier: load store's 5 archetype context blocks from Neon DB
  OasisProfileGenerator: generate N agent profiles (5/25/50 per tier)
  Each profile has: archetype, niche_context, sentiment_bias, activity_level

Step 2 — VIBE CHECK (independent, concurrent per cluster)
  Each agent receives: product context + market baseline + their persona
  LLMClient.chat_json() enforces JSON output:
    { vote: "buy"|"reject", reasoning: string, confidence: 0.0-1.0 }
  Agents within same cluster run concurrently (OASIS parallel execution)
  All outputs logged via action_logger.py → agent_logs table

Step 3 — WATERCOOLER (cluster debate)
  Agents within each cluster receive peers' vibe check reasoning
  Each agent responds to peers (SimulationIPC for inter-agent comms)
  If cluster consensus >80% positive: inject "Research Analyst" dissent
  ZepGraphMemoryUpdater: persist debate actions to knowledge graph
  Compress debate transcript to ≤500 tokens before next round

Step 4 — CONSENSUS
  Final vote collected from all agents
  Purchase Probability Index = (buy_count / total_agents) × 100
  ReportAgent (ReACT loop) classifies rejections → Price/Trust/Logistics
  Sanity-check agent validates consensus vs. Shopify product data (Pro+)
  ZepTools: retrieve supporting evidence from knowledge graph for report

Step 5 — PERSIST & CALLBACK
  All agent logs saved to Neon agent_logs table (100% of debate text)
  Zep graph updated with simulation outcome
  Simulation record updated with PPI and friction scores
  CallbackService: POST results to Cloudflare Worker callback URL
```

### 7.2 Cluster Composition Per Tier

| Tier | Total Agents | Agents per Archetype |
|------|-------------|---------------------|
| Free | 5 | 1 each |
| Pro | 25 | 5 each |
| Enterprise | 50 | 10 each |

### 7.3 Context Drift Prevention

After each debate round, a summary agent compresses the full debate transcript into ≤500 tokens. This summary (not the raw transcript) is fed into the next round. Prompt instructs the summarizer to preserve all unique objections.

Each agent receives a hard token budget of 2,000 tokens per round. Context is truncated if the budget is exceeded (oldest context dropped first).

### 7.4 Prompt Architecture

```
SYSTEM PROMPT:
  "You are [Archetype Name]. [Base archetype description ~150 tokens].
   [Niche context block ~100 tokens].
   You MUST respond in valid JSON: { vote, reasoning, confidence }"

USER PROMPT:
  "Product: [title, price, description (truncated to 2000 chars), images count]
   Market baseline: [avg_price, avg_shipping_days, competitor_count]
   [Previous round summary if applicable]"
```

---

## 8. Weekly Retention Engine

### 8.1 Scheduled Job Architecture

- **Cloudflare Cron Trigger:** Every Monday 06:00 UTC
- Hits `/api/internal/weekly-scan` on the Worker
- Worker queries all stores with `weekly_scan_enabled = true`
- Enqueues one `weekly_scan` job per store into Redis
- Queue consumer on Hetzner processes each store (lightweight sims)
- After all products scanned → `weekly_digest` job generates email

**Watchdog:** A second Cron runs at 08:00 UTC Monday, checks that expected scan records exist. If any store missed their scan, re-triggers. Alerts operator if >10% of stores missed.

### 8.2 Product Selection for Auto-Scan

| Tier | Products auto-scanned |
|------|----------------------|
| Free | 1 — highest-revenue product (or merchant manual selection) |
| Pro | Top 25 by revenue; merchant can customize the list |
| Enterprise | All active products |

### 8.3 Alert Triggers (Week-over-Week)

| Condition | Alert Level | Example Message |
|-----------|-------------|----------------|
| PPI drop >10 points | Red | "Premium Cigar Sampler dropped 74→62. Agents flagged new pricing friction." |
| PPI drop 5-10 points | Yellow | "Slight decline on Dog Food 30lb — review the report." |
| PPI increase >10 points | Green | "Your Engagement Ring listing improved 58→71! Your description changes worked." |
| New friction category (not present last week) | Orange | "New issue: Gift Buyers flagging missing gift wrapping options." |
| Top revenue product declining 3+ weeks | Red | "Your #1 revenue product has trended down for 3 consecutive weeks." |

### 8.4 Weekly Email Digest

**Subject:** `MiroShop Weekly: Your Shop Health Score is [72] (+3 from last week)`

**Body:**
1. Large Shop Health Score with color coding (green/yellow/red) + 8-week sparkline
2. Top 2-3 product movers (biggest changes, up and down) with one-line explanations
3. 1-2 specific actionable recommendations (reference the actual product and friction — never generic advice)
4. Upgrade CTA (Free tier only): "You're tracking 1 of 47 products. Untracked products could have issues you're missing."
5. One-click deep link to full dashboard for that week's results

### 8.5 Shop Health Score

```
SHS = SUM(product_ppi × product_revenue_share)
where product_revenue_share = product_revenue / total_tracked_revenue
```

Revenue-weighted so that optimizing high-revenue products moves the score meaningfully. Fallback to equal weighting if Shopify analytics data unavailable (noted in UI).

---

## 9. Tiered Simulation Quality

| Attribute | Free | Pro ($29/mo) | Enterprise ($99/mo) |
|-----------|------|-------------|---------------------|
| Agents per simulation | 5 (1/archetype) | 25 (5/archetype) | 50 (10/archetype) |
| LLM Model | Llama-3-8B | Llama-3-8B | Llama-3-8B (or 70B if GPU provisioned) |
| Debate rounds | 1 | 5 | 10 |
| Max tokens/sim | ~7,000 (7 MT) | ~35,000 (35 MT) | ~60,000 (60 MT) |
| Monthly MT budget | 30 MT | 500 MT | 2,000 MT |
| Weekly auto-scan | 1 product | 25 products | Unlimited |
| Report: friction categories | 2 | 5 (all) | 5 + raw debate transcript |
| Report: agent quotes | No | Yes | Yes |
| Report: historical trends | No | Yes (8 weeks) | Yes (full history) |
| Report: PDF export | No | No | Yes |
| Sanity-check agent | No | Yes | Yes |
| Queue priority | Lowest | Normal | Highest |
| Support | Docs only | Email, 48h | Dedicated onboarding, 24h |

### Free Tier UX
- Large PPI score circle for the one evaluated product
- Two friction points with brief explanations
- "See full report" section is blurred with "Upgrade to Pro" lock
- Upgrade CTA shows number of remaining simulations this month
- Weekly email with single-product score trend

### Pro Tier UX
- Dashboard showing all tracked products with PPI scores and trend sparklines
- Shop Health Score prominently displayed
- Full reports with all friction categories, agent quotes, specific recommendations
- Week-over-week comparison charts
- What-If Sandbox available

---

## 10. UI/UX Specification

All UI copy follows the language rules from Section 0. No prediction language anywhere.

### Merchant Dashboard (Shopify Polaris)

**Customer Confidence Score** (replaces "Purchase Probability Index" — decision language, not prediction language)
- Dynamic SVG speedometer showing Customer Confidence Score (0-100)
- Subtitle beneath the score: *"X out of 100 simulated [cigar enthusiasts / dog owners / sneaker collectors] said they'd buy this"*
- Color gradient: red (0-30), yellow (30-60), green (60-100)
- Animated needle on load
- Tooltip: *"This score reflects how your dedicated customer panel responded — not a sales forecast"*

**Customer Panel Visualizer** (replaces "Swarm Visualizer")
- 5×N grid of circular avatars (5 archetypes × agents per tier)
- Green fill = "I'd buy", Red fill = "I wouldn't buy"
- Archetype row labels show niche-specific names: not "Research Analyst" but "Cigar Researchers" / "Dog Food Comparers" — generated from store classification
- Hover/click → Polaris Popover showing verbatim agent objection or reason (specific, not generic)
- Cluster grouping visually distinct with archetype icon

**Friction Report** (objections first — see Section 0, Rule 4)
- Header: *"What your customer panel flagged"*
- 3 Polaris Cards: **Price Friction**, **Trust Friction**, **Logistics Friction** — ordered by severity (most objections first)
- Each card shows: % of panel who raised this concern + top 3 verbatim agent quotes
- Action framing: *"What to fix"* label above each card, not *"Problems"*
- Below the 3 cards: a smaller *"What's working"* section with positive signals (always last, always shorter)

**Decision Explorer** (replaces "What-If Sandbox" — decision-support framing)
- Header: *"How would your customer panel respond if you changed this?"*
- Polaris RangeSlider for price (±50% of current) and shipping days (1-14)
- Button: *"Run Panel Check"* (not "Predict" or "Simulate")
- Result: before/after Customer Confidence Score + which specific objections were resolved
- Copy: *"Lowering price by $5 resolved 8 Budget Optimizer objections (from 14 to 6)"*
- Gated behind Pro — Free users see: *"Explore how changes affect your panel — upgrade to Pro"*

---

## 11. Monetization Strategy

| Tier | Price | Limits | Key Features |
|------|-------|--------|-------------|
| **Free** | $0 | 3 panel checks/mo, 1 auto-scan product, 30 MT budget | 5-agent panel, Customer Confidence Score, 2 friction areas, weekly digest (1 product) |
| **Pro** | $29.90/mo | 500 MT budget, 25 auto-scan products | 25-agent panel, full friction report, verbatim agent quotes, historical trends, Decision Explorer, sanity check |
| **Enterprise** | $89.00/mo | 2,000 MT budget, unlimited auto-scan, priority queue | 50-agent panel, full debate transcripts, PDF export, competitor panel comparison, dedicated support |

**MT add-on packs (Pro only):** $5 per 100 MT extra.

**Billing:** Shopify Billing API (`recurringApplicationChargeCreate`). Budget follows `shop_id` — uninstall + reinstall does NOT reset the monthly budget counter.

---

## 12. Inter-Service API Contracts

All Cloudflare Worker API responses use the envelope:
```json
{ "success": boolean, "data": T | null, "error": string | null }
```

### Worker → Engine: POST /simulate
```json
Request:
{
  "simulation_id": "uuid",
  "product": {
    "title": "string",
    "description": "string (max 2000 chars)",
    "price": "29.99",
    "currency": "USD",
    "images": ["url1"],
    "vendor": "string"
  },
  "market_baseline": {
    "average_price": "27.50",
    "average_shipping_days": 5,
    "competitor_count": 12
  },
  "niche_contexts": [
    { "archetype_id": 1, "context_text": "You compare price per cigar..." },
    ...
  ],
  "agent_mode": "single | swarm",
  "agent_count": 5,
  "debate_rounds": 1,
  "callback_url": "https://worker.miroshop.ai/api/simulation/callback"
}

Response (202 Accepted):
{
  "status": "accepted",
  "simulation_id": "uuid",
  "estimated_seconds": 120
}
```

### Engine → Worker: POST /api/simulation/callback
```json
{
  "simulation_id": "uuid",
  "status": "completed | failed",
  "actual_tokens_used": 6840,
  "result": {
    "purchase_probability": 62.5,
    "friction": {
      "price": 28.0,
      "trust": 15.0,
      "logistics": 8.0
    },
    "sanity_check": {
      "confidence": 87,
      "flagged_sections": []
    },
    "agent_logs": [
      {
        "agent_index": 0,
        "cluster_id": 1,
        "archetype": "budget_optimizer",
        "phase": "vibe_check",
        "vote": "reject",
        "reasoning": "Price is 22% above market baseline...",
        "confidence": 0.82,
        "round": 1
      }
    ]
  },
  "error": null
}
```

### Worker → Engine: POST /simulate/delta (What-If Sandbox)
```json
Request:
{
  "simulation_id": "uuid",
  "overrides": {
    "price": "24.99",
    "shipping_days": 3
  }
}

Response (202 Accepted):
{
  "status": "accepted",
  "delta_simulation_id": "uuid",
  "estimated_seconds": 60
}
```

### Worker: GET /api/simulation/:id (polling)
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "completed",
    "purchase_probability": 62.5,
    "friction": { "price": 28.0, "trust": 15.0, "logistics": 8.0 },
    "agents": [...],
    "estimated_mt_cost": 7,
    "actual_mt_cost": 6.84,
    "created_at": "ISO8601",
    "completed_at": "ISO8601"
  },
  "error": null
}
```

### Worker: POST /api/simulation (trigger)
```json
Request:  { "product_id": "gid://shopify/Product/123456" }
Response: { "success": true, "data": { "simulation_id": "uuid", "status": "queued", "estimated_cost_mt": 7, "remaining_mt_after": 9 }, "error": null }
```

---

## 13. Repository Structure

```
miroshop-ai/
├── packages/
│   ├── worker/                        # Cloudflare Worker (Hono.js)
│   │   ├── src/
│   │   │   ├── index.ts               # Hono app entrypoint
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts            # Shopify OAuth + HMAC
│   │   │   │   ├── simulation.ts      # Trigger / status / callback / delta
│   │   │   │   ├── webhooks.ts        # Shopify product + billing webhooks
│   │   │   │   └── billing.ts         # Plan management
│   │   │   ├── middleware/
│   │   │   │   ├── hmac.ts            # HMAC verification (constant-time)
│   │   │   │   ├── session.ts         # Session management
│   │   │   │   └── rateLimit.ts       # Per-store rate limiting via Redis
│   │   │   ├── services/
│   │   │   │   ├── neon.ts            # DB client (WebSocket proxy)
│   │   │   │   ├── inference.ts       # Fetch to FastAPI with bearer token
│   │   │   │   ├── redis.ts           # Upstash Redis client
│   │   │   │   ├── shopify.ts         # Product fetch + KV cache
│   │   │   │   └── classification.ts  # Store niche classification
│   │   │   ├── cron/
│   │   │   │   ├── weeklyScans.ts     # Monday 06:00 UTC trigger
│   │   │   │   └── watchdog.ts        # Monday 08:00 UTC verification
│   │   │   └── config.ts              # Environment bindings
│   │   └── wrangler.toml
│   │
│   ├── engine/                        # Hetzner VPS — MiroFish (cloned + extended)
│   │   │
│   │   │   # === MIROFISH CORE (from github.com/666ghj/MiroFish — DO NOT REWRITE) ===
│   │   ├── backend/
│   │   │   ├── run.py                         # MiroFish Flask entrypoint
│   │   │   ├── app/
│   │   │   │   ├── services/
│   │   │   │   │   ├── oasis_profile_generator.py     # Generates 50 agent personas ← REUSE
│   │   │   │   │   ├── simulation_config_generator.py # Debate parameters per tier ← REUSE
│   │   │   │   │   ├── report_agent.py                # ReACT friction report loop ← REUSE
│   │   │   │   │   ├── simulation_ipc.py              # Inter-agent communication ← REUSE
│   │   │   │   │   ├── zep_graph_memory_updater.py    # Persist actions to graph ← REUSE
│   │   │   │   │   └── zep_tools.py                   # Knowledge graph queries ← REUSE
│   │   │   │   └── utils/
│   │   │   │       ├── llm_client.py                  # OpenAI-compat → Ollama ← REUSE
│   │   │   │       └── retry.py                       # Fault tolerance ← REUSE
│   │   │   │
│   │   │   │   # === MIROSHOP EXTENSIONS (new code on top of MiroFish) ===
│   │   │   │   ├── miroshop/
│   │   │   │   │   ├── api/
│   │   │   │   │   │   ├── routes.py          # /simulate, /simulate/delta, /health
│   │   │   │   │   │   └── schemas.py         # Pydantic models (strict JSON)
│   │   │   │   │   ├── services/
│   │   │   │   │   │   ├── shopify_ingestion.py   # Product JSON → Zep graph seed
│   │   │   │   │   │   ├── niche_classifier.py    # Store niche → archetype contexts
│   │   │   │   │   │   ├── debate_orchestrator.py # Vibe Check → Watercooler → Consensus
│   │   │   │   │   │   ├── token_budget.py        # MT tracking + kill switches
│   │   │   │   │   │   └── callback_service.py    # POST results to Cloudflare Worker
│   │   │   │   │   ├── archetypes/
│   │   │   │   │   │   └── definitions.py         # 5 universal archetype base prompts
│   │   │   │   │   └── scripts/
│   │   │   │   │       └── run_product_debate.py  # Custom OASIS script (replaces Twitter/Reddit scripts)
│   │   │   │   └── tests/
│   │   │   │       ├── test_debate_orchestrator.py
│   │   │   │       ├── test_niche_classifier.py
│   │   │   │       ├── test_shopify_ingestion.py
│   │   │   │       └── test_api.py
│   │   │
│   │   ├── Dockerfile                         # MiroFish + Ollama + MiroShop extensions
│   │   ├── docker-compose.yml                 # Flask + Ollama services
│   │   └── .env.example                       # LLM_API_BASE=http://localhost:11434/v1
│   │
│   ├── dashboard/                     # Shopify Embedded App (React + Polaris)
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── pages/
│   │   │   │   ├── SimulationPage.tsx
│   │   │   │   ├── ResultsPage.tsx
│   │   │   │   └── SandboxPage.tsx
│   │   │   ├── components/
│   │   │   │   ├── SuccessGauge.tsx   # SVG speedometer
│   │   │   │   ├── SwarmGrid.tsx      # 5×N avatar grid
│   │   │   │   ├── FrictionReport.tsx # 3 friction cards
│   │   │   │   └── WhatIfSliders.tsx  # Price/shipping sliders
│   │   │   └── hooks/
│   │   │       ├── useSimulation.ts
│   │   │       └── usePolling.ts
│   │   └── package.json
│   │
│   └── db/                            # Database migrations
│       ├── migrations/
│       │   ├── 001_stores.sql
│       │   ├── 002_simulations.sql
│       │   ├── 003_agent_logs.sql
│       │   ├── 004_store_agent_contexts.sql
│       │   ├── 005_token_usage.sql
│       │   └── 006_weekly_scans.sql
│       └── seed.sql
│
├── docs/
│   ├── api-contracts.md
│   └── deployment.md
│
└── .github/
    └── workflows/
        ├── worker-deploy.yml          # wrangler deploy on push to main
        ├── engine-deploy.yml          # Docker build → GHCR → SSH deploy to Hetzner
        └── dashboard-deploy.yml
```

---

## 14. Implementation Phases

### Phase 1: Foundation (5-7 days) — Medium Risk
**Goal:** All three services boot, connect, and pass health checks. No business logic.

1. Initialize pnpm monorepo with workspaces
2. Neon DB migrations (all 6 tables with indexes)
3. Cloudflare Worker skeleton (Hono) + `/health` endpoint (pings Neon + Redis + Engine)
4. FastAPI + Docker Compose + Ollama on Hetzner (model pre-loaded; `ollama keep_alive` set)
5. Upstash Redis connectivity verified
6. Worker → Engine network path verified with `X-Engine-Secret` bearer token

**Exit criteria:**
- `GET /health` on Worker returns `{ "neon": true, "redis": true, "engine": true }`
- `GET /health` on Engine returns `{ "ollama_available": true, "model_loaded": "llama3:8b-instruct" }`
- All DB tables accept inserts
- Docker Compose boots cleanly

---

### Phase 2: Shopify Integration (5-7 days) — Medium-High Risk
**Goal:** Merchant can install the app; system can fetch their product catalog.

1. HMAC verification middleware (constant-time comparison via `crypto.subtle.timingSafeEqual`)
2. OAuth 2.0 flow with encrypted token storage in Neon
3. Session management middleware
4. Shopify Admin GraphQL product fetch (KV cache 15 min, respects rate limit headers)
5. Store niche classification (one-time LLM call at install, stored in DB)
6. Niche context block generation (5 blocks per store, stored in `store_agent_contexts`)
7. `products/update` and `app/uninstalled` webhooks

**Exit criteria:**
- Full OAuth install flow works on a Shopify development store
- Niche classification runs and stores context blocks
- Fallback to General Retail profile when classification fails

---

### Phase 3: Inference Engine — MiroFish Integration (10-14 days) — HIGH Risk (Critical Path)
**Goal:** MiroFish running on Hetzner with MiroShop extensions, accepting Shopify products and returning scored debate results.

**First: clone MiroFish and verify it boots**
```bash
git clone https://github.com/666ghj/MiroFish
# Configure .env: LLM_API_BASE=http://localhost:11434/v1, LLM_MODEL=llama3:8b-instruct
# Verify OasisProfileGenerator, LLMClient, ReportAgent all work against Ollama
```

1. Configure MiroFish LLMClient to point to local Ollama (OpenAI-compatible endpoint)
2. Verify `OasisProfileGenerator` generates valid agent profiles from test input
3. Implement `ShopifyIngestionService` — converts product JSON to MiroFish seed format (Zep graph entities)
4. Implement `NicheClassifier` — single LLM call → store classification → 5 archetype context blocks stored in Neon
5. Implement `DebateOrchestrator` — orchestrates MiroFish services through 3 debate phases
6. Write custom OASIS script `run_product_debate.py` (replaces Twitter/Reddit scripts):
   - Vibe Check: parallel agent evaluation per cluster
   - Watercooler: cluster debate with dissent injection if >80% positive
   - Consensus: final vote + PPI computation
7. Implement context compression between debate rounds (≤500 tokens via MiroFish LLMClient)
8. Wire MiroFish `ReportAgent` with custom MiroShop tools for friction classification (Price/Trust/Logistics)
9. Add sanity-check agent (Pro/Enterprise only) — validates ReportAgent output vs. product data
10. Implement `TokenBudgetMiddleware` — MT tracking, pre-call budget check, Redis counter update
11. Add MiroShop Flask routes (`/simulate`, `/simulate/delta`, `/health`) as a blueprint
12. Implement `CallbackService` — async POST to Cloudflare Worker on completion (retry ×5)
13. Unit tests with mocked Ollama responses and mocked Zep graph (80%+ coverage)

**Exit criteria:**
- Full 50-agent simulation returns scored result in <10 min on Hetzner CPU
- Single-agent mode returns result in <90 seconds
- Delta simulation produces updated scores from overrides
- All unit tests pass

---

### Phase 4: Integration — Worker ↔ Engine Pipeline (5-7 days) — Medium Risk
**Goal:** End-to-end flow with Redis queue, atomic quota enforcement, callback persistence.

1. Simulation trigger route — atomic quota check-and-increment (`UPDATE ... WHERE simulations_used < limit RETURNING *`)
2. Pre-simulation token estimate shown to merchant
3. Redis queue consumer via Cloudflare Cron (max 2 concurrent; priority: Enterprise > Pro > Free)
4. Callback handler — bulk-insert agent logs to Neon; update simulation record; update Redis MT counter
5. Polling fallback — `GET /api/simulation/:id`; if stuck >15 min, force-complete
6. Delta simulation route — links to original, reuses niche contexts

**Exit criteria:**
- Full round-trip: trigger → queue → engine → callback → Neon persistence
- Quota enforced atomically (no race conditions)
- MT counter accurate within 5% of actual token usage
- Concurrent simulation limit respected

---

### Phase 5: Dashboard — Shopify Polaris UI (7-10 days) — Low-Medium Risk
**Goal:** Embedded app showing all visualizations with real data.

1. Shopify embedded app shell (App Bridge + Polaris)
2. SimulationPage — product selector, quota display, token estimate, loading state
3. `SuccessGauge` — animated SVG speedometer (red/yellow/green)
4. `SwarmGrid` — 5×N avatar grid with hover reasoning
5. `FrictionReport` — 3 Polaris Cards with dropout % and top objections
6. ResultsPage — compose all three components, 5s polling while running, skeleton loading
7. `WhatIfSliders` — price/shipping sliders, delta trigger, before/after comparison
8. SandboxPage — delta comparison view (Pro-gated with upgrade CTA for Free)
9. Notification bell in app header for weekly alert triggers

**Exit criteria:**
- App installs and loads in Shopify admin
- First simulation delivers "aha moment" in <90s
- What-If Sandbox triggers delta and shows comparison
- Free tier features appropriately gated

---

### Phase 6: Weekly Retention Engine (4-5 days) — Medium Risk
**Goal:** Automated weekly scan with email digest and Shop Health Score.

1. Cloudflare Cron Trigger (Monday 06:00 UTC) → fan out `weekly_scan` jobs to Redis
2. Watchdog Cron (Monday 08:00 UTC) → verify all expected scans exist; re-trigger missing
3. `weekly_digest` job — compute Shop Health Score (revenue-weighted), generate alerts
4. Resend email delivery — weekly digest with React Email template
5. In-app notifications for alert triggers
6. Historical trend charts (8-week sparklines) in Pro dashboard

**Exit criteria:**
- Weekly digest email arrives every Monday morning
- Shop Health Score updates week-over-week
- Alert triggers fire correctly for PPI changes >5 points
- Watchdog catches and re-triggers failed scans

---

### Phase 7: Billing, Hardening & CI/CD (7-10 days) — Medium Risk
**Goal:** Stripe/Shopify billing, error resilience, observability, production deployment.

1. Shopify Billing API — `recurringApplicationChargeCreate` for Pro/Enterprise
2. `app_subscriptions/update` webhook — update `stores.plan_tier` on subscription changes
3. Budget follows `shop_id` — reinstall does NOT reset monthly counter
4. MT add-on pack purchase flow (Pro only)
5. Per-store rate limiting middleware (Upstash Redis, tier-aware)
6. Ollama circuit breaker — 3 consecutive failures → 60s cooldown, return 503
7. React error boundaries + toast notifications for transient errors
8. Structured JSON logging → Cloudflare Logpush + Docker stdout
9. Operator alert webhooks (PagerDuty/email) at spend thresholds
10. GitHub Actions CI/CD (Worker: `wrangler deploy`; Engine: GHCR → SSH to Hetzner)
11. Staging vs. production environment configuration

**Exit criteria:**
- Billing upgrade/downgrade flow works end-to-end
- Rate limiting enforced per tier
- Circuit breaker prevents cascade failures
- CI/CD deploys automatically on merge to main
- Operator receives spend alerts at configured thresholds

---

## 15. Critical Implementation Decisions

| Decision | Recommendation | Alternative Rejected & Why |
|----------|---------------|--------------------------|
| **Agent persona persistence** | Generate once at classification, store in `store_agent_contexts`, reuse every sim | On-the-fly generation wastes ~2 MT/sim (20 MT/month per active store); also breaks week-over-week consistency (same "Budget Optimizer for cigars" must evaluate each week) |
| **Weekly scan trigger** | Cloudflare Cron Trigger | Upstash QStash adds paid dependency + extra failure point for a single weekly fan-out; QStash worth reconsidering if per-store custom schedules are needed (Enterprise feature later) |
| **Token counting** | Estimate upfront (shown to merchant) + count actuals after (for reconciliation) | Count-after-only can't prevent overspend; estimate prevents surprise overages; actual usage adjusts Redis counter post-sim |
| **Hallucination handling** | Single sanity-check agent on Pro/Enterprise (validates consensus against Shopify data) | Multi-reviewer or RAG grounding costs disproportionately more for ~20% additional hallucination catch; single reviewer catches ~80% at acceptable cost |
| **Free tier model** | Same Llama-3-8B for all tiers | Lighter model (Phi-3-mini, Llama-3-1B) produces noticeably worse output; free tier IS the conversion tool — poor quality = no upgrade; self-hosted cost difference between 1B and 8B is marginal |
| **Email delivery** | Resend (transactional, React Email, 100 free emails/day) | Shopify Email is marketing-only; no email = merchants forget the app within 2 weeks; Resend scales to $20/mo at thousands of stores |
| **Shop Health Score** | Revenue-weighted average of tracked product PPIs | Simple average treats $5/mo product same as $5,000/mo product → misleading score, misallocated optimization effort |
| **Abuse budget tracking** | By `shop_id` (Shopify immutable ID), not `installation_id` | Installation ID resets on reinstall → free tier exploit |
| **Concurrency limit** | Redis queue max 2 concurrent sims on Hetzner | More concurrent sims would overload CPU; queue depth shown to merchant as estimated wait time |
| **Zep Cloud (agent memory graph)** | **Keep for v1** — Zep provides persistent agent memory that improves week-over-week context richness (same agents "remember" prior evaluations of a product). Free tier: 1 graph/project; paid starts at $20/mo. | Replacing with plain Neon DB would lose cross-simulation memory continuity, weakening the weekly trend insight. Revisit if Zep becomes a cost problem at scale (>1,000 stores). |
| **MiroFish Flask vs. custom FastAPI** | Keep MiroFish Flask — reuse `OasisProfileGenerator`, `ReportAgent`, `LLMClient` directly. Add MiroShop routes in a `miroshop/` blueprint alongside existing Flask app. | Rewriting in FastAPI saves nothing; MiroFish Flask is production-grade and the OASIS simulation scripts are already wired to it. |

---

## 16. Risks & Mitigations

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| **Ollama CPU inference too slow** (150+ LLM calls for 50-agent sim) | Critical | High | Parallelize 10 agents/cluster concurrently; 2 debate rounds max for Pro; Q4_0 quantized model; 10-min hard timeout returns partial results; fallback: reduce to 25 agents for v1 |
| **LLM output non-determinism breaks JSON** | High | Medium | JSON-mode system prompt; Pydantic validation + retry ×3; regex fallback; log all raw outputs for debugging |
| **Hetzner single point of failure** | High | Medium | Docker health checks + auto-restart; Redis AOF persistence; Terraform reprovisioning script; queue buffers jobs during downtime |
| **Context window overflow in debates** | High | Medium | Compression agent (≤500 tokens) after each round; hard 2,000-token budget per agent; truncate oldest context if budget exceeded |
| **Free tier cost unexpectedly high** | High | Medium | Hard MT budget enforced before every simulation; token estimate shown upfront; `GLOBAL_DAILY_LIMIT` env var as last resort; Redis daily counter for operator visibility |
| **Shopify OAuth token storage** | High | Low | Encrypt `access_token` at rest with KMS-derived key before writing to Neon; never log tokens |
| **Niche classification quality for unusual niches** | Medium | Medium | LLM-generated niche context degrades gracefully (generic context still better than none); manual override dropdown covers edge cases |
| **Week-over-week score inconsistency** | Medium | Medium | Same stored niche context blocks used every week; deterministic archetype definitions; log all prompt variants for debugging |
| **Callback delivery failure** | Medium | Medium | 5 retries with backoff; results always queryable via poll endpoint; email notification as final fallback |
| **Shopify rate limits** | Low | Medium | Respect `X-Shopify-Shop-Api-Call-Limit`; KV cache product data for 1 hour; exponential backoff |

---

---

## Gap 1: Progressive Reporting — Latency & Time-to-Value

### The Problem

Running 50 agents with recursive debate on a CPU-only Hetzner VPS takes 10–15 minutes end-to-end. Merchants who see a spinner for 10 minutes will uninstall. This is the single biggest UX risk in the entire product.

### The Solution: Three-Phase Progressive Delivery

The simulation is split into three phases that each deliver partial results to the UI as they complete. The merchant sees value within 30 seconds. The full report arrives in the background.

```
PHASE 1: VIBE CHECK          Target: ≤ 30 seconds
  - 5 agents (1 per archetype), 1 LLM call each, no debate
  - Delivers: preliminary Customer Confidence Score + top objection per archetype
  - UI: needle animates to Phase 1 score, 5 avatar cards appear with vote + one-line reason
  - Merchant already has actionable signal before Phase 2 starts

PHASE 2: CLUSTER DEBATE      Target: 2–5 minutes after Phase 1
  - Remaining agents join, cluster debate runs (2 rounds max)
  - Delivers: updated score, all 3 friction categories with dropout %
  - UI: score needle adjusts, Friction Report cards populate progressively
  - Swarm grid fills in as each cluster completes

PHASE 3: CONSENSUS REPORT    Target: 5–10 minutes after Phase 2
  - ReportAgent (ReACT loop) synthesises full report
  - Delivers: verbatim agent quotes, ranked recommendations, visual quality integration
  - UI: "Full Report Ready" banner, quotes appear, Decision Explorer unlocks
```

### SSE (Server-Sent Events) Architecture

The Cloudflare Worker exposes an SSE endpoint that the dashboard subscribes to for real-time phase updates. The Engine pushes phase completions to the Worker, which relays them to the open SSE connection.

```
Dashboard                Worker (SSE endpoint)          Engine (Flask)
    │                          │                              │
    │── GET /api/sim/:id/stream ──>                           │
    │<── SSE connection open ──│                              │
    │                          │<── POST /phase-complete ─────│  (Phase 1 done ~30s)
    │<── event: vibe_check ────│                              │
    │  [UI updates score,      │                              │
    │   shows 5 avatars]       │<── POST /phase-complete ─────│  (Phase 2 done ~3min)
    │<── event: debate ────────│                              │
    │  [Friction cards fill]   │<── POST /phase-complete ─────│  (Phase 3 done ~8min)
    │<── event: consensus ─────│                              │
    │  [Full report appears]   │                              │
    │<── event: done ──────────│                              │
```

**SSE event payload structure:**
```json
{
  "event": "vibe_check",
  "phase": 1,
  "customer_confidence": 58,
  "agent_votes": [
    { "archetype": "budget_optimizer", "vote": "reject", "reason": "Price 18% above category average" },
    { "archetype": "brand_loyalist",   "vote": "buy",    "reason": "Strong brand imagery detected" },
    { "archetype": "research_analyst", "vote": "reject", "reason": "No ingredient list visible" },
    { "archetype": "impulse_decider",  "vote": "buy",    "reason": "First image is lifestyle-focused" },
    { "archetype": "gift_seeker",      "vote": "reject", "reason": "No mention of gift wrapping or return window" }
  ],
  "top_objection": "Price 18% above category average for this niche"
}
```

### Fallback: Polling (if SSE fails)

If the SSE connection drops (mobile, proxy, timeout), the dashboard falls back to polling `GET /api/simulation/:id` every 5 seconds. The `simulation_phases` table allows the Worker to return the latest completed phase data at any time without waiting for the full simulation to finish.

### UI Behaviour Rules

- **Immediately on trigger:** Show a progress bar with 3 labeled steps ("Your panel is voting", "Panel is debating", "Generating report"). Step 1 ETA: 30s.
- **Phase 1 arrives:** Animate the score needle. Show 5 avatar cards. Show "Early signal — debate in progress" badge on the score.
- **Phase 2 arrives:** Score needle updates. Friction cards animate in. Remove the "early signal" badge.
- **Phase 3 arrives:** "Full Report Ready" banner. Quotes and recommendations appear. Decision Explorer unlocks.
- **If Phase 1 takes >45s:** Show "Your dedicated panel is warming up — first results arriving shortly." Never show a blank spinner beyond 15s.

### Token Cost Impact

Phase 1 (Vibe Check only) for a Free tier merchant costs ~2 MT — well within the 7 MT total budget. This means a Free merchant sees actionable value at 30s for 2 MT, before the remaining 5 MT of debate runs. If they close the tab, Phase 1 results are still persisted and the weekly email includes them.

---

## Gap 2: Visual Intelligence — Vision Model Integration

### The Problem

Agents currently only read JSON text. A product with spectacular specs but a terrible hero image will receive an unfairly positive score because the Impulse Decider archetype cannot actually see the image. In reality, a plain white-background photo on a fashion product kills conversions immediately.

### The Solution: Moondream2 as Visual Pre-Filter

[Moondream2](https://github.com/vikhyat/moondream) is a 1.87B parameter vision-language model that runs efficiently on CPU. It is co-hosted on the same Hetzner VPS via Ollama (`ollama pull moondream`). It analyses the product's primary image before the agent debate begins and produces a **Visual Quality Score** and a structured list of issues.

This score is injected as a hard constraint into the agent prompts — the agents are told what the image looks like, so they can react to visual reality, not just text.

### Vision Analysis Pipeline

```
Step 0 (before any agent runs):
  1. Download product's first image (hero image) from Shopify CDN
  2. Send to Moondream2 via Ollama with structured prompt
  3. Receive Visual Quality Score (0-100) + issue list
  4. Store in visual_analyses table
  5. Inject visual_context block into ALL agent system prompts
```

**Moondream2 prompt template:**
```
Analyse this product image for an e-commerce listing. Answer in JSON only.
Score the image from 0 to 100 where:
  90-100 = Professional lifestyle photo, model/context, great lighting
  70-89  = Clean product photo, good lighting, minimal background distractions
  50-69  = Plain white/grey background, no lifestyle context
  30-49  = Poor lighting, cluttered background, or low resolution
  0-29   = Blurry, watermarked, stock photo, or completely inappropriate

Return:
{
  "visual_quality_score": integer (0-100),
  "issues": ["issue1", "issue2"],  // max 3, specific and actionable
  "dominant_constraint": "The single most critical visual problem",
  "positive_signals": ["what works visually"],
  "lifestyle_present": boolean,
  "background_type": "white | lifestyle | studio | cluttered | other"
}
```

**Visual constraint injection into agent prompts:**
```
[VISUAL CONTEXT — injected before all agent reasoning]
The product's main image has been analysed:
  Visual Quality Score: 34/100
  Primary issue: Plain white background with no lifestyle context
  Additional issues: No scale reference visible, low resolution detected

As a [Archetype Name], factor this into your evaluation.
The Impulse Decider MUST note this as a rejection reason if score < 50.
The Brand Loyalist MUST note this as a trust concern if score < 60.
```

### Visual Quality Score Thresholds

| Score | Forced Agent Behaviour |
|-------|----------------------|
| 0–29 | Impulse Decider: mandatory reject. Brand Loyalist: mandatory reject. Score is hard-capped at max 45 Customer Confidence regardless of text analysis. |
| 30–49 | Impulse Decider: mandatory reject. Score is soft-capped at max 65. |
| 50–69 | Impulse Decider flags visual concern in reasoning. No score cap. |
| 70–100 | No constraint. Agents may reference positive visuals. |

**Why hard-cap the score:** If a merchant has an objectively terrible hero image, no amount of great copy should yield a high Customer Confidence Score. The score cap forces the merchant to fix the image, which is always the right call.

### Token Cost of Vision Analysis

Moondream2 on CPU: ~3–5 seconds per image, ~800 tokens (image tokens + text response). Billed at 0.8 MT per simulation — included in the tier cost estimate. The visual analysis runs **in parallel** with niche context loading during Step 0, adding zero wall-clock time to the simulation.

### Visual Quality in the UI

A **Visual Quality card** sits above the Friction Report:

```
┌─────────────────────────────────────────┐
│  📸 Image Quality: 34/100   [Poor]      │
│  ─────────────────────────────────────  │
│  ⚠ Plain white background — no         │
│    lifestyle context detected           │
│  ⚠ No scale reference visible          │
│  ─────────────────────────────────────  │
│  Impact: This is capping your Customer  │
│  Confidence Score. Improving your       │
│  image could unlock +15–25 points.     │
└─────────────────────────────────────────┘
```

This is the most actionable insight in the entire report for many merchants — and it takes 5 seconds to produce.

---

## Gap 3: Phase 0 — Pre-Launch Landing Page Validation

### The Problem

Shopify App Store approval takes 4–8 weeks. We need real users, real testimonials, and proof of demand before launch. We also need to identify and fix engine bugs before we have paying Shopify customers.

### The Solution: Standalone "Free Audit" Landing Page

A public landing page (separate from the Shopify app) where any merchant can enter their product URL, submit their email, and receive a free audit report via email within ~10 minutes. No Shopify install required.

This is the Phase 0 go-to-market strategy.

### Architecture

```
Landing Page (Next.js or plain HTML — fast to build)
  ├── Input: Product URL (Shopify, WooCommerce, or any e-commerce URL)
  ├── Input: Email address
  └── Submit → POST /api/phase0/submit

Cloudflare Worker /api/phase0/submit:
  ├── Validate URL format (must be a product page, not a homepage)
  ├── Check daily Phase 0 quota (max 50 free audits/day — cost control)
  ├── Store lead in phase0_leads table
  ├── Return: "Your free audit is being prepared. Check your inbox in ~10 minutes."
  └── Enqueue Phase0ScrapeJob to Redis

Hetzner Engine — Phase0ScrapeJob:
  ├── Scrape product URL (Playwright/httpx for JS-rendered pages)
  │   Extract: title, price, description, images, any visible reviews
  ├── Run niche classification on scraped data
  ├── Run vision analysis on hero image
  ├── Run Free-tier simulation (5 agents, Vibe Check only — keep cost minimal)
  ├── Generate email report (HTML, formatted for email)
  └── POST to /api/phase0/deliver

Cloudflare Worker /api/phase0/deliver:
  ├── Update phase0_leads status → 'emailed'
  └── Send via Resend (HTML email with full mini-report)
```

### Phase 0 Email Report Structure

```
Subject: "Your [Product Name] audit is ready — here's what your customers think"

Body:
  1. Customer Confidence Score (big number, colour coded)
  2. "Your 5 simulated [niche] customers said..."
     — One quote per archetype (buy or reject, with specific reason)
  3. Top 2 friction points (text only, no charts in email)
  4. Visual Quality Score + top image issue
  5. CTA: "Want the full 50-agent deep audit with weekly tracking?"
     [Install MiroShop on Shopify] button
  6. "Built with MiroShop AI — Powered by your dedicated customer panel"

Footer: Unsubscribe link (CAN-SPAM compliance)
```

### Product Scraping Strategy

| Page Type | Scraping Method |
|-----------|----------------|
| Shopify product page | Append `?format=json` to URL → free JSON (no scraping needed) |
| WooCommerce | Parse Open Graph meta tags + schema.org Product JSON-LD |
| Generic e-commerce | Playwright headless browser; extract title, price, description, first image |

**Scraping cost control:** Playwright adds ~5s and ~50MB RAM per job. Cap at 30s timeout. If scraping fails, email the user: "We couldn't read your product page. Make sure it's publicly accessible." Do not retry — mark as failed.

### Phase 0 Cost Controls

- Max **50 audits/day** globally (Redis counter `phase0:day:{YYYY-MM-DD}`)
- If daily limit hit: show waitlist form ("We're at capacity today — join the waitlist")
- Each Phase 0 audit costs ~7 MT (same as Free tier sim) — at 50/day = 350 MT/day cap
- Phase 0 leads are **never auto-enrolled** in any billing — explicit opt-in only

### Phase 0 Success Metrics (before Shopify launch)

| Metric | Target |
|--------|--------|
| Audits completed | 200+ |
| Email open rate | >40% |
| Testimonials collected | 10+ |
| Shopify install intent ("clicked CTA") | >15% of audits |
| Engine bugs found | As many as possible — this is the point |

### Converting Phase 0 Leads

After Shopify approval, an automated email goes to all Phase 0 leads:

> "Your free audit from [date] is now available as a full weekly tracker inside your Shopify store. Install MiroShop in one click — your customer panel is already configured for your niche."

This is a warm lead with an established relationship — much higher install rate than cold Shopify App Store discovery.

---

## Gap 4: Anti-Churn — Ad-Creative Sandbox & Competitor Delta

### The Problem

A merchant fixes their top friction point, their score improves, and they think "job done — I don't need this anymore." The weekly scan helps but it's passive. We need two active, high-value features that make merchants come back specifically to use them, not just to read the report.

---

### Feature A: Ad-Creative Sandbox

**The idea:** Before a merchant spends $500 on Facebook or Google ads, they can paste their ad headline and body copy into MiroShop. The same dedicated customer panel that evaluates their products will evaluate their ad copy.

**What it answers:** "Will my customer panel respond to this ad? Does the headline grab the Budget Optimizer? Does the copy reassure the Brand Loyalist?"

**Why it creates retention:** Ad spend is ongoing. Every time a merchant writes a new ad, they have a reason to come back to MiroShop.

#### Ad-Creative Sandbox Implementation

**Input:**
```
Ad Platform: [Facebook / Google / TikTok / Email]
Headline: "Premium Dominican Cigars — Hand-rolled by Masters"
Body Copy: "Limited run. Free shipping on boxes. 30-day satisfaction guarantee."
Optional: Product link (to ground agents in the product context)
```

**Agent prompt modification for ad evaluation:**

The same 5 archetypes evaluate the ad copy through the lens of their persona, but the question changes:

> *"You are [Archetype]. You just saw this [platform] ad in your feed. Does it make you want to click? Would you trust this brand based on this copy alone? What would make you ignore it?"*

**Output:**
- Ad Confidence Score (0-100) — "X of your panel would click this ad"
- Per-archetype response: click / scroll-past / actively distrust
- Top copy objections: "Budget Optimizer thinks 'free shipping on boxes' is unclear — does that mean only box purchases qualify?"
- Improvement suggestions generated by the Research Analyst agent: "Add the price or a price anchor. 'Hand-rolled by Masters' is vague — name the region or the factory."

**Token cost:** ~4 MT per ad check (shorter prompts, no debate — Vibe Check only for ads). Included in Pro/Enterprise MT budget.

**Tier gating:**
- Free: cannot use Ad-Creative Sandbox
- Pro: 5 ad checks/month included in 500 MT budget
- Enterprise: unlimited ad checks

**UI placement:** Separate tab "Ad Panel" in the dashboard. Simple text area inputs. Results appear in ~30 seconds (Vibe Check only, no debate needed for ad copy).

---

### Feature B: Competitor Delta

**The idea:** In the weekly scan, alongside the merchant's own product score, the system also audits one competitor product (merchant-specified URL) and shows the gap: "You score 62. Your competitor scores 78. Here's exactly where you're losing."

**Why this creates urgency every week:** Merchants are competitive. Seeing that a competitor is outperforming them on Trust while they're losing on Price creates immediate motivation to act — and to check back next week to see if they closed the gap.

**Why it works for retention:** The competitor score changes week-over-week too. Maybe the competitor raises their price or removes their review widget. The merchant needs to check every week to maintain competitive awareness.

#### Competitor Delta Implementation

**Setup (one-time per merchant):**
- In Pro/Enterprise dashboard settings: "Track a competitor" → paste a competitor product URL
- Up to 2 competitor URLs for Pro, up to 5 for Enterprise

**How competitor data is obtained:**

Same scraping strategy as Phase 0:
- Shopify competitor: `?format=json` trick for free JSON
- Other platforms: httpx + schema.org JSON-LD extraction
- Playwright fallback for JS-heavy pages (30s timeout)
- Cache scraped data for 24h (competitor pages don't change hourly)

**Competitor simulation:** Uses the same niche agents as the merchant's own panel. This is critical — both the merchant's product and the competitor's product are evaluated by the *same simulated customer panel*, making the comparison fair and directly actionable.

**Output — Competitor Delta card in weekly digest and dashboard:**

```
┌──────────────────────────────────────────────────────────────┐
│  📊 Competitor Comparison — Week of March 29                 │
│  ──────────────────────────────────────────────────────────  │
│  YOUR PRODUCT          COMPETITOR (artisancigar.com/bundle)  │
│  Score: 62  ████████░░  Score: 78  ██████████░              │
│                                                              │
│  WHERE YOU'RE LOSING:                                        │
│  Trust:     You 48%  →  Competitor 71%  (-23 pts)           │
│    "Competitor has 340 reviews. You have 12."               │
│  Logistics: You 55%  →  Competitor 82%  (-27 pts)           │
│    "Competitor ships in 2 days. Your listing says 7-10."    │
│                                                              │
│  WHERE YOU WIN:                                              │
│  Price:     You 74%  →  Competitor 61%  (+13 pts)           │
│    "Your price is 12% lower for comparable product."        │
│                                                              │
│  [Fix Trust Issues →]  [Explore Logistics Options →]        │
└──────────────────────────────────────────────────────────────┘
```

**Token cost:** ~7 MT per competitor product audit (same as a standard product sim). Run once per week alongside the weekly scan. At Pro tier (500 MT budget) with 2 competitors and 25 own products = 27 × 7 MT = 189 MT/week, leaving 311 MT for on-demand sims. This fits within budget.

**Tier gating:**
- Free: no competitor tracking
- Pro: 2 competitor URLs tracked weekly
- Enterprise: 5 competitor URLs tracked weekly + historical trend chart

**Failure handling for competitor scraping:**

| Failure | Response |
|---------|----------|
| Competitor page returns 403/blocked | Skip competitor that week. Show in digest: "Competitor page was unavailable this week." |
| Competitor page structure changed (scraping fails) | Same — skip, notify. Do not crash the weekly scan. |
| Competitor URL is a homepage, not a product page | Validate at setup time. Reject non-product URLs with helpful message. |
| Competitor uses Cloudflare bot protection | Use cached last-known data if <7 days old. Otherwise skip. |

---

### Updated Tier Feature Table (incorporating all four gaps)

| Feature | Free | Pro ($29.90/mo) | Enterprise ($89/mo) |
|---------|------|-----------------|---------------------|
| Panel size | 5 agents | 25 agents | 50 agents |
| Progressive reporting | Phase 1 only (30s) | All 3 phases | All 3 phases + priority |
| Visual Quality Score | Yes (all tiers) | Yes | Yes |
| Debate rounds | 1 | 5 | 10 |
| On-demand panel checks | 3/mo | Within 500 MT budget | Within 2,000 MT budget |
| Weekly auto-scan | 1 product | 25 products | Unlimited |
| Decision Explorer | No | Yes | Yes |
| Ad-Creative Sandbox | No | 5 checks/mo | Unlimited |
| Competitor tracking | No | 2 competitors weekly | 5 competitors weekly |
| Competitor historical trend | No | No | Yes (full history) |
| Report detail | Score + 2 friction areas | Full report + quotes | Full + transcripts + PDF |
| Phase 0 landing page | Pre-install only | N/A | N/A |

---

### Updated Implementation Phases (incorporating all four gaps)

**Phase 0 (NEW — run in parallel with Phase 1, before Shopify launch):**
- Build landing page (plain HTML or Next.js — 2 days)
- Build `Phase0ScrapeJob` (Playwright + httpx product scraper — 3 days)
- Build phase0 email template (Resend HTML — 1 day)
- Wire `/api/phase0/submit` and `/api/phase0/deliver` on Worker — 2 days
- Daily quota counter (Redis) — 1 day
- **Total: 9 days in parallel with Phase 1 infra work**

**Phase 3 additions (Inference Engine):**
- Add Moondream2 to Ollama on Hetzner (`ollama pull moondream`) — 0.5 days
- Implement `VisualAnalysisService` (image download → Moondream2 → structured JSON) — 2 days
- Implement visual constraint injection into agent prompts — 1 day
- Add `visual_analyses` DB migration and persist results — 0.5 days

**Phase 4 additions (Integration):**
- Add SSE endpoint to Cloudflare Worker — 2 days
- Implement phase-completion callbacks from Engine to Worker — 1 day
- Wire `simulation_phases` table updates per phase — 1 day
- Dashboard SSE subscription + progressive UI updates — 3 days
- Polling fallback for SSE drops — 1 day

**Phase 5 additions (Dashboard):**
- Visual Quality card component — 1 day
- Progressive score animation (needle updates per phase) — 1 day
- Ad-Creative Sandbox UI (textarea inputs, Vibe Check results view) — 2 days

**Phase 6 additions (Retention Engine):**
- Competitor URL setup UI in dashboard settings — 1 day
- `CompetitorScrapeService` (reuse Phase 0 scraper) — 1 day
- Competitor Delta card in weekly digest and dashboard — 2 days
- Competitor delta email section in Monday digest — 1 day
- `ad_creative_checks` route and engine handler — 2 days

---

### Updated Risk Register (new risks from gaps 1–4)

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| **SSE connection drops mid-simulation** | Medium | High (mobile users) | Polling fallback automatic on SSE error; `simulation_phases` table allows resume from any phase |
| **Moondream2 misclassifies professional images as poor** | Medium | Medium | Score thresholds are conservative (only hard-cap at <30); offer merchant "override image score" button to flag misclassification; log all vision outputs for calibration |
| **Phase 0 scraper blocked by target site** | Medium | High | Shopify `?format=json` trick handles majority of merchants; Playwright as fallback; graceful failure email to lead |
| **Phase 0 abused (bot submitting thousands of URLs)** | High | Medium | hCaptcha on landing page form; Redis daily cap (50/day); IP rate limit (3 submissions/IP/day); honeypot field |
| **Competitor page scraping blocked (Cloudflare, bot protection)** | Medium | High | Use cached data if <7 days old; skip gracefully with notification; never crash weekly scan for a competitor fetch failure |
| **Ad-Creative Sandbox used as free content generator (abuse)** | Low | Medium | Tie ad checks to verified Shopify store (authenticated session); Free tier blocked entirely; Pro tier 5/month hard limit |
| **Moondream2 adds latency to Phase 0 pipeline** | Low | Low | Runs in parallel with niche context loading; adds ~5s to Phase 0 only, invisible to merchant (async email delivery) |

---

## Gap 5: Response Diversity & Anti-Templating Strategy

### The Problem

Llama-3-8B, like all small LLMs, converges on familiar phrasing. After a few weeks, a merchant will notice that the Budget Optimizer always opens with "As a price-conscious buyer..." and the Research Analyst always closes with "I would need more information before purchasing." When reports start feeling templated, merchants lose trust in the intelligence behind them — and churn.

This is not a hypothetical risk. It is the primary reason AI-generated content tools lose retention: novelty wears off and the mask slips.

### The Solution: Four-Layer Diversity Injection

Diversity is enforced at the prompt architecture level, not patched on top after the fact.

---

#### Layer 1 — Dynamic Temperature Per Agent

Each agent gets a different temperature value, sampled fresh every simulation run. The temperature range varies by archetype to reflect personality:

```python
ARCHETYPE_TEMPERATURE_RANGES = {
    "budget_optimizer":  (0.6, 0.85),   # Analytical — moderate range
    "brand_loyalist":    (0.7, 0.95),   # Emotional — higher range = more expressive
    "research_analyst":  (0.4, 0.65),   # Methodical — tighter range = more precise
    "impulse_decider":   (0.8, 1.05),   # Spontaneous — highest range = most varied
    "gift_seeker":       (0.65, 0.90),  # Relational — moderate-high range
}

def get_agent_temperature(archetype: str, simulation_id: str, agent_index: int) -> float:
    # Deterministic seed per agent per simulation (reproducible if needed for debugging)
    seed = hash(f"{simulation_id}:{archetype}:{agent_index}") % 10000
    rng = random.Random(seed)
    lo, hi = ARCHETYPE_TEMPERATURE_RANGES[archetype]
    return round(rng.uniform(lo, hi), 2)
```

**Why deterministic seed:** If a simulation is re-run for debugging, the same agent gets the same temperature. This makes bug reproduction possible without sacrificing variety across different simulations.

---

#### Layer 2 — Vocabulary & Tone Rotation

A `DiversityContext` object is generated per agent per simulation. It selects a random tone modifier and vocabulary style from pre-defined pools, and injects them into the system prompt.

```python
TONE_POOL = [
    "Be blunt and direct. No pleasantries.",
    "Be conversational, like you're explaining to a friend.",
    "Be analytical — use numbers and comparisons.",
    "Be storytelling — describe your thought process as a narrative.",
    "Be sceptical and demanding — assume the worst until proven otherwise.",
    "Be enthusiastic when you approve, brutally honest when you don't.",
]

VOCABULARY_ANCHORS = {
    "budget_optimizer": [
        "value proposition", "price-to-quality ratio", "I've seen better deals",
        "not worth the premium", "comparable alternatives at lower cost",
        "this is overpriced for what you get", "the maths don't work for me",
    ],
    "impulse_decider": [
        "I want it now", "something about this just grabs me",
        "I'd scroll past this immediately", "this doesn't stop the scroll",
        "the vibe is off", "this feels premium / this feels cheap",
        "my gut says yes/no", "this made me feel something / nothing",
    ],
    # ... one pool per archetype (10-15 phrases each)
}
```

**Injection into system prompt:**
```
[DIVERSITY CONTEXT]
For this evaluation, your communication style is: "Be blunt and direct. No pleasantries."
Naturally weave in at least one of these phrases where appropriate:
"the maths don't work for me" / "comparable alternatives at lower cost"
Do NOT use the phrase "as a [archetype name]" to open your response.
Do NOT start with "I would" — vary your sentence openings.
```

---

#### Layer 3 — Structural Rotation for Reports

The `ReportAgent` (MiroFish) generates the final written report. Without intervention, it will produce the same section order and transition phrases every time. The following structural variations are rotated:

```python
REPORT_STRUCTURES = [
    "objection_first",      # Lead with the strongest rejection, then explain
    "story_arc",            # Build up positives, then reveal the critical flaw
    "comparative",          # Frame every point as "compared to typical [niche] products..."
    "customer_voice",       # Open with a direct quote from the most vocal agent
    "priority_action",      # Lead with the single most impactful fix, then context
]

TRANSITION_PHRASE_POOLS = {
    "adding_evidence":   ["Beyond that,", "What reinforced this was", "The panel also flagged", "Separately,"],
    "contrasting":       ["However,", "That said,", "The tension here is", "On the other side,"],
    "concluding":        ["The bottom line:", "Where this leaves you:", "The actionable takeaway:", "Simply:"],
}
```

The report structure for each simulation is selected by hashing `simulation_id % len(REPORT_STRUCTURES)` — deterministic per simulation but varied across simulations.

---

#### Layer 4 — Freshness Guardrail

A post-generation check runs on every agent output and the final report. It flags templated phrases that have appeared in >60% of recent simulations for that store and triggers a regeneration with an explicit "avoid these phrases" instruction.

```python
BANNED_PHRASE_THRESHOLD = 0.60  # If a phrase appeared in >60% of last 10 sims for this store

def check_phrase_freshness(text: str, store_id: str, recent_phrases: list[str]) -> list[str]:
    """Returns list of overused phrases found in this output."""
    found = []
    for phrase in recent_phrases:
        if phrase.lower() in text.lower():
            found.append(phrase)
    return found

# If found phrases > 0, append to prompt:
# "Do NOT use these phrases, which you have overused recently: [phrase1, phrase2]"
# Regenerate once. If still present after regeneration, accept and log for monitoring.
```

**Storage:** The 20 most recent agent reasoning texts per store are stored as embeddings (or simple phrase hashes) in Neon. Cost: negligible (~200 bytes per simulation record).

---

### Anti-Templating Summary

| Layer | Mechanism | When Applied |
|-------|-----------|-------------|
| 1 — Temperature | Per-agent dynamic temperature from archetype-specific range | Every simulation, every agent |
| 2 — Vocabulary/Tone | Random tone + 2 vocabulary anchors injected into system prompt | Every simulation, every agent |
| 3 — Structure | Report structure rotated via simulation_id hash | Every report generation |
| 4 — Freshness guard | Detects overused phrases vs. store history, forces avoidance | Post-generation check per agent and report |

---

## Gap 6: Mobile-First Dashboard & Digest

### The Problem

70% of Shopify merchants manage their stores via the Shopify Mobile App. The embedded app dashboard and the weekly email both need to work flawlessly on a 390px-wide screen with a spotty 4G connection. The SSE progressive UI, the SVG speedometer, and the Swarm Grid are all high-risk on mobile if not explicitly designed for it.

### Mobile Design Rules (non-negotiable)

These rules apply to every component, every page, every email template.

| Rule | Detail |
|------|--------|
| **No horizontal scroll** | Every layout is single-column on mobile. Tables collapse to card stacks. |
| **Touch targets ≥ 44px** | All buttons, avatar grid cells, and slider handles meet Apple HIG minimum. |
| **No hover-only interactions** | Every hover tooltip (agent reasoning in SwarmGrid) has a tap equivalent. |
| **SVG speedometer max-width: 280px** | Scales down to fit 390px screens without overflow. |
| **Font sizes: min 14px body, 16px inputs** | Prevents iOS auto-zoom on input focus (which breaks the layout). |
| **Progressive loading skeletons** | Every component shows a skeleton state before data arrives — no layout shift. |

---

### Shopify Mobile App Constraints

The Shopify Mobile App renders embedded apps in a WebView. Specific constraints:

| Constraint | Mitigation |
|-----------|------------|
| WebView has limited JS execution budget | No heavy animation libraries (GSAP, Framer Motion). SVG animation via CSS only. |
| No persistent WebSocket in mobile WebView | SSE is preferred over WebSocket — SSE is a plain HTTP stream, more resilient in WebView |
| localStorage unavailable in some WebView contexts | Use sessionStorage or in-memory state only; never rely on localStorage for critical state |
| App Bridge navigation resets scroll position | Preserve scroll position in React state on navigation |
| Shopify Mobile App adds its own top nav bar (~60px) | Subtract 60px from viewport height calculations; use `env(safe-area-inset-*)` for notch devices |

---

### Component-Level Mobile Specifications

**Customer Confidence Score (Speedometer)**
```
Mobile (≤640px):
  - Gauge max-width: 260px, centered
  - Score number: 64px, bold
  - Subtitle: 13px, 2 lines max
  - Remove decorative tick marks at <400px
  - Needle animation: CSS transform only, 400ms ease-out
```

**Customer Panel Visualizer (Avatar Grid)**
```
Mobile: Collapse 5×10 grid to 5×2 grid (show 2 agents per archetype with "see all" expand)
  - Each avatar: 36px circle (touch target wrapper: 44px)
  - Tap → bottom sheet with agent reasoning (not popover — popovers overflow on mobile)
  - Bottom sheet: full-width, max-height 60vh, scrollable
  - Swipe down to dismiss
```

**Friction Report Cards**
```
Mobile: Stacked vertically, full-width cards
  - Card header: 16px bold
  - Dropout percentage: Large (48px) number, right-aligned
  - Agent quotes: 14px, max 2 visible, "show more" toggle
  - No horizontal bar charts — use circular progress indicators (render better on mobile)
```

**Decision Explorer (Sliders)**
```
Mobile:
  - Sliders: full-width, thumb size 28px (44px touch target)
  - Labels above slider (not beside — no space on mobile)
  - "Run Panel Check" button: full-width, 48px height, sticky at bottom of screen
  - Before/after comparison: stacked vertically (not side-by-side)
```

**Ad-Creative Sandbox**
```
Mobile:
  - Textarea: full-width, min-height 120px, 16px font (prevents iOS zoom)
  - Platform selector: horizontal scrollable chip row (not dropdown)
  - Results: card stack below the form
```

---

### SSE on Mobile — Resilience Strategy

SSE on mobile browsers and WebViews has two known failure modes: the connection is dropped when the app goes to background, and some carriers aggressively close long-lived HTTP connections after 30–60 seconds.

**Mitigation strategy: Heartbeat + Auto-reconnect**

```javascript
// Dashboard SSE client
class SimulationStream {
  constructor(simulationId) {
    this.simulationId = simulationId;
    this.lastEventId = null;
    this.reconnectDelay = 1000; // Start at 1s, back off to max 10s
    this.connect();
  }

  connect() {
    const url = `/api/simulation/${this.simulationId}/stream`;
    const params = this.lastEventId ? `?lastEventId=${this.lastEventId}` : '';
    this.sse = new EventSource(url + params);

    this.sse.onmessage = (e) => {
      this.lastEventId = e.lastEventId;
      this.reconnectDelay = 1000; // Reset on success
      this.handleEvent(JSON.parse(e.data));
    };

    this.sse.onerror = () => {
      this.sse.close();
      // Fall back to polling after 2 consecutive SSE failures
      this.sseFailures = (this.sseFailures || 0) + 1;
      if (this.sseFailures >= 2) {
        this.startPolling();
      } else {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
      }
    };
  }

  startPolling() {
    // Fall back: poll every 5s, resume SSE if connection recovers
    this.pollInterval = setInterval(async () => {
      const res = await fetch(`/api/simulation/${this.simulationId}`);
      const data = await res.json();
      this.handleEvent(data);
      if (data.status === 'completed') clearInterval(this.pollInterval);
    }, 5000);
  }
}
```

**Worker SSE endpoint:** Sends a `:heartbeat` comment every 25 seconds to prevent carrier connection timeouts. Supports `Last-Event-ID` header for resumable streams (client reconnects without losing phase data).

---

### Weekly Email Digest — Mobile Optimisation

The Monday email is the most-opened content in the product. It must render perfectly on Gmail iOS, Apple Mail, and Samsung Email.

**Email technical specs:**
```
Max width:        600px (desktop), 100% (mobile)
Layout:           Single column — NO multi-column layouts (break on Gmail mobile)
Images:           All images have width="100%" max-width="600" (fluid)
Font stack:       -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif
Min font size:    14px body, 22px headings (no smaller — Gmail clips small text)
Buttons:          Padding 14px 28px, border-radius 6px, full-width on mobile
                  Use HTML <a> styled as button (NOT <button> — breaks in some clients)
Background:       White only (dark mode email clients invert — test both)
CTA placement:    Above the fold on mobile (within first 400px of email)
```

**Score display in email (no SVG — not supported in all email clients):**
```html
<!-- Score displayed as styled HTML table, not SVG -->
<table>
  <tr>
    <td style="font-size:64px; font-weight:bold; color:#16a34a">72</td>
    <td style="font-size:14px; color:#6b7280; padding-left:8px">
      out of 100<br>
      <span style="color:#16a34a">↑ +3 from last week</span>
    </td>
  </tr>
</table>
```

**React Email components** (using `@react-email/components`):
```
EmailLayout.tsx      — wrapper with max-width, font stack, background
ScoreBlock.tsx       — HTML table score display (no SVG)
FrictionCard.tsx     — single friction area as email-safe card
AgentQuote.tsx       — blockquote-styled agent reasoning
WeeklyDigest.tsx     — composes all components
```

**Testing:** Every email template is tested in [Litmus](https://litmus.com) or [Email on Acid](https://emailonacid.com) against Gmail iOS, Apple Mail 16+, Outlook 2021, Samsung Email before any digest goes live.

---

## Gap 7: Scraping Resilience — Proxy Rotation Layer

### The Problem

Both Phase 0 (landing page audits) and the weekly Competitor Delta rely on scraping external URLs. Modern e-commerce sites — including many Shopify stores, all Shopify Plus stores, and most competitors worth tracking — use Cloudflare Bot Management, DataDome, or similar tools that will block a plain Playwright request from a known Hetzner IP within 5–10 requests.

Without a proxy layer, Phase 0 and Competitor Delta will have ~40–60% success rates in production. That is not viable.

### The Solution: Tiered Scraping Strategy

Not all URLs need a proxy. We use the cheapest method first and escalate only when needed.

```
TIER 1 — Free / Native (no proxy, use first):
  Shopify product pages:  Append ?format=json to any /products/[handle] URL
                          Returns full JSON for free — no scraping, no proxy needed.
                          Handles ~60% of all submissions (most Phase 0 leads are Shopify merchants).

TIER 2 — httpx + headers (cheap, covers most non-Shopify):
  Use realistic browser headers (User-Agent, Accept-Language, Sec-Fetch headers).
  Add 1–3s random delay before request.
  Extract via schema.org JSON-LD or Open Graph meta tags.
  Handles ~20% more (non-protected WooCommerce, Squarespace, etc.).
  Cost: zero.

TIER 3 — ScrapingBee / BrightData (paid, for protected sites):
  Use only when Tier 1 and Tier 2 fail (HTTP 403, 429, or CAPTCHA detected).
  ScrapingBee: $49/mo for 150,000 credits. 1 JS-render request = 5 credits = $0.0016.
  BrightData Residential: ~$10.50/GB — use for competitor tracking on high-value stores.
  Cost is bounded: Phase 0 (50/day max), Competitor Delta (weekly, bounded by Pro/Enterprise count).
```

### Scraping Service Architecture

```python
class ScrapingService:
    """Tiered scraping with automatic escalation."""

    async def fetch_product(self, url: str, simulation_type: str) -> ProductData:
        # Tier 1: Shopify JSON trick
        if self._is_shopify_product_url(url):
            data = await self._fetch_shopify_json(url)
            if data:
                self._record_cost(tier=1, cost_usd=0.0)
                return data

        # Tier 2: httpx + structured extraction
        data = await self._fetch_with_headers(url)
        if data:
            self._record_cost(tier=2, cost_usd=0.0)
            return data

        # Tier 3: proxy (only if previous tiers failed AND budget allows)
        if self._proxy_budget_available(simulation_type):
            data = await self._fetch_via_proxy(url)
            if data:
                self._record_cost(tier=3, cost_usd=self._estimate_proxy_cost(url))
                return data

        # All tiers failed
        raise ScrapingFailure(url=url, reason="All scraping tiers exhausted")

    def _proxy_budget_available(self, simulation_type: str) -> bool:
        """Phase 0 never uses proxy (too expensive at scale). Competitor Delta uses proxy for Pro+."""
        if simulation_type == "phase0":
            return False  # Phase 0 falls back gracefully — no proxy spend on unverified leads
        daily_proxy_spend = self._get_redis_counter("proxy:spend:day")
        return daily_proxy_spend < DAILY_PROXY_BUDGET_USD  # e.g. $3/day hard cap
```

### Proxy Provider Selection

| Provider | Use Case | Cost Model | Why |
|----------|----------|-----------|-----|
| **ScrapingBee** | Competitor Delta (Pro tier) | $49/mo, 150K credits | Simple API, handles JS rendering, good success rate on Shopify/WooCommerce |
| **BrightData Residential** | Competitor Delta (Enterprise tier, high-value targets) | ~$10.50/GB | Residential IPs bypass most bot detection including Cloudflare Bot Management |
| **None (Tier 1+2 only)** | Phase 0 landing page | $0 | Phase 0 leads are unverified; not worth proxy spend. Graceful failure email instead. |

**Why not always use proxy:** Cost. At 50 Phase 0 audits/day with proxy, cost is ~$0.08/audit × 50 = $4/day = $120/month just for scraping. That's not viable on a free lead-capture flow. The Shopify JSON trick handles ~60% of submissions for free.

### Scraping Cost Controls

```python
DAILY_PROXY_BUDGET_USD = 3.00  # Hard cap — operator configurable via env var

# Redis counters updated after every proxy call:
# proxy:spend:day:{YYYY-MM-DD}  (reset daily)
# proxy:spend:month:{YYYY-MM}   (for monthly reporting)

# If daily cap hit: skip proxy tier, return graceful failure (never crash weekly scan)
# Alert operator via email if monthly proxy spend > $50
```

### Competitor Scraping — Caching Strategy

Competitor product pages rarely change more than once per week. Aggressive caching eliminates redundant proxy calls.

| Cache TTL | When Used |
|-----------|-----------|
| 24 hours | Standard competitor page cache (Redis, keyed by URL hash) |
| 7 days | Fallback cache — used if the fresh fetch fails. Serve stale data with a "last updated X days ago" note. |
| Never expire | Permanent cache if competitor site goes down — use last known data indefinitely until URL is re-validated |

---

## Gap 8: Expectation Management UI — The Traffic Gap

### The Problem

A merchant follows all recommendations, their Customer Confidence Score reaches 85, and they still have zero sales. Why? Because they have no traffic, or their ad targeting is sending the wrong people. They blame MiroShop, leave a 1-star review, and churn.

This is a brand risk, not a technical risk. The solution is explicit expectation management baked into the UI — not buried in a FAQ.

### The Core Concept: Conversion Potential vs. Traffic Quality

MiroShop audits **Conversion Potential** — how ready the product listing is to convert a *qualified* visitor. It cannot measure or fix **Traffic Quality** — whether the right people are seeing the listing in the first place.

These are two completely separate variables. A perfect listing (CCS: 90) with bad traffic (wrong audience, irrelevant ads) will have zero sales. This distinction must be communicated to every merchant, at every touchpoint.

---

### Where the Disclaimer Appears (and How)

**Rule:** The disclaimer is never a footnote. It appears at the moment of highest risk — when a merchant might misinterpret a high score as a sales guarantee.

#### 1 — Onboarding (first simulation ever)

Before the first result loads, a one-time explainer screen:

```
┌────────────────────────────────────────────────────────────────┐
│  How to Read Your Customer Confidence Score                    │
│  ────────────────────────────────────────────────────────────  │
│                                                                │
│  ✅ What MiroShop measures:                                    │
│     How your dedicated customer panel responds to your         │
│     product listing — the copy, price, images, and trust       │
│     signals.                                                   │
│                                                                │
│  ❌ What MiroShop does NOT measure:                            │
│     Whether you're getting the right traffic. A great          │
│     listing only converts if the right people see it.          │
│                                                                │
│  Think of it this way:                                         │
│  MiroShop makes sure your store is ready for customers.        │
│  Bringing those customers is up to your ads and SEO.           │
│                                                                │
│  [Got it — show my results]                                    │
└────────────────────────────────────────────────────────────────┘
```

Shown once, persisted in `localStorage`. Never shown again after dismissed.

#### 2 — Score Display (persistent, subtle)

Below every Customer Confidence Score, a single line in muted grey:

```
Customer Confidence Score: 85/100
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Measures listing readiness — not traffic or ad performance.
```

This line is always present. It is small. But it is always there. Merchants who are confused will re-read it. Merchants who understand will ignore it.

#### 3 — High Score Warning (score ≥ 80)

When a merchant's score reaches 80+, a contextual callout appears **once** (persisted, never repeated):

```
┌─────────────────────────────────────────────────────────────┐
│  🎉 Great listing quality! One important note:              │
│                                                             │
│  A score of 80+ means your customer panel has very few      │
│  objections to your product listing. That's excellent.      │
│                                                             │
│  To see this translate into sales, make sure your traffic   │
│  matches your panel — the right audience seeing the right   │
│  product. MiroShop can't control who clicks your ads.       │
│                                                             │
│  [Understood]                                               │
└─────────────────────────────────────────────────────────────┘
```

#### 4 — Weekly Email Digest (footer, every email)

Every digest email includes this section above the unsubscribe footer:

```
─────────────────────────────────────────────
📌 A note on your score and sales:
Your Customer Confidence Score measures how
ready your listings are to convert qualified
visitors. If sales haven't moved yet, the gap
is likely in traffic quality or ad targeting —
not your listing. Your listing is ready.
─────────────────────────────────────────────
```

#### 5 — Decision Explorer (What-If results)

After every delta simulation result:

```
Your panel would raise 6 fewer objections at the new price.

Note: This reflects listing readiness only. The same
traffic quality conditions apply — more ready listings
convert better when the right audience sees them.
```

---

### The "Traffic Gap" Diagnostic (Pro/Enterprise — anti-churn feature)

For merchants who have been using Pro for 30+ days and have a high score (≥75) but haven't upgraded their listing based on recommendations, the dashboard shows a **Traffic Gap Diagnostic card**:

```
┌──────────────────────────────────────────────────────────────┐
│  📊 Your Listing Is Ready — Is Your Traffic?                 │
│  ────────────────────────────────────────────────────────────│
│  Your Customer Confidence Score is 82. Your panel has        │
│  very few objections. If sales haven't moved, consider:      │
│                                                              │
│  • Are you sending targeted traffic to this product?         │
│  • Does your ad audience match your customer panel type?     │
│    (Your panel: [Cigar enthusiasts, age 35-60, premium tier])│
│  • Are your ads sending traffic to this specific product     │
│    page, or to your homepage?                                │
│                                                              │
│  MiroShop cannot optimise your traffic, but your panel       │
│  profile above is a starting point for ad audience           │
│  targeting.                                                  │
└──────────────────────────────────────────────────────────────┘
```

This card turns a potential "this doesn't work" churn moment into a "MiroShop is helping me understand my whole funnel" retention moment. The niche panel profile (cigar enthusiasts, 35-60, premium tier) is genuinely useful for ad audience setup — it gives the merchant something actionable even when the listing score is already high.

---

### Updated Tier Feature Table (v1.5 — all gaps)

| Feature | Free | Pro ($29.90/mo) | Enterprise ($89/mo) |
|---------|------|-----------------|---------------------|
| Panel size | 5 agents | 25 agents | 50 agents |
| Progressive reporting | Phase 1 only (30s) | All 3 phases | All 3 phases + priority |
| Visual Quality Score | Yes | Yes | Yes |
| Debate rounds | 1 | 5 | 10 |
| Anti-templating (diversity injection) | Yes (all tiers) | Yes | Yes |
| On-demand panel checks | 3/mo | Within 500 MT budget | Within 2,000 MT budget |
| Weekly auto-scan | 1 product | 25 products | Unlimited |
| Decision Explorer | No | Yes | Yes |
| Ad-Creative Sandbox | No | 5 checks/mo | Unlimited |
| Competitor tracking | No | 2 competitors weekly (proxy-backed) | 5 competitors weekly (residential proxy) |
| Competitor historical trend | No | No | Yes |
| Traffic Gap Diagnostic | Basic disclaimer | Full diagnostic card | Full diagnostic + panel profile for ad targeting |
| Report detail | Score + 2 friction areas | Full report + quotes | Full + transcripts + PDF |
| Mobile dashboard | Yes (all tiers) | Yes | Yes |
| Phase 0 landing page | Pre-install only | N/A | N/A |

---

### Updated Implementation Phases (v1.5 additions)

**Phase 3 additions (Inference Engine):**
- Implement `DiversityContextGenerator` (temperature sampling, tone/vocab injection) — 2 days
- Implement `FreshnessGuard` (phrase overuse detection against store history) — 1.5 days
- Add report structure rotation to `ReportAgent` wrapper — 1 day
- Store last 20 agent reasoning phrase hashes per store in Neon — 0.5 days

**Phase 4 additions (Integration):**
- SSE heartbeat (25s `:heartbeat` comment from Worker) — 0.5 days
- SSE `Last-Event-ID` support for resumable streams — 1 day
- Mobile SSE auto-reconnect client with polling fallback — 1.5 days

**Phase 5 additions (Dashboard):**
- Mobile-first responsive pass on all Polaris components — 3 days
- Bottom sheet component for mobile agent reasoning (replaces popover) — 1 day
- Onboarding explainer screen (one-time, localStorage persisted) — 1 day
- Score subtitle ("Measures listing readiness — not traffic") — 0.5 days
- High-score warning callout (≥80, shown once) — 0.5 days
- Traffic Gap Diagnostic card (Pro/Enterprise, shown at 30 days + high score) — 1 day
- Decision Explorer disclaimer text — 0.5 days

**Phase 6 additions (Retention Engine):**
- Tiered scraping service (`ScrapingService` with Tier 1/2/3 escalation) — 3 days
- ScrapingBee integration (Tier 3 for Competitor Delta) — 1 day
- Competitor scrape Redis cache (24h TTL, 7-day stale fallback) — 1 day
- Daily proxy spend counter and operator alert ($50/mo threshold) — 1 day
- Weekly digest mobile email template pass (React Email, Litmus test) — 2 days
- Traffic gap section in weekly digest footer — 0.5 days

---

### Updated Risk Register (v1.5 additions)

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| **SSE dropped on mobile carrier after 30–60s** | High | High | 25s heartbeat prevents timeout; `Last-Event-ID` resumption; auto-fallback to polling after 2 failures |
| **Llama-3-8B collapses to template phrasing** | High | High | 4-layer diversity injection (temperature, vocabulary, structure rotation, freshness guard). Monitor phrase entropy per store weekly. |
| **FreshnessGuard false positives (flags legitimate phrases)** | Low | Medium | Threshold is 60% recurrence — very conservative. Only triggers regeneration once. Accepts result even if flagged phrase persists. |
| **ScrapingBee/proxy daily budget overrun** | Medium | Low | $3/day hard Redis cap; operator alert at $50/month; Phase 0 never uses proxy |
| **Residential proxy flagged as fraud traffic by target site** | Low | Low | BrightData residential IPs are genuine residential — not detectable as datacenter. Risk is low. |
| **Merchant blames MiroShop for zero sales despite high score** | High | Medium | 5-layer expectation management (onboarding, score subtitle, high-score warning, email footer, Traffic Gap Diagnostic). Document as known limitation in App Store listing. |
| **Email renders broken in Outlook 2021** | Medium | Medium | React Email components use email-safe HTML only. Litmus testing required before first send. No CSS Grid, no Flexbox in email. |
| **Mobile WebView localStorage unavailable (SSE lastEventId)** | Low | Medium | `lastEventId` stored in React state (memory) as fallback — works for current session even if localStorage is blocked |

*End of MiroShop AI Design Document v1.5*
