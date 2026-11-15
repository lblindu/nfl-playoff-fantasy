const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { leagueAccess } = require('../lib/access');
const { attemptPick, memberOnClock, deadlineFrom } = require('../lib/draftEngine');

// GET /api/draft/:leagueId — full draft state
router.get('/:leagueId', async (req, res) => {
  const { leagueId } = req.params;

  const access = await leagueAccess(req, leagueId);
  if (!access.league) return res.status(404).json({ error: 'League not found' });
  if (!access.canView) return res.status(403).json({ error: 'You are not in this league' });

  const [leagueRes, picksRes, membersRes] = await Promise.all([
    supabase.from('leagues').select('id,name,season,status,created_by,pick_seconds,pick_deadline').eq('id', leagueId).single(),
    supabase.from('draft_picks').select(`
      id, pick_number, round, picked_at, auto_picked,
      member_id,
      players(id, name, position, jersey_number, nfl_team_id, nfl_teams(id, name, abbr, primary_color))
    `).eq('league_id', leagueId).order('pick_number'),
    supabase.from('league_members').select('id, display_name, draft_order, user_id').eq('league_id', leagueId).order('draft_order'),
  ]);

  if (leagueRes.error) return res.status(404).json({ error: 'League not found' });

  const league = leagueRes.data;
  const picks = picksRes.data || [];
  const members = membersRes.data || [];
  const numTeams = members.length;

  // Calculate who's on the clock
  const pickNum = picks.length; // 0-indexed next pick
  const totalPicks = numTeams * 14; // 14 rounds (1 per NFL team)
  const isDone = pickNum >= totalPicks;

  let onTheClock = null;
  if (!isDone && numTeams > 0) {
    const round = Math.floor(pickNum / numTeams);
    const slot = pickNum % numTeams;
    const teamIdx = round % 2 === 0 ? slot : numTeams - 1 - slot;
    const sortedMembers = [...members].sort((a, b) => a.draft_order - b.draft_order);
    onTheClock = sortedMembers[teamIdx] || null;
  }

  res.json({ league, picks, members, onTheClock, isDone, totalPicks, serverNow: new Date().toISOString() });
});

// POST /api/draft/:leagueId/pick — make a pick
router.post('/:leagueId/pick', async (req, res) => {
  const { leagueId } = req.params;
  const { playerId, memberId } = req.body;

  if (!playerId || !memberId) return res.status(400).json({ error: 'playerId and memberId required' });
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const access = await leagueAccess(req, leagueId);
  if (!access.league) return res.status(404).json({ error: 'League not found' });

  const [{ data: members }, { count }, { data: league }] = await Promise.all([
    supabase.from('league_members').select('id, draft_order, user_id').eq('league_id', leagueId),
    supabase.from('draft_picks').select('id', { count: 'exact', head: true }).eq('league_id', leagueId),
    supabase.from('leagues').select('status, pick_deadline').eq('id', leagueId).single(),
  ]);

  const expected = memberOnClock(members || [], count || 0);
  if (!expected || expected.id !== memberId) return res.status(403).json({ error: 'Not your turn' });
  // The commissioner (or an admin) may pick for whoever is on the clock, e.g. a no-show
  if (!access.canManage && expected.user_id !== req.userId) return res.status(403).json({ error: 'Not your turn' });
  // Everyone else waits for the commissioner to start the clock (and can't pick while it is paused)
  if (!access.canManage && !league?.pick_deadline) {
    return res.status(403).json({ error: 'The draft clock is not running - wait for the commissioner to start it' });
  }

  const r = await attemptPick({ leagueId, memberId, playerId });
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(r.pick);
});

// POST /api/draft/:leagueId/clock — commissioner starts or pauses the pick clock
router.post('/:leagueId/clock', async (req, res) => {
  const access = await leagueAccess(req, req.params.leagueId);
  if (!access.league) return res.status(404).json({ error: 'League not found' });
  if (!access.canManage) return res.status(403).json({ error: 'Only the commissioner can control the clock' });
  if (access.league.status !== 'drafting') return res.status(400).json({ error: 'The league is not drafting' });

  const action = req.body.action;
  if (!['start', 'pause'].includes(action)) return res.status(400).json({ error: 'action must be start or pause' });
  const { data: league } = await supabase.from('leagues').select('pick_seconds').eq('id', req.params.leagueId).single();
  const pick_deadline = action === 'start' ? deadlineFrom(league.pick_seconds || 60) : null;
  const { error } = await supabase.from('leagues').update({ pick_deadline }).eq('id', req.params.leagueId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, pick_deadline });
});

// DELETE /api/draft/:leagueId/undo — undo last pick (commissioner or admin)
router.delete('/:leagueId/undo', async (req, res) => {
  const access = await leagueAccess(req, req.params.leagueId);
  if (!access.canManage) return res.status(403).json({ error: 'Only the commissioner can undo picks' });

  const { data: last } = await supabase
    .from('draft_picks')
    .select('id')
    .eq('league_id', req.params.leagueId)
    .order('pick_number', { ascending: false })
    .limit(1)
    .single();

  if (!last) return res.status(404).json({ error: 'No picks to undo' });

  const { error } = await supabase.from('draft_picks').delete().eq('id', last.id);
  if (error) return res.status(500).json({ error: error.message });
  // Give the restored pick a fresh full clock (only if the clock was running)
  const { data: lg } = await supabase.from('leagues').select('pick_seconds').eq('id', req.params.leagueId).single();
  await supabase.from('leagues')
    .update({ status: 'drafting', pick_deadline: deadlineFrom(lg?.pick_seconds || 60) })
    .eq('id', req.params.leagueId).not('pick_deadline', 'is', null);
  res.json({ ok: true });
});

// DELETE /api/draft/:leagueId/reset — wipe all picks (commissioner or admin)
router.delete('/:leagueId/reset', async (req, res) => {
  const access = await leagueAccess(req, req.params.leagueId);
  if (!access.canManage) return res.status(403).json({ error: 'Only the commissioner can reset the draft' });
  const { error } = await supabase.from('draft_picks').delete().eq('league_id', req.params.leagueId);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('leagues').update({ status: 'drafting', pick_deadline: null }).eq('id', req.params.leagueId);
  res.json({ ok: true });
});

module.exports = router;
