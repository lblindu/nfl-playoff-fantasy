/* ============================================================
   NFL Playoff Fantasy — Draft Room
   Real-time snake draft via Supabase Realtime
   ============================================================ */

import { getSupabase, api, getSession, getMe, isAdmin, toast, navigate, fmt } from './app.js';

let leagueId = null;
let draftState = null;
let channel = null;
let playerList = [];
let filterPos = 'ALL';
let filterTeam = '';
let filterSearch = '';

// ── Entry point ──
export async function initDraft(params) {
  leagueId = params.leagueId;
  document.getElementById('app').innerHTML = renderShell();
  await loadDraft();
  subscribeRealtime();
  bindEvents();
}

// ── Load draft state ──
async function loadDraft() {
  try {
    draftState = await api('GET', `/draft/${leagueId}`);
    const [season] = [draftState.league.season];
    playerList = await api('GET', `/players?season=${season}&leagueId=${leagueId}`);
    renderAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Supabase Realtime ──
function subscribeRealtime() {
  if (channel) channel.unsubscribe();

  channel = getSupabase()
    .channel(`draft:${leagueId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'draft_picks',
      filter: `league_id=eq.${leagueId}`,
    }, async () => {
      await loadDraft();
    })
    .subscribe();
}

// ── Make a pick ──
async function makePick(playerId) {
  const me = getMe();
  const myMemberId = draftState.members.find(m => m.user_id === me?.id)?.id;
  if (!myMemberId) return;
  if (draftState.onTheClock?.id !== myMemberId && !isAdmin()) {
    toast('Not your turn', 'error');
    return;
  }

  const memberId = isAdmin() && draftState.onTheClock
    ? draftState.onTheClock.id
    : myMemberId;

  try {
    await api('POST', `/draft/${leagueId}/pick`, { playerId, memberId });
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Undo last pick (admin) ──
async function undoPick() {
  if (!confirm('Undo the last pick?')) return;
  try {
    await api('DELETE', `/draft/${leagueId}/undo`);
    toast('Pick undone');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Render ──
function renderShell() {
  return `
    <nav class="navbar">
      <a class="navbar-brand" href="/" data-link>
        <div class="navbar-logo">🏈</div>
        <span class="navbar-title">Playoff <span>Fantasy</span></span>
      </a>
      <div class="navbar-right">
        <span id="draft-status-pill"></span>
        <span class="nav-link" id="nav-user"></span>
        <button class="btn btn-ghost btn-sm" onclick="app.signOut()">Sign out</button>
      </div>
    </nav>

    <div style="display:grid;grid-template-columns:1fr 340px;height:calc(100vh - 56px);overflow:hidden;" id="draft-layout">
      <!-- Left: players + pick board -->
      <div style="display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--border);">
        <!-- Clock + filter bar -->
        <div style="padding:1rem 1.25rem;border-bottom:1px solid var(--border);flex-shrink:0;">
          <div id="on-clock-banner"></div>
          <div class="flex items-center gap-2 mt-2" style="flex-wrap:wrap;">
            <input type="text" id="search-player" placeholder="Search players…" style="max-width:200px;height:32px;" />
            <div class="flex gap-1" id="pos-filters"></div>
            <select id="team-filter" style="height:32px;width:auto;">
              <option value="">All teams</option>
            </select>
            ${isAdmin() ? `<button class="btn btn-danger btn-sm" id="undo-btn">↩ Undo pick</button>` : ''}
          </div>
        </div>
        <!-- Player list -->
        <div id="player-list" style="overflow-y:auto;flex:1;padding:0.75rem;"></div>
      </div>

      <!-- Right: draft board -->
      <div style="overflow-y:auto;padding:1rem;">
        <h3 class="mb-2">Draft Board</h3>
        <div id="draft-board"></div>
      </div>
    </div>
  `;
}

function renderAll() {
  renderClock();
  renderPlayerList();
  renderDraftBoard();
  renderPosFilters();
  renderTeamFilter();
  updateStatusPill();
}

function renderClock() {
  const el = document.getElementById('on-clock-banner');
  if (!el) return;
  const { onTheClock, isDone, picks, totalPicks } = draftState;
  const me = getMe();
  const myMember = draftState.members.find(m => m.user_id === me?.id);
  const pickNum = picks.length + 1;

  if (isDone) {
    el.innerHTML = `<div class="flex items-center gap-2"><span class="pill pill-complete">Draft Complete</span><span style="color:var(--text-2);font-size:13px;">${picks.length}/${totalPicks} picks made</span></div>`;
    return;
  }

  const isMyTurn = onTheClock && myMember && onTheClock.id === myMember.id;
  const name = onTheClock?.display_name || '?';
  const round = Math.ceil(pickNum / draftState.members.length);

  el.innerHTML = `
    <div class="flex items-center gap-2" style="flex-wrap:wrap;">
      <span class="pill pill-live"><span class="pill-dot pulse"></span>Pick ${pickNum} · Round ${round}</span>
      <span style="font-size:14px;font-weight:600;color:${isMyTurn ? 'var(--gold)' : 'var(--text)'}">
        ${isMyTurn ? '⭐ Your pick!' : `On the clock: ${name}`}
      </span>
      <span style="font-size:12px;color:var(--text-3)">${picks.length}/${totalPicks}</span>
    </div>
  `;
}

function renderPosFilters() {
  const el = document.getElementById('pos-filters');
  if (!el) return;
  const positions = ['ALL', 'QB', 'RB', 'WR', 'TE'];
  el.innerHTML = positions.map(p => `
    <button class="btn btn-sm ${filterPos === p ? 'btn-primary' : 'btn-ghost'}" data-pos="${p}">${p}</button>
  `).join('');
}

function renderTeamFilter() {
  const el = document.getElementById('team-filter');
  if (!el) return;
  const teams = [...new Map(playerList.map(p => [p.nfl_teams?.id, p.nfl_teams])).values()].filter(Boolean);
  teams.sort((a, b) => a.abbr.localeCompare(b.abbr));
  el.innerHTML = `<option value="">All teams</option>` +
    teams.map(t => `<option value="${t.id}">${t.abbr}</option>`).join('');
  if (filterTeam) el.value = filterTeam;
}

function renderPlayerList() {
  const el = document.getElementById('player-list');
  if (!el) return;

  const me = getMe();
  const myMember = draftState.members.find(m => m.user_id === me?.id);
  const isMyTurn = draftState.onTheClock && myMember && draftState.onTheClock.id === myMember.id;
  const canPick = (isMyTurn || isAdmin()) && !draftState.isDone;

  // Count QBs already on my roster
  let myQbCount = 0;
  if (myMember) {
    const myPicks = draftState.picks.filter(p => p.member_id === myMember.id);
    myQbCount = myPicks.filter(p => p.players?.position === 'QB').length;
  }

  let filtered = playerList.filter(p => !p.drafted);
  if (filterPos !== 'ALL') filtered = filtered.filter(p => p.position === filterPos);
  if (filterTeam) filtered = filtered.filter(p => p.nfl_teams?.id === filterTeam);
  if (filterSearch) {
    const q = filterSearch.toLowerCase();
    filtered = filtered.filter(p => p.name.toLowerCase().includes(q));
  }

  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">🔍</div><p>No players match your filter</p></div>`;
    return;
  }

  el.innerHTML = filtered.map(p => {
    const team = p.nfl_teams;
    const isQbLimit = p.position === 'QB' && myQbCount >= 2;
    const disabled = !canPick || isQbLimit;
    const color = team?.primary_color || '#555';
    return `
      <div class="draft-pick" style="margin-bottom:6px;">
        <div style="width:4px;height:40px;background:${color};border-radius:2px;flex-shrink:0;"></div>
        <div class="player-avatar player-avatar-sm">${p.name[0]}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name}</div>
          <div class="flex items-center gap-1" style="margin-top:2px;">
            <span class="${posClass(p.position)}">${p.position}</span>
            ${team ? `<span style="font-size:11px;color:var(--text-3);">${team.abbr}</span>` : ''}
            ${team?.is_eliminated ? '<span style="font-size:10px;color:var(--red);">ELIM</span>' : ''}
          </div>
        </div>
        ${canPick ? `<button class="btn btn-sm btn-primary" ${disabled ? 'disabled' : ''} data-pick="${p.id}" title="${isQbLimit ? 'QB limit reached (2 max)' : ''}">
          ${isQbLimit ? 'QB max' : 'Draft'}
        </button>` : ''}
      </div>
    `;
  }).join('');
}

function renderDraftBoard() {
  const el = document.getElementById('draft-board');
  if (!el) return;
  const { picks, members, totalPicks } = draftState;
  if (!members.length) { el.innerHTML = '<p style="color:var(--text-3);font-size:13px;">No members yet</p>'; return; }

  const sortedMembers = [...members].sort((a, b) => a.draft_order - b.draft_order);
  const numTeams = sortedMembers.length;
  const picksByNum = new Map(picks.map(p => [p.pick_number, p]));

  el.innerHTML = sortedMembers.map(m => {
    const myPicks = picks.filter(p => p.member_id === m.id).sort((a, b) => a.pick_number - b.pick_number);
    const me = getMe();
    const isMe = m.user_id === me?.id;
    return `
      <div style="margin-bottom:1rem;">
        <div class="flex items-center gap-2 mb-1">
          <span style="font-size:12px;font-weight:600;color:${isMe ? 'var(--gold)' : 'var(--text)'}">${m.display_name}${isMe ? ' (you)' : ''}</span>
          <span style="font-size:11px;color:var(--text-3);">${myPicks.length}/14</span>
        </div>
        ${myPicks.map(p => {
          const player = p.players;
          const team = player?.nfl_teams;
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--bg-raised);border-radius:var(--radius-sm);margin-bottom:4px;border:1px solid var(--border);">
              <span style="font-size:10px;color:var(--text-3);font-family:var(--font-mono);min-width:24px;">#${p.pick_number}</span>
              ${team ? `<span style="font-size:10px;font-weight:600;color:var(--text-2);">${team.abbr}</span>` : ''}
              <span class="pos pos-${player?.position}" style="font-size:9px;">${player?.position}</span>
              <span style="font-size:12px;color:var(--text);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${player?.name}</span>
            </div>
          `;
        }).join('')}
        ${myPicks.length < 14 && draftState.onTheClock?.id === m.id
          ? `<div style="padding:5px 8px;border:1px dashed var(--gold-border);border-radius:var(--radius-sm);font-size:11px;color:var(--gold);">On the clock…</div>`
          : ''}
      </div>
    `;
  }).join('');
}

function updateStatusPill() {
  const el = document.getElementById('draft-status-pill');
  if (!el) return;
  const { isDone } = draftState;
  el.innerHTML = isDone
    ? '<span class="pill pill-complete">Complete</span>'
    : '<span class="pill pill-live"><span class="pill-dot pulse"></span>Live Draft</span>';
}

function posClass(pos) {
  return `pos pos-${pos}`;
}

// ── Event wiring ──
function bindEvents() {
  const app = document.getElementById('app');

  app.addEventListener('click', e => {
    // Pick button
    const pickBtn = e.target.closest('[data-pick]');
    if (pickBtn && !pickBtn.disabled) {
      makePick(pickBtn.dataset.pick);
      return;
    }
    // Pos filter
    const posBtn = e.target.closest('[data-pos]');
    if (posBtn) {
      filterPos = posBtn.dataset.pos;
      renderPlayerList();
      renderPosFilters();
      return;
    }
    // Undo
    if (e.target.id === 'undo-btn') {
      undoPick();
      return;
    }
  });

  app.addEventListener('input', e => {
    if (e.target.id === 'search-player') {
      filterSearch = e.target.value.trim();
      renderPlayerList();
    }
    if (e.target.id === 'team-filter') {
      filterTeam = e.target.value;
      renderPlayerList();
    }
  });
}

// Cleanup on navigation away
export function destroyDraft() {
  if (channel) { channel.unsubscribe(); channel = null; }
}
