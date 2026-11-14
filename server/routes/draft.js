const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /api/draft/:leagueId — full draft state
router.get('/:leagueId', async (req, res) => {
  const { leagueId } = req.params;

  const [leagueRes, picksRes, membersRes] = await Promise.all([
    supabase.from('leagues').select('id,name,season,status').eq('id', leagueId).single(),
    supabase.from('draft_picks').select(`
      id, pick_number, round, picked_at,
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

  res.json({ league, picks, members, onTheClock, isDone, totalPicks });
});

// POST /api/draft/:leagueId/pick — make a pick
router.post('/:leagueId/pick', async (req, res) => {
  const { leagueId } = req.params;
  const { playerId, memberId } = req.body;

  if (!playerId || !memberId) return res.status(400).json({ error: 'playerId and memberId required' });

  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  // Validate it's this member's turn
  const { data: picks } = await supabase
    .from('draft_picks')
    .select('id')
    .eq('league_id', leagueId);

  const { data: members } = await supabase
    .from('league_members')
    .select('id, draft_order, user_id')
    .eq('league_id', leagueId)
    .order('draft_order');

  const numTeams = members?.length || 0;
  const pickNum = picks?.length || 0;
  const round = Math.floor(pickNum / numTeams);
  const slot = pickNum % numTeams;
  const teamIdx = round % 2 === 0 ? slot : numTeams - 1 - slot;
  const expectedMember = members[teamIdx];

  if (!expectedMember || expectedMember.id !== memberId) {
    return res.status(403).json({ error: 'Not your turn' });
  }
  if (!req.isAdmin && expectedMember.user_id !== req.userId) {
    return res.status(403).json({ error: 'Not your turn' });
  }

  // Check player not already drafted
  const { data: existing } = await supabase
    .from('draft_picks')
    .select('id')
    .eq('league_id', leagueId)
    .eq('player_id', playerId)
    .single();

  if (existing) return res.status(409).json({ error: 'Player already drafted' });

  // Check QB rule (max 2 QBs per team)
  const { data: player } = await supabase
    .from('players')
    .select('id, position, nfl_team_id')
    .eq('id', playerId)
    .single();
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: memberPicks } = await supabase
    .from('draft_picks')
    .select('players(position, nfl_team_id)')
    .eq('league_id', leagueId)
    .eq('member_id', memberId);

  // One player per NFL team on each roster
  if ((memberPicks || []).some(p => p.players?.nfl_team_id === player.nfl_team_id)) {
    return res.status(400).json({ error: 'You already drafted a player from that team' });
  }

  if (player.position === 'QB') {
    const qbCount = (memberPicks || []).filter(p => p.players?.position === 'QB').length;
    if (qbCount >= 2) return res.status(400).json({ error: 'Maximum 2 QBs per roster' });
  }

  // Insert pick
  const { data: pick, error } = await supabase
    .from('draft_picks')
    .insert({
      league_id: leagueId,
      member_id: memberId,
      player_id: playerId,
      pick_number: pickNum + 1,
      round: round + 1,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // If draft is complete, update league status
  if (pickNum + 1 >= numTeams * 14) {
    await supabase.from('leagues').update({ status: 'active' }).eq('id', leagueId);
  }

  res.json(pick);
});

// DELETE /api/draft/:leagueId/undo — undo last pick (admin only)
router.delete('/:leagueId/undo', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });

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
  res.json({ ok: true });
});

// DELETE /api/draft/:leagueId/reset — wipe all picks (admin only)
router.delete('/:leagueId/reset', async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { error } = await supabase.from('draft_picks').delete().eq('league_id', req.params.leagueId);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('leagues').update({ status: 'drafting' }).eq('id', req.params.leagueId);
  res.json({ ok: true });
});

module.exports = router;
