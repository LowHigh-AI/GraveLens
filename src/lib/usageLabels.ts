/**
 * App slug → display label / icon / noun maps, ported from LowHigh's
 * src/utils/usageLabels.ts. Used by the usage breakdown on /plan and /topup.
 * Token usage is shared across every LowHigh app, so all app slugs are kept.
 */

import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { Zap, PenTool, Mic, Share2, Mail, Scale, MessageSquareText, Newspaper, ScanLine } from "lucide-react";

export const APP_LABELS: Record<string, string> = {
  "ai-writing": "Writing",
  "ai-social": "Social",
  email: "Email",
  integrity: "Integrity",
  news: "News",
  prompts: "Prompts",
  tools: "Tools",
  "my-voice": "My Voice",
  gravelens: "GraveLens",
  generate: "Tools",
  "prompts-ai": "Prompts",
  "format-references": "Writing",
  "fix-link": "Writing",
  "suggest-tags": "Writing",
  "generate-citation": "Writing",
  "generate-user-trends": "Social",
  "news-summary": "News",
  "prompts-tags": "Prompts",
};

export const getAppLabel = (slug: string): string => APP_LABELS[slug] ?? slug;

export const APP_ICONS: Record<string, ComponentType<LucideProps>> = {
  Writing: PenTool,
  "My Voice": Mic,
  Social: Share2,
  Email: Mail,
  Integrity: Scale,
  Prompts: MessageSquareText,
  Tools: Zap,
  News: Newspaper,
  GraveLens: ScanLine,
};

export const APP_NOUN: Record<string, string> = {
  Writing: "generations",
  Social: "posts",
  Email: "emails",
  Integrity: "scans",
  News: "briefings",
  Prompts: "runs",
  Tools: "runs",
  "My Voice": "analyses",
  GraveLens: "scans",
};
