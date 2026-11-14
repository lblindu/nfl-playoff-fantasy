/**
 * seed-2024-playoffs.mjs
 *
 * Pulls the 2024 NFL playoff teams, players, and games from api-sports.io
 * and seeds your local Supabase database for testing.
 *
 * Usage:
 *   node scripts/seed-2024-playoffs.mjs
 *
 * Requires .env with:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, APISPORTS_KEY
 *
 * The free api-sports.io plan allows ~100 requests/day.
 * This script uses approximately 20–30 requests total.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SEASON = 2024;
const NFL_LEAGUE_ID = '1';
const API_BASE = 'https://v1.american-football.api-sports.io';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── API helpers ──────────────────────────────────────────────────────────────

let lastCall = 0;
async function apiCall(path, params = {}) {
  // Free plan: 10 requests/minute — keep calls ~7s apart
  const wait = lastCall + 7000 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: { 'x-apisports-key': process.env.APISPORTS_KEY }
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`API error: ${JSON.stringify(json.errors)}`);
  }
  return json.response || [];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── The 14 2024 NFL playoff teams (hardcoded so we don't burn API calls) ──────
// AFC: KC, BUF, BAL, HOU, LAC, DEN, PIT
// NFC: PHI, DET, LAR, TB, WSH, GB, MIN
const PLAYOFF_TEAM_ABBRS = new Set([
  'KC', 'BUF', 'BAL', 'HOU', 'LAC', 'DEN', 'PIT',
  'PHI', 'DET', 'LA', 'TB', 'WAS', 'GB', 'MIN'   // api-sports codes: Rams = LA, Washington = WAS
]);

function normalizeRound(raw) {
  const r = String(raw || '').toLowerCase();
  if (r.includes('wild')) return 'Wildcard';
  if (r.includes('divis')) return 'Divisional';
  if (r.includes('conf') || r.includes('championship')) return 'Conference';
  if (r.includes('super')) return 'Superbowl';
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🏈 Seeding 2024 NFL Playoff data\n');

  // ── 1. Pull all teams for season 2024 ───────────────────────────────────
  console.log('1/5  Pulling teams from API…');
  const rawTeams = await apiCall('/teams', { league: NFL_LEAGUE_ID, season: SEASON });

  const teamRows = rawTeams.map(t => ({
    season: SEASON,
    api_team_id: String(t.id || t.team?.id),
    name: t.name || t.team?.name || '',
    abbr: (t.code || t.abbreviation || t.team?.code || '').toUpperCase(),
    city: t.city || '',
    logo_url: t.logo || t.team?.logo || null,
    in_playoffs: PLAYOFF_TEAM_ABBRS.has((t.code || t.abbreviation || '').toUpperCase()),
    confirmed: true,
    primary_color: null,
    secondary_color: null,
  }));

  const { data: insertedTeams, error: teamErr } = await supabase
    .from('nfl_teams')
    .upsert(teamRows, { onConflict: 'season,api_team_id' })
    .select();

  if (teamErr) { console.error('Team upsert error:', teamErr.message); process.exit(1); }
  console.log(`   ✓ ${insertedTeams.length} teams upserted (${teamRows.filter(t => t.in_playoffs).length} in playoffs)`);

  // Build lookup: api_team_id → DB row
  const teamByApiId = new Map(insertedTeams.map(t => [t.api_team_id, t]));
  const playoffTeams = insertedTeams.filter(t => t.in_playoffs);

  // ── 2. Pull players for each playoff team ────────────────────────────────
  console.log('\n2/5  Pulling players for 14 playoff teams…');
  const ALLOWED_POS = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);
  let totalPlayers = 0;

  const { data: existing } = await supabase.from('players').select('nfl_team_id').eq('season', SEASON);
  const teamsWithPlayers = new Set((existing || []).map(p => p.nfl_team_id));
  totalPlayers = (existing || []).length;

  for (const team of playoffTeams) {
    if (teamsWithPlayers.has(team.id)) { console.log(`   • ${team.abbr} already seeded, skipping`); continue; }
    try {
      const rawPlayers = await apiCall('/players', { team: team.api_team_id, season: SEASON });
      const playerRows = rawPlayers
        .filter(p => {
          const grp = String(p.group || '').toLowerCase();
          const pos = String(p.position || '').toUpperCase();
          return grp === 'offense' && ALLOWED_POS.has(pos);
        })
        .map(p => ({
          season: SEASON,
          api_player_id: String(p.id),
          name: p.name || '',
          position: String(p.position || '').toUpperCase(),
          jersey_number: String(p.number || ''),
          nfl_team_id: team.id,
          confirmed: true,
        }));

      if (playerRows.length) {
        const { error } = await supabase
          .from('players')
          .upsert(playerRows, { onConflict: 'season,api_player_id' });
        if (error) console.warn(`   ⚠ ${team.abbr}: ${error.message}`);
        else {
          totalPlayers += playerRows.length;
          process.stdout.write(`   ✓ ${team.abbr} (${playerRows.length} players)\n`);
        }
      }
      await sleep(300);
    } catch (e) {
      console.warn(`   ⚠ ${team.abbr}: ${e.message}`);
    }
  }
  console.log(`   Total: ${totalPlayers} players`);

  // ── 3. Pull postseason games ─────────────────────────────────────────────
  console.log('\n3/5  Pulling postseason games…');
  const gameRows = [];

  // Free plan blocks date filters but allows the whole season in one call
  try {
    const games = await apiCall('/games', { league: NFL_LEAGUE_ID, season: SEASON });
    for (const g of games) {
      const gameObj = g.game || g;
      const stage = String(gameObj.stage || '').toLowerCase();
      if (!stage.includes('post')) continue;

      const round = normalizeRound(gameObj.week || '');   // skips Pro Bowl
      if (!round) continue;

      const homeApiId = String(g.teams?.home?.id || '');
      const awayApiId = String(g.teams?.away?.id || '');

      const hs = g.scores?.home?.total, as = g.scores?.away?.total;
      gameRows.push({
        winner_team_id: hs == null || as == null || hs === as ? null
          : teamByApiId.get(hs > as ? homeApiId : awayApiId)?.id || null,
        season: SEASON,
        api_game_id: String(gameObj.id),
        playoff_round: round,
        game_date: gameObj.date?.date,
        kickoff_time: gameObj.date?.timestamp ? new Date(gameObj.date.timestamp * 1000).toISOString() : null,
        status: 'FT',
        home_team_id: teamByApiId.get(homeApiId)?.id || null,
        away_team_id: teamByApiId.get(awayApiId)?.id || null,
        home_score: g.scores?.home?.total ?? null,
        away_score: g.scores?.away?.total ?? null,
      });
    }
  } catch (e) {
    console.warn(`   ⚠ games: ${e.message}`);
  }

  const { data: insertedGames, error: gameErr } = await supabase
    .from('games')
    .upsert(gameRows, { onConflict: 'api_game_id' })
    .select();

  if (gameErr) { console.error('Game upsert error:', gameErr.message); process.exit(1); }
  console.log(`   ✓ ${insertedGames.length} games upserted`);
  insertedGames.forEach(g => {
    const home = insertedTeams.find(t => t.id === g.home_team_id);
    const away = insertedTeams.find(t => t.id === g.away_team_id);
    console.log(`     ${g.playoff_round}: ${away?.abbr || '?'} @ ${home?.abbr || '?'}  ${g.away_score}–${g.home_score}`);
  });

  // ── 4. Pull player stats for each completed game ─────────────────────────
  console.log('\n4/5  Pulling player stats for each game…');

  const { computePoints, parseGroupedStats } = await import('../server/lib/apiSports.js');

  for (const game of insertedGames) {
    try {
      const rawStats = await apiCall('/games/statistics/players', { id: game.api_game_id });
      const statMap = parseGroupedStats(rawStats);

      // Look up player IDs from api_player_id
      const apiPlayerIds = [...statMap.keys()];
      if (!apiPlayerIds.length) { console.log(`   ⚠ No stats for game ${game.api_game_id}`); continue; }

      const { data: dbPlayers } = await supabase
        .from('players')
        .select('id, api_player_id')
        .in('api_player_id', apiPlayerIds)
        .eq('season', SEASON);

      const playerIdMap = new Map((dbPlayers || []).map(p => [p.api_player_id, p.id]));

      const scoreRows = [];
      for (const [apiId, stats] of statMap) {
        const playerId = playerIdMap.get(apiId);
        if (!playerId) continue;
        const pts = computePoints(stats);
        scoreRows.push({
          game_id: game.id,
          player_id: playerId,
          api_player_id: apiId,
          points: pts,
          pass_yds: stats.passYds,
          pass_td: stats.passTD,
          interceptions: stats.int,
          rush_yds: stats.rushYds,
          rush_td: stats.rushTD,
          receptions: stats.rec,
          rec_yds: stats.recYds,
          rec_td: stats.recTD,
          fumbles: stats.fumbles,
          two_pt: stats.twoPt,
        });
      }

      if (scoreRows.length) {
        const { error } = await supabase
          .from('game_player_scores')
          .upsert(scoreRows, { onConflict: 'game_id,player_id' });
        if (error) console.warn(`   ⚠ Scores ${game.api_game_id}: ${error.message}`);
        else console.log(`   ✓ Game ${game.api_game_id} (${game.playoff_round}): ${scoreRows.length} player scores`);
      }
      await sleep(400);
    } catch (e) {
      console.warn(`   ⚠ Game ${game.api_game_id}: ${e.message}`);
    }
  }

  // ── 5. Create a demo league + members ────────────────────────────────────
  console.log('\n5/5  Creating demo league…');

  let { data: demoLeague, error: leagueErr } = await supabase
    .from('leagues').select().eq('name', 'Demo League 2024').eq('season', SEASON).maybeSingle();
  if (!demoLeague && !leagueErr) {
    ({ data: demoLeague, error: leagueErr } = await supabase
      .from('leagues')
      .insert([{ name: 'Demo League 2024', season: SEASON, status: 'setup' }])
      .select()
      .single());
  }

  if (leagueErr) { console.warn('League upsert:', leagueErr.message); }
  else console.log(`   ✓ League: "${demoLeague.name}" (id: ${demoLeague.id})`);

  console.log(`
╔══════════════════════════════════════════════════════╗
║           Seed complete!                             ║
╠══════════════════════════════════════════════════════╣
║  Teams:    ${String(insertedTeams.length).padEnd(43)}║
║  Players:  ${String(totalPlayers).padEnd(43)}║
║  Games:    ${String(insertedGames.length).padEnd(43)}║
╠══════════════════════════════════════════════════════╣
║  Next steps:                                         ║
║  1. Open Supabase > Authentication > Users           ║
║     and manually create 2–3 test user accounts       ║
║  2. Add them to the Demo League via admin panel       ║
║  3. Run the draft and verify scoring adds up         ║
╚══════════════════════════════════════════════════════╝
`);
}

main().catch(e => { console.error(e); process.exit(1); });
