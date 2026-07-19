# Reward Redemption Notification Dots — Design

**Date:** 2026-07-06
**App:** GraveLens
**Status:** Approved design, pending spec review

## Goal

When a user has a reward they can redeem, guide them to the redeem action with
subtle notification dots. The experience must feel **seamless**: the dot is
present the instant the app finishes loading, and it appears the instant a user
completes a requirement mid-session — without polling loops.

## Background (why this is the shape it is)

Two facts from the codebase drive the design:

1. **Rewards are reachable only through the account menu.** `/rewards` has no
   direct nav-bar or bottom-nav link. The single entry point is the
   `ProfileBadge` account menu's "Balance & Rewards" button
   (`src/components/auth/ProfileBadge.tsx`). So the badge is where an app-wide
   indicator belongs.

2. **Explorer rank is tracked client-side.** Achievements unlock into
   `localStorage` (`gl_achievement_unlocks`); the server only learns the user's
   rank when `pushExplorerPoints()` (`src/lib/cloudSync.ts`) syncs
   `explorer_xp` up to `gravelens_user_profiles`. The server computes
   rank-reward claimability from that column
   (`goalsServer.ts` → `loadContext()` → `isEligible()`), so the server's view
   is stale until a sync runs. "Seamless" is therefore **not** a polling
   problem — it is a matter of (a) refreshing at the exact moments state
   changes, (b) making sure the server has fresh rank data when we ask, and
   (c) optimistically reflecting locally-known rank the instant it changes.

There is already a proven precedent for a persistent dot on the badge: the
token-alert dot driven by `EcosystemProvider.tokenAlert.dotVisible`
(`src/components/ecosystem/EcosystemProvider.tsx`, rendered at
`ProfileBadge.tsx:139-155`). We reuse that pattern and styling.

## What "claimable" means

A reward is redeemable when its goal `status === "claimable"` and it is not a
referral goal. `fetchGraveLensGoals()` (`src/lib/goalsServer.ts`) already
computes this, and `/api/goals` returns `GraveLensGoal[]` where each goal
carries `status` and, for rank goals, `minRank`. The app-wide "any reward
claimable?" answer is: **at least one goal with `status === "claimable"` that is
not a referral.**

Claimable rank goals additionally depend on `minRank <= currentRank`, and the
current rank is knowable on the client instantly via
`getRank(totalXP(loadUnlocks())).level` (`src/lib/achievements.ts`).

## Architecture

### Source of truth: `EcosystemProvider`

`EcosystemProvider` already fetches billing on authenticated mount and exposes a
context to the whole app. We extend it to also own reward-claimability state,
so the dot is available anywhere (badge, menu) without per-page fetches.

New context surface:

```ts
interface ClaimableRewards {
  /** Server-confirmed claimable goals (excluding referrals). */
  count: number;
  /** True when the dot should show: server count > 0 OR optimistic local rank
   *  crosses an unclaimed rank goal's threshold. */
  dotVisible: boolean;
}
// added to EcosystemContextValue:
claimableRewards: ClaimableRewards;
```

New internal method:

```ts
/** Push local XP so the server sees current rank, then refetch claimable goals. */
refreshRewards(): Promise<void>;
```

`refreshRewards()`:
1. `await pushExplorerPoints(createClient(), user.id)` (best-effort; non-fatal on
   error — matches the existing pattern in `rewards/page.tsx`).
2. `fetch("/api/goals")`, keep the goal list (need `status` + `minRank`).
3. Store `count = goals.filter(g => g.status === "claimable" && !isReferral(g)).length`.
4. Store the set of **unclaimed rank goals** (`status !== "claimed"`, has
   `minRank`) so the optimistic layer can compare against local rank.

The existing `refresh()` (currently billing-only) is extended to also call the
claimable refetch, so every place that already refreshes billing
(the `/billing/confirmation` poll, the claim handler) also refreshes the dot.

### Optimistic-local rank layer

`dotVisible` is computed as:

```
serverClaimable = count > 0
optimisticRank  = any unclaimed rank goal with minRank <= localRankLevel
dotVisible      = serverClaimable || optimisticRank
```

`localRankLevel` is read from `localStorage` via
`getRank(totalXP(loadUnlocks())).level`. This lights the dot the instant a local
rank-up crosses an unclaimed threshold, with **no network round-trip**. The next
`refreshRewards()` reconciles: once the server confirms and the user claims, the
goal flips to `claimed`, drops out of the unclaimed-rank set, and the optimistic
condition goes false. (If the user already claimed a rank reward, that goal is
`claimed` and excluded from the unclaimed set, so no false positive.)

### The four refresh triggers

1. **On app load** — inside the existing authenticated-mount effect in
   `EcosystemProvider`, after `recordAppOpen()`, call `refreshRewards()`. The dot
   is correct and present as soon as the app finishes loading, including rank
   rewards earned while offline.

2. **The moment a rank is earned mid-session** — `checkAndUnlock()` has a single
   caller, `ResultPage.tsx:208` (scan result processing, the only in-session
   point new achievements unlock). When its returned `newUnlocks` is non-empty,
   fire a new lightweight window event `gl:explorer-progress` (modeled exactly on
   `ARCHIVE_SYNCED_EVENT` / `notifyArchiveSynced()` in `cloudSync.ts`).
   `EcosystemProvider` listens for it: it immediately recomputes the optimistic
   local rank (instant dot) and calls `refreshRewards()` to reconcile with the
   server.

3. **On subscription / top-up return** — `/billing/confirmation` already polls
   `eco.refresh()` after Stripe returns. Because `refresh()` now also refetches
   claimable goals, subscribe-tier rewards light the dot as the subscription
   activates. No new code on the confirmation page beyond what `refresh()` gives.

4. **Safety net: on tab focus** — a single `visibilitychange` listener in
   `EcosystemProvider` calls `refreshRewards()` when the document becomes visible
   again, throttled (ignore if the last refresh was < ~30s ago) to avoid churn.
   Catches anything not explicitly hooked, including changes made on another
   device/tab. Fires on focus only — no timer, no polling.

### UI: the dot trail

All three dots reuse the existing gold token-dot styling
(`var(--t-gold-500)`, `w-2.5 h-2.5 rounded-full ring-2 ring-stone-900`) so it is
understated and consistent (per GraveLens's anti-slop rule). No new colors, no
animation.

1. **ProfileBadge avatar dot** — a gold dot on the avatar when
   `claimableRewards.dotVisible`. Positioned **top-right** (`-top-0.5 -right-0.5`)
   so it coexists with the token-alert dot at bottom-right; the two are distinct
   concerns and may show together. The token dot stays `aria-hidden`; the rewards
   dot carries a visually-hidden label ("You have rewards to claim") for screen
   readers.

2. **"Balance & Rewards" menu item** — a small gold dot beside the `Gift`
   icon/label inside the account menu
   (`ProfileBadge.tsx:238-252`), shown on the same `dotVisible` condition. Pulls
   the eye to the right row once the menu is open.

3. **`/rewards` "Ready to Claim" section** — a subtle gold dot on the section
   header (`src/components/rewards/ReadyToClaim.tsx`) as the terminal marker,
   shown when that section has claimable goals. It is the visual "you are here"
   at the redeem spot.

### Auto-clear on claim

Dots are purely derived from claimable state — there is **no stored "seen"
flag**. When the user claims, `rewards/page.tsx` `handleClaim()` already calls
`eco?.refresh()` and `loadGoals()`; `refresh()` now recomputes
`claimableRewards`, so the whole trail clears the moment the last claimable
reward is redeemed.

## Files touched

- `src/components/ecosystem/EcosystemProvider.tsx` — add `claimableRewards`
  state + `refreshRewards()`; extend `refresh()`; add the `gl:explorer-progress`
  and `visibilitychange` listeners; call `refreshRewards()` on mount.
- `src/lib/cloudSync.ts` (or a small sibling in `achievements.ts`) — add
  `EXPLORER_PROGRESS_EVENT` + `notifyExplorerProgress()`, mirroring
  `ARCHIVE_SYNCED_EVENT` / `notifyArchiveSynced()`.
- `src/components/results/ResultPage.tsx` — after `checkAndUnlock()` returns new
  unlocks (line ~208), call `notifyExplorerProgress()`.
- `src/components/auth/ProfileBadge.tsx` — render the avatar dot and the menu-row
  dot from `eco.claimableRewards.dotVisible`.
- `src/components/rewards/ReadyToClaim.tsx` — render the section-header dot.

No server, migration, or `/api/goals` changes: the endpoint already returns
everything needed.

## Error handling

- Every network step in `refreshRewards()` is best-effort and non-fatal
  (`try/catch`, silent), matching existing patterns. On failure the previous
  `claimableRewards` state is retained (no flicker to zero).
- The optimistic-local layer never *hides* a server-confirmed dot; it can only
  *add* one, so a stale local read cannot suppress a real reward.
- All event listeners are registered/torn down in `useEffect` cleanups and guard
  `typeof window !== "undefined"` (SSR-safe, following the existing dot code).

## Testing

- **Load:** signed-in user with a claimable reward sees dots on the badge (and in
  the menu) on first paint after billing/goals resolve; no reward → no dot.
- **Rank-up mid-session:** processing a scan result that unlocks the achievement
  crossing a rank threshold lights the badge dot within a beat (optimistic
  immediate; server reconciles).
- **Subscribe:** returning from Stripe checkout to `/billing/confirmation` lights
  the dot for a subscribe-tier reward during the existing poll.
- **Claim clears:** claiming the last claimable reward removes all three dots
  without a reload.
- **Focus safety net:** backgrounding the tab, claiming on another device, then
  refocusing clears the dot.
- **Coexistence:** a low/out token alert dot and a rewards dot render together on
  the avatar without overlap.
- **A11y:** the rewards dot exposes a screen-reader label; the token dot remains
  `aria-hidden`.

## Out of scope

- No new rewards, goals, or eligibility rules.
- No changes to how XP/achievements are earned.
- No new nav-bar/bottom-nav rewards link (badge-menu remains the entry point).
- No numeric badge (count) — a single subtle dot, per the "subtle" requirement.
