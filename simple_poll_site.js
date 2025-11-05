/*
Simple Poll Site - single-file Node.js + Express app
Features implemented:
- Landing page to create a new poll
- Build page supports: title, text fields, single-choice and multi-choice questions
- On publish, creates two unique pages:
  - /c/:creatorKey  -> creator dashboard (view responses, taker link)
  - /p/:pollKey     -> poll taking page
- Each poll enforces a per-poll unique "response id" (an arbitrary string entered by taker)
- Polls expire after 90 days and are removed by a cleanup run at startup and on publish
- Simple random URL strings like craigslist-style (nanoid)
- Uses SQLite (better-sqlite3) for persistence; very small footprint and sustainable

How to run:
1) save this file as `simple-poll-site.js`
2) create package.json with the dependencies below or run:
   npm init -y
   npm install express better-sqlite3 nanoid body-parser cookie-parser
3) start with: node simple-poll-site.js
4) open http://localhost:3000

Notes:
- This is intentionally small and not production hardened. For production: add authentication for creators, rate-limiting, input sanitization, HTTPS, backup strategy, and stronger cleanup (cron job).
- Polls are deleted if created_at + 90 days < now; cleanup runs on startup and when creating polls.
*/

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// -- DB setup --
const db = new Database(path.join(__dirname, 'polls.db'));

// create tables
db.exec(`
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY,
  poll_key TEXT UNIQUE,
  creator_key TEXT UNIQUE,
  title TEXT,
  created_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  poll_id INTEGER,
  q_index INTEGER,
  q_type TEXT, -- 'text' | 'single' | 'multi'
  q_prompt TEXT,
  q_options TEXT -- JSON array for choices when applicable
);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY,
  poll_id INTEGER,
  responder_id TEXT, -- unique per poll
  submitted_at INTEGER,
  answers TEXT -- JSON of answers: { q_index: value }
);
`);

// prepared statements
const insertPoll = db.prepare('INSERT INTO polls (poll_key, creator_key, title, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
const insertQuestion = db.prepare('INSERT INTO questions (poll_id, q_index, q_type, q_prompt, q_options) VALUES (?, ?, ?, ?, ?)');
const getPollByPollKey = db.prepare('SELECT * FROM polls WHERE poll_key = ?');
const getPollByCreatorKey = db.prepare('SELECT * FROM polls WHERE creator_key = ?');
const getQuestionsForPoll = db.prepare('SELECT * FROM questions WHERE poll_id = ? ORDER BY q_index');
const insertResponse = db.prepare('INSERT INTO responses (poll_id, responder_id, submitted_at, answers) VALUES (?, ?, ?, ?)');
const getResponsesForPoll = db.prepare('SELECT * FROM responses WHERE poll_id = ? ORDER BY submitted_at DESC');
const countResponderId = db.prepare('SELECT COUNT(*) as c FROM responses WHERE poll_id = ? AND responder_id = ?');
const deletePollById = db.prepare('DELETE FROM polls WHERE id = ?');
const deleteQuestionsByPollId = db.prepare('DELETE FROM questions WHERE poll_id = ?');
const deleteResponsesByPollId = db.prepare('DELETE FROM responses WHERE poll_id = ?');
const selectExpired = db.prepare('SELECT * FROM polls WHERE expires_at < ?');

// cleanup expired polls
function cleanupExpired() {
  const now = Date.now();
  const expired = selectExpired.all(now);
  const tx = db.transaction((list) => {
    for (const p of list) {
      deleteQuestionsByPollId.run(p.id);
      deleteResponsesByPollId.run(p.id);
      deletePollById.run(p.id);
      console.log('Deleted expired poll', p.poll_key);
    }
  });
  tx(expired);
}

cleanupExpired();

// -- Helpers --
function makeUrlKey() {
  // 10-char url-safe key
  return nanoid(10);
}

function nowMs() { return Date.now(); }
function daysToMs(d) { return d * 24*60*60*1000; }

function renderPage(content) {
  return `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Poll It!</title>
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>
      <div class="card">
        ${content}
      </div>
      <footer class="site-footer">
        <p>Poll It! — a site by <a target="_blank href="https://www.rdrobny.me">Ryan Drobny</a> / <a href="/">Home</a></p>
      </footer>
    </body>
  </html>`;
}

// -- Routes: Simple static landing & create UI --
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.send(renderPage(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Poll It! | Make simple polls</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="card">
    <h1>Poll It!</h1>
    <p>Create a poll and share the link. Polls auto-expire after 90 days.</p>
    <p><a href="/create">Build a new poll</a></p>
    <hr />
  </div>
</body>
</html>`));
});

// Serve create page
app.get('/create', (req, res) => {
  res.send(renderPage(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Create Poll</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="stylesheet" href="/styles.css">
</head>
<div class="card">
<body>
  <h1>Build a new poll</h1>
  <form id="pollForm">
    <label>Title</label>
    <input name="title" required />
    <div id="questions"></div>
    <p>
      <button type="button" onclick="addText()">Add Text Field</button>
      <button type="button" onclick="addSingle()">Add Single-choice</button>
      <button type="button" onclick="addMulti()">Add Multi-choice</button>
    </p>
    <p>
      <button type="submit">Publish poll</button>
    </p>
  </form>

  <script>
    let qIndex = 0;
    const questionsEl = document.getElementById('questions');
    function addText(){ addQ('text'); }
    function addSingle(){ addQ('single'); }
    function addMulti(){ addQ('multi'); }
    function addQ(type){
      const div = document.createElement('div'); div.className='q';
      div.innerHTML = '<input placeholder="Question prompt" data-qprompt />' +
        '<input placeholder="optional description or instructions" data-qplaceholder />' +
        '<div data-options style="margin-top:8px"></div>' +
        '<button type="button" onclick="this.parentNode.remove()">Remove question</button>';
      div.setAttribute('data-qtype', type);
      div.setAttribute('data-qindex', qIndex++);
      if(type==='single' || type==='multi'){
        const opts = div.querySelector('[data-options]');
        opts.innerHTML = '<div><button type="button" onclick="addOption(this)">Add option</button></div>';
      }
      questionsEl.appendChild(div);
    }
    function addOption(btn){
      const opts = btn.parentNode;
      const input = document.createElement('input');
      input.placeholder = 'Option text';
      input.setAttribute('data-option', '');
      opts.insertBefore(input, btn.parentNode.querySelector('div'));
    }

    document.getElementById('pollForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const title = e.target.title.value.trim();
      const qs = [];
      for(const q of document.querySelectorAll('.q')){
        const type = q.getAttribute('data-qtype');
        const prompt = q.querySelector('[data-qprompt]').value || '';
        const options = [];
        for(const opt of q.querySelectorAll('[data-option]')){
          if(opt.value.trim()) options.push(opt.value.trim());
        }
        qs.push({type, prompt, options});
      }
      if(!title){ alert('Title required'); return; }
      const payload = { title, questions: qs };
      const resp = await fetch('/api/polls', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload)});
      const data = await resp.json();
      if(data.creator_url){
        // redirect to creator page
        window.location = data.creator_url;
      } else {
        alert('Error creating poll');
      }
    });
  </script>
   <p><a href="/">Poll It! Home page</a></p>
   <details>
  <summary>How To</summary>
  <p><strong>First</strong>, give your poll an informative <strong>Title</strong>.</p>
  <p><strong>Next, build your poll!</strong> This is where you determine what kinds of questions you want your poll takers to answer. This builder give you 3 options: free text fields where takers can type out their answers, single-choice questions where they can select one of the options you provide, or multi-choice questions where they can select any number of the options you give.</p>
  <p>Each question type will prompt you for the question prompt itself and allow for an optional description/instruction field. You can leave this blank if you'd like.</p>
  <p><strong>Add Text Feild:</strong> A free-text box will be added - as the creator you only see it's Title & optional description.</p>
  <p><strong>Add Single-Choice:</strong> Enables you to add multiple options, but only 1 can be selected by poll takers.</p>
  <p><strong>Add Multi-Choice:</strong> Same as Single-Choice, but poll takers can select as many options as they like.</p>
  <p><strong>Note:</strong>Every poll will include a field for a unique poll ID. The system requires each poll response to have a unique poll ID. This enables poll creators (you) a little more control over the responses. Issue IDs (like passwords) to your poll takers so that you only get their answers (you can filter out any others). Or you can ignore this field! Poll takers will be instructed to add any random text if they were not provided an ID.</p>
</details>
</body>
</html>`));
});

// API: create poll
app.post('/api/polls', (req, res) => {
  try{
    const { title, questions } = req.body;
    if(!title || !Array.isArray(questions)) return res.status(400).json({ error: 'bad request' });
    cleanupExpired();
    const pollKey = makeUrlKey();
    const creatorKey = makeUrlKey();
    const created = nowMs();
    const expires = created + daysToMs(90);
    const info = insertPoll.run(pollKey, creatorKey, title, created, expires);
    const pollId = info.lastInsertRowid;
    const tx = db.transaction((qs) => {
      for(let i=0;i<qs.length;i++){
        const q = qs[i];
        const type = q.type;
        const prompt = q.prompt || '';
        const options = (Array.isArray(q.options) && q.options.length) ? JSON.stringify(q.options) : null;
        insertQuestion.run(pollId, i, type, prompt, options);
      }
    });
    tx(questions);
    const creator_url = `${req.protocol}://${req.get('host')}/c/${creatorKey}`;
    const poll_url = `${req.protocol}://${req.get('host')}/p/${pollKey}`;
    return res.json({ creator_url, poll_url, creator_key: creatorKey, poll_key: pollKey });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Creator dashboard
app.get('/c/:creatorKey', (req, res) => {
  const ck = req.params.creatorKey;
  const poll = getPollByCreatorKey.get(ck);
  if(!poll) return res.status(404).send('Creator page not found');
  const questions = getQuestionsForPoll.all(poll.id);
  const responses = getResponsesForPoll.all(poll.id);
  // simple HTML
  res.send(renderPage(`<!doctype html>
<html><head><meta charset="utf-8"><title>Creator - ${escapeHtml(poll.title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
 <link rel="stylesheet" href="/styles.css">
  <div class="card">
  <h1>Creator dashboard</h1>
  <p><strong>Title:</strong> ${escapeHtml(poll.title)}</p>
  <p><strong>Important:</strong>This is your only way to access your creator dashboard again:<a href="/c/${poll.creator_key}">
     ${req.protocol}://${req.get('host')}/c/${poll.creator_key}</a></p>
  <p><strong>Send poll takers this link:</strong> <a href="/p/${poll.poll_key}">${req.protocol}://${req.get('host')}/p/${poll.poll_key}</a></p>
  <p><strong>Expires at:</strong> ${new Date(poll.expires_at).toLocaleString()}</p>
  <h2>Questions</h2>
  <ol>
    ${questions.map(q=>`<li>${escapeHtml(q.q_prompt || '(no prompt)')} <em>(${q.q_type})</em>${q.q_options?'<ul>'+JSON.parse(q.q_options).map(o=>'<li>'+escapeHtml(o)+'</li>').join('')+'</ul>':''}</li>`).join('')}
  </ol>
  <h2>Responses (${responses.length})</h2>
  <table border="1" cellpadding="6"><tr><th>responder id</th><th>submitted</th><th>answers (json)</th></tr>
  ${responses.map(r=>`<tr><td>${escapeHtml(r.responder_id)}</td><td>${new Date(r.submitted_at).toLocaleString()}</td><td><pre>${escapeHtml(r.answers)}</pre></td></tr>`).join('')}
  </table>
  <p><a href="/">Poll It! Home page</a></p>
</div></body></html>`));
});

// Poll taker page
app.get('/p/:pollKey', (req, res) => {
  const pk = req.params.pollKey;
  const poll = getPollByPollKey.get(pk);
  if(!poll) return res.status(404).send('Poll not found');
  const questions = getQuestionsForPoll.all(poll.id);
  res.send(renderPage(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(poll.title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
 <link rel="stylesheet" href="/styles.css">
  <div class="card">
  <body>
  <h1>${escapeHtml(poll.title)}</h1>
  <form id="respForm">
    <label>Response ID (must be unique for this poll). It can be any string, or you can be assigned one by the creator.</label>
    <input name="responder_id" required />
    <div id="questions">
      ${questions.map(q=>renderQuestionHtml(q)).join('')}
    </div>
    <p><button type="submit">Submit response</button></p>
  </form>
  <div id="msg"></div>
  <script>
    document.getElementById('respForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const form = e.target;
      const responder_id = form.responder_id.value.trim();
      if(!responder_id){ alert('Enter responder ID'); return; }
      const answers = {};
      for(const el of form.querySelectorAll('[data-qindex]')){
        const qi = el.getAttribute('data-qindex');
        const type = el.getAttribute('data-qtype');
        if(type==='text'){
          answers[qi] = el.querySelector('textarea').value;
        } else if(type==='single'){
          const sel = el.querySelector('input[type=radio]:checked');
          answers[qi] = sel ? sel.value : null;
        } else if(type==='multi'){
          const vals = [];
          for(const cb of el.querySelectorAll('input[type=checkbox]:checked')) vals.push(cb.value);
          answers[qi] = vals;
        }
      }
      const payload = { responder_id, answers };
      const r = await fetch('/api/polls/${pk}/responses', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload)});
      const j = await r.json();
      if(r.status===200){ document.getElementById('msg').innerText = 'Thanks! Response saved.'; form.reset(); } else { document.getElementById('msg').innerText = 'Error: '+(j.error||'unknown'); }
    });
  </script>
  <p><a href="/">Poll It! Home page</a></p>
</div>
</body></html>`));
});

// API: submit response
app.post('/api/polls/:pollKey/responses', (req, res) => {
  const pk = req.params.pollKey;
  const poll = getPollByPollKey.get(pk);
  if(!poll) return res.status(404).json({ error: 'poll not found' });
  const { responder_id, answers } = req.body;
  if(!responder_id) return res.status(400).json({ error: 'responder_id required' });
  // check uniqueness per poll
  const c = countResponderId.get(poll.id, responder_id);
  if(c.c > 0) return res.status(409).json({ error: 'responder_id already used for this poll' });
  const now = nowMs();
  insertResponse.run(poll.id, responder_id, now, JSON.stringify(answers));
  return res.json({ ok:true });
});

// Utility: simple HTML escaping
function escapeHtml(s){
  if(!s) return '';
  return String(s).replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[m]; });
}

function renderQuestionHtml(q){
  const idx = q.q_index;
  if(q.q_type==='text'){
    return `<div data-qindex="${idx}" data-qtype="text"><label>${escapeHtml(q.q_prompt)}</label><div><textarea rows="3" style="width:100%"></textarea></div></div>`;
  } else if(q.q_type==='single'){
    const opts = JSON.parse(q.q_options || '[]');
    return `<div data-qindex="${idx}" data-qtype="single"><label>${escapeHtml(q.q_prompt)}</label><div>${opts.map((o,i)=>`<div><label><input type="radio" name="q${idx}" value="${escapeHtml(o)}"> ${escapeHtml(o)}</label></div>`).join('')}</div></div>`;
  } else if(q.q_type==='multi'){
    const opts = JSON.parse(q.q_options || '[]');
    return `<div data-qindex="${idx}" data-qtype="multi"><label>${escapeHtml(q.q_prompt)}</label><div>${opts.map((o,i)=>`<div><label><input type="checkbox" name="q${idx}" value="${escapeHtml(o)}"> ${escapeHtml(o)}</label></div>`).join('')}</div></div>`;
  }
  return '';
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

app.get('/__admin/polls', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    if (req.query.token !== ADMIN_TOKEN) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  
  const rows = db.prepare(
    'SELECT id,poll_key,creator_key,title,created_at,expires_at FROM polls ORDER BY created_at DESC'
  ).all();
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
