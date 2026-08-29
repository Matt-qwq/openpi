/**
 * plan_ready renders the recorded plan as Markdown.
 *
 * These tests pin two things: the renderer is wired at all (the regression
 * that motivated it was a missing `renderResult`, which silently fell back to
 * plain text), and a realistic plan survives rendering.
 *
 * Note on styling: `Markdown` colors itself from the global theme via
 * `getMarkdownTheme()`, not from the `theme` argument passed to `renderResult`.
 * That argument is only used for the fallback placeholder here. So rendered
 * output carries ANSI codes whenever the global theme is initialized, and
 * these assertions run against ANSI-stripped text.
 *
 * Assertions stay structural — heading markers consumed, content preserved,
 * nothing throws — rather than pinning pi-tui's exact visual treatment.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

initTheme("dark", false);

/** Matches the SGR sequences the Markdown component emits. */
const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  inverse: (text: string) => text,
};

interface RenderedComponent {
  render(width: number): string[];
}

interface PlanTool {
  name: string;
  renderResult?: (
    result: { details?: { plan?: string } | null },
    options: { expanded?: boolean },
    theme: unknown,
  ) => RenderedComponent;
}

/** Wide enough that line wrapping does not interfere with assertions. */
const WIDTH = 200;

async function loadPlanReady(): Promise<PlanTool> {
  const { default: planMode } = await import(
    "../../../extensions/plan-mode/index.ts"
  );
  const tools = new Map<string, PlanTool>();
  const pi = {
    on() {},
    registerTool(definition: PlanTool) {
      tools.set(definition.name, definition);
    },
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  planMode(pi);

  const tool = tools.get("plan_ready");
  assert.ok(tool, "plan_ready must be registered");
  assert.ok(tool.renderResult, "plan_ready must supply renderResult");
  return tool;
}

function renderPlan(
  tool: PlanTool,
  details: { plan?: string } | null | undefined,
  expanded = false,
): string {
  const component = tool.renderResult?.({ details }, { expanded }, THEME);
  assert.ok(component, "renderResult must return a component");
  return stripAnsi(component.render(WIDTH).join("\n"));
}

const RICH_PLAN = [
  "# Migration plan",
  "",
  "## Goal",
  "Move the queue off Redis.",
  "",
  "### Steps",
  "1. Snapshot the queue",
  "2. Drain consumers",
  "   - verify depth is zero",
  "   - stop the workers",
  "3. Cut over",
  "",
  "> Do not run steps 2 and 3 in the same window.",
  "",
  "| Phase | Owner |",
  "| --- | --- |",
  "| snapshot | platform |",
  "| cutover | platform |",
  "",
  "Use `queuectl drain` first, then **stop** the workers.",
  "",
  "See [the runbook](https://example.com/runbook) for detail.",
  "",
  "```bash",
  "queuectl drain --timeout 30s",
  "```",
  "",
  "```",
  "plain fence with no language",
  "```",
  "",
  "```python",
  "def check(depth):",
  "    return depth == 0",
  "```",
  "",
  "---",
  "",
  "Inline `code` and a trailing [link](https://example.com).",
].join("\n");

test("plan_ready is registered with a renderer", async () => {
  const tool = await loadPlanReady();
  assert.equal(tool.name, "plan_ready");
  assert.equal(typeof tool.renderResult, "function");
});

test("headings lose their markers and keep their text", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(tool, {
    plan: "# Migration plan\n\n## Goal\n\n### Steps\n",
  });

  assert.doesNotMatch(out, /^#\s/m, "no bare ATX heading markers");
  assert.match(out, /Migration plan/);
  assert.match(out, /Goal/);
  assert.match(out, /Steps/);
});

test("a rich plan renders without throwing and keeps its content", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(tool, { plan: RICH_PLAN });

  // Headings and body.
  assert.match(out, /Migration plan/);
  assert.match(out, /Move the queue off Redis\./);

  // Ordered list plus a nested unordered sub-list.
  assert.match(out, /1\. Snapshot the queue/);
  assert.match(out, /2\. Drain consumers/);
  assert.match(out, /- verify depth is zero/);

  // Block quote: rendered with a gutter, text preserved.
  assert.match(out, /Do not run steps 2 and 3 in the same window\./);

  // Table: drawn with box characters, not echoed as pipes.
  assert.match(out, /┌/, "table has a top border");
  assert.match(out, /Phase/);
  assert.match(out, /platform/);
  assert.doesNotMatch(out, /\|\s*---\s*\|/, "delimiter row is consumed");

  // Inline code and bold: markers consumed, text kept.
  assert.match(out, /Use queuectl drain first, then stop the workers\./);
  assert.doesNotMatch(out, /\*\*stop\*\*/, "bold markers are consumed");

  // Link: label kept, URL surfaced.
  assert.match(out, /the runbook/);
  assert.match(out, /https:\/\/example\.com\/runbook/);

  // All three fences, with and without a language.
  assert.match(out, /queuectl drain --timeout 30s/);
  assert.match(out, /plain fence with no language/);
  assert.match(out, /def check\(depth\):/);
  assert.match(out, /return depth == 0/);

  // Thematic break becomes a rule, not a literal ---.
  assert.match(out, /─{10,}/, "thematic break is drawn as a rule");

  assert.match(out, /Inline code and a trailing link/);
});

test("fenced code body is indented while the fence stays visible", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(tool, { plan: "```\nhello\n```\n" });

  // pi-tui colors the fence markers but does not draw a background block, so
  // the backticks remain; the body is what gets indented.
  assert.match(out, /```/);
  // Lines are padded to the render width, so allow trailing whitespace.
  assert.match(out, /^ {2}hello\s*$/m, "code body indented two spaces");
});

test("a missing or empty plan falls back to a placeholder", async () => {
  const tool = await loadPlanReady();

  assert.match(renderPlan(tool, undefined), /\(no plan content\)/);
  assert.match(renderPlan(tool, null), /\(no plan content\)/);
  assert.match(renderPlan(tool, { plan: "" }), /\(no plan content\)/);
});

test("plain prose with no markup renders as itself", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(tool, { plan: "Just a sentence.\nAnd another.\n" });

  assert.match(out, /Just a sentence\./);
  assert.match(out, /And another\./);
});

test("a plan near the documented size cap still renders", async () => {
  const tool = await loadPlanReady();
  // MAX_READY_PLAN_CHARS is 50_000; stay under it but well past one screen.
  const plan = `# Long\n\n${"- item line to pad the plan out\n".repeat(1500)}`;
  assert.ok(plan.length > 40_000, "fixture is meaningfully large");

  const out = renderPlan(tool, { plan });
  assert.match(out, /Long/);
  assert.match(out, /item line to pad the plan out/);
});

test("unusual characters do not break the renderer", async () => {
  const tool = await loadPlanReady();
  // execute() sanitizes before storing, so this is not a path the renderer
  // normally sees. It should degrade, not throw.
  const out = renderPlan(tool, {
    plan: "# Ünïcode ✓\n\n- 日本語のテキスト\n\n```\nemoji 🎉 here\n```\n",
  });

  assert.match(out, /Ünïcode/);
  assert.match(out, /日本語のテキスト/);
  assert.match(out, /emoji 🎉 here/);
});

test("expanded and collapsed both render the plan body", async () => {
  const tool = await loadPlanReady();
  const plan = "# Plan\n\n- one\n- two\n";
  const collapsed = renderPlan(tool, { plan }, false);
  const expanded = renderPlan(tool, { plan }, true);

  // The renderer is not expansion-gated: the plan is the whole point, and Pi
  // owns the collapse affordance.
  assert.match(collapsed, /one/);
  assert.match(expanded, /one/);
  assert.equal(collapsed, expanded, "expansion does not change the output");
});
