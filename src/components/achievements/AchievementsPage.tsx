"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import PageShell from "@/components/layout/PageShell";
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_CATEGORIES,
  RANKS,
  getRank,
  getNextRank,
  xpToNextRank,
  totalXP,
  loadUnlocks,
  loadStats,
  isUnlocked,
  unseenUnlocks,
  markUnlocksSeen,
  type Achievement,
  type UnlockRecord,
  type AchievementCategory,
} from "@/lib/achievements";
import { pushExplorerPoints } from "@/lib/cloudSync";
import { getAllGraves } from "@/lib/storage";
import type { GraveRecord, UserProfile } from "@/types";
import { RankInsignia } from "@/components/ui/RankInsignia";
import { useAuth } from "@/lib/auth";
import { useEcosystem } from "@/components/ecosystem/EcosystemProvider";
import { createClient } from "@/lib/supabase/browser";
import { SHOW_COMMUNITY_FEATURES } from "@/lib/config";
import { AchievementGlyph } from "@/components/achievements/achievementIcons";
import { Users, Gift, X, Sparkles } from "lucide-react";
import { formatTokens } from "@/lib/lowhighClient";

function RankBadge({ level }: { level: number }) {
  const isMax = level === 10;
  return (
    <div
      className="relative flex flex-col items-center justify-center rounded-full border-2 w-28 h-28 shrink-0"
      style={{
        background: isMax
          ? "radial-gradient(circle at 40% 35%, var(--t-gold-200), var(--t-gold-500) 55%, var(--t-gold-600))"
          : "radial-gradient(circle at 40% 35%, var(--t-stone-700), var(--t-stone-800))",
        borderColor: isMax ? "var(--t-gold-200)" : "var(--t-gold-500)",
        boxShadow: isMax ? "0 0 20px rgba(201,168,76,0.45)" : "0 0 8px rgba(201,168,76,0.2)",
      }}
    >
      <RankInsignia level={level} size={88} />
    </div>
  );
}

function XPBar({ progress, label }: { progress: number; label: string }) {
  return (
    <div className="w-full">
      <div className="h-2 rounded-full bg-stone-700 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${Math.max(2, Math.min(100, progress * 100))}%`,
            background: "linear-gradient(90deg, var(--t-gold-600), var(--t-gold-500), var(--t-gold-200))",
          }}
        />
      </div>
      <p className="text-[0.8rem] text-stone-500 mt-1 text-right">{label}</p>
    </div>
  );
}

function AchievementCard({
  achievement,
  unlocked,
  progress,
  label,
  onClick,
}: {
  achievement: (typeof ACHIEVEMENTS)[number];
  unlocked: boolean;
  progress: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-xl p-4 flex gap-3 items-start transition-all active:scale-[0.98]"
      style={{
        background: unlocked
          ? "linear-gradient(135deg, var(--t-stone-800), var(--t-stone-900))"
          : "rgba(var(--glass-bg-rgb), 0.85)",
        border: unlocked
          ? "1px solid rgba(201,168,76,0.4)"
          : "1px solid var(--t-stone-700)",
        boxShadow: unlocked ? "0 0 12px rgba(201,168,76,0.12)" : "none",
      }}
    >
      {/* Icon */}
      <div
        className="w-10 h-10 flex items-center justify-center rounded-lg shrink-0"
        style={{
          background: unlocked
            ? "rgba(201,168,76,0.15)"
            : "rgba(255,255,255,0.04)",
        }}
      >
        <AchievementGlyph
          id={achievement.id}
          size={20}
          strokeWidth={1.75}
          color={unlocked ? "var(--t-gold-500)" : "#8a8580"}
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p
            className="text-sm font-semibold leading-tight"
            style={{ color: unlocked ? "var(--t-gold-200)" : "#a09890" }}
          >
            {achievement.title}
          </p>
          <span
            className="text-[0.75rem] font-bold shrink-0 px-1.5 py-0.5 rounded"
            style={{
              background: unlocked ? "rgba(201,168,76,0.2)" : "rgba(255,255,255,0.06)",
              color: unlocked ? "var(--t-gold-500)" : "var(--t-stone-400)",
            }}
          >
            +{achievement.xp} XP
          </span>
        </div>

        {unlocked ? (
          <p className="text-[0.8rem] text-stone-400 mt-0.5 leading-snug italic">
            &ldquo;{achievement.flavour}&rdquo;
          </p>
        ) : (
          <p className="text-[0.8rem] text-stone-500 mt-0.5 leading-snug">
            {achievement.description}
          </p>
        )}

        {/* Progress bar for in-progress achievements */}
        {!unlocked && progress > 0 && (
          <div className="mt-2">
            <div className="h-1 rounded-full bg-stone-700 overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, progress * 100)}%`,
                  background: "linear-gradient(90deg, #5a4010, var(--t-gold-500))",
                }}
              />
            </div>
            <p className="text-[0.75rem] text-stone-400 mt-0.5">{label}</p>
          </div>
        )}

        {/* Unlocked checkmark */}
        {unlocked && (
          <div className="flex items-center gap-1 mt-1.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="text-[0.75rem]" style={{ color: "var(--t-gold-500)" }}>Unlocked · tap for details</span>
          </div>
        )}
        {!unlocked && (
          <p className="text-[0.75rem] text-stone-400 mt-1.5">Tap to see how to earn this</p>
        )}
      </div>
    </button>
  );
}

// ── Achievement detail sheet ───────────────────────────────────────────────
function AchievementDetailSheet({
  achievement,
  unlocked,
  unlockedAt,
  progress,
  label,
  onClose,
}: {
  achievement: Achievement;
  unlocked: boolean;
  unlockedAt?: number;
  progress: number;
  label: string;
  onClose: () => void;
}) {
  // Portal to document.body so `fixed inset-0` is viewport-relative and immune to
  // the PageShell layout/stacking context — matching every other modal in the app.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  // Backdrop covers the whole viewport (incl. sidebar); the card centers within
  // the content column. lg:pl-60 = desktop sidebar (pl-56 / 224px) + the Explorer
  // main's px-4 (16px), so the card lines up with the centered content panel.
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 lg:pl-60" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70" />
      <div
        className="relative w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-3xl animate-in fade-in zoom-in-95 duration-200"
        style={{
          background: "linear-gradient(160deg, var(--t-stone-900), var(--t-stone-800))",
          border: "1px solid rgba(201,168,76,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 z-10 w-8 h-8 inline-flex items-center justify-center rounded-full text-stone-400 hover:text-stone-100 hover:bg-stone-800/60 transition-colors"
        >
          <X size={18} />
        </button>
        <div className="px-6 py-6">
          {/* Icon + category */}
          <div className="flex items-start justify-between mb-5 pr-9">
            <div
              className="w-16 h-16 flex items-center justify-center rounded-2xl"
              style={{
                background: unlocked
                  ? "rgba(201,168,76,0.18)"
                  : "rgba(255,255,255,0.05)",
              }}
            >
              <AchievementGlyph
                id={achievement.id}
                size={30}
                strokeWidth={1.5}
                color={unlocked ? "var(--t-gold-500)" : "#7a756f"}
              />
            </div>
            <div className="text-right">
              <span
                className="text-xs font-medium px-2 py-1 rounded-full"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  color: "var(--t-stone-500)",
                }}
              >
                {achievement.category}
              </span>
              <div className="mt-2">
                <span
                  className="text-sm font-bold px-2.5 py-1 rounded-lg"
                  style={{
                    background: unlocked ? "rgba(201,168,76,0.2)" : "rgba(255,255,255,0.06)",
                    color: unlocked ? "var(--t-gold-200)" : "#8a8580",
                  }}
                >
                  +{achievement.xp} XP
                </span>
              </div>
            </div>
          </div>

          {/* Title */}
          <h2
            className="font-serif text-2xl font-bold leading-tight mb-2"
            style={{ color: unlocked ? "var(--t-gold-500)" : "var(--t-stone-500)" }}
          >
            {achievement.title}
          </h2>

          {/* Unlock status */}
          {unlocked ? (
            <div className="flex items-center gap-2 mb-4">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center"
                style={{ background: "rgba(201,168,76,0.2)" }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--t-gold-500)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span className="text-sm font-medium" style={{ color: "var(--t-gold-500)" }}>
                Unlocked
                {unlockedAt && (
                  <span className="text-stone-500 font-normal ml-1">
                    · {new Date(unlockedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                )}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 mb-4">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center"
                style={{ background: "rgba(255,255,255,0.05)" }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#8a8580" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <span className="text-sm text-stone-500">Not yet unlocked</span>
            </div>
          )}

          {/* Divider */}
          <div className="h-px bg-stone-700/50 mb-4" />

          {/* How to earn */}
          <div className="mb-4">
            <p className="text-[0.75rem] uppercase tracking-widest text-stone-500 font-medium mb-1.5">
              How to earn
            </p>
            <p className="text-stone-300 text-sm leading-relaxed">
              {achievement.description}
            </p>
          </div>

          {/* Progress (if in progress) */}
          {!unlocked && progress > 0 && (
            <div className="mb-4">
              <p className="text-[0.75rem] uppercase tracking-widest text-stone-500 font-medium mb-2">
                Your progress
              </p>
              <div className="h-2 rounded-full bg-stone-700 overflow-hidden mb-1">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, progress * 100)}%`,
                    background: "linear-gradient(90deg, #5a4010, var(--t-gold-500))",
                  }}
                />
              </div>
              <p className="text-xs text-stone-500">{label}</p>
            </div>
          )}

          {/* Flavour quote (always show) */}
          <div
            className="rounded-xl px-4 py-3"
            style={{
              background: "rgba(255,255,255,0.03)",
              borderLeft: "2px solid rgba(201,168,76,0.3)",
            }}
          >
            <p className="text-stone-400 text-sm italic leading-relaxed">
              &ldquo;{achievement.flavour}&rdquo;
            </p>
          </div>

        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Friend profile card ────────────────────────────────────────────────────
function FriendCard({ profile }: { profile: UserProfile }) {
  const rank = getRank(profile.explorerXp);
  const displayName = profile.showUsername && profile.displayName
    ? profile.displayName
    : "Community Member";

  return (
    <div
      className="flex items-center gap-3 rounded-xl p-3"
      style={{
        background: "rgba(var(--glass-bg-rgb), 0.85)",
        border: "1px solid var(--t-stone-700)",
      }}
    >
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-lg font-bold font-serif"
        style={{ background: "rgba(201,168,76,0.12)", border: "1px solid rgba(201,168,76,0.25)", color: "var(--t-gold-500)" }}
      >
        {displayName.slice(0, 1).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-stone-200 text-sm font-semibold truncate">{displayName}</p>
        <p className="text-stone-500 text-[0.75rem] mt-0.5">{rank.title} · {profile.publicGraveCount} graves shared</p>
      </div>
      <RankInsignia level={rank.level} size={32} />
    </div>
  );
}

export default function AchievementsPage() {
  const { user, loading: authLoading } = useAuth();
  // Tri-state: only treat as signed out once auth has resolved, so we don't flash
  // the sign-in prompt at a user whose session is still loading.
  const signedOut = !authLoading && !user;
  const eco = useEcosystem();
  const [graves, setGraves] = useState<GraveRecord[]>([]);
  const [unlocks, setUnlocks] = useState<UnlockRecord[]>([]);
  const [justUnlocked, setJustUnlocked] = useState<Achievement[]>([]);
  const [needsSeenPush, setNeedsSeenPush] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<AchievementCategory | null>(null);
  // Claimable rank-reward tokens — derived from the shared goals in context (no
  // separate /api/goals fetch), drives the "claim" nudge.
  const rankClaimable = (eco?.goals ?? [])
    .filter((g) => g.slug.startsWith("gravelens_rank_") && g.status === "claimable")
    .reduce((acc, g) => acc + (Number(g.tokenReward) || 0), 0);

  // Determine initial category: first incomplete one, or First Steps if all done
  useEffect(() => {
    if (loaded && !selectedCategory) {
      const firstIncomplete = ACHIEVEMENT_CATEGORIES.find((cat) => {
        const items = ACHIEVEMENTS.filter((a) => a.category === cat);
        const unlockedCount = items.filter((a) => isUnlocked(a.id, unlocks)).length;
        return unlockedCount < items.length;
      });
      setSelectedCategory(firstIncomplete || "First Steps");
    }
  }, [loaded, unlocks, selectedCategory]);

  // Friends state
  const [friends, setFriends] = useState<UserProfile[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [friendSearch, setFriendSearch] = useState("");
  const [friendSearchResult, setFriendSearchResult] = useState<UserProfile[] | null | "notfound">(null);
  const [friendSearching, setFriendSearching] = useState(false);
  const [sendingRequest, setSendingRequest] = useState(false);

  useEffect(() => {
    getAllGraves()
      .then((g) => {
        setGraves(g);
        const u = loadUnlocks();
        // Snapshot what's unseen BEFORE clearing so we can pin a "Just unlocked"
        // section, then mark everything seen (clears the Explorer nav badge).
        const unseen = unseenUnlocks(u);
        if (unseen.length > 0) {
          const ids = new Set(unseen.map((r) => r.id));
          setJustUnlocked(ACHIEVEMENTS.filter((a) => ids.has(a.id)));
          markUnlocksSeen();
          setNeedsSeenPush(true); // persist the cleared state to the cloud
        }
        setUnlocks(u);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // Persist the "seen" clear to the cloud once auth resolves, so the badge stays
  // cleared on other devices too. Fire-and-forget; local is the source of truth.
  useEffect(() => {
    if (!user || !needsSeenPush) return;
    const supabase = createClient();
    pushExplorerPoints(supabase, user.id).catch(() => {});
    setNeedsSeenPush(false);
  }, [user, needsSeenPush]);

  // Keep the shared goals fresh when this page opens (the provider coalesces the
  // /api/goals call across consumers, so this doesn't add a round-trip).
  useEffect(() => {
    if (user) void eco?.refreshRewards?.();
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load confirmed friends
  useEffect(() => {
    if (!user) return;
    setFriendsLoading(true);
    const supabase = createClient();
    (async () => {
      try {
        const { data: relData } = await supabase
          .from("gravelens_user_relationships")
          .select("from_user_id, to_user_id")
          .eq("type", "friend")
          .or(`from_user_id.eq.${user.id},to_user_id.eq.${user.id}`);
        if (!relData?.length) return;
        const friendIds = relData.map((r: { from_user_id: string; to_user_id: string }) =>
          r.from_user_id === user.id ? r.to_user_id : r.from_user_id
        );
        const { data: profiles } = await supabase
          .from("gravelens_user_profiles")
          .select("user_id, display_name, show_username, explorer_xp, explorer_rank, public_scan_count")
          .in("user_id", friendIds);
        setFriends(
          (profiles ?? []).map((p: {
            user_id: string;
            display_name: string | null;
            show_username: boolean | null;
            explorer_xp: number | null;
            explorer_rank: number | null;
            public_scan_count: number | null;
          }) => ({
            userId: p.user_id,
            displayName: p.display_name ?? undefined,
            showUsername: p.show_username ?? true,
            shareAllByDefault: false,
            explorerXp: p.explorer_xp ?? 0,
            explorerRank: p.explorer_rank ?? 1,
            graveCount: 0,
            publicGraveCount: p.public_scan_count ?? 0,
            joinedAt: "",
          }))
        );
      } catch { /* non-fatal */ }
      finally { setFriendsLoading(false); }
    })();
  }, [user]);

  const handleSearchFriend = async () => {
    if (!friendSearch.trim()) return;
    setFriendSearching(true);
    setFriendSearchResult(null);
    try {
      const supabase = createClient();
      const query = friendSearch.trim().replace(/^@/, "");
      // Search by Display Name; only users who chose to show their name are
      // discoverable. Same-named people are disambiguated by rank + graves shared.
      const { data } = await supabase
        .from("gravelens_user_profiles")
        .select("user_id, display_name, show_username, explorer_xp, explorer_rank, public_scan_count")
        .eq("show_username", true)
        .ilike("display_name", `%${query}%`)
        .limit(10);
      type SearchRow = {
        user_id: string;
        display_name: string | null;
        show_username: boolean | null;
        explorer_xp: number | null;
        explorer_rank: number | null;
        public_scan_count: number | null;
      };
      const rows = ((data ?? []) as SearchRow[]).filter((d) => d.user_id !== user?.id);
      if (rows.length === 0) { setFriendSearchResult("notfound"); return; }
      setFriendSearchResult(
        rows.map((d) => ({
          userId: d.user_id,
          displayName: d.display_name ?? undefined,
          showUsername: d.show_username ?? true,
          shareAllByDefault: false,
          explorerXp: d.explorer_xp ?? 0,
          explorerRank: d.explorer_rank ?? 1,
          graveCount: 0,
          publicGraveCount: d.public_scan_count ?? 0,
          joinedAt: "",
        }))
      );
    } catch { setFriendSearchResult("notfound"); }
    finally { setFriendSearching(false); }
  };

  const handleSendRequest = async (toUserId: string) => {
    if (!user) return;
    setSendingRequest(true);
    try {
      const supabase = createClient();
      await supabase.from("gravelens_user_relationships").insert({
        from_user_id: user.id,
        to_user_id: toUserId,
        type: "friend_request",
      });
      setAddFriendOpen(false);
      setFriendSearch("");
      setFriendSearchResult(null);
    } catch { /* non-fatal */ }
    finally { setSendingRequest(false); }
  };

  const stats = loadStats();
  const xp = totalXP(unlocks);
  const rank = getRank(xp);
  const nextRank = getNextRank(xp);
  const { needed, progress } = xpToNextRank(xp);
  const unlockedCount = unlocks.length;
  const totalCount = ACHIEVEMENTS.length;

  return (
    <PageShell
      title="History Explorer"
      icon={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
          <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
          <path d="M4 22h16" />
          <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
          <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
          <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
        </svg>
      }
      backgroundClass="bg-transparent"
      // Full-width main = the whole area scrolls (even over the side gutters);
      // children are centered/capped via the direct-child utilities.
      customMainClasses="w-full px-4 pb-44 mt-5 scroll-container flex flex-col items-center"
      absoluteOverlays={
        selectedId && (() => {
          const achievement = ACHIEVEMENTS.find((a) => a.id === selectedId);
          if (!achievement) return null;
          const unlocked = isUnlocked(selectedId, unlocks);
          const unlockRecord = unlocks.find((u) => u.id === selectedId);
          const catStats = loaded ? stats : { sharesCount: 0, cemeteryNamesAdded: 0, daysActive: [] };
          const { ratio, label } = loaded ? achievement.evaluate(graves, catStats) : { ratio: 0, label: "" };
          return (
            <AchievementDetailSheet
              achievement={achievement}
              unlocked={unlocked}
              unlockedAt={unlockRecord?.unlockedAt}
              progress={ratio}
              label={label}
              onClose={() => setSelectedId(null)}
            />
          );
        })()
      }
    >
      <div className="w-full max-w-lg mx-auto rounded-3xl bg-stone-950/70 border border-white/5 p-3 sm:p-4 space-y-6">
        {/* Signed-out prompt — community/explorer features need a LowHigh login */}
        {signedOut && SHOW_COMMUNITY_FEATURES && (
          <Link
            href="/login?next=/explorer"
            // shrink-0: this is a direct child of PageShell's scrolling flex
            // column. Without it, flexbox compresses the fixed h-10 down to the
            // text's line height when the page overflows, making the button thin.
            className="flex shrink-0 items-center justify-center gap-2 w-full h-10 rounded-xl text-sm font-semibold transition-opacity hover:opacity-90"
            // Same two gold stops as the sidebar Sign In button, but a vertical
            // (180deg) gradient so it renders identically at any width. The
            // sidebar's 135deg spread washes out when stretched full-width
            // because the dark stop gets pushed into the bottom-right corner.
            style={{ background: "linear-gradient(180deg, #c9a84c 0%, #a07830 100%)", color: "#1a1917" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
              <polyline points="10 17 15 12 10 7"/>
              <line x1="15" y1="12" x2="3" y2="12"/>
            </svg>
            Sign In to Explore
          </Link>
        )}

        {/* Rank-reward nudge — only when there are unclaimed bonus tokens */}
        {rankClaimable > 0 && (
          <Link
            href="/rewards"
            className="flex shrink-0 items-center gap-3 w-full rounded-2xl px-4 py-3 transition-all active:scale-[0.98]"
            style={{ background: "linear-gradient(135deg, var(--t-gold-500), var(--t-gold-400))", color: "#1a1917" }}
          >
            <Gift size={20} strokeWidth={2.25} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold leading-tight">You&apos;ve earned a rank reward</p>
              <p className="text-xs opacity-80">Claim {formatTokens(rankClaimable)} bonus tokens</p>
            </div>
            <span className="text-xs font-bold underline underline-offset-2">Claim</span>
          </Link>
        )}

        {/* Rank card */}
        <div
          className="rounded-2xl p-5"
          style={{
            background: "linear-gradient(135deg, var(--t-stone-900), var(--t-stone-800))",
            border: "1px solid rgba(201,168,76,0.25)",
          }}
        >
          <div className="flex items-center gap-4">
            <RankBadge level={rank.level} />
            <div className="flex-1 min-w-0">
              <p className="text-[0.8rem] uppercase tracking-widest text-stone-500 font-medium">
                Current Rank
              </p>
              <h2
                className="font-serif text-xl font-bold mt-0.5 leading-tight"
                style={{ color: "var(--t-gold-200)" }}
              >
                {rank.title}
              </h2>
              <p className="text-xs text-stone-400 mt-0.5 italic">{rank.subtitle}</p>

              <div className="mt-3">
                {nextRank ? (
                  <>
                    <XPBar progress={progress} label={`${xp} XP · ${needed} to ${nextRank.title}`} />
                  </>
                ) : (
                  <p className="text-xs text-gold-500 font-semibold" style={{ color: "var(--t-gold-500)" }}>
                    Maximum rank achieved
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Rank ladder preview */}
          <div className="mt-4 flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {RANKS.map((r) => {
              const isCurrentRank = r.level === rank.level;
              const isPastRank = r.level < rank.level;
              return (
                <div
                  key={r.level}
                  className="flex flex-col items-center shrink-0"
                  title={r.title}
                >
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-[0.75rem] font-bold border"
                    style={{
                      background: isCurrentRank
                        ? "var(--t-gold-500)"
                        : isPastRank
                        ? "rgba(201,168,76,0.2)"
                        : "rgba(255,255,255,0.05)",
                      borderColor: isCurrentRank
                        ? "var(--t-gold-200)"
                        : isPastRank
                        ? "rgba(201,168,76,0.4)"
                        : "rgba(255,255,255,0.1)",
                      color: isCurrentRank ? "#1a1510" : isPastRank ? "var(--t-gold-500)" : "#8a8580",
                    }}
                  >
                    {r.level}
                  </div>
                  {isCurrentRank && (
                    <div
                      className="w-1 h-1 rounded-full mt-0.5"
                      style={{ background: "var(--t-gold-500)" }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Stats row */}
        {loaded && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Unlocked", value: `${unlockedCount}/${totalCount}` },
              { label: "Total XP", value: xp.toLocaleString() },
              { label: "Markers", value: graves.length.toString() },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-xl p-3 text-center"
                style={{
                  background: "rgba(var(--glass-bg-rgb), 0.85)",
                  border: "1px solid var(--t-stone-700)",
                }}
              >
                <p className="text-lg font-bold font-serif" style={{ color: "var(--t-gold-500)" }}>
                  {s.value}
                </p>
                <p className="text-[0.75rem] uppercase tracking-wide text-stone-500 mt-0.5">
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Friends section — only shown when signed in and enabled */}
        {user && SHOW_COMMUNITY_FEATURES && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Users size={18} strokeWidth={1.75} style={{ color: "var(--t-gold-500)" }} />
              <h3 className="font-serif text-base font-semibold text-stone-200">Explorer Friends</h3>
              <button
                onClick={() => { setAddFriendOpen((o) => !o); setFriendSearch(""); setFriendSearchResult(null); }}
                className="ml-auto flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all active:scale-95"
                style={{ background: "rgba(201,168,76,0.12)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.25)" }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add
              </button>
            </div>

            {addFriendOpen && (
              <div
                className="rounded-2xl p-4 mb-3 flex flex-col gap-3"
                style={{ background: "rgba(var(--glass-bg-rgb), 0.85)", border: "1px solid var(--t-stone-700)" }}
              >
                <p className="text-stone-400 text-xs">Search by name</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={friendSearch}
                    onChange={(e) => setFriendSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearchFriend()}
                    placeholder="Explorer's name…"
                    className="flex-1 bg-stone-800 text-stone-200 text-base rounded-lg px-3 py-2 border border-stone-700 focus:outline-none focus:border-stone-500 placeholder:text-stone-400"
                  />
                  <button
                    onClick={handleSearchFriend}
                    disabled={friendSearching}
                    className="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all active:scale-95 disabled:opacity-50"
                    style={{ background: "rgba(201,168,76,0.15)", color: "var(--t-gold-500)", border: "1px solid rgba(201,168,76,0.3)" }}
                  >
                    {friendSearching ? "…" : "Search"}
                  </button>
                </div>

                {friendSearchResult === "notfound" && (
                  <p className="text-stone-500 text-xs">No explorer found with that name. They may keep their name private.</p>
                )}
                {Array.isArray(friendSearchResult) && (
                  <div className="flex flex-col gap-2">
                    {friendSearchResult.length > 1 && (
                      <p className="text-stone-500 text-[0.7rem]">Multiple matches — check the rank to pick the right explorer.</p>
                    )}
                    {friendSearchResult.map((r) => {
                      const rRank = getRank(r.explorerXp);
                      return (
                        <div key={r.userId} className="flex items-center gap-3 rounded-xl p-3" style={{ background: "rgba(var(--glass-bg-rgb), 0.85)", border: "1px solid var(--t-stone-700)" }}>
                          <RankInsignia level={rRank.level} size={28} />
                          <div className="flex-1 min-w-0">
                            <p className="text-stone-200 text-sm font-semibold truncate">{r.displayName || "Community Member"}</p>
                            <p className="text-stone-500 text-[0.75rem]">{rRank.title} · {r.publicGraveCount} graves shared</p>
                          </div>
                          <button
                            onClick={() => handleSendRequest(r.userId)}
                            disabled={sendingRequest}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 disabled:opacity-50"
                            style={{ background: "var(--t-gold-500)", color: "#1a1510" }}
                          >
                            {sendingRequest ? "…" : "Send Request"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {friendsLoading ? (
              <div className="flex items-center justify-center py-6">
                <div className="w-5 h-5 border-2 border-stone-600 border-t-stone-400 rounded-full animate-spin" />
              </div>
            ) : friends.length === 0 ? (
              <p className="text-stone-400 text-sm text-center py-4 italic">
                No friends yet — search above to connect with other explorers.
              </p>
            ) : (
              <div className="space-y-2">
                {friends.map((f) => <FriendCard key={f.userId} profile={f} />)}
              </div>
            )}
          </section>
        )}

        {/* Just unlocked — the achievements the user hasn't viewed yet, pinned
            above the grid. Populated from the unseen set captured on load. */}
        {justUnlocked.length > 0 && (
          <section className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles size={18} strokeWidth={1.75} style={{ color: "var(--t-gold-500)" }} />
              <h3 className="font-serif text-base font-semibold text-stone-200">
                Just unlocked
              </h3>
              <span className="text-xs text-stone-500">{justUnlocked.length} new</span>
            </div>
            <div className="space-y-3">
              {justUnlocked.map((achievement) => (
                <AchievementCard
                  key={achievement.id}
                  achievement={achievement}
                  unlocked
                  progress={1}
                  label=""
                  onClick={() => setSelectedId(achievement.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Achievement Selector */}
        <div className="w-full space-y-4">
          <div className="relative">
            <select
              value={selectedCategory || "First Steps"}
              onChange={(e) => setSelectedCategory(e.target.value as AchievementCategory)}
              className="w-full appearance-none bg-stone-900/80 border border-stone-800 text-stone-200 text-sm font-semibold rounded-2xl px-5 py-4 focus:outline-none focus:border-stone-600 active:scale-[0.98] transition-all"
              style={{
                background: "linear-gradient(135deg, var(--t-stone-900), var(--t-stone-800))",
                boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
              }}
            >
              {ACHIEVEMENT_CATEGORIES.map((category) => {
                const items = ACHIEVEMENTS.filter((a) => a.category === category);
                const catUnlocked = items.filter((a) => isUnlocked(a.id, unlocks)).length;
                const isComplete = catUnlocked === items.length;
                return (
                  <option key={category} value={category} className="bg-stone-900 py-2">
                    {category} {isComplete ? "✓" : `(${catUnlocked}/${items.length})`}
                  </option>
                );
              })}
            </select>
            {/* Custom dropdown arrow */}
            <div className="absolute right-5 top-1/2 -translate-y-1/2 pointer-events-none">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a8580" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>

          {/* Achievement list for selected category */}
          {selectedCategory && (
            <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
              {ACHIEVEMENTS.filter((a) => a.category === selectedCategory).map((achievement) => {
                const unlocked = isUnlocked(achievement.id, unlocks);
                const catStats = loaded ? stats : { sharesCount: 0, cemeteryNamesAdded: 0, daysActive: [] };
                const { ratio, label } = loaded
                  ? achievement.evaluate(graves, catStats)
                  : { ratio: 0, label: "" };
                return (
                  <AchievementCard
                    key={achievement.id}
                    achievement={achievement}
                    unlocked={unlocked}
                    progress={ratio}
                    label={label}
                    onClick={() => setSelectedId(achievement.id)}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Bottom CTA into Balance & Rewards (ranks → token bonuses).
            Matches the page's sign-in button: same gold gradient, h-10, rounded-xl. */}
        <Link
          href="/rewards"
          className="flex shrink-0 items-center justify-center gap-2 w-full h-10 rounded-xl text-sm font-semibold transition-opacity hover:opacity-90"
          style={{ background: "linear-gradient(180deg, #c9a84c 0%, #a07830 100%)", color: "#1a1917" }}
        >
          <Gift size={16} strokeWidth={2} /> View Balance &amp; Rewards
        </Link>
      </div>
    </PageShell>
  );
}
