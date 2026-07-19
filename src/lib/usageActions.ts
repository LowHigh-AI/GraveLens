/**
 * Frontend usage-tracking identities.
 *
 * One user action often fans out into several backend AI routes. Tagging every
 * call in that action with the SAME tool/component (plus one shared promptId per
 * action instance) lets the usage estimator sum them into a single line instead
 * of showing each backend step as its own row. The frontend owns this identity
 * because a route (e.g. /api/cultural) belongs to different actions depending on
 * where it was invoked. See feedback_tool_component_hierarchy.
 */

/** Scan a marker: /api/analyze + the auto-loaded /api/cultural summary. */
export const SCAN_USAGE = { tool: "Scan", component: "Scan a marker" } as const;

/** Hear their story: /api/cultural (summary) + /api/story + /api/tts. */
export const HEAR_STORY_USAGE = { tool: "Story", component: "Hear their story" } as const;
