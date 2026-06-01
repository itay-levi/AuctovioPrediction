# Shopify App Store Submission Readiness — CustomerPanel AI

Generated 2026-06-01. Use this as the source of truth when filling out the
Partner Dashboard listing.

---

## 1. Technical readiness

### App Bridge — PASS
- `AppProvider isEmbeddedApp apiKey={apiKey}` in [app/routes/app.tsx](../packages/shopify-app/app/routes/app.tsx#L50)
- `NavMenu` for in-app navigation
- `TitleBar` on every nested route (app._index, app.simulate, app.history, app.results, app.sandbox, app.billing)
- Polaris v12 for all UI components
- All in-app links use Remix `<Link>` (no raw `<a href="/app/...">` after [cf0cb98](../packages/shopify-app/app/routes/app.results.$id.tsx))

### Session token authentication — PASS
- [shopify.server.ts](../packages/shopify-app/app/shopify.server.ts) sets `future.unstable_newEmbeddedAuthStrategy: true` (Shopify's new mandatory session-token auth)
- `distribution: AppDistribution.AppStore` — correct for App Store
- Every route calls `authenticate.admin(request)` which validates the session token from the `Authorization: Bearer` header
- API version: January 2025 — current

### GDPR webhooks — PASS
All three mandatory compliance topics are registered in [shopify.app.toml](../packages/shopify-app/shopify.app.toml#L48-L58) using `compliance_topics`:

| Topic                  | Handler                                                                                                  | Behaviour |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | --------- |
| `customers/data_request` | [webhooks.customers.data_request.tsx](../packages/shopify-app/app/routes/webhooks.customers.data_request.tsx) | Returns 200; app stores no customer PII |
| `customers/redact`     | [webhooks.customers.redact.tsx](../packages/shopify-app/app/routes/webhooks.customers.redact.tsx)       | Returns 200; app stores no customer PII |
| `shop/redact`          | [webhooks.shop.redact.tsx](../packages/shopify-app/app/routes/webhooks.shop.redact.tsx)                 | Transactionally deletes store + all simulations + all agent logs + competitor watches |

All handlers call `authenticate.webhook(request)` for HMAC verification.

### Other webhooks
- `app/uninstalled` → cleans up sessions
- `app/scopes_update` → records scope changes
- `app_subscriptions/update` → downgrades store to FREE on cancellation/decline

### Database & cleanup — PASS
- Prisma migration in working tree adds `unlockedAt` + `unlockChargeId` to Simulation
- New compound indexes in [schema.prisma](../packages/shopify-app/prisma/schema.prisma#L81-L87) on `(storeId, originalSimulationId, createdAt DESC)`, `(storeId, status, createdAt)`, etc.
- **Before submission**: run `prisma migrate dev --name add_unlock_indexes` to generate a deployable migration, then `prisma migrate deploy` against production DB.

### Build & test status
- TypeScript: 0 errors
- Tests: 121/121 passing
- Production build: green
- Engine (Python): config validation fails fast in production if `SECRET_KEY`, `ENGINE_API_KEY`, or `SHOPIFY_APP_API_KEY` are missing; `FLASK_DEBUG=False` by default

---

## 2. Pre-submission CLI checks

Run these against a **fresh development store** before submitting:

```bash
cd packages/shopify-app

# 1. Link config + confirm OAuth is clean
npx shopify app config link
npx shopify app dev --tunnel-url https://dev.auctovio.com:443

# 2. Run prisma migrate to apply new indexes + unlock fields
npx prisma migrate dev --name add_unlock_paywall_and_indexes

# 3. Verify GDPR webhook handlers respond 200 (use ngrok URLs from `shopify app dev`)
curl -X POST <tunnel>/webhooks/customers/data_request -H 'X-Shopify-Topic: customers/data_request'
curl -X POST <tunnel>/webhooks/shop/redact -H 'X-Shopify-Topic: shop/redact'
# (Both will return 401 unless properly signed — that's expected from outside Shopify.
#  In dev they'll succeed because Shopify CLI signs the test webhooks.)

# 4. Trigger Shopify's app detector on the live URL
# (Partner Dashboard → Apps → CustomerPanel AI → Distribution → "Run app review")
```

---

## 3. App Store listing (Partner Dashboard fields)

### App name
**`CustomerPanel AI`**

(stored in `shopify.app.toml`; does NOT contain "Shopify" → no trademark issue)

### Tagline (max 70 chars)
**Suggested:** `AI customer panels that explain why shoppers leave your PDP`

Alternatives:
- `5 AI buyer personas stress-test your listings before you ship`
- `See why shoppers don't buy — before you spend on traffic`

### App icon
1200×1200 PNG; the ⚗️ emoji on the index page is a placeholder. Need a designed icon for the listing. The Brand Studio dark indigo gradient (`#1E1B4B → #4C1D95`) on a white "CP" mark fits the existing UI aesthetic.

### App description
Use this structure (Shopify limits to ~5000 chars):

```
Run an instant AI customer panel that reveals exactly why shoppers
abandon your product pages — and what to fix first.

WHAT IT IS
CustomerPanel AI assembles a panel of 5 distinct AI buyer personas
(Budget Optimizer, Brand Loyalist, Research Analyst, Impulse Decider,
Gift Seeker), gives them your live product page, and runs a structured
debate. You see each panelist's verdict, the dominant friction
categories (price, trust, logistics), and a ranked action plan.

PRIVACY-SAFE BY DESIGN
Our agents evaluate your listing data — they never visit your
storefront, fire browser events, or create sessions. Your Google
Analytics, Facebook Pixel, and all conversion tracking stay clean.

WHAT YOU GET
✓ Customer Confidence Score (0-100) and tier
✓ Full friction breakdown with % per category
✓ Every panelist's reasoning in their own words
✓ Prioritised action plan ranked by impact
✓ One-click policy generation (return policy, shipping, contact)
✓ What-If Lab: stress-test price/shipping/copy changes (Pro)
✓ Retake tests: re-run the same panel after you ship changes (Pro)
✓ Printable PDF report

PRICING
- FREE: see the score and a preview on every analysis
- $4.99 one-time: unlock the full report for a single product
- PRO $29.90/mo: 10 reports/month + What-If Lab + Retake + Intelligence Export
- ENTERPRISE $89/mo: 50 reports/month + everything

POSITIONING
This is a decision-support tool, not a forecasting tool. Scores
represent how a defined AI panel responded to your specific listing,
not predicted sales or conversion rates.
```

### Pricing plans (Partner Dashboard)
Configure these **exactly** as the in-app billing API uses them, otherwise approval fails:

| Plan | Type | Price | Currency | Trial | Billing API mutation |
| ---- | ---- | ----- | -------- | ----- | -------------------- |
| Free | (no charge) | $0 | USD | — | — |
| Single Report Unlock | One-time | $4.99 | USD | None | `appPurchaseOneTimeCreate` |
| Pro | Recurring 30d | $29.90 | USD | 7 days | `appSubscriptionCreate` |
| Enterprise | Recurring 30d | $89.00 | USD | 7 days | `appSubscriptionCreate` |

All four are sourced from [billing.server.ts](../packages/shopify-app/app/services/billing.server.ts#L4-L23).

### Screenshots (1600×900, max 6)

1. **Dashboard with Brand Studio hero + step cards** — `/app` for a brand-new store. Shows the install-time onboarding.
2. **Run Analysis page with sticky launch CTA** — `/app/simulate` showing the 4 step cards. Highlights the unique "5-persona panel" promise.
3. **Live Panel Room (analysing state)** — `/app/results/:id` during a running analysis. Shows the 5 animated avatars; this is the unique visual differentiator.
4. **Completed report — FREE tier paywall view** — score hero + teaser strip + paywall card. Shows the freemium model clearly.
5. **Completed report — UNLOCKED view** — score hero + full friction breakdown + action plan. Shows the value.
6. **What-If Lab with Price Optimizer** — `/app/sandbox/:id`. Shows the Pro-tier differentiation.

### Promotional video (optional but recommended)
30-60 sec walkthrough: install → pick a product → start analysis → watch the Panel Room → land on the locked report → unlock → see the action plan → apply a recommendation.

---

## 4. Test instructions for the Shopify reviewer

**Paste this verbatim into the Partner Dashboard "Test instructions" field.** Reviewers test against a fresh development store, so every step must be reproducible from a clean install.

```
THANK YOU FOR REVIEWING CUSTOMERPANEL AI

The app evaluates Shopify product pages via an AI customer panel.
No customer PII is stored. All analysis is on merchant-owned product
data only (title, description, images, price, tags).

PREREQUISITE
The development store must have at least one ACTIVE, PUBLISHED product
with a title, description, at least one image, and a price. If none
exist, the Run Analysis page will show an empty-state prompt to add a
product (this is intentional — we never run on empty listings).

If you don't already have a product, please add one:
- Shopify admin → Products → Add product
- Title: "Anything (e.g. 'Test Hoodie')"
- Description: A few sentences
- Status: Active
- Add at least one image
- Price: any
- Save

STEP-BY-STEP TEST

1. Install the app from the test link. You'll be redirected to the
   embedded dashboard at /app.

2. The dashboard shows 3 onboarding step cards. Click "Run Analysis"
   (you can also click "▶ Run" in the left sidebar).

3. On /app/simulate, select any product from the dropdown. The
   "▶ Run analysis now" button in the dark hero AND the sticky
   bottom bar should both light up. Click either one.

4. You'll be redirected to /app/results/{id} where you'll see:
   - A "Live Panel Room" with 5 animated panelist avatars
   - Status messages cycling every ~2.5 seconds
   - A shimmer progress bar
   This is the ~2-10 minute analysis window. The Live Panel Room
   keeps the merchant engaged while the LLM runs.

5. When complete (typically 2-5 min on the test engine), the page
   updates with:
   - Customer Confidence Score (0-100) inside a conic-gradient ring
   - A teaser strip showing the top friction category (no numbers)
   - A dark "Unlock full report — $4.99" paywall card
   - The full friction breakdown, panel debate, and action plan tabs
     are visible but show "Locked" placeholders for FREE-tier users.

6. PAY-PER-SCAN TEST (one-time charge):
   - Click "🔓 Unlock this report" on the paywall.
   - You'll be redirected to Shopify's payment confirmation page.
   - Approve the test charge ($4.99 — billed as a TEST charge in
     development, no real money moves).
   - Shopify redirects to /app/billing/unlock/callback?simulationId=…&charge_id=…
   - Our callback VERIFIES the charge is ACTIVE via the Shopify Admin
     API before unlocking. (We never trust query params alone.)
   - You land back on /app/results/{id}?unlocked=1 with the full
     report visible.

7. SUBSCRIPTION TEST (Pro plan):
   - From the sidebar, click "◆ Plans".
   - Click "Start free trial" under Pro ($29.90/mo, 7-day trial).
   - Shopify shows the subscription confirmation.
   - Approve. You'll return to /app?upgraded=1 and the store will
     show full Pro access (10 reports/month, What-If Lab, Retake).

8. WHAT-IF LAB TEST (Pro feature):
   - From the unlocked report, click "Launch What-If Lab →"
   - You land on /app/sandbox/{id}
   - The Price Optimizer panel is open by default
   - Adjust price slider, click Run simulation — a second analysis
     starts using ~50 MT from your monthly budget

9. GDPR WEBHOOK TEST (already wired):
   - customers/data_request: returns 200 (we store no customer PII)
   - customers/redact: returns 200 (we store no customer PII)
   - shop/redact: transactionally deletes the store, all its
     simulations, agent logs, and competitor watches in one
     transaction. Test via Partner Dashboard → Webhooks → Send test.

10. UNINSTALL TEST:
    - Uninstall the app from Shopify admin
    - The /webhooks/app/uninstalled handler fires and removes the
      OAuth session token from our session store
    - 48 hours later, Shopify sends shop/redact and we purge all
      remaining data

NOTES FOR THE REVIEWER

- Analysis takes 2-10 minutes because we run a real multi-phase LLM
  debate (5 panelists × 3 phases). The "Live Panel Room" UI is
  designed specifically so the merchant has visible progress
  feedback throughout the wait.

- All one-time and recurring charges are created via the Shopify
  Billing API (appPurchaseOneTimeCreate and appSubscriptionCreate
  GraphQL mutations). In development mode all charges are TEST
  charges — no real funds move.

- This is a DECISION-SUPPORT tool, not a sales forecasting tool.
  All UI copy uses "Customer Confidence Score", "panel buy rate",
  and "simulated customers said they'd buy". We never claim to
  predict conversion rates or revenue.

- If you need to reset the test data, click the in-app "Reset demo"
  button (only visible in development mode) or contact support
  at hello@auctovio.com.

CONTACT
hello@auctovio.com — replies within 24h Mon-Fri
```

---

## 5. Open items / pre-submission checklist

Before clicking Submit in Partner Dashboard:

- [ ] Run `prisma migrate dev` and `prisma migrate deploy` to apply the new `unlockedAt`, `unlockChargeId`, and compound indexes
- [ ] Set `ENGINE_API_KEY`, `SHOPIFY_APP_API_KEY`, and `SECRET_KEY` in production env (engine refuses to boot without them)
- [ ] Set `FLASK_DEBUG=false` in production env (default is now `False` so this is just a sanity check)
- [ ] Confirm `CRON_SECRET` is set so `/api/cron/cleanup` and `/api/weekly-scan` are reachable but auth'd
- [ ] Test the unlock flow end-to-end on a real development store (Shopify auto-creates test charges in dev mode — no real money moves)
- [ ] Test the subscription flow end-to-end (Pro and Enterprise)
- [ ] Run `npx shopify app deploy` to push the updated `shopify.app.toml` (GDPR webhook subscriptions + scopes)
- [ ] Create a 1200×1200 PNG app icon (replace the ⚗️ placeholder on the marketing page)
- [ ] Take the 6 screenshots at 1600×900 listed in section 3
- [ ] Optionally record a 30-60 sec walkthrough video
- [ ] Add `hello@auctovio.com` (or whichever support email you use) to the Partner Dashboard listing
- [ ] Confirm the dev tunnel `https://dev.auctovio.com` is replaced by a real production URL in `shopify.app.toml` before submission

---

## 6. Known limitations to disclose in the listing

These won't block approval but should be in the description so merchants know what they're buying:

- Analysis takes 2-10 minutes (we run real LLM debate, not pre-canned templates)
- Free tier: 3 root analyses + 30 MT per month
- One-time unlock ($4.99) unlocks THAT specific report forever, not all reports
- Subscription downgrades reset MT counter at the start of each month (calendar month, not 30-day rolling)
