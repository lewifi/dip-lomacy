# Dip-lomacy: architecture

Version: 0.4.3
Updated: 2026-08-15 13:15 AEST

Living decision log for the build. The full product brief lives in the handover
document; this file records what we have actually decided and why, plus the
questions still open. Conventions: British English, no em dashes, sentence case,
three-level semver bumped on every meaningful change.

## 1. What this is

A deliberately dumb, addictive web toy. There is a snack over a dish of sauce, you
dip it, it goes "blop". Two factions (Tendie and Dimmie) each feed a shared global
counter, they trash talk each other about the food (never the people), and a daily
streak plus the live war is the retention engine. It is meant to be **fun, funny and
completely meaningless, but addictive**. That is the whole brief. The handover's
framing rules are not gravity to be solemn about, they are just cheap insurance that
keeps it that way, the couple of habits that stop anyone projecting a meaning onto two
snacks. Hold them light.

## 2. Naming and terminology

- **Tendie**: the left mascot, a breaded chicken tender held by a bare cartoon arm,
  dipped into ranch. Golden-retriever energy. Currency: good boy points (see
  section 3).
- **Dimmie**: the right mascot, a dumpling held by chopsticks, dipped into dark
  vinegar. Quiet menace, a personal code. Name is Aussie slang from "dim sim", so it
  reads as the food and geolocates the nickname to Australia rather than pinning the
  side to a country. Currency: respect (see section 3).
- Left is Tendie, right is Dimmie, fixed, so they square up against each other.
- Canonical spelling in code is **tendie** (not "tendy"), one spelling per side.
- Counters and faction keys: `tendie_dips`, `dimmie_dips`, `tendie`, `dimmie`.
- Keep the labels generic: Dimmie is just the character's nickname. The team and food
  surface stays "dumpling" ("Team Dumpling", "dip the dumpling"), not "dim sim" or
  "XLB". Same as Tendie being the name while the food is a "tender". Costs nothing.

Considered and rejected: **Ling** (from dump-*ling*). Clean and globally legible,
but it reads as a feminine given name, which clashes with the character. Kept on the
bench only as the name we would use if the dumpling were ever reworked into a
"refined aunty" character.

## 3. Faction voice and currency

The two sides split on **internet register**: how they post, not where they are from.
Tendie is western brainrot, Dimmie is deadpan Aussie menace. That is where all the
contrast and the comedy come from, and it happens to keep the jokes pointed at posting
styles and soggy food instead of at anybody real. Win win.

### Tendie

- Currency: **good boy points**. Straight from the r9k/"tendies" meme, where mummy
  awards good boy points for being a good boy and they are redeemed for chicken
  tendies. Western-internet-generic, represents no nation, just brainrot.
- Voice: loud, needy, earnest, desperate for approval, mummy's good boy. Says
  everything. Wholesome and a little unhinged.
- Reward feel: handed out by the fistful, wholesome inflation (+37!).
- Opportunity: mummy could be an actual voice on the counter ("that's my good boy").
  Tendie has a doting mummy in his ear.

### Dimmie

- Currency: **respect** (styled "respect points" to mirror "good boy points"). Not
  dojo-sensei respect: underworld respect, earned, never given, backed by an implied
  consequence.
- Voice: **Ray Shoesmith from Mr Inbetween**. Quiet, deadpan, understated, polite,
  Aussie, with a personal code and casually dangerous. Says almost nothing; a short
  cold line lands harder than a paragraph. A **principled anti-hero, not a villain**:
  like Ray, he only comes for the guilty, and in this game the guilty party is a soggy
  tendie. So the menace is always aimed at the plate, which is what makes him funny and
  rootable rather than mean.
- Reward feel: stingy. One grudging point at a time, and you feel it.
- The inversion that matters: Tendie has a doting mummy; Dimmie has nobody, just his
  own cold judgement. The absence of a mummy is the joke (and handily it is a
  lone-operator bit, nothing to do with anyone's family).

### Keeping it dumb (the fun kind of rules)

- **Menace stays a vibe, never literal.** The joke is the calm, not the kill. Dimmie
  radiates "don't", the toy never actually threatens anyone.
- **Trash talk stays about the food.** Soggy pastry, beige nuggets, mayo as a flavour,
  bitter vinegar. Bottomless material, and it is funnier than going after people
  anyway. Tendie rambles it, Dimmie says it flat and cold.
- **Red packet is a cosmetic, not the currency.** As the core reward it would quietly
  turn Dimmie into A Statement About A Culture, which is the opposite of dumb fun. As
  an opt-in skin on the cosmetics shelf it is just a nice thing a player picked. Same
  object, way more fun.

## 4. Tech stack

Cloudflare-native, matching the owner's existing Worker projects (trash-can,
file-share).

- Cloudflare Worker serves the single-page front end and the API (`src/worker.ts`).
- Hono for routing inside the Worker.
- One Durable Object holds authoritative global state and fans out live totals over
  WebSocket.
- Vite build to `./dist`, served via the Worker `assets` binding as a single-page
  app, with `run_worker_first` for the API and WebSocket routes.
- Front end is vanilla (no React/Tailwind here), kept clean and componentised, per
  the handover's "no framework needed".
- npm, single lockfile. `nodejs_compat`. Observability on.
- Per-player state (faction, points, streak, cosmetics, sauce) in localStorage for
  v1. Anonymous KV id is a later option only if cross-device persistence is needed.

## 5. Repo layout

- Git repo root: `dip-lomacy.com/dip-lomacy/` (remote
  `github.com/lewifi/dip-lomacy.git`, branch `main`, no commits yet).
- **To do**: the art currently sits one level up in `dip-lomacy.com/assets/`,
  outside the repo. It needs to move inside the project before the build can see it,
  matching the owner's convention where everything lives inside the project folder.

## 6. Art inventory and rig notes

Source SVGs (Illustrator exports), both on a shared 2160 x 1672 canvas, and now
**co-registered to the same position**, so a mascot swap is a pure art swap with
nothing repositioning. Both are pure vector (no embedded raster), so recolouring and
sauce swaps stay trivial. Note the filesystem is case-insensitive, so `xlb.svg` and
`XLB.svg` are the same file.

- `tendie.svg` (~16KB): has a `#dip` wrapper group meant to be the group that rotates
  for the dip. Contains `#Hand` (the arm) and `#tendie` (the tender). Currently one
  full face (`#Face_Happy`), plus alternate brow and mouth parts being added
  (`mouth1`, `left_eyebrow`, `right_eye_brow1`) to build more expressions by swap.
- `XLB.svg` (~574KB, path-heavy, run through SVGO on import): the dumpling. Chopsticks
  split into `#Chop_Stick_Back` and `#Chop_Stick_Front` so the dumpling nests between
  them with depth. Six toggleable faces: happy, begging, worried, angry, stunned,
  surprised. `#Vinegar_Bowl` is a sibling of the dumpling, so the bowl stays put while
  the food dips into it. **No `#dip` wrapper**: on import, wrap the dumpling's dipping
  parts (everything except `#Vinegar_Bowl`) into a matching group so both mascots
  rotate an identically named group around the shared pivot.

Decisions from the art:

- **Holder is in for v1.** Owner has drawn Tendie's arm and kept Dimmie's chopsticks,
  so both mascots dip via their holder, not as naked food.
- **Dip animation is an off-frame arc, not a straight plunge.** Rotate the holder
  group around a `transform-origin` set off the top corner of the artboard, so the
  food swings into the sauce on a natural arc. The sauce vessel is excluded from the
  rotating group and stays still. Because the two mascots are co-registered, this is
  **one shared rig**: single pivot, single vessel spot, faction is just the art layer.
- **Expression system: fixed eyes, swappable brow and mouth.** The eyeballs never
  move, the brow angle and mouth shape carry the emotion, so a face is a couple of
  swappable layers over constant eyes, cheap to drive from code. Because both mascots
  share the same eye geometry, Dimmie's brow/mouth vocabulary can be borrowed to build
  Tendie's set. **Borrow the rig, retune the emotion**: Dimmie's shapes are drawn for
  quiet menace, Tendie's must read golden-retriever (a furious Tendie is a big hurt
  tantrum, brows up and pleading, not cold). Still to be built for Tendie: the losing
  faces. Dimmie's six are done.
- **Expressions are dip-triggered, not a static standings readout.** At rest the
  mascot holds a baseline face. The moment a dip is committed, the face reacts to who
  is winning at that instant (smug if ahead, worried or scared if losing), so the war
  is *felt* on every dip rather than read off a passive mood indicator. Purely
  standings-driven in v1, no depth scaling (the depth idea is parked, see section 9).
- **"XLB" ids are left as-is.** The filename and internal group ids contain "XLB". We
  are not sanitising them: the art is already visibly a specific dumpling, a group id
  only visible in devtools is not the surface that matters, and sanitising would be
  wiped on every Illustrator re-export. Code references the real ids. The line we hold
  is the rendered, readable surface (title, meta, copy, share text).

### Milestone evolutions (the mascots slowly fall apart)

As point milestones stack up, the mascot permanently evolves for everyone, and the
direction is **escalating silly degradation**, not tidy accessory unlocks. The war
leaves marks: bruising, greasier hands, leaking soup, general dishevelment. Early on
the mascot is a pristine hero, deep into a hard-fought war it is a glorious wreck. The
damage is the story of the war.

- Built as **stacked damage/silly layers** over the base art, same principle as the
  swappable faces: cross a threshold, add a layer. Permanent and shared (global),
  which is what distinguishes it from the personal, momentary depth-swell.
- Keep it **cute-wrecked, not gross-wrecked.** Battle damage reads as a comedy trophy
  (dishevelled golden retriever, dignified dumpling losing its composure, monocle
  askew, still trying to look superior). Never genuinely ugly, or people stop wanting
  to look at their own side.
- Serves the return hook directly (people come back "to see what the mascots are doing
  to each other"). Pair with the handover's "next evolution at N (???)" teaser so the
  next indignity stays a surprise.
- Fork to settle: driven by a mascot's **own side's total** (a badge of the team's
  grind, current lean) or by combined war intensity. No reset (perpetual war), so
  degradation is permanent and ever-accumulating, which means the ladder needs a
  terminal "maximally wrecked" top rung it settles into rather than degrading forever.

### Typography

Three tiers, by role:

- **Bungee Shade** for the logo and major titles: a chunky drop-shadow display face,
  loud arcade-sign energy. Display only (heavy, all-caps), never at small sizes.
- **Space Mono** for numbers and short UI chrome (tallies, labels, buttons). The
  fixed-width look is a feature here, tabular numerals keep the counters from jittering
  as they tick. But it is wide, so it is wrong for long copy.
- **Plus Jakarta Sans** for readable prose: rules, descriptions, multi-line microcopy
  below the arena. Friendly geometric sans, a clean foil to the loud logo and the
  techy mono. (Work Sans is an acceptable, more neutral swap.)
- All **self-hosted** (woff2 in the repo) for the real build, not hotlinked from Google
  Fonts, for speed and to keep the page free of third-party requests. The demo uses the
  Google Fonts link for convenience.

## 7. Decisions locked

- Names: Tendie (left), Dimmie (right). Code spelling `tendie` / `dimmie`.
- Currencies: **good boy points** (Tendie), **respect points** (Dimmie). The voice
  split is register-based (western brainrot vs Aussie deadpan menace), never ethnic.
  Trash talk always points at the plate.
- Holder in frame for v1. Both mascots co-registered to the same position, so there is
  **one shared dip rig** (single off-frame arc pivot) and faction selection is a pure
  in-place art swap. Treason (switching sides) becomes a satisfying in-place morph.
- Face is **fixed eyes plus swappable brow/mouth**; expressions are **dip-triggered
  reactions to the current standings**, not a static readout, and purely
  standings-driven in v1 (no depth scaling).
- v1 core interaction is a **pure tap, one blop**, with basic escalating juice (pitch
  and splash creep up on a rally) as free polish. No depth mechanic and no scored
  combo multiplier in v1; both are parked (section 9).
- Milestone evolutions are **escalating silly degradation** (bruising, grease, leaking
  soup), built as stacked art layers, cute-wrecked not gross, permanent and shared.
- Type: **Bungee Shade** for logo and major titles, **Space Mono** for everything
  else, both self-hosted.
- Stack: Cloudflare Worker + Hono + single Durable Object + WebSocket fan-out, Vite,
  vanilla front end, npm, localStorage for per-player state.
- Broadcast is a throttled aggregate (target ~10 Hz), not one message per dip, so the
  DO survives the viral case. Counters stay exact; only the wire is throttled. Client
  increments its own dip optimistically and reconciles to server truth on each tick.
- **No hard reset: one perpetual war that runs forever**, totals just accumulate. How
  to keep a runaway-lead war feeling live is a known open question, deferred (see
  section 8).

## 8. Open questions

1. **Anti-bot posture for v1.** Every client can hit the dip endpoint, so the war is
   trivially botted. Decide how dips get gated (do nothing, per-connection rate limit
   in the DO, or Turnstile on bursts). Shapes the dip endpoint.
2. **Identity and persistence.** Confirm localStorage-only is acceptable for launch
   (cleared cache wipes streak and points, no cross-device), or bring the anonymous
   KV id in from the start.
3. **Keeping a forever war live (deferred).** No reset means a purely cumulative war
   goes stale once one side banks an uncatchable lead. Likely fix to look into later:
   keep lifetime totals forever (milestones, evolutions, all-time scoreboard) but drive
   the live "who's winning" (faces, trash talk, momentum) off a rolling recent window
   (e.g. last 24h), so the daily fight stays winnable without ever wiping anything.
4. **Broadcast tick rate.** Confirm ~10 Hz aggregate is the right feel versus
   something slower.

## 9. Parked / future ideas (icebox)

Deliberately not in v1, kept here so they are not lost.

- **Hidden dip depth.** The original "perfect dip depth" skill element. There is no
  good UX for *teaching* depth (hold, drag, flick and timing bars all tax the one-tap
  immediacy that makes the toy feel good), so it is not a surfaced mechanic. Park it
  as a *hidden, discoverable* layer instead: committing to a deeper dunk quietly gives
  a fatter blop and a bonus, never taught, never metered. No onboarding cost because
  it is undocumented, and it seeds folklore ("wait, you can dip deeper?"). Discovered
  depth, not taught depth. Hint at it, do not explain it: the hint and the reward are
  the same thing. A deeper dip that simply *sounds* juicier (subtle audio shift) is a
  breadcrumb the ear catches before the brain does, and a slow food-swell on repeated
  deep dips is a second, slower-burn tell. Keep that swell visually distinct from the
  global evolution language (mascot getting bigger/sillier for everyone): depth-swell
  is the player's own food, momentary and subtle; evolution is the mascot, permanent
  and shared.
- **Scored rhythm combo.** Rapid consecutive dips build a scored multiplier that
  decays if you stop, layered on top of the free audio-visual escalation. Frequency,
  not precision, so it keeps one-tap immediacy. Held back to keep v1 lean.
- **Red packet cosmetic.** Opt-in skin in the personal cosmetics shelf (not a
  currency), where a player choosing it is emergent flavour rather than assigned
  identity.
