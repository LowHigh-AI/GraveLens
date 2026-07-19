/**
 * On-brand Lucide icons for the Explorer page.
 *
 * Supersedes the full-colour emoji that used to render for each achievement and
 * category — those clashed with GraveLens's understated stone/gold identity.
 * Keyed by achievement id (and category) so the pure `achievements.ts` data
 * module stays free of any client icon dependency (the rewards API imports the
 * rank logic from it server-side). Explicit named imports keep lucide-react
 * tree-shaken. Anything missing falls back to `FALLBACK_ICON`.
 */

import {
  Footprints,
  User,
  MapPin,
  ScrollText,
  Sparkles,
  Quote,
  Sprout,
  Rows3,
  LayoutGrid,
  Building2,
  Library,
  KeyRound,
  DoorOpen,
  Map as MapIcon,
  Compass,
  Route,
  Award,
  Globe,
  Plane,
  MapPinned,
  Anchor,
  Hourglass,
  Clock,
  Crown,
  Swords,
  Flame,
  Scroll,
  Cake,
  TreeDeciduous,
  TreePine,
  Bird,
  Medal,
  Shield,
  ShieldCheck,
  Flag,
  Users,
  UsersRound,
  Network,
  Home,
  Heart,
  Newspaper,
  Wheat,
  Landmark,
  Search,
  FileSearch,
  Trophy,
  CircleCheckBig,
  MessageSquareQuote,
  Tags,
  Signpost,
  Share2,
  Megaphone,
  Calendar,
  CalendarDays,
  Target,
  Layers,
  CloudRain,
  Star,
  type LucideIcon,
} from "lucide-react";
import type { AchievementCategory } from "@/lib/achievements";

export const FALLBACK_ICON: LucideIcon = Star;

export const ACHIEVEMENT_ICONS: Record<string, LucideIcon> = {
  // First Steps
  first_stone: Footprints,
  first_name: User,
  first_gps: MapPin,
  first_inscription: ScrollText,
  first_symbol: Sparkles,
  first_epitaph: Quote,

  // Collection
  col_5: Sprout,
  col_10: Rows3,
  col_25: LayoutGrid,
  col_50: Building2,
  col_100: Library,
  col_250: KeyRound,

  // Exploration
  exp_cemetery_1: DoorOpen,
  exp_cemetery_3: MapIcon,
  exp_cemetery_5: Compass,
  exp_cemetery_10: Route,
  exp_cemetery_25: Award,
  exp_state_2: Globe,
  exp_state_3: Globe,
  exp_state_5: Plane,
  exp_gps_10: MapPinned,
  exp_gps_25: Anchor,

  // Through the Ages
  age_75: Hourglass,
  age_100: Clock,
  age_victorian: Crown,
  age_civil_war: Swords,
  age_antebellum: Flame,
  age_republic: Scroll,
  age_colonial: Anchor,
  age_centenarian: Cake,
  age_long_life: TreeDeciduous,
  age_young: Bird,

  // Military
  mil_first: Medal,
  mil_5: Award,
  mil_10: Shield,
  mil_25: ShieldCheck,
  mil_ww1: Swords,
  mil_ww2: Globe,
  mil_civil_war: Flag,
  mil_two_conflicts: Users,
  mil_three_conflicts: Medal,

  // Family
  fam_first_relative: Sprout,
  fam_first_ancestor: TreeDeciduous,
  fam_3: Network,
  fam_same_cemetery: Home,
  fam_5: TreePine,
  fam_10: Users,
  multi_spouse: Heart,
  multi_family: UsersRound,

  // Research
  res_newspaper: Newspaper,
  res_land: Wheat,
  res_nara: Landmark,
  res_five_people: Search,
  res_trifecta: FileSearch,
  res_military_context: Footprints,
  goal_met_1: ShieldCheck,
  goal_met_3: Trophy,

  // Discovery
  dis_high_confidence: CircleCheckBig,
  dis_epitaphs_5: MessageSquareQuote,
  dis_symbolist: Sparkles,
  dis_tagged_all: Tags,
  dis_cemetery_named: Signpost,
  dis_share: Share2,
  dis_share_5: Megaphone,
  dis_days_3: Calendar,
  dis_days_7: CalendarDays,
  dis_streak_3: Flame,
  dis_streak_7: Crown,
  goal_setter: Target,
  mat_bronze: Shield,
  mat_slate: Layers,
  cond_weathered: CloudRain,
};

export const CATEGORY_ICONS: Record<AchievementCategory, LucideIcon> = {
  "First Steps": Footprints,
  "Collection": Library,
  "Exploration": Compass,
  "Through the Ages": Hourglass,
  "Military": Medal,
  "Family": TreeDeciduous,
  "Research": Search,
  "Discovery": Sparkles,
};

/** Resolve an achievement's icon component, falling back to a neutral glyph. */
export function achievementIcon(id: string): LucideIcon {
  return ACHIEVEMENT_ICONS[id] ?? FALLBACK_ICON;
}

/**
 * Render an achievement's icon. A stable component (declared once, here) so
 * call sites never create a component during render — keeps lint/react-compiler
 * happy and avoids remounting the glyph on every parent render.
 */
export function AchievementGlyph({
  id,
  size = 20,
  strokeWidth = 1.75,
  color,
}: {
  id: string;
  size?: number;
  strokeWidth?: number;
  color?: string;
}) {
  const Icon = ACHIEVEMENT_ICONS[id] ?? FALLBACK_ICON;
  return <Icon size={size} strokeWidth={strokeWidth} style={color ? { color } : undefined} />;
}
