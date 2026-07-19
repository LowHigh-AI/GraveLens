import type { GraveRecord } from "@/types";


// ── Rank ladder ───────────────────────────────────────────────────────────
// Themed as a "History Explorer" progression — from casual visitor to master.

export interface Rank {
  level: number;
  title: string;
  subtitle: string;
  minXP: number;
}

export const RANKS: Rank[] = [
  { level: 1,  title: "The Wanderer",       subtitle: "Your journey into history begins",           minXP: 0     },
  { level: 2,  title: "The Curious",         subtitle: "Questions stir among the stones",            minXP: 100   },
  { level: 3,  title: "The Seeker",          subtitle: "Following trails through the grass",         minXP: 300   },
  { level: 4,  title: "The Chronicler",      subtitle: "Names and dates fill your pages",            minXP: 600   },
  { level: 5,  title: "The Sleuth",          subtitle: "Every stone holds a secret",                 minXP: 1000  },
  { level: 6,  title: "The Historian",       subtitle: "Patterns emerge across the centuries",       minXP: 1500  },
  { level: 7,  title: "The Archivist",       subtitle: "Deep in the records, deep in the past",      minXP: 2200  },
  { level: 8,  title: "The Curator",         subtitle: "Preserving heritage for those who follow",   minXP: 3000  },
  { level: 9,  title: "The Scholar",         subtitle: "Your knowledge spans generations",           minXP: 4000  },
  { level: 10, title: "Master Historian",    subtitle: "Guardian of the forgotten and the found",    minXP: 5000  },
];

export function getRank(xp: number): Rank {
  return [...RANKS].reverse().find((r) => xp >= r.minXP) ?? RANKS[0];
}

export function getNextRank(xp: number): Rank | null {
  const current = getRank(xp);
  return RANKS.find((r) => r.level === current.level + 1) ?? null;
}

export function xpToNextRank(xp: number): { needed: number; progress: number } {
  const next = getNextRank(xp);
  if (!next) return { needed: 0, progress: 1 };
  const current = getRank(xp);
  const span = next.minXP - current.minXP;
  const earned = xp - current.minXP;
  return { needed: next.minXP - xp, progress: earned / span };
}

// ── Rank token rewards ─────────────────────────────────────────────────────
// Reaching a new Explorer rank grants a one-time LowHigh-token bonus, claimable
// on the Balance & Rewards page. Rank 1 is the starting rank (no bonus). These
// amounts are the canonical reference for the per-rank reward. Each level maps to
// a goal row `gravelens_rank_<level>` in the shared `goals` table whose
// token_amount MUST match the value here; the shared `claim_goal` RPC does the
// atomic, idempotent credit. Keep in sync with
// GraveLens/db/migrations/gravelens_rewards_goals.sql when tuning.
export const RANK_TOKEN_BONUS: Record<number, number> = {
  2: 5_000,
  3: 10_000,
  4: 15_000,
  5: 20_000,
  6: 30_000,
  7: 40_000,
  8: 50_000,
  9: 75_000,
  10: 100_000,
};

/** Token reward for reaching exactly this rank level (0 for rank 1 / unknown). */
export function rankBonus(level: number): number {
  return RANK_TOKEN_BONUS[level] ?? 0;
}

/** Cumulative token reward for every rank from 2 through `level` inclusive. */
export function rankBonusUpTo(level: number): number {
  let sum = 0;
  for (let l = 2; l <= level; l++) sum += rankBonus(l);
  return sum;
}

/** The slug of the hidden seed goal backing a given rank level's bonus. */
export function rankGoalSlug(level: number): string {
  return `gravelens_rank_${level}`;
}

// ── Achievement definitions ───────────────────────────────────────────────

export type AchievementCategory =
  | "First Steps"
  | "Collection"
  | "Exploration"
  | "Through the Ages"
  | "Military"
  | "Family"
  | "Research"
  | "Discovery";

export interface AchievementProgress {
  /** 0–1, where 1 = unlocked */
  ratio: number;
  /** Human label, e.g. "3 / 10" */
  label: string;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  flavour: string;  // thematic one-liner shown after unlock
  xp: number;
  category: AchievementCategory;
  icon: string;
  evaluate: (graves: GraveRecord[], stats: AppStats) => AchievementProgress;
}

// ── App stats tracked separately in localStorage ──────────────────────────
export interface AppStats {
  sharesCount: number;
  cemeteryNamesAdded: number;  // manually named cemeteries
  daysActive: string[];        // ISO date strings "YYYY-MM-DD"
}

const STATS_KEY = "gl_app_stats";

export function loadStats(): AppStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return { sharesCount: 0, cemeteryNamesAdded: 0, daysActive: [] };
    return { sharesCount: 0, cemeteryNamesAdded: 0, daysActive: [], ...JSON.parse(raw) };
  } catch {
    return { sharesCount: 0, cemeteryNamesAdded: 0, daysActive: [] };
  }
}

export function updateStats(patch: Partial<AppStats>): void {
  try {
    const current = loadStats();
    localStorage.setItem(STATS_KEY, JSON.stringify({ ...current, ...patch }));
  } catch { /* ignore */ }
}

export function recordActiveDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  const stats = loadStats();
  if (!stats.daysActive.includes(today)) {
    updateStats({ daysActive: [...stats.daysActive, today] });
  }
}

// ── Helpers used in evaluate functions ───────────────────────────────────

function longestStreak(days: string[]): number {
  if (days.length === 0) return 0;
  const sorted = Array.from(new Set(days))
    .map((d) => new Date(d + "T00:00:00Z").getTime())
    .sort((a, b) => a - b);
  let maxStreak = 1;
  let currentStreak = 1;
  const oneDay = 24 * 60 * 60 * 1000;
  for (let i = 1; i < sorted.length; i++) {
    const diff = sorted[i] - sorted[i - 1];
    if (diff === oneDay) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else if (diff > oneDay) {
      currentStreak = 1;
    }
  }
  return maxStreak;
}

function completedGoalsCount(graves: GraveRecord[]): number {
  try {
    const goalsRaw = localStorage.getItem("gl_cemetery_goals");
    if (!goalsRaw) return 0;
    const goals: Record<string, number> = JSON.parse(goalsRaw);
    if (Object.keys(goals).length === 0) return 0;

    const namesRaw = localStorage.getItem("gl_cemetery_id_names");
    const idToName: Record<string, string> = namesRaw ? JSON.parse(namesRaw) : {};

    const counts: Record<string, number> = {};
    for (const g of graves) {
      if (g.location?.cemetery) {
        const key = g.location.cemetery.toLowerCase().trim();
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }

    let completed = 0;
    for (const [cemId, target] of Object.entries(goals)) {
      let name = idToName[cemId];
      if (!name && cemId.startsWith("gl_derived_")) {
        name = cemId.substring("gl_derived_".length);
      }
      if (name) {
        const current = counts[name.toLowerCase().trim()] ?? 0;
        if (current >= target) completed++;
      }
    }
    return completed;
  } catch {
    return 0;
  }
}

function uniqueCemeteries(graves: GraveRecord[]) {
  return new Set(graves.map((g) => g.location?.cemetery).filter(Boolean));
}

function uniqueStates(graves: GraveRecord[]) {
  return new Set(graves.map((g) => g.location?.state).filter(Boolean));
}

const MILITARY_TERMS =
  /\b(war|veteran|vet\b|tank|infantry|cavalry|regiment|battalion|squadron|division|brigade|corps|platoon|army|navy|marine|air\s*force|pvt|sgt|cpl|cpt|maj|col|gen|lt\b|served|service|killed\s*in\s*action|k\.i\.a|medal|doughboy|soldier|sailor|airman|pilot|gunner|commander|sergeant|corporal|private|lieutenant|captain|major|colonel|admiral)\b/i;

function isMilitary(g: GraveRecord): boolean {
  if (g.research?.militaryContext) return true;
  if (g.tags?.includes("Veteran")) return true;
  const text = [g.extracted.inscription, ...(g.extracted.symbols ?? [])].join(" ");
  return MILITARY_TERMS.test(text);
}

function markerAgeYears(g: GraveRecord): number | null {
  const year = g.extracted.deathYear ?? g.extracted.birthYear;
  if (!year) return null;
  return new Date().getFullYear() - year;
}

function conflictFromGrave(g: GraveRecord): string | null {
  return g.research?.militaryContext?.likelyConflict ?? null;
}

function isFamily(g: GraveRecord): boolean {
  return Boolean(g.tags?.some((t) => ["Relative", "Ancestor"].includes(t)));
}

function count(n: number, target: number): AchievementProgress {
  return { ratio: Math.min(n / target, 1), label: `${n} / ${target}` };
}

function binary(met: boolean): AchievementProgress {
  return { ratio: met ? 1 : 0, label: met ? "Complete" : "Incomplete" };
}

// ── The full achievement list ─────────────────────────────────────────────

export const ACHIEVEMENTS: Achievement[] = [

  // ── FIRST STEPS ────────────────────────────────────────────────────────

  {
    id: "first_stone",
    title: "First Stone",
    description: "Save your first grave marker to the archive.",
    flavour: "Every great archive begins with a single stone.",
    xp: 10, category: "First Steps", icon: "🪦",
    evaluate: (g) => count(g.length, 1),
  },
  {
    id: "first_name",
    title: "A Name Remembered",
    description: "Save a marker with a full name extracted.",
    flavour: "To speak a name is to keep them alive.",
    xp: 6, category: "First Steps", icon: "✍️",
    evaluate: (g) => binary(g.some((r) => Boolean(r.extracted.name))),
  },
  {
    id: "first_gps",
    title: "Marked on the Map",
    description: "Save a GPS-tagged grave marker.",
    flavour: "Place them on the map of memory.",
    xp: 8, category: "First Steps", icon: "📍",
    evaluate: (g) => binary(g.some((r) => Boolean(r.location?.lat))),
  },
  {
    id: "first_inscription",
    title: "The Written Word",
    description: "Find a grave marker with an inscription.",
    flavour: "Stone outlasts paper. These words were meant to last.",
    xp: 6, category: "First Steps", icon: "📖",
    evaluate: (g) => binary(g.some((r) => r.extracted.inscription?.length > 10)),
  },
  {
    id: "first_symbol",
    title: "Symbol Seeker",
    description: "Find a grave marker bearing a symbol or emblem.",
    flavour: "Every symbol carries a century of meaning.",
    xp: 6, category: "First Steps", icon: "✦",
    evaluate: (g) => binary(g.some((r) => (r.extracted.symbols?.length ?? 0) > 0)),
  },
  {
    id: "first_epitaph",
    title: "Last Words",
    description: "Find a grave marker with an epitaph.",
    flavour: "The final message, chosen with great care.",
    xp: 8, category: "First Steps", icon: "📜",
    evaluate: (g) => binary(g.some((r) => r.extracted.epitaph?.length > 5)),
  },

  // ── COLLECTION ─────────────────────────────────────────────────────────

  {
    id: "col_5",
    title: "Stone Garden",
    description: "Save 5 grave markers.",
    flavour: "A small garden of names and dates.",
    xp: 25, category: "Collection", icon: "🌿",
    evaluate: (g) => count(g.length, 5),
  },
  {
    id: "col_10",
    title: "Cemetery Row",
    description: "Save 10 grave markers.",
    flavour: "A proper row of history taking shape.",
    xp: 50, category: "Collection", icon: "🏚️",
    evaluate: (g) => count(g.length, 10),
  },
  {
    id: "col_25",
    title: "Burial Ground",
    description: "Save 25 grave markers.",
    flavour: "Your archive grows into hallowed territory.",
    xp: 75, category: "Collection", icon: "⛪",
    evaluate: (g) => count(g.length, 25),
  },
  {
    id: "col_50",
    title: "The Necropolis",
    description: "Save 50 grave markers.",
    flavour: "A city of the departed, preserved in your care.",
    xp: 100, category: "Collection", icon: "🏛️",
    evaluate: (g) => count(g.length, 50),
  },
  {
    id: "col_100",
    title: "Eternal Archive",
    description: "Save 100 grave markers.",
    flavour: "One hundred stories saved from silence.",
    xp: 175, category: "Collection", icon: "📚",
    evaluate: (g) => count(g.length, 100),
  },
  {
    id: "col_250",
    title: "Keeper of the Departed",
    description: "Save 250 grave markers.",
    flavour: "You have become a guardian of the forgotten.",
    xp: 300, category: "Collection", icon: "🗝️",
    evaluate: (g) => count(g.length, 250),
  },

  // ── EXPLORATION ────────────────────────────────────────────────────────

  {
    id: "exp_cemetery_1",
    title: "Hallowed Ground",
    description: "Visit and document a named cemetery.",
    flavour: "The gate opens. The stones await.",
    xp: 20, category: "Exploration", icon: "🚪",
    evaluate: (g) => binary(uniqueCemeteries(g).size >= 1),
  },
  {
    id: "exp_cemetery_3",
    title: "Beyond the Gates",
    description: "Visit 3 different cemeteries.",
    flavour: "Each cemetery holds its own chapter of local history.",
    xp: 40, category: "Exploration", icon: "🗺️",
    evaluate: (g) => count(uniqueCemeteries(g).size, 3),
  },
  {
    id: "exp_cemetery_5",
    title: "Cemetery Hopper",
    description: "Visit 5 different cemeteries.",
    flavour: "The roots run deeper than any single yard.",
    xp: 75, category: "Exploration", icon: "🧭",
    evaluate: (g) => count(uniqueCemeteries(g).size, 5),
  },
  {
    id: "exp_cemetery_10",
    title: "The Circuit",
    description: "Visit 10 different cemeteries.",
    flavour: "You know the roads less travelled.",
    xp: 100, category: "Exploration", icon: "🛤️",
    evaluate: (g) => count(uniqueCemeteries(g).size, 10),
  },
  {
    id: "exp_cemetery_25",
    title: "Cemetery Connoisseur",
    description: "Visit 25 different cemeteries.",
    flavour: "Every plot has its own personality.",
    xp: 200, category: "Exploration", icon: "🏆",
    evaluate: (g) => count(uniqueCemeteries(g).size, 25),
  },
  {
    id: "exp_state_2",
    title: "Crossing State Lines",
    description: "Document graves in 2 different states.",
    flavour: "History doesn't respect borders.",
    xp: 50, category: "Exploration", icon: "🌎",
    evaluate: (g) => count(uniqueStates(g).size, 2),
  },
  {
    id: "exp_state_3",
    title: "The Grand Tour",
    description: "Document graves in 3 different states.",
    flavour: "A regional historian in the making.",
    xp: 100, category: "Exploration", icon: "🗾",
    evaluate: (g) => count(uniqueStates(g).size, 3),
  },
  {
    id: "exp_state_5",
    title: "Cross Country",
    description: "Document graves in 5 different states.",
    flavour: "America's stories are buried coast to coast.",
    xp: 200, category: "Exploration", icon: "🦅",
    evaluate: (g) => count(uniqueStates(g).size, 5),
  },
  {
    id: "exp_gps_10",
    title: "Map Maker",
    description: "Have 10 GPS-tagged markers on your map.",
    flavour: "The map of memory grows more complete.",
    xp: 40, category: "Exploration", icon: "🗺️",
    evaluate: (g) => count(g.filter((r) => r.location?.lat).length, 10),
  },
  {
    id: "exp_gps_25",
    title: "The Navigator",
    description: "Have 25 GPS-tagged markers on your map.",
    flavour: "Your map rivals any local historical society's.",
    xp: 75, category: "Exploration", icon: "⚓",
    evaluate: (g) => count(g.filter((r) => r.location?.lat).length, 25),
  },

  // ── THROUGH THE AGES ───────────────────────────────────────────────────

  {
    id: "age_75",
    title: "Touched by Time",
    description: "Find a grave marker from 75 or more years ago.",
    flavour: "These stones have weathered more than we know.",
    xp: 25, category: "Through the Ages", icon: "⏳",
    evaluate: (g) => binary(g.some((r) => (markerAgeYears(r) ?? 0) >= 75)),
  },
  {
    id: "age_100",
    title: "A Century Past",
    description: "Find a grave marker 100 or more years old.",
    flavour: "A century of silence, broken by your lens.",
    xp: 50, category: "Through the Ages", icon: "🕰️",
    evaluate: (g) => binary(g.some((r) => (markerAgeYears(r) ?? 0) >= 100)),
  },
  {
    id: "age_victorian",
    title: "Victorian Era",
    description: "Document a grave from before 1900.",
    flavour: "Gaslight and grave plots — another world entirely.",
    xp: 75, category: "Through the Ages", icon: "🎩",
    evaluate: (g) => binary(g.some((r) => (r.extracted.deathYear ?? 9999) < 1900)),
  },
  {
    id: "age_civil_war",
    title: "Civil War Era",
    description: "Find a grave from the Civil War years (1861–1865).",
    flavour: "Brother against brother. A nation's wound in stone.",
    xp: 100, category: "Through the Ages", icon: "⚔️",
    evaluate: (g) =>
      binary(
        g.some((r) => {
          const y = r.extracted.deathYear;
          return y !== null && y >= 1861 && y <= 1865;
        })
      ),
  },
  {
    id: "age_antebellum",
    title: "Antebellum",
    description: "Document a grave from before the Civil War (pre-1861).",
    flavour: "A world about to be shattered.",
    xp: 125, category: "Through the Ages", icon: "🕯️",
    evaluate: (g) => binary(g.some((r) => (r.extracted.deathYear ?? 9999) < 1861)),
  },
  {
    id: "age_republic",
    title: "The Early Republic",
    description: "Find a grave from before 1800.",
    flavour: "The ink on the Constitution was barely dry.",
    xp: 200, category: "Through the Ages", icon: "📜",
    evaluate: (g) => binary(g.some((r) => (r.extracted.deathYear ?? 9999) < 1800)),
  },
  {
    id: "age_colonial",
    title: "Colonial Roots",
    description: "Document a grave from the 1700s.",
    flavour: "They knew the colonies before they became a nation.",
    xp: 300, category: "Through the Ages", icon: "⚓",
    evaluate: (g) =>
      binary(
        g.some((r) => {
          const y = r.extracted.deathYear ?? r.extracted.birthYear;
          return y !== null && y >= 1700 && y < 1800;
        })
      ),
  },
  {
    id: "age_centenarian",
    title: "The Centenarian",
    description: "Find someone who lived to 100 years or older.",
    flavour: "A century of living — what stories they could tell.",
    xp: 50, category: "Through the Ages", icon: "🎂",
    evaluate: (g) => binary(g.some((r) => (r.extracted.ageAtDeath ?? 0) >= 100)),
  },
  {
    id: "age_long_life",
    title: "Long Life",
    description: "Find someone who lived to 90 years or older.",
    flavour: "They outlasted empires.",
    xp: 25, category: "Through the Ages", icon: "🌳",
    evaluate: (g) => binary(g.some((r) => (r.extracted.ageAtDeath ?? 0) >= 90)),
  },
  {
    id: "age_young",
    title: "Gone Too Soon",
    description: "Find a marker for someone who died before age 18.",
    flavour: "A life interrupted. Their name deserves to be remembered.",
    xp: 20, category: "Through the Ages", icon: "🕊️",
    evaluate: (g) =>
      binary(
        g.some((r) => {
          const a = r.extracted.ageAtDeath;
          return a !== null && a < 18 && a >= 0;
        })
      ),
  },

  // ── MILITARY ───────────────────────────────────────────────────────────

  {
    id: "mil_first",
    title: "Salute",
    description: "Document your first military grave marker.",
    flavour: "They answered the call. You answered theirs.",
    xp: 40, category: "Military", icon: "🎖️",
    evaluate: (g) => binary(g.some(isMilitary)),
  },
  {
    id: "mil_5",
    title: "The Honor Roll",
    description: "Document 5 military grave markers.",
    flavour: "Five names. Five lives of service.",
    xp: 75, category: "Military", icon: "🏅",
    evaluate: (g) => count(g.filter(isMilitary).length, 5),
  },
  {
    id: "mil_10",
    title: "In Memoriam",
    description: "Document 10 military grave markers.",
    flavour: "Ten stones. Ten futures interrupted.",
    xp: 100, category: "Military", icon: "🪖",
    evaluate: (g) => count(g.filter(isMilitary).length, 10),
  },
  {
    id: "mil_25",
    title: "Hall of Honor",
    description: "Document 25 military grave markers.",
    flavour: "You carry their memory forward.",
    xp: 200, category: "Military", icon: "🦸",
    evaluate: (g) => count(g.filter(isMilitary).length, 25),
  },
  {
    id: "mil_ww1",
    title: "The Doughboy",
    description: "Document a World War I veteran's marker.",
    flavour: "They crossed an ocean to defend an ideal.",
    xp: 75, category: "Military", icon: "⚔️",
    evaluate: (g) =>
      binary(g.some((r) => conflictFromGrave(r)?.toLowerCase().includes("world war i") ?? false)),
  },
  {
    id: "mil_ww2",
    title: "The Greatest Generation",
    description: "Document a World War II veteran's marker.",
    flavour: "They saved the world and came home to mow the lawn.",
    xp: 75, category: "Military", icon: "🌍",
    evaluate: (g) =>
      binary(g.some((r) => conflictFromGrave(r)?.toLowerCase().includes("world war ii") ?? false)),
  },
  {
    id: "mil_civil_war",
    title: "Blue or Grey",
    description: "Document a Civil War veteran's marker.",
    flavour: "A nation tore itself apart. They survived it.",
    xp: 100, category: "Military", icon: "🪖",
    evaluate: (g) =>
      binary(g.some((r) => conflictFromGrave(r)?.toLowerCase().includes("civil war") ?? false)),
  },
  {
    id: "mil_two_conflicts",
    title: "Brothers in Arms",
    description: "Document veterans from 2 different conflicts.",
    flavour: "War visits every generation.",
    xp: 100, category: "Military", icon: "✊",
    evaluate: (g) => {
      const conflicts = new Set(
        g.map(conflictFromGrave).filter((c): c is string => Boolean(c))
      );
      return count(conflicts.size, 2);
    },
  },
  {
    id: "mil_three_conflicts",
    title: "Theater of War",
    description: "Document veterans from 3 different conflicts.",
    flavour: "Three generations. Three calls to duty.",
    xp: 150, category: "Military", icon: "🎖️",
    evaluate: (g) => {
      const conflicts = new Set(
        g.map(conflictFromGrave).filter((c): c is string => Boolean(c))
      );
      return count(conflicts.size, 3);
    },
  },

  // ── FAMILY ─────────────────────────────────────────────────────────────

  {
    id: "fam_first_relative",
    title: "Family Roots",
    description: "Tag a grave marker as a Relative.",
    flavour: "Blood and stone. The oldest connection.",
    xp: 40, category: "Family", icon: "🌱",
    evaluate: (g) => binary(g.some((r) => r.tags?.includes("Relative") ?? false)),
  },
  {
    id: "fam_first_ancestor",
    title: "The Ancestor",
    description: "Tag a grave marker as an Ancestor.",
    flavour: "You stand here because they stood there.",
    xp: 40, category: "Family", icon: "🌳",
    evaluate: (g) => binary(g.some((r) => r.tags?.includes("Ancestor") ?? false)),
  },
  {
    id: "fam_3",
    title: "The Family Tree",
    description: "Tag 3 grave markers as Relative or Ancestor.",
    flavour: "Three branches of the same tree.",
    xp: 75, category: "Family", icon: "🌲",
    evaluate: (g) => count(g.filter(isFamily).length, 3),
  },
  {
    id: "fam_same_cemetery",
    title: "Family Plot",
    description: "Find 3 relatives buried in the same cemetery.",
    flavour: "They chose to rest together.",
    xp: 75, category: "Family", icon: "🏡",
    evaluate: (g) => {
      const familyByCemetery: Record<string, number> = {};
      for (const r of g) {
        if (isFamily(r) && r.location?.cemetery) {
          familyByCemetery[r.location.cemetery] =
            (familyByCemetery[r.location.cemetery] ?? 0) + 1;
        }
      }
      const max = Math.max(0, ...Object.values(familyByCemetery));
      return count(max, 3);
    },
  },
  {
    id: "fam_5",
    title: "Deep Roots",
    description: "Tag 5 family members in your archive.",
    flavour: "The deeper you dig, the richer the soil.",
    xp: 100, category: "Family", icon: "🪴",
    evaluate: (g) => count(g.filter(isFamily).length, 5),
  },
  {
    id: "fam_10",
    title: "Family Reunion",
    description: "Tag 10 family members in your archive.",
    flavour: "Generations gathered in one archive.",
    xp: 150, category: "Family", icon: "👨‍👩‍👧‍👦",
    evaluate: (g) => count(g.filter(isFamily).length, 10),
  },

  // ── RESEARCH ───────────────────────────────────────────────────────────

  {
    id: "res_newspaper",
    title: "Paper Trail",
    description: "Find a newspaper archive record for a documented person.",
    flavour: "They made the news. You found the clipping.",
    xp: 30, category: "Research", icon: "📰",
    evaluate: (g) =>
      binary(g.some((r) => (r.research?.newspapers?.length ?? 0) > 0)),
  },
  {
    id: "res_land",
    title: "Land Baron",
    description: "Find a land patent record.",
    flavour: "They staked a claim. You found the deed.",
    xp: 30, category: "Research", icon: "🌾",
    evaluate: (g) =>
      binary(g.some((r) => (r.research?.landRecords?.length ?? 0) > 0)),
  },
  {
    id: "res_nara",
    title: "Archive Diver",
    description: "Find a National Archives record.",
    flavour: "The government kept records. Now you have them.",
    xp: 30, category: "Research", icon: "🏛️",
    evaluate: (g) =>
      binary(g.some((r) => (r.research?.naraRecords?.length ?? 0) > 0)),
  },
  {
    id: "res_five_people",
    title: "The Researcher",
    description: "Find at least one external record on 5 different people.",
    flavour: "History rewards the persistent.",
    xp: 75, category: "Research", icon: "🔍",
    evaluate: (g) => {
      const n = g.filter(
        (r) =>
          (r.research?.newspapers?.length ?? 0) > 0 ||
          (r.research?.naraRecords?.length ?? 0) > 0 ||
          (r.research?.landRecords?.length ?? 0) > 0
      ).length;
      return count(n, 5);
    },
  },
  {
    id: "res_trifecta",
    title: "Primary Source",
    description: "Find newspaper, NARA, and land records all for one person.",
    flavour: "Three sources. One life, fully illuminated.",
    xp: 125, category: "Research", icon: "🔎",
    evaluate: (g) =>
      binary(
        g.some(
          (r) =>
            (r.research?.newspapers?.length ?? 0) > 0 &&
            (r.research?.naraRecords?.length ?? 0) > 0 &&
            (r.research?.landRecords?.length ?? 0) > 0
        )
      ),
  },
  {
    id: "res_military_context",
    title: "Boots on the Ground",
    description: "Discover military service context for a grave marker.",
    flavour: "The inscription told you rank. History tells you the rest.",
    xp: 50, category: "Research", icon: "🗃️",
    evaluate: (g) =>
      binary(g.some((r) => Boolean(r.research?.militaryContext?.roleDescription))),
  },

  // ── DISCOVERY ──────────────────────────────────────────────────────────

  {
    id: "dis_high_confidence",
    title: "Clearly Inscribed",
    description: "Record a high-confidence extraction from a grave marker.",
    flavour: "This stone was carved by a patient hand.",
    xp: 20, category: "Discovery", icon: "✅",
    evaluate: (g) =>
      binary(g.some((r) => r.extracted.confidence === "high")),
  },
  {
    id: "dis_epitaphs_5",
    title: "Epitaph Collector",
    description: "Collect 5 markers with epitaphs.",
    flavour: "Five final thoughts, preserved in stone.",
    xp: 50, category: "Discovery", icon: "💬",
    evaluate: (g) =>
      count(g.filter((r) => r.extracted.epitaph?.length > 5).length, 5),
  },
  {
    id: "dis_symbolist",
    title: "The Symbolist",
    description: "Find a marker bearing 3 or more distinct symbols.",
    flavour: "Every symbol was a deliberate choice.",
    xp: 35, category: "Discovery", icon: "🔱",
    evaluate: (g) =>
      binary(g.some((r) => (r.extracted.symbols?.length ?? 0) >= 3)),
  },
  {
    id: "dis_tagged_all",
    title: "The Cataloguer",
    description: "Apply tags to 10 grave markers.",
    flavour: "Named and categorised. The archivist's art.",
    xp: 50, category: "Discovery", icon: "🏷️",
    evaluate: (g) =>
      count(g.filter((r) => (r.tags?.length ?? 0) > 0).length, 10),
  },
  {
    id: "dis_cemetery_named",
    title: "Name the Ground",
    description: "Manually assign a cemetery name to a grave marker.",
    flavour: "The places between places deserve names too.",
    xp: 25, category: "Discovery", icon: "🪧",
    evaluate: (_g, stats) => binary(stats.cemeteryNamesAdded >= 1),
  },
  {
    id: "dis_share",
    title: "Pass It On",
    description: "Share a grave record with someone.",
    flavour: "History lives through conversation.",
    xp: 20, category: "Discovery", icon: "📤",
    evaluate: (_g, stats) => binary(stats.sharesCount >= 1),
  },
  {
    id: "dis_share_5",
    title: "Town Crier",
    description: "Share 5 grave records.",
    flavour: "You've become a local historian's newsletter.",
    xp: 50, category: "Discovery", icon: "📣",
    evaluate: (_g, stats) => count(stats.sharesCount, 5),
  },
  {
    id: "dis_days_3",
    title: "Weekend Explorer",
    description: "Use the app on 3 different days.",
    flavour: "History is a habit, not a moment.",
    xp: 30, category: "Discovery", icon: "📅",
    evaluate: (_g, stats) => count(stats.daysActive.length, 3),
  },
  {
    id: "dis_days_7",
    title: "Regular Visitor",
    description: "Use the app on 7 different days.",
    flavour: "The stones become familiar. The names, like old friends.",
    xp: 75, category: "Discovery", icon: "🗓️",
    evaluate: (_g, stats) => count(stats.daysActive.length, 7),
  },
  {
    id: "dis_streak_3",
    title: "Dedicated Archivist",
    description: "Use the app on 3 consecutive days.",
    flavour: "Consistency turns curiosity into chronicling.",
    xp: 30, category: "Discovery", icon: "🔥",
    evaluate: (_g, stats) => count(longestStreak(stats.daysActive), 3),
  },
  {
    id: "dis_streak_7",
    title: "Chronicle Keeper",
    description: "Use the app on 7 consecutive days.",
    flavour: "A week of memories preserved in stone.",
    xp: 100, category: "Discovery", icon: "👑",
    evaluate: (_g, stats) => count(longestStreak(stats.daysActive), 7),
  },
  {
    id: "goal_setter",
    title: "Goal Setter",
    description: "Set a cemetery documentation goal.",
    flavour: "A plan in place makes history manageable.",
    xp: 10, category: "Discovery", icon: "🎯",
    evaluate: () => {
      try {
        const goalsRaw = localStorage.getItem("gl_cemetery_goals");
        const countGoals = goalsRaw ? Object.keys(JSON.parse(goalsRaw)).length : 0;
        return binary(countGoals >= 1);
      } catch {
        return binary(false);
      }
    },
  },
  {
    id: "goal_met_1",
    title: "Cemetery Guardian",
    description: "Complete 1 cemetery documentation goal.",
    flavour: "You set a mark and met it. The ground is documented.",
    xp: 50, category: "Research", icon: "🏰",
    evaluate: (g) => count(completedGoalsCount(g), 1),
  },
  {
    id: "goal_met_3",
    title: "Master Chronicler",
    description: "Complete 3 cemetery documentation goals.",
    flavour: "Three entire yards preserved forever under your watch.",
    xp: 100, category: "Research", icon: "🏆",
    evaluate: (g) => count(completedGoalsCount(g), 3),
  },
  {
    id: "multi_spouse",
    title: "Shared Rest",
    description: "Document a marker commemorating 2 or more individuals.",
    flavour: "Together in life, together in history.",
    xp: 15, category: "Family", icon: "👩‍❤️‍👨",
    evaluate: (g) => binary(g.some((r) => (r.extracted.people?.length ?? 0) >= 2)),
  },
  {
    id: "multi_family",
    title: "Family Plot Stone",
    description: "Document a marker commemorating 4 or more individuals.",
    flavour: "A whole generation commemorated on a single face.",
    xp: 40, category: "Family", icon: "👪",
    evaluate: (g) => binary(g.some((r) => (r.extracted.people?.length ?? 0) >= 4)),
  },
  {
    id: "mat_bronze",
    title: "Bronze Age",
    description: "Document a marker made of Bronze.",
    flavour: "Metal that withstands the elements, keeping memory bright.",
    xp: 20, category: "Discovery", icon: "🛡️",
    evaluate: (g) => binary(g.some((r) => (r.extracted.material ?? "").toLowerCase().includes("bronze"))),
  },
  {
    id: "mat_slate",
    title: "Slate Scholar",
    description: "Document a marker made of Slate.",
    flavour: "Dark stone carved by early colonial hands.",
    xp: 25, category: "Discovery", icon: "🖤",
    evaluate: (g) => binary(g.some((r) => (r.extracted.material ?? "").toLowerCase().includes("slate"))),
  },
  {
    id: "cond_weathered",
    title: "Weathered Witness",
    description: "Document a grave marker in weathered or cracked condition.",
    flavour: "Fading letters salvaged just in time.",
    xp: 15, category: "Discovery", icon: "🌧️",
    evaluate: (g) =>
      binary(
        g.some((r) => {
          const cond = (r.extracted.condition ?? "").toLowerCase();
          return cond.includes("weathered") || cond.includes("cracked");
        })
      ),
  },
];

// ── Unlock state management ───────────────────────────────────────────────

const UNLOCKS_KEY = "gl_achievement_unlocks";

export interface UnlockRecord {
  id: string;
  unlockedAt: number;
  /**
   * Whether the user has viewed this unlock (i.e. opened the Explorer since it
   * unlocked). Drives the Explorer nav "unseen" badge. Records written before
   * this field existed have `seen` undefined and are treated as already seen —
   * they predate the badge, so surfacing them would be noise. Only `seen ===
   * false` counts as unseen.
   */
  seen?: boolean;
}

/** True unless the record is explicitly marked unseen (`seen === false`). */
export function isUnlockSeen(u: UnlockRecord): boolean {
  return u.seen !== false;
}

/** Newly-unlocked records the user hasn't viewed yet. */
export function unseenUnlocks(unlocks: UnlockRecord[]): UnlockRecord[] {
  return unlocks.filter((u) => u.seen === false);
}

/** Count of unlocks the user hasn't viewed yet (Explorer badge count). */
export function unseenCount(unlocks: UnlockRecord[] = loadUnlocks()): number {
  return unseenUnlocks(unlocks).length;
}

/**
 * Fired on `window` whenever the unseen-unlock set changes — a new unlock is
 * recorded, or the user views the Explorer and unseen items are cleared. The
 * nav badges listen for this to refresh without a reload.
 */
export const ACHIEVEMENT_UNSEEN_EVENT = "gl:achievement-unseen";

function notifyUnseenChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ACHIEVEMENT_UNSEEN_EVENT));
  }
}

/**
 * Mark every currently-unseen unlock as seen. Returns the ids that changed so
 * the caller can decide whether to push the new state to the cloud. Fires the
 * unseen-changed event when anything changed.
 */
export function markUnlocksSeen(): string[] {
  const unlocks = loadUnlocks();
  const changed: string[] = [];
  for (const u of unlocks) {
    if (u.seen === false) {
      u.seen = true;
      changed.push(u.id);
    }
  }
  if (changed.length > 0) {
    saveUnlocks(unlocks);
    notifyUnseenChanged();
  }
  return changed;
}

export function loadUnlocks(): UnlockRecord[] {
  try {
    return JSON.parse(localStorage.getItem(UNLOCKS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveUnlocks(unlocks: UnlockRecord[]): void {
  try {
    localStorage.setItem(UNLOCKS_KEY, JSON.stringify(unlocks));
  } catch { /* ignore */ }
}

export function isUnlocked(id: string, unlocks: UnlockRecord[]): boolean {
  return unlocks.some((u) => u.id === id);
}

/** Signals a rank increase caused by a save, for the celebratory hero toast. */
export interface RankUp {
  level: number;
  title: string;
  /** One-time claimable token bonus for reaching this rank (0 if none). */
  bonus: number;
}

export interface UnlockResult {
  /** Minor achievements newly unlocked in this call. */
  newUnlocks: Achievement[];
  /** Set when the new unlocks pushed the user across a rank threshold. */
  rankUp: RankUp | null;
}

/**
 * Evaluate all achievements against the current graves + stats. Records any
 * newly-unlocked achievements (as unseen), and reports whether the added XP
 * raised the user's rank so the caller can show the right notification.
 */
export function checkAndUnlock(
  graves: GraveRecord[],
  stats: AppStats
): UnlockResult {
  const existing = loadUnlocks();
  const alreadyUnlocked = new Set(existing.map((u) => u.id));
  const rankBefore = getRank(totalXP(existing)).level;
  const newUnlocks: Achievement[] = [];
  const now = Date.now();

  for (const a of ACHIEVEMENTS) {
    if (alreadyUnlocked.has(a.id)) continue;
    const { ratio } = a.evaluate(graves, stats);
    if (ratio >= 1) {
      existing.push({ id: a.id, unlockedAt: now, seen: false });
      newUnlocks.push(a);
    }
  }

  if (newUnlocks.length === 0) return { newUnlocks, rankUp: null };

  saveUnlocks(existing);
  notifyUnseenChanged();

  const rankAfter = getRank(totalXP(existing));
  const rankUp: RankUp | null =
    rankAfter.level > rankBefore
      ? {
          level: rankAfter.level,
          title: rankAfter.title,
          // Cumulative bonus for every rank crossed in this save (usually one).
          bonus: rankBonusUpTo(rankAfter.level) - rankBonusUpTo(rankBefore),
        }
      : null;

  return { newUnlocks, rankUp };
}

export function totalXP(unlocks: UnlockRecord[]): number {
  const unlockedIds = new Set(unlocks.map((u) => u.id));
  return ACHIEVEMENTS.filter((a) => unlockedIds.has(a.id)).reduce(
    (sum, a) => sum + a.xp,
    0
  );
}

export const ACHIEVEMENT_CATEGORIES: AchievementCategory[] = [
  "First Steps",
  "Collection",
  "Exploration",
  "Through the Ages",
  "Military",
  "Family",
  "Research",
  "Discovery",
];
