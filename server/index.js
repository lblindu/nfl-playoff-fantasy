require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { startScoringJob } = require('./jobs/scoring');
const { startDraftClock } = require('./lib/draftEngine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Auth middleware: verify Supabase JWT on every request ──
const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.use(async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return next(); // unauthenticated — public routes still work

  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return next();

  req.userId = user.id;
  req.userEmail = user.email;

  // Check admin
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  req.isAdmin = adminEmails.includes(user.email?.toLowerCase());

  next();
});

// ── API routes ──
app.use('/api/leagues', require('./routes/leagues'));
app.use('/api/draft', require('./routes/draft'));
app.use('/api/players', require('./routes/players'));
app.use('/api/scores', require('./routes/scores'));
app.use('/api/live', require('./routes/live'));
app.use('/api/home', require('./routes/home'));

// ── Public config (anon key is safe to expose) ──
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl:  process.env.SUPABASE_URL,
    supabaseAnon: process.env.SUPABASE_ANON_KEY,
  });
});

// ── Auth: get current user info ──
app.get('/api/me', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: req.userId, email: req.userEmail, isAdmin: req.isAdmin });
});

// ── SPA fallback — serve index.html for all non-API routes ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`🏈 Playoff Fantasy server running on port ${PORT}`);
  startScoringJob();
  startDraftClock();
});
