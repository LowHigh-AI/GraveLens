/**
 * Usage aggregation helpers, ported from LowHigh's src/utils/usageGroups.ts.
 * Transforms the flat per-component averages from /api/billing/usage-stats into
 * an app → tool → component tree for the estimated-uses breakdown.
 */

import { getAppLabel } from "./usageLabels";

export interface UsageAverage {
  appSlug: string;
  tool: string | null;
  component: string;
  avgTokens: number;
  totalPrompts: number;
  estimatedTokensPerUse: number;
}

export interface ComponentRow {
  avgTokens: number;
  totalPrompts: number;
  estimatedTokensPerUse: number;
}

export type AppMap = Record<string, Record<string, Record<string, ComponentRow>>>;

export interface DisplayRow {
  key: string;
  appLabel: string;
  toolName: string;
  componentName: string;
  avgTokens: number;
  totalPrompts: number;
  estimatedTokensPerUse: number;
  showApp: boolean;
  showTool: boolean;
  lastInApp: boolean;
}

export const groupByApp = (averages: UsageAverage[]): AppMap => {
  const acc: AppMap = {};
  for (const row of averages) {
    const appLabel = getAppLabel(row.appSlug);
    const tool = row.tool ?? "General";
    const component = row.component ?? "Unknown";
    if (!acc[appLabel]) acc[appLabel] = {};
    if (!acc[appLabel][tool]) acc[appLabel][tool] = {};
    acc[appLabel][tool][component] = {
      avgTokens: row.avgTokens,
      totalPrompts: row.totalPrompts,
      estimatedTokensPerUse: row.estimatedTokensPerUse,
    };
  }
  return acc;
};

export const buildRows = (grouped: AppMap, appLabels: string[]): DisplayRow[] => {
  const rows: DisplayRow[] = [];
  for (const appLabel of appLabels) {
    const tools = grouped[appLabel];
    const toolNames = Object.keys(tools).sort();
    let appFirst = true;
    for (const toolName of toolNames) {
      const components = tools[toolName];
      const componentNames = Object.keys(components).sort();
      let toolFirst = true;
      for (const componentName of componentNames) {
        const c = components[componentName];
        rows.push({
          key: `${appLabel}-${toolName}-${componentName}`,
          appLabel,
          toolName,
          componentName,
          avgTokens: c.avgTokens,
          totalPrompts: c.totalPrompts,
          estimatedTokensPerUse: c.estimatedTokensPerUse,
          showApp: appFirst,
          showTool: toolFirst,
          lastInApp: false,
        });
        appFirst = false;
        toolFirst = false;
      }
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].appLabel === appLabel) {
        rows[i].lastInApp = true;
        break;
      }
    }
  }
  return rows;
};

export const fmtTokens = (n: number): string => n.toLocaleString();

export const fmtUses = (n: number): string =>
  n >= 10000 ? `${Math.round(n / 1000)}K` : n.toLocaleString(undefined, { maximumFractionDigits: 0 });
