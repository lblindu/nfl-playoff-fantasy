const supabase = require('./supabase');
const { buildChain, activePlayerAt, gameTime } = require('./rosters');

const ROUNDS = ['Wildcard', 'Divisional', 'Conference', 'Superbowl'];
const r2 = n => Math.round(n * 100) / 100;

// Live standings for a league, computed straight from game scores + injury-swap chains
// (so it never depends on cached totals). Returns { rounds, members } sorted by total.
async function computeLeagueStandings(leagueId) {
  const { data: lg } = await supabase.from('leagues').select('season').eq('id', leagueId).single();
  // A team is out once it loses a finished playoff game (the round of that loss is recorded)
  const elim = new Map();
  if (lg) {
    const { data: games } = await supabase.from('games')
      .select('home_team_id, away_team_id, home_score, away_score, status, playoff_round, game_date')
      .eq('season', lg.season).in('status', ['FT', 'OT', 'AOT']).order('game_date');
    for (const g of games || []) {
      if (g.home_score == null || g.away_score == null || g.home_score === g.away_score) continue;
      elim.set(g.home_score < g.away_score ? g.home_team_id : g.away_team_id, g.playoff_round);
    }
  }

  const [membersRes, picksRes, swapsRes] = await Promise.all([
    supabase.from('league_members').select('id, display_name, user_id').eq('league_id', leagueId),
    supabase.from('draft_picks').select('member_id, pick_number, player_id').eq('league_id', leagueId).order('pick_number'),
    supabase.from('roster_swaps')
      .select('member_id, out_player_id, in_player_id, effective_game:games!effective_game_id(kickoff_time, game_date)')
      .eq('league_id', leagueId),
  ]);
  if (membersRes.error) throw new Error(membersRes.error.message);

  const picks = picksRes.data || [];
  const swaps = swapsRes.data || [];
  const chainsByPick = picks.map(pick => ({
    pick,
    chain: buildChain(pick.player_id, swaps.filter(s => s.member_id === pick.member_id)),
  }));
  const ids = [...new Set(chainsByPick.flatMap(c => c.chain.map(e => e.playerId)))];

  let playerById = new Map();
  const scoresByPlayer = new Map();
  if (ids.length) {
    const [playersRes, scoresRes] = await Promise.all([
      supabase.from('players')
        .select('id, name, position, injury_status, nfl_teams(id, abbr, primary_color, is_eliminated, eliminated_round)')
        .in('id', ids),
      supabase.from('game_player_scores')
        .select('player_id, points, games!inner(playoff_round, game_date, kickoff_time)')
        .in('player_id', ids),
    ]);
    if (playersRes.error) throw new Error(playersRes.error.message);
    playerById = new Map(playersRes.data.map(p => [p.id, p]));
    for (const s of scoresRes.data || []) {
      if (!scoresByPlayer.has(s.player_id)) scoresByPlayer.set(s.player_id, []);
      scoresByPlayer.get(s.player_id).push(s);
    }
  }

  const slotsByMember = new Map();
  for (const { pick, chain } of chainsByPick) {
    const scores = {};
    const segments = chain.map(entry => {
      let total = 0;
      for (const s of scoresByPlayer.get(entry.playerId) || []) {
        if (activePlayerAt(chain, gameTime(s.games)) !== entry.playerId) continue;
        const round = s.games.playoff_round;
        scores[round] = (scores[round] || 0) + (s.points || 0);
        total += s.points || 0;
      }
      return { player: playerById.get(entry.playerId), total };
    });
    const p = segments[segments.length - 1].player;
    if (!p) continue;
    const slot = {
      pick_number: pick.pick_number,
      name: p.name,
      position: p.position,
      team: p.nfl_teams?.abbr || null,
      color: p.nfl_teams?.primary_color || null,
      eliminatedRound: elim.get(p.nfl_teams?.id) || (p.nfl_teams?.is_eliminated ? (p.nfl_teams.eliminated_round || 'Out') : null),
      eliminated: elim.has(p.nfl_teams?.id) || !!p.nfl_teams?.is_eliminated,
      out: p.injury_status === 'out',
      scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, r2(v)])),
      total: r2(Object.values(scores).reduce((a, b) => a + b, 0)),
      replaced: segments.slice(0, -1).map(s => ({ name: s.player?.name, total: r2(s.total) })),
    };
    if (!slotsByMember.has(pick.member_id)) slotsByMember.set(pick.member_id, []);
    slotsByMember.get(pick.member_id).push(slot);
  }

  const members = membersRes.data.map(m => {
    const roster = slotsByMember.get(m.id) || [];
    const byRound = {};
    for (const r of ROUNDS) byRound[r] = r2(roster.reduce((a, s) => a + (s.scores[r] || 0), 0));
    const total = r2(ROUNDS.reduce((a, r) => a + byRound[r], 0));
    const best = roster.reduce((b, s) => (!b || s.total > b.total ? s : b), null);
    return {
      id: m.id, user_id: m.user_id, display_name: m.display_name,
      byRound, total, roster,
      alive: roster.filter(s => !s.eliminated).length,
      bestPlayer: best && best.total > 0 ? { name: best.name, total: best.total } : null,
    };
  });

  members.sort((a, b) => b.total - a.total || a.display_name.localeCompare(b.display_name));

  // Competition ranking (ties share a rank), overall and within each round
  members.forEach((m, i) => { m.rank = i > 0 && members[i - 1].total === m.total ? members[i - 1].rank : i + 1; });
  const leader = members[0]?.total || 0;
  members.forEach(m => { m.behind = r2(leader - m.total); m.roundRank = {}; });
  for (const r of ROUNDS) {
    const sorted = [...members].sort((a, b) => b.byRound[r] - a.byRound[r]);
    sorted.forEach((m, i) => {
      m.roundRank[r] = i > 0 && sorted[i - 1].byRound[r] === m.byRound[r] ? sorted[i - 1].roundRank[r] : i + 1;
    });
  }

  // Rounds that have any points on the board
  const started = ROUNDS.filter(r => members.some(m => m.byRound[r] !== 0));
  return { rounds: ROUNDS, started, members };
}

module.exports = { computeLeagueStandings, ROUNDS };
