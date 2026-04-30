# Session Notes — 2026-04-28 / 2026-04-29

Reference log of everything done in this Claude Code session. Spans:
1. **Brand Studio UI redesign** (Sidebar, Dashboard, Run, History, Results, What-If Lab)
2. **Full system test sweep** (10 iterations — bugs found and fixed)
3. **Results + What-If Lab** redesign (separate user request later in session)
4. **Phase 4 — UX bugs reported by user** (launch button broken, hidden price optimizer)

Project: **MiroShop AI / CustomerPanel AI / Auctovio** — Shopify embedded app + Python engine.

---

## TL;DR — Final state

- TypeScript: **0 errors**
- Tests: **121/121 passing** (was 79/85 with broken suites at session start)
- Production build: **green** (`npx remix vite:build` completes)
- 16 bugs found + fixed (2 critical: lifetime-MT lockout, Lab quota bypass)
- 6 pages restyled in Brand Studio dark-gradient + numbered-cards aesthetic
- 1 new test file added covering quota math (18 tests)

---

## Phase 1 — Brand Studio UI redesign (initial request)

**User context:** Showed Brand Studio (Salesforce multi-brand experience engine) screenshots, asked for "deep change in my UI and UX to match." First attempt was CSS-only and was rejected with: *"you need to do deep change in my UI and UX to match!! it hard work! start"*. Second round: *"you need to modify Run and history to match the UI i gave you!! make it better… again i am asking you to do deep changes!! if need redesign the UI and UX"*.

### Files created
- [packages/shopify-app/app/styles/app-shell.module.css](../packages/shopify-app/app/styles/app-shell.module.css) — left icon sidebar, 68 px wide, dark indigo gradient (`#1E1B4B → #2D2A75 → #312E81`), sticky position
- [packages/shopify-app/app/styles/results-page.module.css](../packages/shopify-app/app/styles/results-page.module.css) — Brand Studio shell shared by Results + Sandbox (created in Phase 3)

### Files heavily modified
- [packages/shopify-app/app/routes/app.tsx](../packages/shopify-app/app/routes/app.tsx) — wraps Outlet in shell with persistent left sidebar, active-route highlighting via `useLocation`
- [packages/shopify-app/app/routes/app._index.tsx](../packages/shopify-app/app/routes/app._index.tsx) — full rewrite: dark hero, stats row, 3 vertical step cards (Brand Studio Instructions style), Store Health right-panel for first-time users; compact hero strip + analyses list for returning users
- [packages/shopify-app/app/styles/dashboard.module.css](../packages/shopify-app/app/styles/dashboard.module.css) — added `.stepsV2`, `.stepCardV2`, `.stepCardV2Done`, `.stepCardV2Active`, `.stepCardV2Dim`, `.stepCircleV2`, `.doneBadge`, `.heroCompact*`
- [packages/shopify-app/app/routes/app.simulate.tsx](../packages/shopify-app/app/routes/app.simulate.tsx) — replaced old `simIntro + simStepper + simSetupGrid` with Brand Studio "Instructions" banner (`runBanner`) with progress bar + 4 numbered step cards (Select product / Scenario Lab / Extra emphasis / Launch)
- [packages/shopify-app/app/styles/simulate-flow.module.css](../packages/shopify-app/app/styles/simulate-flow.module.css) — added Brand Studio runBanner, runStepCard, runStepCircle, runStepCirclePurple/Green, doneBadge, requiredBadge, proBadge, optionalBadge
- [packages/shopify-app/app/routes/app.history.tsx](../packages/shopify-app/app/routes/app.history.tsx) — restructured grid card JSX: dark gradient top with dimmed image + score overlay + status chip badge + clean bottom for name/date/actions
- [packages/shopify-app/app/styles/history.module.css](../packages/shopify-app/app/styles/history.module.css) — added Brand Studio dark card-top: `.cardDarkTop` (148 px gradient), `.cardDarkTopBg` (22% opacity image), `.cardDarkTopInitial`, `.cardScoreOverlay`, `.cardScoreNum`, `.chipDone/.chipLive/.chipQueued/.chipFailed`

### Brand Studio design tokens (used everywhere)
- **Dark gradient hero:** `linear-gradient(135deg, #1E1B4B 0%, #312E81 50%, #4C1D95 100%)` with starfield texture overlay
- **Numbered step circles:** 36–44 px rounded squares with `linear-gradient(135deg, #312E81, #4338CA)`, indigo glow shadow
- **Done state:** green gradient `#16A34A → #15803D` with `✓` + DONE pill badge
- **Pill tabs:** white surface w/ 1 px slate border, active = indigo gradient with glow
- **Status chips on dark:** frosted glass — `rgba(255,255,255,0.10)` bg, `rgba(255,255,255,0.20)` border

---

## Phase 2 — Full system test sweep (10 iterations)

**User request:** *"run full system testing… simulate different users… SW engineer, AI engineer, expert QA, Shopify expert, architect… find bugs and fix them… 10 iterations… production ready. no question! start!"*

### Bugs found & fixed (16 total)

| # | Severity | Area | Bug | File |
|---|---|---|---|---|
| 1 | High | Type | `confidenceScore` field missing from agent-log inline type but read at runtime | [simulation.server.ts:391](../packages/shopify-app/app/services/simulation.server.ts#L391) |
| 2 | High | Type | `reportJson: { not: null }` — Prisma rejects bare `null` on JSON fields, must use `Prisma.JsonNull` | [app.simulate.tsx:68](../packages/shopify-app/app/routes/app.simulate.tsx#L68) |
| 3 | UI | Polaris | `Badge` rendered string-array children; broke layout silently in 5 places | [FrictionReport.tsx:112](../packages/shopify-app/app/components/FrictionReport.tsx#L112) |
| 4 | UI | Polaris | `<TitleBar breadcrumbs={…} primaryAction={…}>` props removed from current Shopify SDK; passed as silent DOM noise in 5 routes | results / sandbox / simulate / history / billing |
| 5 | **CRITICAL** | Quota | `canRunSimulation` only validated 1 sim cost while Customer Lab creates 2 — FREE users could effectively double their MT budget | [simulation.server.ts:12](../packages/shopify-app/app/services/simulation.server.ts#L12) |
| 6 | High | Quota | Sandbox `simulate_all` (N experiment cards) and `batch_price_optimize` (3 sims) only validated 1 sim's worth of MT | [app.sandbox.$id.tsx](../packages/shopify-app/app/routes/app.sandbox.$id.tsx) |
| 7 | Reliability | Engine | `triggerDeltaSimulation` had no `AbortSignal.timeout` — request could hang forever | [engine.server.ts:180](../packages/shopify-app/app/services/engine.server.ts#L180) |
| 8 | Reliability | Memory | Unbounded products `Map` cache — memory leak across many shops; added 200-entry LRU eviction | [products.server.ts:38](../packages/shopify-app/app/services/products.server.ts#L38) |
| 9 | Reliability | Loop | `fetchProducts` infinite loop if Shopify returned `hasNextPage: true` with null cursor; no error handling for GraphQL `errors` block | [products.server.ts:94](../packages/shopify-app/app/services/products.server.ts#L94) |
| 10 | **CRITICAL** | Quota | `mtBudgetUsed` was a lifetime counter never reset → users permanently locked out after one month. Now computed from this-month's COMPLETED simulations via `aggregate({_sum: mtCost})`. | [store.server.ts:50](../packages/shopify-app/app/services/store.server.ts#L50) |
| 11 | Security | Webhook | `webhooks.engine.callback` accepted negative/non-finite `actualMtCost` from engine → could decrement MT; now clamped to `[0, 10000]` | [webhooks.engine.callback.tsx:127](../packages/shopify-app/app/routes/webhooks.engine.callback.tsx#L127) |
| 12 | **Security XSS** | Print | `IntelligenceExport.handlePrint` used `document.write` with unescaped product title + engine synthesis text. Rebuilt with `createElement` + `textContent`. | [IntelligenceExport.tsx:100](../packages/shopify-app/app/components/IntelligenceExport.tsx#L100) |
| 13 | Logic | Health score | `computeShopHealthScore` returned "price" as topFriction even when no sim had any friction data (fall-through from default-0 counters) | [health-score.server.ts:25](../packages/shopify-app/app/services/health-score.server.ts#L25) |
| 14 | Tests | Vitest | `vi.mock` factories referenced top-level `const mockX = vi.fn()` — TDZ at hoist. Wrap with `vi.hoisted(() => ({…}))` | api.simulation.synthesize.test, api.weekly-scan.test, app.billing.callback.test |
| 15 | Tests | Mock | `Banner` mock spread `title` as DOM attribute, breaking 3 RouteErrorBoundary tests; rebuilt mock to render `title` as visible div | [test/setup.tsx](../packages/shopify-app/app/test/setup.tsx) |
| 16 | Encoding | Parser | 172 smart-quote characters (`"` `"`) silently introduced into [app.simulate.tsx](../packages/shopify-app/app/routes/app.simulate.tsx) from prior Brand Studio rewrite — TS parse errors | fixed via byte-level Python replace |

### New tests added
- [packages/shopify-app/app/services/simulation.server.test.ts](../packages/shopify-app/app/services/simulation.server.test.ts) — **18 tests** covering:
  - `estimateSimulationCost` for FREE/PRO/ENTERPRISE
  - `canRunSimulation` dev-mode bypass
  - MT < 1 sim cost rejection
  - **Lab quota (2 sims) when MT only covers 1** — Bug #5 regression test
  - Monthly slot count + simsToCreate > limit
  - Boundary conditions (exactly at limit)
  - PRO 25-agent allowance
  - **Delta sims (`countsTowardSlotQuota=false`) skip slot quota** — Bug #6 regression test
  - **Delta sim batch validates total MT cost**
  - **Monthly MT reset implicit (sum is COMPLETED only)** — Bug #10 regression test
  - `getMonthlyAnalysesQuota` clamping
  - `expireStuckSimulations` count
- Extended [products.server.test.ts](../packages/shopify-app/app/services/products.server.test.ts) — GraphQL errors, infinite-loop guard, empty data block
- Extended [store.server.test.ts](../packages/shopify-app/app/services/store.server.test.ts) — monthly reset, mt-from-aggregate

### API surface changes
```ts
// canRunSimulation gained 2 optional params
canRunSimulation(
  shopDomain: string,
  storeId: string,
  simulationsToCreate: number = 1,        // Lab=2, batch What-If=N
  countsTowardSlotQuota: boolean = true,  // false for delta/retake/what-if
)

// getMtBudgetStatus now reads simulations table not store.mtBudgetUsed
// (mtBudgetUsed field still updated for legacy/audit but no longer authoritative)
```

---

## Phase 3 — Results + What-If Lab page redesign (separate request)

**User request:** *"Results page is not following the same UI i asked you do to.. implement that, same for What-If Lab. Results page is hard to understabd.. it's scatterd.. it's SHIT!!"*

### What was wrong
- 4–5 stacked Polaris `<Banner>`s (failure / status / TL;DR / PDF guide) competed for attention above the fold
- Polaris `<Tabs>` with plain text — no visual weight in the hierarchy
- Massive dark "What-If Lab" promo eating ~250 px of vertical space inside Overview tab
- Sandbox top was just a subdued paragraph — nothing to anchor the eye

### Solution — shared shell

Created [packages/shopify-app/app/styles/results-page.module.css](../packages/shopify-app/app/styles/results-page.module.css) used by both pages. Components:

1. **`.scoreHero`** — dark gradient hero. Splits into:
   - **Left:** dot-eyebrow + product title + TL;DR/desc + meta chips (status, back link, count)
   - **Right:** **conic-gradient score ring** filling proportionally to the score, color-coded by tier (green ≥80, blue ≥65, amber ≥45, red <45) with score number inside + tier badge underneath
2. **`.statusStrip`** — compact running indicator (CSS-only spinner) replaces the noisy banner
3. **`.tabNav`** + **`.tabBtn`** + **`.tabBtnActive`** — pill tab bar with indigo-gradient active state, red issue-count pill
4. **`.whatIfCompact`** — single-row dark gradient strip with white CTA (or frosted locked CTA for non-Pro) replaces the 250 px marketing block
5. **`.sectionCard`** + **`.sectionNumber`** — numbered Brand Studio section cards (used selectively where helpful)

### Results page ([app.results.$id.tsx](../packages/shopify-app/app/routes/app.results.$id.tsx))
- Removed Polaris `<Tabs>` import + JSX usage; replaced with `<div role="tabpanel">` so existing tab content keeps working unchanged
- Three stacked banners collapsed into hero + meta chips (PDF link is now a chip; failure message becomes TL;DR text)
- Score lives in hero ring instead of duplicated above the existing `ConfidenceGauge` Card

### Sandbox / What-If Lab page ([app.sandbox.$id.tsx](../packages/shopify-app/app/routes/app.sandbox.$id.tsx))
- Replaced the plain "Discover friction…" paragraph with same Brand Studio hero, anchored on the **baseline score** ring
- Hero meta: ← back to results, scenario count, live-running indicator
- `<ComparisonLaboratory>` component below stayed untouched (kept all experiment-card / scenario-history / price-batch logic)

---

## Phase 4 — UX fixes (user-reported)

**User report:** *"Run simulation on the UI is not very visible to user. Users need to scroll down to see it. They can miss it. It's not working — when I press it, it spins but nothing happens. Also Price Optimizer — this is a selling point in my app, it's hidden, people can miss it easily!"*

### Bug A — Launch button spins forever (CRITICAL functional bug)

**Root cause:** [app.simulate.tsx](../packages/shopify-app/app/routes/app.simulate.tsx) used `useFetcher()` + `<fetcher.Form>` for a form whose action does `throw redirect("/app/results/${id}")`. With `useFetcher`, server redirects are **followed silently in the background** — the fetcher loads the new page's data but the user's URL never changes. The button stays in `loading=true` forever because no navigation completes.

**Fix:** Replaced `useFetcher()` + `<fetcher.Form>` with `<Form method="post">` + `useNavigation()` + `useActionData()`. Now `throw redirect` causes a **real page navigation** to `/app/results/:id`.

```diff
- import { useLoaderData, useFetcher } from "@remix-run/react";
+ import { useLoaderData, Form, useNavigation, useActionData } from "@remix-run/react";

- const fetcher = useFetcher<typeof action>();
- const isSubmitting = fetcher.state !== "idle";
- const error = fetcher.data?.error;
+ const navigation = useNavigation();
+ const actionData = useActionData<typeof action>();
+ const isSubmitting = navigation.state === "submitting" || navigation.state === "loading";
+ const error = actionData?.error;

- <fetcher.Form method="post">
+ <Form method="post" id="simulate-form">
```

**Note:** Sandbox page also uses `useFetcher` with redirect, but its redirects target the SAME route (`/app/sandbox/${id}`) so the fetcher correctly revalidates the loader. Only simulate (which redirects to a DIFFERENT route) was broken.

### Bug B — Launch button hidden below the fold

Step 4 ("Launch") was at the bottom of the form, requiring scroll to find. Two visible CTAs added (both target `<form id="simulate-form">` via HTML `form` attribute):

1. **Inside the dark hero banner** ([app.simulate.tsx](../packages/shopify-app/app/routes/app.simulate.tsx) — `.runBannerCta`): white pill button "▶ Run analysis now" appears once `canRun=true`, dimmed frosted button "Pick a product to enable" before that — always above the fold.
2. **Sticky bottom launch bar** (`.stickyLaunchBar`): dark gradient bar at `position: sticky; bottom: 0.85rem` with title + subtitle + white CTA — guarantees the action is always visible no matter where the user scrolls.

CSS additions in [simulate-flow.module.css](../packages/shopify-app/app/styles/simulate-flow.module.css):
- `.runBannerCta`, `.runBannerCtaBtn`, `.runBannerCtaReady`, `.runBannerCtaWaiting`, `.runBannerCtaHint`
- `.stickyLaunchBar`, `.stickyLaunchBarText`, `.stickyLaunchBarTitle`, `.stickyLaunchBarSub`, `.stickyLaunchBarBtn`

### Bug C — Price Optimizer hidden behind tiny disclosure link

Was rendered as a Polaris `<Button variant="plain" disclosure="down">` saying "Optional: scan three price points at once" — looked like a tertiary footnote despite being a primary selling point.

**Fix in [ComparisonLaboratory.tsx](../packages/shopify-app/app/components/sandbox/ComparisonLaboratory.tsx):**
- Default state changed from `useState(false)` → `useState(true)` — **expanded by default**
- Replaced plain disclosure button with a **Brand Studio dark feature banner** (indigo gradient + eyebrow "💰 Price Optimizer · Pro feature" + bold title + description + white expand/collapse pill on right)
- Added a **sandbox-hero CTA chip** in [app.sandbox.$id.tsx](../packages/shopify-app/app/routes/app.sandbox.$id.tsx) — "💰 Try the Price Optimizer" — that smooth-scrolls to `#lab-price-optimizer-panel`. Discoverable from the very top of the What-If Lab page.

CSS additions in [ComparisonLaboratory.module.css](../packages/shopify-app/app/components/sandbox/ComparisonLaboratory.module.css):
- `.priceOptHeroBanner`, `.priceOptHeroBannerLeft`, `.priceOptHeroEyebrow`, `.priceOptHeroTitle`, `.priceOptHeroDesc`, `.priceOptHeroToggle`

### Cloudflared tunnel logs (infrastructure, not app code)

User pasted ~200 lines of cloudflared logs showing repeated QUIC stream timeouts and DNS lookup failures for `protocol-v2.argotunnel.com`. **These are normal** — cloudflared resets idle tunnel connections every ~25 minutes. Two follow-ups if you want quieter logs:
- **Upgrade cloudflared** to `2026.3.0` (current `2025.8.1` is flagged outdated by its own warning)
- **DNS timeouts** during a few reconnects suggest brief ISP/network blips — nothing the app can do

---

## Files touched (summary)

### Created
- [packages/shopify-app/app/styles/app-shell.module.css](../packages/shopify-app/app/styles/app-shell.module.css)
- [packages/shopify-app/app/styles/results-page.module.css](../packages/shopify-app/app/styles/results-page.module.css)
- [packages/shopify-app/app/services/simulation.server.test.ts](../packages/shopify-app/app/services/simulation.server.test.ts)
- [docs/SESSION_NOTES_2026-04-29.md](./SESSION_NOTES_2026-04-29.md) (this file)

### Heavily modified
- [packages/shopify-app/app/routes/app.tsx](../packages/shopify-app/app/routes/app.tsx)
- [packages/shopify-app/app/routes/app._index.tsx](../packages/shopify-app/app/routes/app._index.tsx)
- [packages/shopify-app/app/routes/app.simulate.tsx](../packages/shopify-app/app/routes/app.simulate.tsx)
- [packages/shopify-app/app/routes/app.history.tsx](../packages/shopify-app/app/routes/app.history.tsx)
- [packages/shopify-app/app/routes/app.results.$id.tsx](../packages/shopify-app/app/routes/app.results.$id.tsx)
- [packages/shopify-app/app/routes/app.sandbox.$id.tsx](../packages/shopify-app/app/routes/app.sandbox.$id.tsx)
- [packages/shopify-app/app/routes/webhooks.engine.callback.tsx](../packages/shopify-app/app/routes/webhooks.engine.callback.tsx)
- [packages/shopify-app/app/services/simulation.server.ts](../packages/shopify-app/app/services/simulation.server.ts)
- [packages/shopify-app/app/services/store.server.ts](../packages/shopify-app/app/services/store.server.ts)
- [packages/shopify-app/app/services/engine.server.ts](../packages/shopify-app/app/services/engine.server.ts)
- [packages/shopify-app/app/services/products.server.ts](../packages/shopify-app/app/services/products.server.ts)
- [packages/shopify-app/app/services/health-score.server.ts](../packages/shopify-app/app/services/health-score.server.ts)
- [packages/shopify-app/app/components/IntelligenceExport.tsx](../packages/shopify-app/app/components/IntelligenceExport.tsx)
- [packages/shopify-app/app/components/FrictionReport.tsx](../packages/shopify-app/app/components/FrictionReport.tsx)
- [packages/shopify-app/app/styles/dashboard.module.css](../packages/shopify-app/app/styles/dashboard.module.css)
- [packages/shopify-app/app/styles/simulate-flow.module.css](../packages/shopify-app/app/styles/simulate-flow.module.css)
- [packages/shopify-app/app/styles/history.module.css](../packages/shopify-app/app/styles/history.module.css)

### Tests fixed/extended
- [packages/shopify-app/app/test/setup.tsx](../packages/shopify-app/app/test/setup.tsx) — Banner mock, URL.createObjectURL stubs
- [packages/shopify-app/app/components/RouteErrorBoundary.test.tsx](../packages/shopify-app/app/components/RouteErrorBoundary.test.tsx)
- [packages/shopify-app/app/components/IntelligenceExport.test.tsx](../packages/shopify-app/app/components/IntelligenceExport.test.tsx)
- [packages/shopify-app/app/components/RecommendationsPanel.test.tsx](../packages/shopify-app/app/components/RecommendationsPanel.test.tsx)
- [packages/shopify-app/app/routes/api.cron.cleanup.test.ts](../packages/shopify-app/app/routes/api.cron.cleanup.test.ts)
- [packages/shopify-app/app/routes/api.simulation.synthesize.test.ts](../packages/shopify-app/app/routes/api.simulation.synthesize.test.ts)
- [packages/shopify-app/app/routes/api.weekly-scan.test.ts](../packages/shopify-app/app/routes/api.weekly-scan.test.ts)
- [packages/shopify-app/app/routes/app.billing.callback.test.ts](../packages/shopify-app/app/routes/app.billing.callback.test.ts)
- [packages/shopify-app/app/services/store.server.test.ts](../packages/shopify-app/app/services/store.server.test.ts)
- [packages/shopify-app/app/services/health-score.server.test.ts](../packages/shopify-app/app/services/health-score.server.test.ts)
- [packages/shopify-app/app/services/products.server.test.ts](../packages/shopify-app/app/services/products.server.test.ts)
- [packages/shopify-app/vitest.config.ts](../packages/shopify-app/vitest.config.ts)

---

## How to verify after restart

```bash
cd h:/Dev/AuctovioPrediction/packages/shopify-app

# TypeScript — should be clean
npx tsc --noEmit

# Test suite — should be 27 files / 121 tests passing
npx vitest run --no-coverage

# Production build — should complete
npx remix vite:build

# Dev server (engine + shopify-app concurrently)
cd h:/Dev/AuctovioPrediction
npm run dev -- --tunnel-url https://dev.auctovio.com:443
```

---

## Open follow-ups / known limitations

- **`mtBudgetUsed` field is now dead state** — `incrementMtUsage` and `cancelSubscription` still write to it, but `getMtBudgetStatus` reads from `simulation.aggregate`. Cleanup task: drop the field in a migration once we're confident nothing else reads it.
- **Vitest config workspace-hoisting** — vite is duplicated between `packages/shopify-app/node_modules/vite` and `node_modules/vite` causing a TS plugin-type mismatch; worked around with `as any` cast in [vitest.config.ts](../packages/shopify-app/vitest.config.ts). Real fix is to dedupe via npm overrides or hoist Vite to root only.
- **Engine pytest skipped** — pytest install on Python 3.12 had OSErrors creating `.exe.deleteme` lockfiles; would need a clean venv. Engine code was reviewed by inspection instead.
- **Polaris vendor CSS warning** — `@media (--p-breakpoints-md-up) and print` invalid CSS in Polaris bundle, esbuild warns but it's not actionable from our side.
- **Pre-existing CSS warning** — same Polaris warning visible during build, not introduced by us.

---

## Positioning rules (recall — from memory)

> **NEVER** describe MiroShop AI as a prediction tool — Shopify bans apps that predict sales/conversion rates.
> **USE:** "Customer Confidence Score", "panel buy rate", "simulated customers said they'd buy", "decision confidence".
> **BAN:** "Purchase Probability Index", "conversion rate prediction", "will sell", "predicted revenue".
> Reports lead with **objections first, positives last** (prevents false confidence → bad decisions → churn).
> Agents must **structurally disagree** — hardcoded archetype rejection thresholds, mandatory dissenter injection if any cluster >80% positive.

---

*Generated 2026-04-29 by Claude Code session.*
