const cron = require('node-cron');
const supabase = require('../lib/supabase');
const { getGamePlayerStats, parseGroupedStats, computePoints } = require('../lib/apiSports');

const ROUNDS = ['Wildcard', 'Divisional', 'Conference', 'Superbowl'];

// Run every minute during game windows (Sat 4:30-midnight, Sun 1pm-midnight, Mon 8pm-11:30pm ET)
function isWithinGameWindow() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = now.getDay(); // 0=Sun, 1=Mon, 6=Sat
  const mins = now.getHours() * 60 + now.getMinutes();

  if (dow === 6) return mins >= 16 * 60 + 30;             // Sat 4:30pm+
  if (dow === 0) return mins >= 13 * 60;                   // Sun 1pm+
  if (dow === 1) return mins >= 20 * 60 && mins <= 23 * 60 + 30; // Mon 8-11:30pm
  return false;
}

async function refreshLiveScores() {
  if (!isWithinGameWindow()) return;

  try {
    // Get games that are live (not NS, not FT)
    const { data: games, error } = await supabase
      .from('games')
      .select('id, api_game_id, playoff_round')
      .not('status', 'in', '("NS","FT","TBD")')
      .not('status', 'is', null);

    if (error || !games?.length) return;

    for (const game of games) {
      await refreshGameStats(game);
    }
  } catch (e) {
    console.error('[scoring] refreshLiveScores error:', e.message);
  }
}

async function refreshGameStats(game) {
  try {
    const responseArr = await getGamePlayerStats(game.api_game_id);
    if (!responseArr.length) return;

    const isGrouped = !!responseArr[0]?.groups;
    const statsMap = isGrouped ? parseGroupedStats(responseArr) : new Map();
    if (!statsMap.size) return;

    // Get all drafted players with their api_player_id
    const { data: players } = await supabase
      .from('players')
      .select('id, api_player_id')
      .in('api_player_id', Array.from(statsMap.keys()));

    if (!players?.length) return;

    const pidToDbId = new Map(players.map(p => [p.api_player_id, p.id]));
    const now = new Date().toISOString();
    const upserts = [];

    for (const [apiPid, line] of statsMap.entries()) {
      const dbPlayerId = pidToDbId.get(apiPid);
      if (!dbPlayerId) continue;

      const pts = computePoints(line);
      upserts.push({
        game_id: game.id,
        player_id: dbPlayerId,
        api_player_id: apiPid,
        pass_yds: line.passYds,
        pass_td: line.passTD,
        interceptions: line.int,
        rush_yds: line.rushYds,
        rush_td: line.rushTD,
        receptions: line.rec,
        rec_yds: line.recYds,
        rec_td: line.recTD,
        fumbles: line.fumbles,
        two_pt: line.twoPt,
        points: pts,
        last_updated: now,
      });
    }

    if (upserts.length) {
      await supabase
        .from('game_player_scores')
        .upsert(upserts, { onConflict: 'game_id,player_id' });
    }

    await recalcMemberScores(game.playoff_round);
  } catch (e) {
    console.error(`[scoring] refreshGameStats(${game.api_game_id}):`, e.message);
  }
}

// Recompute member_round_scores for a given round across all leagues
async function recalcMemberScores(playoffRound) {
  // Get all draft picks with their player's current round score
  const { data: picks } = await supabase
    .from('draft_picks')
    .select(`
      member_id,
      league_id,
      player_id,
      players!inner(id,
        game_player_scores(points, games!inner(playoff_round))
      )
    `);

  if (!picks?.length) return;

  // Aggregate: member_id + league_id + round → sum of points
  const agg = new Map();
  for (const pick of picks) {
    for (const score of (pick.players?.game_player_scores || [])) {
      const round = score.games?.playoff_round;
      if (!round) continue;
      const key = `${pick.league_id}|${pick.member_id}|${round}`;
      agg.set(key, (agg.get(key) || 0) + (score.points || 0));
    }
  }

  const upserts = Array.from(agg.entries()).map(([key, points]) => {
    const [league_id, member_id, round] = key.split('|');
    return { league_id, member_id, playoff_round: round, points, updated_at: new Date().toISOString() };
  });

  if (upserts.length) {
    await supabase
      .from('member_round_scores')
      .upsert(upserts, { onConflict: 'league_id,member_id,playoff_round' });
  }

  // Also update total_score on league_members
  const totals = new Map();
  for (const { league_id, member_id, points } of upserts) {
    const key = `${league_id}|${member_id}`;
    totals.set(key, (totals.get(key) || 0) + points);
  }
  for (const [key, total] of totals.entries()) {
    const [league_id, member_id] = key.split('|');
    await supabase
      .from('league_members')
      .update({ total_score: Math.round(total * 100) / 100 })
      .eq('id', member_id)
      .eq('league_id', league_id);
  }
}

function startScoringJob() {
  cron.schedule('* * * * *', refreshLiveScores);
  console.log('[scoring] Cron job started (every minute)');
}

module.exports = { startScoringJob, refreshGameStats, recalcMemberScores };
