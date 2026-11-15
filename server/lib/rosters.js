const supabase = require('./supabase');

// Game start as epoch ms. Games without a kickoff time count from the start of their date (UTC).
function gameTime(g) {
  const t = Date.parse(g?.kickoff_time || g?.game_date);
  return Number.isNaN(t) ? 0 : t;
}

// One drafted slot plus its replacements, oldest first: [{ playerId, from }].
// `from` is when that player became active (the kickoff of the game the swap was made before).
function buildChain(pickPlayerId, swaps) {
  const chain = [{ playerId: pickPlayerId, from: -Infinity }];
  let current = pickPlayerId;
  for (;;) {
    const swap = swaps.find(s => s.out_player_id === current);
    if (!swap) break;
    chain.push({ playerId: swap.in_player_id, from: gameTime(swap.effective_game) });
    current = swap.in_player_id;
  }
  return chain;
}

// Which player in the chain owns the points of a game played at time t
function activePlayerAt(chain, t) {
  let active = chain[0];
  for (const entry of chain) if (entry.from <= t) active = entry;
  return active.playerId;
}

// The team's next game that has not kicked off yet, or null
async function findNextGame(teamId) {
  const { data } = await supabase
    .from('games')
    .select('id, playoff_round, game_date, kickoff_time, status')
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .eq('status', 'NS');
  const now = Date.now();
  return (data || [])
    .filter(g => gameTime(g) > now)
    .sort((a, b) => gameTime(a) - gameTime(b))[0] || null;
}

module.exports = { gameTime, buildChain, activePlayerAt, findNextGame };
