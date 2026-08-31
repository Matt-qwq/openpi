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

/** Strip SGR escape sequences the Markdown component emits. */
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

/** Load plan-mode under a stub pi API and return the registered plan_ready tool. */
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

/** Render a plan through renderResult, ANSI-stripped, at the test width. */
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
  const out = renderPlan(
    tool,
    {
      plan: "# Migration plan\n\n## Goal\n\n### Steps\n",
    },
    true,
  );

  assert.doesNotMatch(out, /^#\s/m, "no bare ATX heading markers");
  assert.match(out, /Migration plan/);
  assert.match(out, /Goal/);
  assert.match(out, /Steps/);
});

test("a rich plan renders without throwing and keeps its content", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(tool, { plan: RICH_PLAN }, true);

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
  const out = renderPlan(tool, { plan: "```\nhello\n```\n" }, true);

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
  const out = renderPlan(
    tool,
    { plan: "Just a sentence.\nAnd another.\n" },
    true,
  );

  assert.match(out, /Just a sentence\./);
  assert.match(out, /And another\./);
});

test("a plan near the documented size cap still renders", async () => {
  const tool = await loadPlanReady();
  // MAX_READY_PLAN_CHARS is 50_000; stay under it but well past one screen.
  const plan = `# Long\n\n${"- item line to pad the plan out\n".repeat(1500)}`;
  assert.ok(plan.length > 40_000, "fixture is meaningfully large");

  const out = renderPlan(tool, { plan }, true);
  assert.match(out, /Long/);
  assert.match(out, /item line to pad the plan out/);
});

test("unusual characters do not break the renderer", async () => {
  const tool = await loadPlanReady();
  // execute() sanitizes before storing, so this is not a path the renderer
  // normally sees. It should degrade, not throw.
  const out = renderPlan(
    tool,
    {
      plan: "# Ünïcode ✓\n\n- 日本語のテキスト\n\n```\nemoji 🎉 here\n```\n",
    },
    true,
  );

  assert.match(out, /Ünïcode/);
  assert.match(out, /日本語のテキスト/);
  assert.match(out, /emoji 🎉 here/);
});

test("collapsed shows a bounded preview of a long plan", async () => {
  const tool = await loadPlanReady();
  const plan = `# Long\n\n${"- item line to pad the plan out\n".repeat(1500)}Final sentinel line`;
  const out = renderPlan(tool, { plan }, false);

  // Header line carries line count and expand hint.
  assert.match(out, /^Plan ready · \d+ lines · /);
  assert.match(out, /to expand/);
  // Preview exposes the first content lines ...
  assert.match(out, /Long/);
  assert.match(out, /item line to pad the plan out/);
  // ... the block is bounded: header + 10 preview rows + '... more' row.
  const rowCount = out.split("\n").length;
  assert.ok(rowCount <= 13, `bounded rows, got ${rowCount}`);
  // ... and content past the cap stays hidden.
  assert.doesNotMatch(out, /Final sentinel line/, "tail stays hidden");
});

test("collapsed short plan omits the expand hint", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(tool, { plan: "# Plan\n\n- one\n- two" }, false);

  // No hint and no 'more lines' when the preview already shows everything.
  assert.match(out, /^Plan ready · 4 lines/);
  assert.doesNotMatch(out, /to expand/);
  assert.doesNotMatch(out, /more lines/);
  assert.match(out, /- one/);
  assert.match(out, /- two/);
});

test("collapsed line-count boundaries at the preview cap", async () => {
  const tool = await loadPlanReady();
  // One line.
  const one = renderPlan(tool, { plan: "just a line" }, false);
  assert.match(one, /^Plan ready · 1 lines/);
  // Exactly at the cap: no hint, no 'more', all rows shown.
  const atCap = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const ten = renderPlan(tool, { plan: atCap }, false);
  assert.match(ten, /^Plan ready · 10 lines/);
  assert.doesNotMatch(ten, /to expand/);
  assert.doesNotMatch(ten, /more lines/);
  assert.match(ten, /line 10/);
  // One past the cap: hint and '... (N more lines)' appear; row 11 hidden.
  const pastCap = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const eleven = renderPlan(tool, { plan: pastCap }, false);
  assert.match(eleven, /^Plan ready · 11 lines · /);
  assert.match(eleven, /to expand/);
  assert.match(eleven, /\.\.\. \(1 more lines\)/);
  assert.match(eleven, /line 10/);
  assert.doesNotMatch(eleven, /line 11/);
});

test("collapsed counts a trailing newline", async () => {
  const tool = await loadPlanReady();
  // "a\n".split("\n") → ["a", ""] → the trailing empty element counts.
  const out = renderPlan(tool, { plan: "a\n" }, false);
  assert.match(out, /^Plan ready · 2 lines/);
});

test("collapsed preview wraps unbroken long lines at narrow width", async () => {
  const tool = await loadPlanReady();
  const plan = "short start\n" + "x".repeat(400) + "\nend line\n";
  const component = tool.renderResult?.(
    { details: { plan } },
    { expanded: false },
    THEME,
  );
  assert.ok(component, "renderResult must return a component");
  const lines = stripAnsi(component.render(40).join("\n")).split("\n");
  assert.ok(
    lines.every((line) => line.length <= 40),
    "no overflow beyond width",
  );
  assert.match(lines.join("\n"), /^Plan ready · 4 lines/);
});

test("rendering is stable across repeated calls", async () => {
  const tool = await loadPlanReady();
  const plan = "# Plan\n\n- one\n- two\n";
  assert.equal(
    renderPlan(tool, { plan }, false),
    renderPlan(tool, { plan }, false),
    "collapsed output is deterministic",
  );
  assert.equal(
    renderPlan(tool, { plan }, true),
    renderPlan(tool, { plan }, true),
    "expanded output is deterministic",
  );
});

test("expanded restores the full plan", async () => {
  const tool = await loadPlanReady();
  const plan = `# Long\n\n${"- item line to pad the plan out\n".repeat(1500)}Final sentinel line`;
  const out = renderPlan(tool, { plan }, true);

  assert.match(out, /Long/);
  assert.match(out, /item line to pad the plan out/);
  assert.match(out, /Final sentinel line/, "tail restorable when expanded");
  assert.doesNotMatch(
    out,
    /^Plan ready · /,
    "no collapsed summary when expanded",
  );
});
