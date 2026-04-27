# What-If Lab redesign — continuation handoff

Use this file when resuming work on the **What-If Lab / PDP Simulator** visual redesign. Paste or mention it in chat so context aligns with this line of work.

## Goal

Match a **premium SaaS** look (Stripe/Vercel-style): cool gray canvas, white elevated cards, blue accent, generous whitespace, dashboard-style **Discover** and a **split Build** step (left context, right floating “simulation workspace” with metric strip and controls).

**Product preview:** Prefer **no dependency on merchant product photos** for the premium look — abstract gradient block + first letter of title (`LabPdpPreview`); `productImageUrl` may still be passed but is not used for the main visual.

## Primary files

| Area | Path |
|------|------|
| UI + flow | `packages/shopify-app/app/components/sandbox/ComparisonLaboratory.tsx` |
| Styles | `packages/shopify-app/app/components/sandbox/ComparisonLaboratory.module.css` |
| Route / props | `packages/shopify-app/app/routes/app.sandbox.$id.tsx` |

## What was implemented (checkpoint)

- **Theme:** `.labRoot` and related tokens shifted toward light gray background, white surfaces, blue accent (`#2563eb`), updated nav rail to light sidebar with blue active state.
- **Discover (step 0):** Dashboard-style layout with CSS classes prefixed `dash*` — page head, eyebrow, KPI board (4 cards with icons, trends, mini progress bar), insight card, section label; existing priority queue retained.
- **Build (step 1):** `refineSplit` — left `refineContext` (kicker, headline, product row with badge letter + name, no photo); right `refineSimCard` with simulation kicker/title, **metric strip** (list / test price hero / ship), **pill segment buttons** (`refineSegBtn`) for focus areas, same per-type control surfaces as before, `refinePreviewBlock` + compact `LabPdpPreview`, `refineCardDock` for actions and primary CTA styling.
- **Abstract PDP:** `labPdpAbstract`, `labPdpAbstractLetter`, `labPdpShellCompact` for compact preview.
- **Sliders:** Price and shipping `RangeSlider` wrapped in `refineSliderWrap` for blue progress track (Polaris CSS vars / overrides).
- **Default focus:** Simulation opens with a lever selected (e.g. price) via `buildFocus` default.

## Verification

- `npx vite build` (from `packages/shopify-app`) has been run successfully after these changes.

## Known issues / follow-ups

- **ESLint:** `npm run lint` in `packages/shopify-app` may fail due to **eslint-plugin-jest** (“Unable to detect Jest version”) on test files — unrelated to the Lab UI; fix separately if needed.
- **Polish:** Remaining gaps vs. reference screenshots (spacing, Arena/comparison step, typography, copy) — decide per review.
- **Naming:** Optional alignment of page title (“PDP Simulator” vs “What-If”) in the sandbox route and in-app copy.

## How to resume

1. Open the two component files above and this doc.
2. Note what still feels wrong vs. the reference images (specific screen + element).
3. Prefer **small, focused diffs** — extend existing `dash*` / `refine*` patterns before adding new systems.

Last updated: continuation checkpoint after adding missing `dash*` / `refine*` CSS and slider wrappers.
