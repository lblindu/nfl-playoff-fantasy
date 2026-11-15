const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getPostseasonGames } = require('../lib/apiSports');
const { refreshGameStats } = require('../jobs/scoring');
const { computeLeagueStandings } = require('../lib/standings');
const { buildChain, activePlayerAt, gameTime, findNextGame } = require('../lib/rosters');

// GET /api/scores/standings/:leagueId
router.get('/standings/:leagueId', async (req, res) => {
  try {
    res.json(await computeLeagueStandings(req.params.leagueId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scores/roster/:leagueId/:memberId
router.get('/roster/:leagueId/:memberId', async (req, res) => {
  const { leagueId, memberId } = req.params;

  const { data: picks, error } = await supabase
    .from('draft_picks')
    .select('pick_number, player_id')
    .eq('league_id', leagueId)
    .eq('member_id', memberId)
    .order('pick_number');

  if (error) return res.status(500).json({ error: error.message });

  const { data: swapRows } = await supabase
    .from('roster_swaps')
    .select('out_player_id, in_player_id, effective_game:games!effective_game_id(kickoff_time, game_date)')
    .eq('league_id', leagueId)
    .eq('member_id', memberId);
  const swaps = swapRows || [];

  const chains = (picks || []).map(pick => ({ pick, chain: buildChain(pick.player_id, swaps) }));
  const ids = [...new Set(chains.flatMap(c => c.chain.map(e => e.playerId)))];
  if (!ids.length) return res.json([]);

  const [playersRes, scoresRes] = await Promise.all([
    supabase.from('players')
      .select('*, nfl_teams(id, name, abbr, primary_color, secondary_color, logo_url, is_eliminated, eliminated_round)')
      .in('id', ids),
    supabase.from('game_player_scores')
      .select('player_id, points, games!inner(playoff_round, game_date, kickoff_time)')
      .in('player_id', ids),
  ]);
  if (playersRes.error) return res.status(500).json({ error: playersRes.error.message });

  const playerById = new Map(playersRes.data.map(p => [p.id, p]));
  const scoresByPlayer = new Map();
  for (const s of scoresRes.data || []) {
    if (!scoresByPlayer.has(s.player_id)) scoresByPlayer.set(s.player_id, []);
    scoresByPlayer.get(s.player_id).push(s);
  }

  const result = [];
  for (const { pick, chain } of chains) {
    // Points each player in the slot earned while he was the active one
    const segments = chain.map(entry => {
      const byRound = {};
      for (const s of scoresByPlayer.get(entry.playerId) || []) {
        if (activePlayerAt(chain, gameTime(s.games)) !== entry.playerId) continue;
        const round = s.games.playoff_round;
        byRound[round] = (byRound[round] || 0) + (s.points || 0);
      }
      const total = Object.values(byRound).reduce((a, b) => a + b, 0);
      return { player: playerById.get(entry.playerId), byRound, total };
    });

    const current = segments[segments.length - 1];
    const p = current.player;
    const scores = {};
    for (const seg of segments) {
      for (const [round, pts] of Object.entries(seg.byRound)) scores[round] = (scores[round] || 0) + pts;
    }

    // Can this slot be swapped? Only an OUT player, and only before his team's next kickoff
    const swap = { canSwap: false, nextGame: null, teamGames: null };
    if (p.injury_status === 'out') {
      swap.nextGame = await findNextGame(p.nfl_teams.id);
      swap.canSwap = !!swap.nextGame || req.isAdmin === true;
      if (req.isAdmin) {
        const { data: tg } = await supabase
          .from('games')
          .select('id, playoff_round, game_date, kickoff_time, status')
          .or(`home_team_id.eq.${p.nfl_teams.id},away_team_id.eq.${p.nfl_teams.id}`)
          .order('game_date');
        swap.teamGames = tg || [];
      }
    }

    result.push({
      pick_number: pick.pick_number,
      player: { id: p.id, name: p.name, position: p.position, jersey_number: p.jersey_number, headshot_url: p.headshot_url },
      team: p.nfl_teams,
      injury: p.injury_status || null,
      scores,
      total: Object.values(scores).reduce((a, b) => a + b, 0),
      replaced: segments.slice(0, -1).map(s => ({ name: s.player?.name, position: s.player?.position, total: s.total })),
      swap,
    });
  }

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
