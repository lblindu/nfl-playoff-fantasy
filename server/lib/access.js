const supabase = require('./supabase');

// Who is this request's user in a league?
// Commissioner = the user who created it. Site admins can manage every league.
async function leagueAccess(req, leagueId) {
  const { data: league } = await supabase
    .from('leagues')
    .select('id, created_by, status, season')
    .eq('id', leagueId)
    .maybeSingle();
  if (!league) return { league: null };

  let isMember = false;
  if (req.userId) {
    const { data } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', leagueId)
      .eq('user_id', req.userId)
      .maybeSingle();
    isMember = !!data;
  }

  const isCommissioner = !!req.userId && league.created_by === req.userId;
  const canManage = req.isAdmin === true || isCommissioner;
  return { league, isMember, isCommissioner, canManage, canView: canManage || isMember };
}

module.exports = { leagueAccess };
