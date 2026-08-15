# Dip-lomacy: Handoff & Build State

**Version**: 0.4.4  
**Updated**: 2026-08-16 AEST  
**Repo Root**: `dip-lomacy.com/dip-lomacy/`

---

## 1. Executive Summary & Vision

A deliberately dumb, highly addictive clicker web toy. Two food mascots square up against each other across a shared, perpetual global counter:
- **Tendie (Left)**: Chicken tender held by cartoon arm, dipped in ranch. Western brainrot / needy golden retriever energy. Currency: **Good boy points**.
- **Dimmie (Right)**: Dumpling held by chopsticks, dipped in dark vinegar. Ray Shoesmith (*Mr Inbetween*) deadpan Aussie menace. Currency: **Respect points**.

The interaction is a pure, single-tap **"blop"** dunking the food into the sauce. Fast, funny, and completely responsive.

---

## 2. UI & Screen Layout Requirements

### Strict "Above the Fold" Constraint (`100vh`)
- The entire application viewport is strictly **`height: 100vh; overflow: hidden;`**. No vertical scrolling under any circumstance.
- Divided into 3 proportional flex tiers:
  1. **Top Header & War Scoreboard** (~110px): Arcade display logo (**Bungee Shade**), live tug-of-war progress bar with lead margin badges.
  2. **Center Arena** (`flex: 1`, min-height 0): Side-by-side stages for Tendie and Dimmie.
  3. **Bottom Footer** (~45px): Tabular lifetime counters (**Space Mono**).

### Visual Arena System
- **Unified Neutral Backdrop**: Solid soft slate-blue / off-white (`#F0F4F8`) across both sides to eliminate harsh contrast splits.
- **Direct Interaction**: Tapping anywhere on a mascot stage triggers the dunk directly.

---

## 3. SVG Art & Rig Architecture

Both mascots are pure vector SVGs created on a shared **2160 x 1672** canvas and co-registered to identical coordinates.

### Crucial Rig Rule (The Stationary Bowl Fix)
- **Do not animate the outer SVG or HTML containers.**
- In `XLB.svg`:
  - `#Vinegar_Bowl` is a stationary sibling layer on the table.
  - The dipping components (`#Chop_Stick_Back`, `#Main_Dumpling`, `#Chop_Stick_Front`, and face groups) are grouped into `#dip`.
- In `tendie.svg`:
  - Dipping group is `#dip` (arm, tender, mouth/brows).
- **The Dip Animation**:
  - CSS keyframe rotation is applied **strictly to `svg #dip`** around an off-frame pivot point (`transform-origin: 1800px -200px` or proportional).
  - The sauce bowls stay completely stationary on the table while the food swings down into the sauce on a natural arc.
- **No Fake HTML Bowls**: Remove ad-hoc HTML sauce bowl divs. Let the native SVG vector bowl render in place.

### Expression System
- Fixed eye geometry with standings-reactive eyebrow and mouth swaps (`XLB_Face_Happy` when winning, `XLB_Face_Worried` / `XLB_Face_Begging` when trailing).

---

## 4. Backend & Bot Protection Architecture

- **Stack**: Cloudflare Worker + Hono + 1 Durable Object (`GlobalWarDO`) with WebSocket fan-out (~10 Hz aggregation).
- **Physical Animation Gate**: Drops taps arriving faster than the **300ms mascot arc duration**.
- **Bot Detection via Statistical Jitter**:
  - Tracks rolling 15-dip interval variance per connection.
  - Synthetic zero/near-zero variance (<15ms stdDev) or continuous non-stop streaks (>100 dips without a >1.5s pause) triggers a quiet shadow-ban on global score contribution.
- **Local Persistence**: Browser `localStorage` for player streak and faction choice.

---

## 5. Current File Tree

```
dip-lomacy.com/
├── assets/                       # Original art source exports
│   ├── XLB.svg
│   ├── tendie.svg
│   └── demo.html
└── dip-lomacy/                   # Application Repository
    ├── public/
    │   └── assets/
    │       ├── XLB.svg           # Co-registered Dumpling vector
    │       └── tendie.svg        # Co-registered Tendie vector
    ├── src/
    │   ├── durable_object.ts     # Global war state, rate gate & bot jitter checks
    │   ├── index.ts              # Hono Worker entrypoint & static asset fallback
    │   ├── main.ts               # Front-end engine, Web Audio blop & WebSocket sync
    │   └── style.css             # Unified arcade layout & SVG #dip keyframes
    ├── index.html                # Main SPA entrypoint
    ├── architecture.md           # Master architectural decision log
    ├── handoff.md                # This document
    ├── package.json              # npm dependencies (Hono, Vite, Wrangler)
    ├── tsconfig.json             # TypeScript configuration
    ├── vite.config.ts            # Vite bundler config (outputs to ./dist)
    └── wrangler.jsonc            # Cloudflare Worker & DO bindings
```

---

## 6. Immediate Next Steps

1. **Refire Layout in `src/style.css` & `index.html`**:
   - Strip out custom HTML sauce divs.
   - Lock outer container to `height: 100vh; overflow: hidden;`.
   - Scale SVG viewports to fit dynamically inside the `flex: 1` center arena.
2. **Refire Rig in `src/main.ts`**:
   - Target only the internal `svg #dip` elements for keyframe rotation so `#Vinegar_Bowl` remains completely motionless.
