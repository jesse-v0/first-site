// ── Config ──
if (localStorage.getItem('theme') === 'light') document.body.classList.add('light');
document.getElementById('theme-toggle').addEventListener('click', () => {
  document.body.classList.toggle('light');
  localStorage.setItem('theme', document.body.classList.contains('light') ? 'light' : 'dark');
});
const CORRECT_PIN = '0511';
let SUPABASE_URL = null;

// ── Remote config (fetches Supabase credentials from Netlify function) ──
let _config = null;
async function getConfig() {
  if (_config) return _config;
  const res = await fetch('/.netlify/functions/config');
  _config = await res.json();
  SUPABASE_URL = _config.supabaseUrl;
  return _config;
}

async function getAnonKey() {
  const config = await getConfig();
  return config.supabaseAnonKey;
}

// ── PIN logic ──
let pinEntry = '';

const pinScreen = document.getElementById('pin-screen');
const app       = document.getElementById('app');
const pinError  = document.getElementById('pin-error');
const dots      = [0,1,2,3].map(i => document.getElementById('d' + i));

document.querySelectorAll('.key[data-val]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (pinEntry.length >= 4) return;
    pinEntry += btn.dataset.val;
    updateDots();
    if (pinEntry.length === 4) checkPin();
  });
});

document.getElementById('pin-del').addEventListener('click', () => {
  pinEntry = pinEntry.slice(0, -1);
  updateDots();
  pinError.classList.remove('visible');
});

function updateDots() {
  dots.forEach((d, i) => d.classList.toggle('filled', i < pinEntry.length));
}

function checkPin() {
  if (pinEntry === CORRECT_PIN) {
    pinScreen.style.display = 'none';
    app.classList.remove('hidden');
    loadThoughts();
  } else {
    pinError.classList.add('visible');
    document.querySelector('.pin-dots').classList.add('shake');
    setTimeout(() => {
      document.querySelector('.pin-dots').classList.remove('shake');
      pinEntry = '';
      updateDots();
    }, 400);
  }
}

// ── Supabase helpers ──
async function sbFetch(path, options = {}) {
  const anonKey = await getAnonKey();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': anonKey,
      'Authorization': `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || '',
      ...options.headers
    },
    ...options
  });
  return res;
}

async function loadThoughts() {
  try {
    const res = await sbFetch('thoughts?select=*&order=created_at.desc');
    const thoughts = await res.json();
    renderFeed(thoughts);
    updateCounter(thoughts.length);
    window._allThoughts = thoughts;
  } catch(e) {
    console.error('load error', e);
  }
}

async function saveThought(text) {
  const res = await sbFetch('thoughts', {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify({ thought: text })
  });
  const data = await res.json();
  return data[0];
}

// ── Render ──
function renderFeed(thoughts) {
  const feed = document.getElementById('thought-feed');
  if (!thoughts.length) {
    feed.innerHTML = '<div class="feed-empty">nothing yet. start dumping.</div>';
    return;
  }
  feed.innerHTML = thoughts.map(t => `
    <div class="thought-entry">
      <div class="thought-ts">${formatDate(t.created_at)}</div>
      <div class="thought-text">${escHtml(t.thought)}</div>
    </div>
  `).join('');
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + '\n' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updateCounter(n) {
  document.getElementById('flotsam-counter').textContent = `${n} thought${n !== 1 ? 's' : ''}`;
}

// ── Submit ──
const textarea  = document.getElementById('thought-input');
const charCount = document.getElementById('char-count');
const submitBtn = document.getElementById('submit-btn');

textarea.addEventListener('input', () => {
  const remaining = 280 - textarea.value.length;
  charCount.textContent = remaining;
  charCount.className = 'char-count' + (remaining <= 20 ? ' danger' : remaining <= 60 ? ' warning' : '');
});

textarea.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitThought();
  }
});

submitBtn.addEventListener('click', submitThought);

async function submitThought() {
  const text = textarea.value.trim();
  if (!text) return;

  submitBtn.textContent = '...';
  submitBtn.disabled = true;

  try {
    const saved = await saveThought(text);
    textarea.value = '';
    charCount.textContent = '280';
    charCount.className = 'char-count';
    window._allThoughts = [saved, ...(window._allThoughts || [])];
    renderFeed(window._allThoughts);
    updateCounter(window._allThoughts.length);
  } catch(e) {
    console.error('save error', e);
    alert('something went wrong saving that thought.');
  }

  submitBtn.textContent = 'deposit';
  submitBtn.disabled = false;
  textarea.focus();
}

// ── Claude ──
const claudeOutput  = document.getElementById('claude-output');
const synthesizeBtn = document.getElementById('synthesize-btn');
const queryInput    = document.getElementById('query-input');
const queryBtn      = document.getElementById('query-btn');

synthesizeBtn.addEventListener('click', () => runClaude('synthesize'));
queryBtn.addEventListener('click', () => runClaude('query'));
queryInput.addEventListener('keydown', e => { if (e.key === 'Enter') runClaude('query'); });

async function runClaude(mode) {
  const thoughts = window._allThoughts || [];
  if (!thoughts.length) {
    showClaudeOutput('no thoughts yet. deposit something first.');
    return;
  }

  const total    = thoughts.length;
  const batch    = thoughts.slice(0, 100);
  const overflow = total > 100 ? total - 100 : 0;

  let prompt = '';

  if (mode === 'synthesize') {
    prompt = `Here are ${batch.length} personal thought fragments, newest first, from someone's private thought-dump app. Each is a raw, unfiltered mental note — could be anything: desires, observations, memories, plans, feelings, random associations.\n\nYour job: synthesize what's on this person's mind. Identify recurring themes, emotional undercurrents, contradictions, or anything surprising. Be specific. Cite actual thoughts when relevant. Write in second person, conversationally. No bullet lists — flowing prose only. Keep it under 200 words.\n\nThoughts:\n${batch.map((t,i) => `${i+1}. ${t.thought}`).join('\n')}`;
  } else {
    const q = queryInput.value.trim();
    if (!q) return;
    prompt = `Here are ${batch.length} personal thought fragments from someone's private thought-dump app, newest first:\n\n${batch.map((t,i) => `${i+1}. [${formatDate(t.created_at)}] ${t.thought}`).join('\n')}\n\nUser question: "${q}"\n\nAnswer the question directly and specifically using the thoughts above. Quote relevant entries when useful. Be concise.`;
  }

  showClaudeOutput('thinking...', true);
  synthesizeBtn.disabled = true;
  queryBtn.disabled = true;

  try {
    const res = await fetch('/.netlify/functions/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const data = await res.json();
    let output = data.content?.[0]?.text || 'no response.';

    if (overflow > 0) {
      output += `\n\n─\n${overflow} older thought${overflow !== 1 ? 's' : ''} not included in this analysis.`;
    }

    showClaudeOutput(output);
  } catch(e) {
    showClaudeOutput('something went wrong. try again.');
    console.error(e);
  }

  synthesizeBtn.disabled = false;
  queryBtn.disabled = false;
}

function showClaudeOutput(text, loading = false) {
  claudeOutput.textContent = text;
  claudeOutput.className = 'claude-output' + (loading ? ' loading' : '');
  claudeOutput.classList.remove('hidden');
}