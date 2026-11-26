const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { computeLeagueStandings } = require('../lib/standings');
const { findNextGame, gameTime } = require('../lib/rosters');
const { memberOnClock, ROSTER_SIZE } = require('../lib/draftEngine');

// GET /api/home — everything the home page needs about the signed-in user's leagues
router.get('/', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const [memberOf, created] = await Promise.all([
    supabase.from('league_members').select('league_id').eq('user_id', req.userId),
    supabase.from('leagues').select('id').eq('created_by', req.userId),
  ]);
  const ids = [...new Set([...(memberOf.data || []).map(m => m.league_id), ...(created.data || []).map(l => l.id)])];

  const { data: leagues } = ids.length
    ? await supabase.from('leagues').select('id, name, season, status, created_by, invite_code, pick_seconds, pick_deadline').in('id', ids)
    : { data: [] };

  const actions = [];
  const out = [];

  for (const lg of leagues || []) {
    const base = { id: lg.id, name: lg.name, season: lg.season, status: lg.status, isCommissioner: lg.created_by === req.userId };

    const { data: members } = await supabase.from('league_members').select('id, user_id, display_name, draft_order').eq('league_id', lg.id);
    const me = (members || []).find(m => m.user_id === req.userId);
    base.memberCount = (members || []).length;
    base.playing = !!me;

    if (lg.status === 'setup') {
      out.push({ ...base, inviteCode: lg.invite_code });
      continue;
    }

    if (lg.status === 'drafting') {
      const { count } = await supabase.from('draft_picks').select('id', { count: 'exact', head: true }).eq('league_id', lg.id);
      const picksMade = count || 0;
      const total = base.memberCount * ROSTER_SIZE;
      const onClock = memberOnClock(members || [], picksMade);
      let upIn = null;
      if (me) {
        const n = members.length;
        const order = [...members].sort((a, b) => a.draft_order - b.draft_order);
        for (let k = picksMade; k < total; k++) {
          const idx = Math.floor(k / n) % 2 === 0 ? k % n : n - 1 - (k % n);
          if (order[idx]?.id === me.id) { upIn = k - picksMade; break; }
        }
      }
      const myTurn = !!me && onClock?.id === me.id;
      base.draft = { picksMade, total, upIn, myTurn, onClock: onClock?.display_name || null, clockRunning: !!lg.pick_deadline, pickSeconds: lg.pick_seconds };
      if (myTurn) actions.push({ type: 'pick', leagueId: lg.id, leagueName: lg.name });
      out.push(base);
      continue;
    }

    // active / complete: live standings summary
    try {
      const st = await computeLeagueStandings(lg.id);
      const mine = st.members.find(m => m.user_id === req.userId);
      const leader = st.members[0];
      base.size = st.members.length;
      base.leaderName = leader?.display_name;
      base.leaderTotal = leader?.total ?? 0;
      base.top = st.members.slice(0, 3).map(m => ({ name: m.display_name, total: m.total, rank: m.rank, isMe: m.user_id === req.userId }));
      base.started = st.started;
      if (mine) {
        base.me = {
          rank: mine.rank, total: mine.total, behind: mine.behind, alive: mine.alive, rosterSize: mine.roster.length,
          byRound: mine.byRound, roundRank: mine.roundRank, bestPlayer: mine.bestPlayer,
        };
        // A player ruled out before his team's next game can still be swapped until kickoff
        for (const slot of mine.roster.filter(s => s.out && !s.eliminated && s.teamId)) {
          const next = await findNextGame(slot.teamId);
          if (next) actions.push({ type: 'swap', leagueId: lg.id, leagueName: lg.name, player: slot.name, team: slot.team, kickoff: new Date(gameTime(next)).toISOString() });
        }
      }
    } catch (e) {
      console.error('[home] standings failed for', lg.id, e.message);
    }
    out.push(base);
  }

  // Next playoff kickoff, for the header line
  const { data: ng } = await supabase.from('games').select('playoff_round, game_date, kickoff_time').eq('status', 'NS');
  const nextG = (ng || []).filter(g => gameTime(g) > Date.now()).sort((a, b) => gameTime(a) - gameTime(b))[0];

  res.json({
    leagues: out,
    actions,
    next: nextG ? { round: nextG.playoff_round, kickoff: new Date(gameTime(nextG)).toISOString() } : null,
    serverTime: new Date().toISOString(),
  });
});

module.exports = router;
