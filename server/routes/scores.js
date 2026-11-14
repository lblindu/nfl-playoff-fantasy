const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getPostseasonGames } = require('../lib/apiSports');
const { refreshGameStats } = require('../jobs/scoring');

// GET /api/scores/standings/:leagueId
router.get('/standings/:leagueId', async (req, res) => {
  const { data, error } = await supabase
    .from('league_members')
    .select(`
      id, display_name, total_score,
      member_round_scores(playoff_round, points),
      draft_picks(
        players(
          id, name, position,
          nfl_teams(name, abbr, primary_color, is_eliminated)
        )
      )
    `)
    .eq('league_id', req.params.leagueId)
    .order('total_score', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/scores/roster/:leagueId/:memberId
router.get('/roster/:leagueId/:memberId', async (req, res) => {
  const { leagueId, memberId } = req.params;

  const { data: picks, error } = await supabase
    .from('draft_picks')
    .select(`
      id, pick_number,
      players(
        id, name, position, jersey_number, headshot_url,
        nfl_teams(id, name, abbr, primary_color, secondary_color, logo_url, is_eliminated, eliminated_round),
        game_player_scores(
          points, pass_yds, pass_td, interceptions, rush_yds, rush_td,
          receptions, rec_yds, rec_td, fumbles, two_pt, last_updated,
          games(playoff_round, game_date, status)
        )
      )
    `)
    .eq('league_id', leagueId)
    .eq('member_id', memberId)
    .order('pick_number');

  if (error) return res.status(500).json({ error: error.message });

  // Reshape: group scores by round
  const result = (picks || []).map(pick => {
    const p = pick.players;
    const scoresByRound = {};
    for (const s of (p?.game_player_scores || [])) {
      const round = s.games?.playoff_round;
      if (!round) continue;
      scoresByRound[round] = (scoresByRound[round] || 0) + s.points;
    }
    return {
      pick_number: pick.pick_number,
      player: { id: p.id, name: p.name, position: p.position, jersey_number: p.jersey_number, headshot_url: p.headshot_url },
      team: p.nfl_teams,
      scores: scoresByRound,
      total: Object.values(scoresByRound).reduce((a, b) => a + b, 0),
    };
  });

  res.json(result);
});

// GET /api/scores/games?season=2026
router.get('/games', async (req, res) => {
  const { season } = req.query;
  const q = supabase.from('games').select(`
    id, api_game_id, playoff_round, game_date, kickoff_time, status,
    home_score, away_score, last_synced_at,
    home_team:nfl_teams!home_team_id(name, abbr, logo_url, primary_color),
    away_team:nfl_teams!away_team_id(name, abbr, logo_url, primary_color)
  `).order('game_date');

  if (season) q.eq('season', season);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/scores/pull-games — admin: pull postseason schedule from API
router.post('/pull-games', requireAdmin, async (req, res) => {
  const { season, startDate, endDate } = req.body;
  if (!season || !startDate || !endDate) {
    return res.status(400).json({ error: 'season, startDate, endDate required' });
  }

  try {
    const games = await getPostseasonGames(season, startDate, endDate);

    // Resolve home/away team IDs from api_team_id
    const { data: teams } = await supabase
      .from('nfl_teams')
      .select('id, api_team_id')
      .eq('season', season);

    const teamMap = new Map((teams || []).map(t => [t.api_team_id, t.id]));

    const rows = games.map(g => ({
      season: parseInt(season),
      api_game_id: g.api_game_id,
      playoff_round: normalizeRound(g.round),
      game_date: g.game_date,
      status: g.status,
      home_team_id: teamMap.get(g.home_api_team_id) || null,
      away_team_id: teamMap.get(g.away_api_team_id) || null,
      home_score: g.home_score,
      away_score: g.away_score,
    })).filter(g => g.playoff_round);

    const { data, error } = await supabase
      .from('games')
      .upsert(rows, { onConflict: 'api_game_id' })
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ imported: data.length, games: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scores/refresh-game/:gameId — admin: manually refresh a specific game
router.post('/refresh-game/:gameId', requireAdmin, async (req, res) => {
  const { data: game } = await supabase
    .from('games')
    .select('id, api_game_id, playoff_round')
    .eq('id', req.params.gameId)
    .single();

  if (!game) return res.status(404).json({ error: 'Game not found' });

  try {
    await refreshGameStats(game);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function normalizeRound(raw) {
  const r = String(raw || '').toLowerCase();
  if (r.includes('wild')) return 'Wildcard';
  if (r.includes('divis')) return 'Divisional';
  if (r.includes('conf')) return 'Conference';
  if (r.includes('super')) return 'Superbowl';
  return null;
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = router;
