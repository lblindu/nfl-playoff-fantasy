const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /api/leagues — list all leagues (authenticated user sees theirs + public ones)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('leagues')
    .select(`
      id, name, season, status, draft_started_at,
      league_members(count)
    `)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/leagues/:id — full league detail
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('leagues')
    .select(`
      *,
      league_members(
        id, display_name, draft_order, total_score,
        user_id,
        member_round_scores(playoff_round, points)
      )
    `)
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'League not found' });

  // Sort members by total score descending
  if (data.league_members) {
    data.league_members.sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
  }

  res.json(data);
});

// POST /api/leagues — create league (admin only)
router.post('/', requireAdmin, async (req, res) => {
  const { name, season } = req.body;
  if (!name || !season) return res.status(400).json({ error: 'name and season required' });

  const { data, error } = await supabase
    .from('leagues')
    .insert({ name, season: parseInt(season), created_by: req.userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/leagues/:id — update status etc (admin only)
router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['name', 'status'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

  const { data, error } = await supabase
    .from('leagues')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/leagues/:id/members — add member (admin only)
router.post('/:id/members', requireAdmin, async (req, res) => {
  const { email, display_name } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  // Find user by email
  const { data: user } = await supabase
    .from('users')
    .select('id, display_name')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (!user) return res.status(404).json({ error: 'No user with that email. They must sign in first.' });

  const { data, error } = await supabase
    .from('league_members')
    .insert({
      league_id: req.params.id,
      user_id: user.id,
      display_name: display_name || user.display_name || email.split('@')[0],
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/leagues/:id/members/:memberId (admin only)
router.delete('/:id/members/:memberId', requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from('league_members')
    .delete()
    .eq('id', req.params.memberId)
    .eq('league_id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/leagues/:id/set-draft-order (admin only)
router.post('/:id/set-draft-order', requireAdmin, async (req, res) => {
  const { order } = req.body; // array of member IDs in draft order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of member IDs' });

  const updates = order.map((memberId, i) =>
    supabase.from('league_members').update({ draft_order: i + 1 }).eq('id', memberId).eq('league_id', req.params.id)
  );
  await Promise.all(updates);
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = router;
