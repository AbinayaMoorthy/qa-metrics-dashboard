#!/usr/bin/env node
/**
 * flatten-metrics.js
 *
 * Converts raw Playwright and Newman JSON run files into flat CSVs for Power BI.
 *
 *   node flatten-metrics.js <runs-folder> <output-folder>
 *
 * Expects files named:
 *   playwright-<runId>.json
 *   newman-<runId>.json
 *
 * Emits:
 *   ui_tests.csv        one row per test result per run
 *   api_requests.csv    one row per request per run
 *   api_assertions.csv  one row per assertion per run
 *   runs.csv            one row per run (suite-level summary)
 */

const fs = require('fs');
const path = require('path');

const inDir = process.argv[2] || 'metrics/raw';
const outDir = process.argv[3] || 'metrics/csv';

if (!fs.existsSync(inDir)) {
  console.error(`Input folder not found: ${inDir}`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

// ── CSV helpers ──────────────────────────────────────────────────────────────
const esc = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, cols) =>
  [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';

// runId is whatever follows the first dash, e.g. playwright-2026-08-16T10-00-00.json
const runIdFrom = (file) => path.basename(file).replace(/\.json$/i, '').replace(/^[a-z]+-/i, '');

// Turn "2026-08-16T18-37-54" into "2026-08-16 18:37:54" so Power BI reads it
// as a datetime without any manual transformation.
const runIdToTimestamp = (runId) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(runId);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : '';
};

const registerRun = (runId) => {
  if (!dimRuns.has(runId)) {
    dimRuns.set(runId, { run_id: runId, run_started: runIdToTimestamp(runId), run_seq: 0 });
  }
};

const uiTests = [];
const dimRuns = new Map();   // unique run_id -> { run_id, run_started, run_seq }
const apiRequests = [];
const apiAssertions = [];
const runs = [];

// ── Playwright ───────────────────────────────────────────────────────────────
// The JSON reporter nests suites arbitrarily deep, so walk recursively and keep
// the top-level suite title as the module name.
function walkSuites(suite, runId, moduleName) {
  const mod = moduleName || suite.file || suite.title || 'unknown';

  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const results = test.results || [];
      results.forEach((res, idx) => {
        uiTests.push({
          run_id: runId,
          module: path.basename(mod),
          suite: suite.title || '',
          test_name: spec.title || '',
          project: test.projectName || '',
          status: res.status || '',
          duration_ms: res.duration ?? '',
          retry: res.retry ?? idx,
          is_retry: (res.retry ?? idx) > 0 ? 1 : 0,
          // final verdict for the spec after retries — lets you separate
          // "failed outright" from "passed on retry", i.e. flaky
          spec_ok: spec.ok ? 1 : 0,
        });
      });
    }
  }

  for (const child of suite.suites || []) {
    walkSuites(child, runId, mod);
  }
}

function parsePlaywright(file) {
  const runId = runIdFrom(file);
  registerRun(runId);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = uiTests.length;

  for (const suite of data.suites || []) walkSuites(suite, runId, null);

  const s = data.stats || {};
  runs.push({
    run_id: runId,
    suite_type: 'UI (Playwright)',
    started_at: s.startTime || '',
    duration_ms: s.duration ?? '',
    passed: s.expected ?? '',
    failed: s.unexpected ?? '',
    flaky: s.flaky ?? '',
    skipped: s.skipped ?? '',
    total_items: uiTests.length - before,
  });
}

// ── Newman ───────────────────────────────────────────────────────────────────
function parseNewman(file) {
  const runId = runIdFrom(file);
  registerRun(runId);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = data.run || {};

  for (const ex of run.executions || []) {
    const url = ex.request?.url || {};
    const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
    const p = Array.isArray(url.path) ? '/' + url.path.join('/') : url.path || '';

    apiRequests.push({
      run_id: runId,
      request_name: ex.item?.name || '',
      method: ex.request?.method || '',
      endpoint: p,
      host,
      status_code: ex.response?.code ?? '',
      response_time_ms: ex.response?.responseTime ?? '',
      response_size_bytes: ex.response?.responseSize ?? '',
      // an execution with no response usually means a transport-level failure
      completed: ex.response ? 1 : 0,
    });

    for (const a of ex.assertions || []) {
      apiAssertions.push({
        run_id: runId,
        request_name: ex.item?.name || '',
        assertion: a.assertion || '',
        passed: a.error ? 0 : 1,
        error_message: a.error?.message || '',
      });
    }
  }

  const st = run.stats || {};
  const t = run.timings || {};
  runs.push({
    run_id: runId,
    suite_type: 'API (Newman)',
    started_at: t.started ? new Date(t.started).toISOString() : '',
    duration_ms: t.started && t.completed ? t.completed - t.started : '',
    passed: (st.assertions?.total ?? 0) - (st.assertions?.failed ?? 0),
    failed: st.assertions?.failed ?? '',
    flaky: '',
    skipped: st.assertions?.pending ?? '',
    total_items: st.requests?.total ?? '',
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
const files = fs.readdirSync(inDir).filter((f) => f.toLowerCase().endsWith('.json'));
let pw = 0, nm = 0, skipped = 0;

for (const f of files) {
  const full = path.join(inDir, f);
  try {
    if (/^playwright/i.test(f)) { parsePlaywright(full); pw++; }
    else if (/^newman/i.test(f)) { parseNewman(full); nm++; }
    else { skipped++; }
  } catch (err) {
    console.error(`  ! skipped ${f}: ${err.message}`);
    skipped++;
  }
}

// dim_runs is the dimension table every fact table joins to. It must have one
// row per run_id — runs.csv has two (UI and API), so it cannot serve this role.
const dimRunRows = [...dimRuns.values()].sort((a, b) =>
  a.run_started < b.run_started ? -1 : a.run_started > b.run_started ? 1 : 0);
dimRunRows.forEach((r, i) => { r.run_seq = i + 1; });

fs.writeFileSync(path.join(outDir, 'dim_runs.csv'), toCsv(dimRunRows,
  ['run_id','run_started','run_seq']));

fs.writeFileSync(path.join(outDir, 'ui_tests.csv'), toCsv(uiTests,
  ['run_id','module','suite','test_name','project','status','duration_ms','retry','is_retry','spec_ok']));

fs.writeFileSync(path.join(outDir, 'api_requests.csv'), toCsv(apiRequests,
  ['run_id','request_name','method','endpoint','host','status_code','response_time_ms','response_size_bytes','completed']));

fs.writeFileSync(path.join(outDir, 'api_assertions.csv'), toCsv(apiAssertions,
  ['run_id','request_name','assertion','passed','error_message']));

fs.writeFileSync(path.join(outDir, 'runs.csv'), toCsv(runs,
  ['run_id','suite_type','started_at','duration_ms','passed','failed','flaky','skipped','total_items']));

console.log(`Parsed ${pw} Playwright and ${nm} Newman file(s)${skipped ? `, skipped ${skipped}` : ''}`);
console.log(`  dim_runs.csv        ${dimRunRows.length} rows`);
console.log(`  ui_tests.csv        ${uiTests.length} rows`);
console.log(`  api_requests.csv    ${apiRequests.length} rows`);
console.log(`  api_assertions.csv  ${apiAssertions.length} rows`);
console.log(`  runs.csv            ${runs.length} rows`);
console.log(`Written to ${path.resolve(outDir)}`);
