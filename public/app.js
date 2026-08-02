const screens = {
  menu: document.getElementById('screen-menu'),
  solo: document.getElementById('screen-solo'),
  interview: document.getElementById('screen-interview'),
  mpLobby: document.getElementById('screen-mp-lobby'),
  mpGame: document.getElementById('screen-mp-game'),
  mpGameOver: document.getElementById('screen-mp-gameover'),
};

function showScreen(name) {
  for (const s of Object.values(screens)) s.classList.remove('active');
  screens[name].classList.add('active');
}

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => showScreen('menu'));
});

document.querySelectorAll('.mode-card').forEach((card) => {
  card.addEventListener('click', () => {
    const mode = card.dataset.mode;
    if (mode === 'solo') { showScreen('solo'); startSolo(); }
    if (mode === 'interview') { showScreen('interview'); startInterview(); }
    if (mode === 'multiplayer') { showScreen('mpLobby'); }
  });
});

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
  return res.json();
}

// ---------------- SOLO MODE ----------------

const soloState = { score: 0, askedTopics: [] };

function startSolo() {
  soloState.score = 0;
  soloState.askedTopics = [];
  document.getElementById('solo-score').textContent = '0';
  loadSoloQuestion();
}

async function loadSoloQuestion() {
  const card = document.getElementById('solo-card');
  const nextBtn = document.getElementById('solo-next');
  nextBtn.hidden = true;
  card.innerHTML = '<div class="loading">Loading question…</div>';

  let q;
  try {
    q = await postJSON('/api/solo/question', { excludeTopics: soloState.askedTopics.slice(-5) });
  } catch (err) {
    card.innerHTML = `<div class="loading">Couldn't load a question. <button class="btn-link" onclick="loadSoloQuestion()">Retry</button></div>`;
    return;
  }
  soloState.askedTopics.push(q.topic);
  renderSoloQuestion(q);
}
window.loadSoloQuestion = loadSoloQuestion;

function renderSoloQuestion(q) {
  const card = document.getElementById('solo-card');
  card.innerHTML = `
    <div class="topic">${escapeHtml(q.topic)}</div>
    <p class="question-text">${escapeHtml(q.question)}</p>
    <div class="choices">
      ${q.choices.map((c, i) => `<button class="choice-btn" data-index="${i}">${escapeHtml(c)}</button>`).join('')}
    </div>
  `;

  card.querySelectorAll('.choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chosen = Number(btn.dataset.index);
      card.querySelectorAll('.choice-btn').forEach((b) => (b.disabled = true));
      if (chosen === q.correctIndex) {
        btn.classList.add('correct');
        soloState.score += 100;
        document.getElementById('solo-score').textContent = soloState.score;
      } else {
        btn.classList.add('incorrect');
        card.querySelector(`[data-index="${q.correctIndex}"]`).classList.add('correct');
      }
      card.insertAdjacentHTML('beforeend', `<div class="explanation">${escapeHtml(q.explanation)}</div>`);
      document.getElementById('solo-next').hidden = false;
    });
  });
}

document.getElementById('solo-next').addEventListener('click', loadSoloQuestion);

// ---------------- INTERVIEW MODE ----------------

const interviewState = { count: 0, askedTopics: [], currentQuestion: null };

function startInterview() {
  interviewState.count = 0;
  interviewState.askedTopics = [];
  document.getElementById('interview-count').textContent = '0';
  loadInterviewQuestion();
}

async function loadInterviewQuestion() {
  const card = document.getElementById('interview-question-card');
  const answerArea = document.getElementById('interview-answer-area');
  const feedbackCard = document.getElementById('interview-feedback');
  const nextBtn = document.getElementById('interview-next');

  nextBtn.hidden = true;
  feedbackCard.hidden = true;
  answerArea.hidden = true;
  document.getElementById('interview-answer').value = '';
  card.innerHTML = '<div class="loading">Loading question…</div>';

  let q;
  try {
    q = await postJSON('/api/interview/question', { excludeTopics: interviewState.askedTopics.slice(-5) });
  } catch (err) {
    card.innerHTML = `<div class="loading">Couldn't load a question. <button class="btn-link" onclick="loadInterviewQuestion()">Retry</button></div>`;
    return;
  }
  interviewState.askedTopics.push(q.topic);
  interviewState.currentQuestion = q.question;
  card.innerHTML = `
    <div class="topic">${escapeHtml(q.topic)}</div>
    <p class="question-text">${escapeHtml(q.question)}</p>
  `;
  answerArea.hidden = false;
}
window.loadInterviewQuestion = loadInterviewQuestion;

document.getElementById('interview-submit').addEventListener('click', async () => {
  const answer = document.getElementById('interview-answer').value.trim();
  if (!answer) return;

  const submitBtn = document.getElementById('interview-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Evaluating…';

  const feedbackCard = document.getElementById('interview-feedback');
  try {
    const evaluation = await postJSON('/api/interview/evaluate', {
      question: interviewState.currentQuestion,
      answer,
    });
    interviewState.count += 1;
    document.getElementById('interview-count').textContent = interviewState.count;

    const verdictLabel = { strong: 'Strong', good: 'Good', needs_work: 'Needs work', incorrect: 'Incorrect' }[evaluation.verdict] || evaluation.verdict;
    feedbackCard.innerHTML = `
      <span class="verdict ${evaluation.verdict}">${verdictLabel}</span>
      <p>${escapeHtml(evaluation.feedback)}</p>
      <p class="label">What a strong answer covers</p>
      <p>${escapeHtml(evaluation.idealAnswerSummary)}</p>
      <p class="label">A follow-up they might ask</p>
      <p>${escapeHtml(evaluation.followUp)}</p>
    `;
    feedbackCard.hidden = false;
    document.getElementById('interview-answer-area').hidden = true;
    document.getElementById('interview-next').hidden = false;
  } catch (err) {
    feedbackCard.innerHTML = `<p>Couldn't evaluate that answer. Try submitting again.</p>`;
    feedbackCard.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit answer';
  }
});

document.getElementById('interview-next').addEventListener('click', loadInterviewQuestion);

// ---------------- MULTIPLAYER MODE ----------------

const socket = io();
const mp = { code: null, name: '', isHost: false, questionStart: 0, answered: false };

document.getElementById('mp-create').addEventListener('click', () => {
  mp.name = document.getElementById('mp-name').value.trim() || 'Host';
  socket.emit('create-room', { name: mp.name }, (res) => {
    if (res.error) return showMpError(res.error);
    mp.code = res.code;
    mp.isHost = true;
    enterLobby(res);
  });
});

document.getElementById('mp-join').addEventListener('click', () => {
  mp.name = document.getElementById('mp-name').value.trim() || 'Player';
  const code = document.getElementById('mp-code').value.trim().toUpperCase();
  if (!code) return showMpError('Enter a room code');
  socket.emit('join-room', { code, name: mp.name }, (res) => {
    if (res.error) return showMpError(res.error);
    mp.code = res.code;
    mp.isHost = false;
    enterLobby(res);
  });
});

function showMpError(message) {
  document.getElementById('mp-error').textContent = message;
}

function enterLobby(res) {
  showMpError('');
  document.getElementById('mp-choice').hidden = true;
  document.getElementById('mp-room').hidden = false;
  document.getElementById('mp-room-code').textContent = mp.code;
  document.getElementById('mp-start').hidden = !mp.isHost;
  document.getElementById('mp-waiting-hint').hidden = mp.isHost;
  renderPlayerList(res.players);
}

function renderPlayerList(players) {
  const list = document.getElementById('mp-player-list');
  list.innerHTML = players.map((p) => `<li><span>${escapeHtml(p.name)}</span><span>${p.score}</span></li>`).join('');
}

socket.on('lobby-update', ({ players }) => renderPlayerList(players));

document.getElementById('mp-start').addEventListener('click', () => {
  socket.emit('start-game', { code: mp.code });
});

let mpTimerInterval = null;

socket.on('question', ({ round, totalRounds, question, choices, timeLimitMs }) => {
  showScreen('mpGame');
  mp.answered = false;
  mp.questionStart = Date.now();

  document.getElementById('mp-round').textContent = round;
  document.getElementById('mp-total-rounds').textContent = totalRounds;
  document.getElementById('mp-reveal').hidden = true;
  document.getElementById('mp-leaderboard').hidden = true;

  const card = document.getElementById('mp-question-card');
  card.innerHTML = `
    <p class="question-text">${escapeHtml(question)}</p>
    <div class="choices">
      ${choices.map((c, i) => `<button class="choice-btn" data-index="${i}">${escapeHtml(c)}</button>`).join('')}
    </div>
  `;
  card.querySelectorAll('.choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (mp.answered) return;
      mp.answered = true;
      card.querySelectorAll('.choice-btn').forEach((b) => (b.disabled = true));
      btn.style.borderColor = 'var(--accent)';
      socket.emit('submit-answer', {
        code: mp.code,
        choiceIndex: Number(btn.dataset.index),
        elapsedMs: Date.now() - mp.questionStart,
      });
    });
  });

  let remaining = Math.ceil(timeLimitMs / 1000);
  document.getElementById('mp-timer').textContent = remaining;
  clearInterval(mpTimerInterval);
  mpTimerInterval = setInterval(() => {
    remaining -= 1;
    document.getElementById('mp-timer').textContent = Math.max(remaining, 0);
    if (remaining <= 0) clearInterval(mpTimerInterval);
  }, 1000);
});

socket.on('reveal', ({ correctIndex, explanation, players }) => {
  clearInterval(mpTimerInterval);
  const card = document.getElementById('mp-question-card');
  const buttons = card.querySelectorAll('.choice-btn');
  buttons.forEach((b) => {
    b.disabled = true;
    if (Number(b.dataset.index) === correctIndex) b.classList.add('correct');
  });

  const revealCard = document.getElementById('mp-reveal');
  revealCard.innerHTML = `<p>${escapeHtml(explanation)}</p>`;
  revealCard.hidden = false;

  const leaderboard = document.getElementById('mp-leaderboard');
  leaderboard.innerHTML = players.map((p) => `<li><span>${escapeHtml(p.name)}</span><span>${p.score}</span></li>`).join('');
  leaderboard.hidden = false;
});

socket.on('game-over', ({ players }) => {
  showScreen('mpGameOver');
  document.getElementById('mp-final-leaderboard').innerHTML =
    players.map((p, i) => `<li><span>${i + 1}. ${escapeHtml(p.name)}</span><span>${p.score}</span></li>`).join('');
});

socket.on('room-error', ({ message }) => {
  alert(message);
});

// ---------------- utils ----------------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
