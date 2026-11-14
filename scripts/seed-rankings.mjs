/**
 * seed-rankings.mjs
 *
 * Ranks the draft pool by regular-season fantasy points (same scoring rules as the game).
 * Uses one api-sports call per playoff team (14 total); responses are cached in
 * scripts/.cache-stats so re-running costs no API quota.
 *
 *   node scripts/seed-rankings.mjs [season]
 *
 * Requires the ranking columns (see supabase/schema.sql, "Player rankings").
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const SEASON = parseInt(process.argv[2] || '2024');
const API_BASE = 'https://v1.american-football.api-sports.io';
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache-stats', String(SEASON));
fs.mkdirSync(CACHE_DIR, { recursive: true });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let lastCall = 0;
async function apiCall(p, params) {
  const wait = lastCall + 7000 - Date.now(); // free plan: 10 requests/minute
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${p}?${qs}`, { headers: { 'x-apisports-key': process.env.APISPORTS_KEY } });
  if (!res.ok) throw new Error(`API ${p} → ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) throw new Error(`API error: ${JSON.stringify(json.errors)}`);
  return json.response || [];
}

const num = v => {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};
const norm = s => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');

// Season totals → points. Same weights as server/lib/apiSports.js computePoints.
function seasonPoints(teamEntry) {
  const s = { passYds: 0, passTD: 0, int: 0, rushYds: 0, rushTD: 0, rec: 0, recYds: 0, recTD: 0, fumbles: 0 };
  for (const g of teamEntry.groups || []) {
    const grp = norm(g.name);
    for (const st of g.statistics || []) {
      const k = norm(st.name), v = num(st.value);
      if (grp === 'passing') {
        if (k === 'yards') s.passYds = v;
        else if (k === 'passing touchdowns') s.passTD = v;
        else if (k === 'interceptions') s.int = v;
      } else if (grp === 'rushing') {
        if (k === 'yards') s.rushYds = v;
        else if (k === 'rushing touchdowns') s.rushTD = v;
        else if (k === 'fumbles lost') s.fumbles = v;
      } else if (grp === 'receiving') {
        if (k === 'receptions' || k === 'total receptions') s.rec = v;
        else if (k === 'yards') s.recYds = v;
        else if (k === 'receiving touchdowns') s.recTD = v;
      }
    }
  }
  const pts = s.passYds / 25 + s.passTD * 4 - s.int * 2
    + s.rushYds * 0.1 + s.rushTD * 6
    + s.rec + s.recYds * 0.1 + s.recTD * 6
    - s.fumbles * 2;
  return Math.round(pts * 10) / 10;
}

async function main() {
  console.log(`\nRanking ${SEASON} playoff players by regular-season fantasy points\n`);

  const { data: teams, error: tErr } = await supabase
    .from('nfl_teams').select('id, abbr, api_team_id').eq('season', SEASON).eq('in_playoffs', true);
  if (tErr) throw tErr;
  if (!teams.length) throw new Error('No playoff teams found — run the seed first.');

  const { data: players, error: pErr } = await supabase
    .from('players').select('id, api_player_id, name, position, nfl_team_id').eq('season', SEASON);
  if (pErr) throw pErr;
  const byApiId = new Map(players.map(p => [p.api_player_id, p]));

  const scored = new Map(); // player.id → points
  for (const team of teams) {
    const file = path.join(CACHE_DIR, `${team.abbr}.json`);
    let response;
    if (fs.existsSync(file)) {
      response = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log(`   • ${team.abbr} (cached)`);
    } else {
      try {
        response = await apiCall('/players/statistics', { team: team.api_team_id, season: SEASON });
        fs.writeFileSync(file, JSON.stringify(response));
        console.log(`   ✓ ${team.abbr} (${response.length} players)`);
      } catch (e) {
        console.warn(`   ⚠ ${team.abbr}: ${e.message}`);
        continue;
      }
    }
    for (const entry of response) {
      const player = byApiId.get(String(entry.player?.id));
      if (!player) continue;
      // Only this team's stats — API also lists college / former teams
      const teamEntry = (entry.teams || []).find(t => String(t.team?.id) === String(team.api_team_id));
      scored.set(player.id, teamEntry ? seasonPoints(teamEntry) : 0);
    }
  }

  // Rank: overall and within position (higher points = better rank 1)
  const ranked = players.map(p => ({ ...p, pts: scored.get(p.id) ?? 0 }))
    .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));
  const posCount = {};
  const rows = ranked.map((p, i) => {
    posCount[p.position] = (posCount[p.position] || 0) + 1;
    return { id: p.id, reg_season_points: p.pts, overall_rank: i + 1, pos_rank: posCount[p.position] };
  });

  console.log('\nTop 12:');
  ranked.slice(0, 12).forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.name.padEnd(24)} ${p.position}  ${p.pts}`));

  // Probe the columns before writing
  const probe = await supabase.from('players').select('reg_season_points').limit(1);
  if (probe.error) {
    console.error(`\n✗ ${probe.error.message}\n  Run this in the Supabase SQL Editor, then rerun this script (it uses the cache, so no API calls):\n
  alter table public.players
    add column if not exists reg_season_points numeric,
    add column if not exists overall_rank int,
    add column if not exists pos_rank int;\n`);
    process.exit(1);
  }

  for (const r of rows) {
    const { error } = await supabase.from('players')
      .update({ reg_season_points: r.reg_season_points, overall_rank: r.overall_rank, pos_rank: r.pos_rank })
      .eq('id', r.id);
    if (error) { console.error('Update failed:', error.message); process.exit(1); }
  }
  console.log(`\n✓ Ranked ${rows.length} players`);
}

main().catch(e => { console.error(e); process.exit(1); });
