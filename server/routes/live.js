const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getLive } = require('../lib/live');
const { buildChain, activePlayerAt, gameTime } = require('../lib/rosters');

const r1 = n => Math.round(n * 10) / 10;

// GET /api/live — games in progress, with the signed-in user's players and league impact
router.get('/', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  let live;
  try { live = await getLive(); } catch (e) { return res.status(502).json({ error: 'Live data is unavailable right now' }); }

  // Leagues the user plays in (drafted rosters only)
  const { data: mine } = await supabase.from('league_members').select('league_id, leagues(id, name, season, status)').eq('user_id', req.userId);
  const leagues = (mine || []).map(m => m.leagues).filter(l => l && ['active', 'complete'].includes(l.status));

  const next = await nextGame();

  if (!live.games.length) return res.json({ serverTime: new Date().toISOString(), games: [], next });

  // Everyone's active player per slot, for each of the user's leagues
  const leagueIds = leagues.map(l => l.id);
  let members = [], picks = [], swaps = [], playersById = new Map();
  if (leagueIds.length) {
    const [m, p, s] = await Promise.all([
      supabase.from('league_members').select('id, league_id, user_id, display_name').in('league_id', leagueIds),
      supabase.from('draft_picks').select('league_id, member_id, player_id').in('league_id', leagueIds),
      supabase.from('roster_swaps')
        .select('league_id, member_id, out_player_id, in_player_id, effective_game:games!effective_game_id(kickoff_time, game_date)')
        .in('league_id', leagueIds),
    ]);
    members = m.data || []; picks = p.data || []; swaps = s.data || [];
    const ids = new Set();
    const chains = picks.map(pk => {
      const chain = buildChain(pk.player_id, swaps.filter(x => x.league_id === pk.league_id && x.member_id === pk.member_id));
      chain.forEach(c => ids.add(c.playerId));
      return { ...pk, active: activePlayerAt(chain, Date.now()) };
    });
    const { data: pl } = await supabase.from('players').select('id, name, position, api_player_id').in('id', [...ids]);
    playersById = new Map((pl || []).map(p => [p.id, p]));
    picks = chains;
  }

  const myApiIds = new Set();
  const games = live.games.map(g => {
    const perLeague = leagues.map(lg => {
      const ms = members.filter(m => m.league_id === lg.id).map(m => {
        const mine = picks
          .filter(p => p.league_id === lg.id && p.member_id === m.id)
          .map(p => playersById.get(p.active))
          .filter(p => p && g.players.has(String(p.api_player_id)))
          .map(p => ({ name: p.name, position: p.position, points: r1(g.players.get(String(p.api_player_id)).points) }));
        const isMe = m.user_id === req.userId;
        if (isMe) mine.forEach(p => myApiIds.add(p.name));
        return { id: m.id, name: m.display_name, isMe, total: r1(mine.reduce((a, p) => a + p.points, 0)), players: mine.sort((a, b) => b.points - a.points) };
      }).filter(m => m.players.length).sort((a, b) => b.total - a.total);
      return { leagueId: lg.id, name: lg.name, members: ms };
    }).filter(l => l.members.length);

    const mineNames = new Set(perLeague.flatMap(l => l.members.filter(m => m.isMe).flatMap(m => m.players.map(p => p.name))));
    const leaders = [...g.players.values()]
      .filter(p => p.points > 0)
      .sort((a, b) => b.points - a.points).slice(0, 8)
      .map(p => ({ name: p.name, team: p.team, points: r1(p.points), mine: mineNames.has(p.name) }));

    return {
      id: g.apiGameId, status: g.status, stage: g.stage, week: g.week,
      home: g.home, away: g.away, leaders, leagues: perLeague,
    };
  });

  res.json({ serverTime: new Date().toISOString(), games, next });
});

// Next scheduled playoff game (for the "nothing live" state)
async function nextGame() {
  const { data } = await supabase
    .from('games')
    .select('playoff_round, game_date, kickoff_time, status, home:nfl_teams!home_team_id(name, abbr), away:nfl_teams!away_team_id(name, abbr)')
    .eq('status', 'NS');
  const upcoming = (data || []).filter(g => gameTime(g) > Date.now()).sort((a, b) => gameTime(a) - gameTime(b))[0];
  if (!upcoming) return null;
  return { round: upcoming.playoff_round, kickoff: new Date(gameTime(upcoming)).toISOString(), home: upcoming.home?.name || null, away: upcoming.away?.name || null };
}

module.exports = router;
