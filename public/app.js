const screens = {
  menu: document.getElementById('screen-menu'),
  solo: document.getElementById('screen-solo'),
  interviewCategory: document.getElementById('screen-interview-category'),
  interview: document.getElementById('screen-interview'),
  mpLobby: document.getElementById('screen-mp-lobby'),
  mpGame: document.getElementById('screen-mp-game'),
  mpGameOver: document.getElementById('screen-mp-gameover'),
};

const DISCIPLINE_LABELS = {
  mechanical: 'Mechanical',
  electrical: 'Electrical',
  software: 'Software',
  computer: 'Computer Engineering',
  mixed: 'Mixed',
};

function showScreen(name) {
  for (const s of Object.values(screens)) s.classList.remove('active');
  screens[name].classList.add('active');
}

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => showScreen('menu'));
});

document.querySelectorAll('.mode-card:not(.discipline-card)').forEach((card) => {
  card.addEventListener('click', () => {
    const mode = card.dataset.mode;
    if (mode === 'solo') { showScreen('solo'); startSolo(); }
    if (mode === 'interview') { showScreen('interviewCategory'); }
    if (mode === 'multiplayer') { showScreen('mpLobby'); }
  });
});

document.querySelectorAll('.discipline-card').forEach((card) => {
  card.addEventListener('click', () => {
    const discipline = card.dataset.discipline;
    showScreen('interview');
    startInterview(discipline);
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

// ---------------- QUESTION PREFETCH QUEUE ----------------
// Keeps a buffer of pre-generated questions per mode so "next" is instant most
// of the time: once the buffer drops to `refillAt`, a background request tops
// it back up to `batchSize` while the remaining buffered questions keep serving.

function makeQuestionQueue(endpoint, { batchSize = 5, refillAt = 2 } = {}) {
  return {
    items: [],
    askedTopics: [],
    extraParams: {},
    filling: false,
    async refill() {
      if (this.filling) return;
      this.filling = true;
      try {
        const { questions } = await postJSON(endpoint, {
          count: batchSize,
          excludeTopics: this.askedTopics.slice(-10),
          ...this.extraParams,
        });
        for (const q of questions) {
          this.askedTopics.push(q.topic);
          this.items.push(q);
        }
      } finally {
        this.filling = false;
      }
    },
    async take() {
      if (this.items.length === 0) {
        await this.refill(); // nothing buffered yet — this one has to wait
      } else if (this.items.length <= refillAt) {
        this.refill(); // fire-and-forget top-up while serving from the buffer
      }
      return this.items.shift() ?? null;
    },
    reset(extraParams = {}) {
      this.items = [];
      this.askedTopics = [];
      this.extraParams = extraParams;
    },
  };
}

// ---------------- SOLO MODE ----------------

const soloState = { score: 0 };
const soloQueue = makeQuestionQueue('/api/solo/questions');

function startSolo() {
  soloState.score = 0;
  soloQueue.reset();
  document.getElementById('solo-score').textContent = '0';
  loadSoloQuestion();
}

async function loadSoloQuestion() {
  const card = document.getElementById('solo-card');
  const nextBtn = document.getElementById('solo-next');
  nextBtn.hidden = true;
  if (soloQueue.items.length === 0) {
    card.innerHTML = '<div class="loading">Loading question…</div>';
  }

  let q;
  try {
    q = await soloQueue.take();
  } catch (err) {
    card.innerHTML = `<div class="loading">${escapeHtml(err.message)} <button class="btn-link" onclick="loadSoloQuestion()">Retry</button></div>`;
    return;
  }
  if (!q) {
    card.innerHTML = `<div class="loading">Couldn't load a question. <button class="btn-link" onclick="loadSoloQuestion()">Retry</button></div>`;
    return;
  }
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

const interviewState = { count: 0, currentQuestion: null };
const interviewQueue = makeQuestionQueue('/api/interview/questions');

function startInterview(discipline = 'mixed') {
  interviewState.count = 0;
  interviewQueue.reset({ discipline });
  document.getElementById('interview-count').textContent = '0';
  document.getElementById('interview-discipline-pill').textContent = DISCIPLINE_LABELS[discipline] || 'Mixed';
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
  if (interviewQueue.items.length === 0) {
    card.innerHTML = '<div class="loading">Loading question…</div>';
  }

  let q;
  try {
    q = await interviewQueue.take();
  } catch (err) {
    card.innerHTML = `<div class="loading">${escapeHtml(err.message)} <button class="btn-link" onclick="loadInterviewQuestion()">Retry</button></div>`;
    return;
  }
  if (!q) {
    card.innerHTML = `<div class="loading">Couldn't load a question. <button class="btn-link" onclick="loadInterviewQuestion()">Retry</button></div>`;
    return;
  }
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
