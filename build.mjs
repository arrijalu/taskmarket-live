#!/usr/bin/env node
// build.mjs — fetch Taskmarket's public API, aggregate an honest snapshot, render one static page.
// No dependencies. Node >= 18 (global fetch).
//
// Every number in the output is computed from the API response captured in this run.
// Nothing is synthesised: fields the API does not expose are stated as absent on the page.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const API = 'https://taskmarket.dev';
const UA = 'taskmarket-live/1.0 (+public dashboard; hourly refresh)';
const OUT_DIR = path.join(ROOT, 'docs'); // GitHub Pages serves main:/docs
const WATCH_FILE = path.join(ROOT, 'data', 'watch.json');

const OUSD = 1e6; // reward fields are 6-decimal base units
const now = new Date();

async function getJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 25000);
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const body = await res.json();
      clearTimeout(t);
      return body;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw new Error(`fetch failed: ${url} — ${lastErr && lastErr.message}`);
}

// ---------- fetch ----------
const stats = await getJSON(`${API}/api/market/stats`);

const tasks = [];
let cursor = null;
let pages = 0;
for (;;) {
  const u = new URL(`${API}/api/tasks`);
  u.searchParams.set('limit', '100');
  if (cursor) u.searchParams.set('cursor', cursor);
  const page = await getJSON(u.toString());
  if (!Array.isArray(page.tasks)) throw new Error('unexpected /api/tasks shape');
  tasks.push(...page.tasks);
  pages++;
  cursor = page.nextCursor || null;
  if (!page.hasMore || !cursor || pages > 200) break;
  await new Promise((r) => setTimeout(r, 120)); // be a good citizen
}
if (!tasks.length) throw new Error('no tasks returned');

// ---------- helpers ----------
const ts = (s) => (s ? new Date(s).getTime() : null);
const val = (t, k = 'reward') => Number(t[k] || 0) / OUSD;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const quant = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const median = (a) => quant(a, 0.5);
const sum = (a) => a.reduce((x, y) => x + y, 0);

const byStatus = {};
const byMode = {};
const byChain = {};
for (const t of tasks) {
  byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const m = (byMode[t.mode] ||= { count: 0, ousd: 0, rewards: [] });
  m.count++; m.ousd += val(t); m.rewards.push(val(t));
  const c = (byChain[t.chainId] ||= { count: 0, ousd: 0 });
  c.count++; c.ousd += val(t);
}

// ---------- money flow ----------
const committed = sum(tasks.map((t) => val(t)));
const paidTasks = tasks.filter((t) => t.status === 'completed');
const paid = sum(paidTasks.map((t) => Number(t.netReward || t.reward) / OUSD));
const inFlight = tasks.filter((t) => ['open', 'claimed', 'pending_approval'].includes(t.status));
const escrow = sum(inFlight.map((t) => val(t)));
const dead = tasks.filter((t) => ['cancelled', 'expired'].includes(t.status));
const deadValue = sum(dead.map((t) => val(t)));
const resolved = paidTasks.length + dead.length;

// ---------- velocity ----------
const claimHours = [];
const claimHoursByMode = {};
for (const t of tasks) {
  const c = ts(t.claimedAt), k = ts(t.createdAt);
  if (!c || !k) continue;
  const h = (c - k) / 36e5;
  if (!(h >= 0) || h > 24 * 45) continue;
  claimHours.push(h);
  (claimHoursByMode[t.mode] ||= []).push(h);
}
const claimHist = Array.from({ length: 8 }, (_, i) => ({ bucket: i, n: 0 })); // <1m,<5m,<15m,<1h,<6h,<24h,<72h,>=72h
const edge = [1 / 60, 5 / 60, 0.25, 1, 6, 24, 72];
for (const h of claimHours) {
  let i = edge.findIndex((e) => h < e);
  if (i === -1) i = 7;
  claimHist[i].n++;
}

// ---------- competition ----------
const subsByCompleted = paidTasks.map((t) => Number(t.submissionCount || 0));
const totalSubs = sum(paidTasks.map((t) => Number(t.submissionCount || 0)));
const totalAwards = sum(paidTasks.map((t) => Number(t.awardCount || 0)));

// ---------- concentration ----------
const reqMap = new Map();
for (const t of tasks) {
  const k = t.requester;
  const e = reqMap.get(k) || { addr: k, name: t.requesterDisplayName || k.slice(0, 10), count: 0, ousd: 0, completed: 0 };
  e.count++; e.ousd += val(t);
  if (t.status === 'completed') e.completed++;
  reqMap.set(k, e);
}
const posters = [...reqMap.values()].sort((a, b) => b.ousd - a.ousd);
const share = posters.map((p) => p.ousd / (committed || 1));
const hhi = r2(sum(share.map((s) => s * s)) * 10000);
const top10Share = r2(sum(share.slice(0, 10)) * 100);

// ---------- weekly distinct posters / workers ----------
function weekStart(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
const weekMap = new Map();
for (const t of tasks) {
  const w = weekStart(ts(t.createdAt));
  const e = weekMap.get(w) || { w, created: 0, ousd: 0, posters: new Set(), workers: new Set(), completed: 0 };
  e.created++; e.ousd += val(t);
  e.posters.add(t.requester);
  if (t.claimedBy || (t.primaryAward && t.primaryAward.workerAddress)) e.workers.add(t.claimedBy || t.primaryAward.workerAddress);
  if (t.status === 'completed') e.completed++;
  weekMap.set(w, e);
}
const weeks = [...weekMap.values()]
  .sort((a, b) => (a.w < b.w ? -1 : 1))
  .map((e) => ({ w: e.w, created: e.created, ousd: r2(e.ousd), posters: e.posters.size, workers: e.workers.size, completed: e.completed }));

// ---------- series ----------
const dayMap = new Map();
const hourMap = new Map();
function bump(map, key, t) {
  const e = map.get(key) || { k: key, created: 0, claims: 0, ousd: 0, paid: 0, agents: new Set(), completed: 0 };
  e.created++; e.ousd += val(t); e.agents.add(t.requester);
  if (t.status === 'completed') { e.completed++; e.paid += Number(t.netReward || t.reward) / OUSD; }
  map.set(key, e);
}
for (const t of tasks) {
  bump(dayMap, dayKey(ts(t.createdAt)), t);
  bump(hourMap, hourKey(ts(t.createdAt)), t);
  if (t.claimedAt) {
    const hk = hourKey(ts(t.claimedAt));
    const e = hourMap.get(hk) || { k: hk, created: 0, claims: 0, ousd: 0, paid: 0, agents: new Set(), completed: 0 };
    e.claims++;
    hourMap.set(hk, e);
  }
}
const firstDay = new Date(Math.min(...tasks.map((t) => ts(t.createdAt))));
firstDay.setUTCHours(0, 0, 0, 0);
const daySeries = [];
for (let d = new Date(firstDay); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
  const k = d.toISOString().slice(0, 10);
  const e = dayMap.get(k);
  daySeries.push({ k, created: e ? e.created : 0, claims: e ? e.claims : 0, ousd: e ? r2(e.ousd) : 0, paid: e ? r2(e.paid) : 0, agents: e ? e.agents.size : 0, completed: e ? e.completed : 0 });
}
const hourSeries = [];
for (let i = 71; i >= 0; i--) {
  const d = new Date(now.getTime() - i * 36e5);
  d.setUTCMinutes(0, 0, 0);
  const k = d.toISOString().slice(0, 13);
  const e = hourMap.get(k);
  hourSeries.push({ k, created: e ? e.created : 0, claims: e ? e.claims : 0, ousd: e ? r2(e.ousd) : 0, paid: e ? r2(e.paid) : 0, agents: e ? e.agents.size : 0 });
}

// ---------- heatmap (created tasks, UTC) ----------
const heatAll = Array.from({ length: 7 }, () => Array(24).fill(0));
const heat30 = Array.from({ length: 7 }, () => Array(24).fill(0));
const cutoff30 = now.getTime() - 30 * 864e5;
for (const t of tasks) {
  const d = new Date(ts(t.createdAt));
  const dow = d.getUTCDay(), hr = d.getUTCHours();
  heatAll[dow][hr]++;
  if (d.getTime() >= cutoff30) heat30[dow][hr]++;
}

// ---------- reward tiers ----------
const tiers = [
  { label: '<0.5', lo: 0, hi: 0.5 },
  { label: '0.5–1', lo: 0.5, hi: 1 },
  { label: '1–2', lo: 1, hi: 2 },
  { label: '2–5', lo: 2, hi: 5 },
  { label: '5–10', lo: 5, hi: 10 },
  { label: '10–50', lo: 10, hi: 50 },
  { label: '50+', lo: 50, hi: Infinity },
];
const tierData = tiers.map((b) => {
  const inTier = tasks.filter((t) => { const v = val(t); return v >= b.lo && v < b.hi; });
  const lat = inTier.filter((t) => t.claimedAt && ts(t.claimedAt) >= ts(t.createdAt)).map((t) => (ts(t.claimedAt) - ts(t.createdAt)) / 36e5).filter((h) => h <= 24 * 45);
  return { label: b.label, count: inTier.length, ousd: r2(sum(inTier.map((t) => val(t)))), medianClaimH: lat.length ? r2(median(lat)) : null };
});

// ---------- feed ----------
const feed = [...tasks]
  .sort((a, b) => ts(b.createdAt) - ts(a.createdAt))
  .slice(0, 24)
  .map((t) => ({
    ref: t.referenceCode,
    r: r2(val(t)),
    mode: t.mode,
    status: t.status,
    chain: t.chainId,
    at: t.createdAt,
    by: t.requesterDisplayName || t.requester.slice(0, 10),
    worker: t.workerDisplayName || null,
    subs: Number(t.submissionCount || 0),
    tags: (t.tags || []).filter((x) => !x.startsWith('tap:')).slice(0, 2),
  }));

// ---------- watch: accrued from our own hourly captures ----------
let watch = [];
if (existsSync(WATCH_FILE)) {
  try { watch = JSON.parse(await readFile(WATCH_FILE, 'utf8')); } catch { watch = []; }
}
const point = {
  t: now.toISOString(),
  workers: stats.registeredWorkers ?? null,
  active7d: stats.activeWorkers7d ?? null,
  agents7d: stats.activeAgents7d ?? null,
  open: stats.openTasks ?? null,
  paid: stats.paidWorkers ?? null,
  wallets: stats.activeWallets ?? null,
  tasksSeen: tasks.length,
  committed: r2(committed),
  paidOut: r2(paid),
};
const last = watch[watch.length - 1];
if (!last || now.getTime() - new Date(last.t).getTime() > 20 * 60e3) watch.push(point);
else watch[watch.length - 1] = point;
await mkdir(path.dirname(WATCH_FILE), { recursive: true });
await writeFile(WATCH_FILE, JSON.stringify(watch, null, 0));

// ---------- exact per-range aggregates (deduped, computed here not in the browser) ----------
function rangeAgg(sinceMs) {
  const inR = tasks.filter((t) => ts(t.createdAt) >= sinceMs);
  const posting = new Set(inR.map((t) => t.requester));
  const working = new Set();
  for (const t of inR) {
    if (t.claimedBy) working.add(t.claimedBy);
    else if (t.primaryAward && t.primaryAward.workerAddress) working.add(t.primaryAward.workerAddress);
  }
  const done = inR.filter((t) => t.status === 'completed');
  return {
    posted: inR.length,
    committed: r2(sum(inR.map((t) => val(t)))),
    completed: done.length,
    paid: r2(sum(done.map((t) => Number(t.netReward || t.reward) / OUSD))),
    claims: inR.filter((t) => t.claimedAt).length,
    agentsPosting: posting.size,
    agentsWorking: working.size,
    modes: Object.entries(inR.reduce((a, t) => ((a[t.mode] = (a[t.mode] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]),
  };
}
const ranges = {
  '24H': rangeAgg(now.getTime() - 24 * 36e5),
  '7D': rangeAgg(now.getTime() - 7 * 864e5),
  '30D': rangeAgg(now.getTime() - 30 * 864e5),
  ALL: rangeAgg(0),
};

// ---------- payload ----------
const payload = {
  repo: 'https://github.com/arrijalu/taskmarket-live',
  meta: {
    fetchedAt: now.toISOString(),
    endpoints: ['/api/market/stats', '/api/tasks?limit=100&cursor=…'],
    pagesFetched: pages,
    tasksSeen: tasks.length,
    oldestTask: new Date(Math.min(...tasks.map((t) => ts(t.createdAt)))).toISOString(),
    newestTask: new Date(Math.max(...tasks.map((t) => ts(t.createdAt)))).toISOString(),
    watchSince: watch[0] ? watch[0].t : now.toISOString(),
    watchPoints: watch.length,
  },
  headline: {
    registeredWorkers: stats.registeredWorkers ?? null,
    activeWorkers7d: stats.activeWorkers7d ?? null,
    activeAgents7d: stats.activeAgents7d ?? null,
    openTasks: stats.openTasks ?? null,
    paidWorkers: stats.paidWorkers ?? null,
    activeWallets: stats.activeWallets ?? null,
  },
  flow: {
    committed: r2(committed),
    paid: r2(paid),
    escrow: r2(escrow),
    dead: r2(deadValue),
    completed: paidTasks.length,
    inFlight: inFlight.length,
    deadCount: dead.length,
    resolved,
    fillRate: r2(pct(paidTasks.length, resolved)),
    cancelRate: r2(pct(dead.length, resolved)),
    paidShare: r2(pct(paid, committed)),
  },
  velocity: {
    n: claimHours.length,
    medianH: claimHours.length ? r2(median(claimHours)) : null,
    p90H: claimHours.length ? r2(quant(claimHours, 0.9)) : null,
    fastShare: r2(pct(claimHours.filter((h) => h < 1 / 60).length, claimHours.length || 1)),
    under1h: r2(pct(claimHours.filter((h) => h < 1).length, claimHours.length || 1)),
    hist: claimHist.map((b) => b.n),
    byMode: Object.entries(claimHoursByMode).map(([m, arr]) => ({ mode: m, n: arr.length, medianH: r2(median(arr)) })).sort((a, b) => b.n - a.n),
  },
  competition: {
    completed: paidTasks.length,
    totalSubs,
    totalAwards,
    medianSubs: subsByCompleted.length ? median(subsByCompleted) : null,
    p90Subs: subsByCompleted.length ? quant(subsByCompleted, 0.9) : null,
    subsPerAward: totalAwards ? r2(totalSubs / totalAwards) : null,
    zeroSubs: subsByCompleted.filter((s) => s === 0).length,
  },
  concentration: {
    posters: posters.length,
    top: posters.slice(0, 10).map((p) => ({ name: p.name, addr: p.addr, count: p.count, ousd: r2(p.ousd), completed: p.completed, share: r2(pct(p.ousd, committed)) })),
    top1Share: r2(share[0] * 100 || 0),
    top5Share: r2(sum(share.slice(0, 5)) * 100),
    top10Share,
    hhi,
  },
  status: byStatus,
  mode: Object.entries(byMode).map(([m, e]) => ({ mode: m, count: e.count, ousd: r2(e.ousd), median: r2(median(e.rewards) || 0) })).sort((a, b) => b.count - a.count),
  chain: Object.entries(byChain).map(([c, e]) => ({ chain: Number(c), count: e.count, ousd: r2(e.ousd) })).sort((a, b) => b.count - a.count),
  fee: {
    withFee: tasks.filter((t) => Number(t.platformFeeBps) > 0).length,
    bps: [...new Set(tasks.map((t) => Number(t.platformFeeBps || 0)))].sort(),
  },
  tiers: tierData,
  ranges,
  weeks,
  daySeries,
  hourSeries,
  heat: { all: heatAll, last30: heat30 },
  feed,
  watch,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(ROOT, 'data', 'market.json'), JSON.stringify(payload));

// ---------- render ----------
const tpl = await readFile(path.join(ROOT, 'src', 'index.html'), 'utf8');
const asof = now.toISOString().slice(0, 16).replace('T', ' ');
const html = tpl
  .replace('/*__DATA__*/null', JSON.stringify(payload))
  .replaceAll('__ASOF__', asof);
await writeFile(path.join(OUT_DIR, 'index.html'), html);

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' kB';
console.log(`fetched ${tasks.length} tasks over ${pages} pages`);
console.log(`committed ${r2(committed)} OUSD · paid ${r2(paid)} OUSD · escrow ${r2(escrow)} OUSD`);
console.log(`wrote data/market.json ${kb(JSON.stringify(payload))} and docs/index.html ${kb(html)}`);
