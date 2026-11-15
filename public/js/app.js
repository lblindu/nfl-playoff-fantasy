/* ============================================================
   NFL Playoff Fantasy — App Core
   Auth, routing, shared utilities
   ============================================================ */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { applyTheme } from './theme.js';

// ── Config — fetched from server at boot ──
let _supabase = null;

async function getConfig() {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  return {
    url:  cfg.supabaseUrl  || window.APP_SUPABASE_URL  || '',
    anon: cfg.supabaseAnon || window.APP_SUPABASE_ANON || '',
  };
}

// Lazy accessor — initialized in init()
export function getSupabase() { return _supabase; }
// Alias used throughout
export let supabase = null;

// ── Auth state ──
let _session = null;
let _me = null;

export function getSession() { return _session; }
export function getMe()      { return _me; }

// Loads /api/me; keeps the previous value if a refresh fails, and logs the reason
export async function loadMe() {
  try {
    _me = await api('GET', '/me');
  } catch (e) {
    console.error('[auth] /api/me failed:', e.message);
  }
  return _me;
}
export function isAdmin()    { return _me?.isAdmin === true; }

// ── API helper ──
export async function api(method, path, body) {
  const token = _session?.access_token;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Toast notifications ──
const toastContainer = document.getElementById('toasts');

export function toast(msg, type = '') {
  if (!toastContainer) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── SPA Router ──
const routes = {};

export function route(pattern, handler) {
  routes[pattern] = handler;
}

function matchRoute(path) {
  for (const [pattern, handler] of Object.entries(routes)) {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'
    );
    const m = path.match(re);
    if (m) {
      const params = {};
      keys.forEach((k, i) => params[k] = m[i + 1]);
      return { handler, params };
    }
  }
  return null;
}

export function navigate(path) {
  history.pushState({}, '', path);
  render(path);
}

async function render(path) {
  const matched = matchRoute(path);
  if (!matched) {
    navigate('/');
    return;
  }
  await matched.handler(matched.params);
}

window.addEventListener('popstate', () => render(location.pathname));

// Intercept in-app links
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

// ── Init ──
export async function init() {
  const cfg = await getConfig();
  _supabase = createClient(cfg.url, cfg.anon);
  // Re-export so callers that imported `supabase` get the real instance
  // (modules that import this file get the live binding after init() resolves)
  supabase = _supabase;

  const { data: { session } } = await supabase.auth.getSession();
  _session = session;
  applyTheme(session?.user?.user_metadata?.theme);

  _supabase.auth.onAuthStateChange(async (event, s) => {
    _session = s;
    applyTheme(s?.user?.user_metadata?.theme);
    if (s) {
      await loadMe();
      updateNavbar();
      if (location.pathname === '/login') navigate('/');
    } else {
      _me = null; // signed out
      updateNavbar();
      // Invite links are viewable signed-out; they ask you to sign in when you press Join
      if (location.pathname !== '/login' && !location.pathname.startsWith('/join/')) navigate('/login');
    }
  });

  if (session) {
    await loadMe();
  }

  updateNavbar();
  render(location.pathname);
}

function updateNavbar() {
  const userEl = document.getElementById('nav-user');
  const adminEl = document.getElementById('nav-admin-link');
  if (!userEl) return;

  if (_me) {
    userEl.textContent = _me.email.split('@')[0];
    if (adminEl) adminEl.style.display = isAdmin() ? 'inline-flex' : 'none';
  } else {
    userEl.textContent = '';
    if (adminEl) adminEl.style.display = 'none';
  }
}

// ── Google Sign-In ──
export async function signInWithGoogle() {
  await _supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin },
  });
}

export async function signOut() {
  await _supabase.auth.signOut();
  navigate('/login');
}

// ── Shared render helpers ──
export function posClass(pos) {
  return `pos pos-${pos}`;
}

export function fmt(n, decimals = 1) {
  if (n == null) return '—';
  return Number(n).toFixed(decimals);
}

export function statusPill(status) {
  const map = {
    setup:    ['setup',    'Setup'],
    draft:    ['setup',    'Draft'],
    drafting: ['live',     'Drafting'],
    active:   ['active',   'Active'],
    complete: ['complete', 'Complete'],
  };
  const [cls, label] = map[status] || ['complete', status];
  return `<span class="pill pill-${cls}"><span class="pill-dot${cls === 'live' ? ' pulse' : ''}"></span>${label}</span>`;
}
