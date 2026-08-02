import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { customAlphabet } from 'nanoid';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-3.1-flash-lite';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const httpServer = createServer(app);
const io = new Server(httpServer);

const roomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);

async function generateJSON(prompt, schema) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });
  return JSON.parse(response.text);
}

const TRIVIA_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    topic: { type: Type.STRING },
    question: { type: Type.STRING },
    choices: { type: Type.ARRAY, items: { type: Type.STRING } },
    correctIndex: { type: Type.INTEGER },
    explanation: { type: Type.STRING },
  },
  required: ['topic', 'question', 'choices', 'correctIndex', 'explanation'],
};

const TRIVIA_ARRAY_SCHEMA = { type: Type.ARRAY, items: TRIVIA_SCHEMA };

async function generateTriviaQuestions(count, excludeTopics = [], difficulty = 'medium') {
  return generateJSON(
    `Write ${count} distinct ${difficulty}-difficulty multiple-choice engineering trivia questions, ` +
      `each on a different engineering topic (electrical, mechanical, civil, software, robotics, ` +
      `embedded systems, materials science, aerospace, control systems, computer architecture, ` +
      `thermodynamics, signal processing, PCB design, or engineering history). ` +
      `Exactly 4 answer choices per question, only one correct. Keep questions and choices concise. ` +
      `Provide a one-to-two sentence explanation of the correct answer for each. ` +
      `Avoid these topics if possible: ${excludeTopics.join(', ') || 'none'}.`,
    TRIVIA_ARRAY_SCHEMA,
  );
}

const INTERVIEW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    topic: { type: Type.STRING },
    question: { type: Type.STRING },
  },
  required: ['topic', 'question'],
};

const INTERVIEW_ARRAY_SCHEMA = { type: Type.ARRAY, items: INTERVIEW_SCHEMA };

async function generateInterviewQuestions(count, excludeTopics = []) {
  return generateJSON(
    `Write ${count} distinct open-ended technical interview questions a hiring manager might ask an ` +
      `engineering candidate, each on a different engineering topic. Each should require an explanation, ` +
      `not a one-word answer (e.g. "Walk me through...", "How would you...", "Explain..."). ` +
      `Avoid these topics if possible: ${excludeTopics.join(', ') || 'none'}.`,
    INTERVIEW_ARRAY_SCHEMA,
  );
}

const EVALUATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ['strong', 'good', 'needs_work', 'incorrect'] },
    feedback: { type: Type.STRING },
    idealAnswerSummary: { type: Type.STRING },
    followUp: { type: Type.STRING },
  },
  required: ['verdict', 'feedback', 'idealAnswerSummary', 'followUp'],
};

async function evaluateInterviewAnswer(question, answer) {
  return generateJSON(
    `You are a technical interviewer grading a candidate's spoken answer. ` +
      `Question: "${question}"\nCandidate's answer: "${answer}"\n\n` +
      `Give a verdict, brief constructive feedback (2-4 sentences, direct and specific), ` +
      `a short summary of what a strong answer would cover, and one natural follow-up question ` +
      `an interviewer might ask next based on their answer.`,
    EVALUATION_SCHEMA,
  );
}

// ---------- REST endpoints (solo + interview) ----------

const MAX_BATCH = 10;

function sendGenerationError(res, err) {
  console.error(err);
  if (err?.status === 429) {
    return res.status(429).json({ error: "Hit the Gemini free-tier rate limit — wait a bit and try again." });
  }
  res.status(502).json({ error: 'Failed to generate questions' });
}

app.post('/api/solo/questions', async (req, res) => {
  try {
    const { count = 5, excludeTopics = [], difficulty = 'medium' } = req.body ?? {};
    const questions = await generateTriviaQuestions(Math.min(count, MAX_BATCH), excludeTopics, difficulty);
    res.json({ questions });
  } catch (err) {
    sendGenerationError(res, err);
  }
});

app.post('/api/interview/questions', async (req, res) => {
  try {
    const { count = 5, excludeTopics = [] } = req.body ?? {};
    const questions = await generateInterviewQuestions(Math.min(count, MAX_BATCH), excludeTopics);
    res.json({ questions });
  } catch (err) {
    sendGenerationError(res, err);
  }
});

app.post('/api/interview/evaluate', async (req, res) => {
  try {
    const { question, answer } = req.body ?? {};
    if (!question || !answer) {
      return res.status(400).json({ error: 'question and answer are required' });
    }
    const evaluation = await evaluateInterviewAnswer(question, answer);
    res.json(evaluation);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to evaluate answer' });
  }
});

// ---------- Multiplayer (Socket.IO) ----------

const ROUNDS_PER_GAME = 8;
const QUESTION_TIME_MS = 20_000;
const QUEUE_TARGET = 3;

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeRoom(hostSocketId, hostName) {
  const code = roomCode();
  const room = {
    code,
    hostSocketId,
    players: new Map([[hostSocketId, { name: hostName, score: 0 }]]),
    round: 0,
    currentQuestion: null,
    answers: new Map(),
    timer: null,
    askedTopics: [],
    started: false,
    queue: [],
    filling: false,
  };
  rooms.set(code, room);
  fillQueue(room); // start prefetching while players are still in the lobby
  return room;
}

function publicPlayers(room) {
  return [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, score: p.score }));
}

async function fillQueue(room, target = QUEUE_TARGET) {
  const needed = target - room.queue.length;
  if (needed <= 0 || room.filling || !rooms.has(room.code)) return;
  room.filling = true;
  try {
    const questions = await generateTriviaQuestions(needed, room.askedTopics, 'medium');
    for (const q of questions) {
      room.askedTopics.push(q.topic);
      room.queue.push(q);
    }
  } catch (err) {
    console.error(err);
  } finally {
    room.filling = false;
  }
}

async function nextRound(room) {
  room.round += 1;
  room.answers = new Map();
  clearTimeout(room.timer);

  if (room.round > ROUNDS_PER_GAME) {
    io.to(room.code).emit('game-over', { players: publicPlayers(room).sort((a, b) => b.score - a.score) });
    room.started = false;
    return;
  }

  if (room.queue.length === 0) {
    await fillQueue(room, 1); // cold start (e.g. game started before the lobby prefetch finished)
  }
  const question = room.queue.shift();
  if (!question) {
    io.to(room.code).emit('room-error', { message: 'Failed to generate the next question. Try again.' });
    return;
  }
  room.currentQuestion = question;
  fillQueue(room); // top the buffer back off in the background for future rounds

  io.to(room.code).emit('question', {
    round: room.round,
    totalRounds: ROUNDS_PER_GAME,
    question: question.question,
    choices: question.choices,
    timeLimitMs: QUESTION_TIME_MS,
  });

  room.timer = setTimeout(() => revealRound(room), QUESTION_TIME_MS);
}

function revealRound(room) {
  clearTimeout(room.timer);
  const q = room.currentQuestion;
  if (!q) return;

  for (const [socketId, answer] of room.answers.entries()) {
    if (answer.choiceIndex === q.correctIndex) {
      const player = room.players.get(socketId);
      if (player) {
        const speedBonus = Math.max(0, Math.floor((QUESTION_TIME_MS - answer.elapsedMs) / 1000));
        player.score += 100 + speedBonus;
      }
    }
  }

  io.to(room.code).emit('reveal', {
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    players: publicPlayers(room).sort((a, b) => b.score - a.score),
  });

  setTimeout(() => nextRound(room), 4000);
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name }, callback) => {
    const room = makeRoom(socket.id, name?.slice(0, 20) || 'Host');
    socket.join(room.code);
    callback?.({ code: room.code, players: publicPlayers(room) });
  });

  socket.on('join-room', ({ code, name }, callback) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return callback?.({ error: 'Room not found' });
    if (room.started) return callback?.({ error: 'Game already in progress' });
    room.players.set(socket.id, { name: name?.slice(0, 20) || 'Player', score: 0 });
    socket.join(room.code);
    callback?.({ code: room.code, players: publicPlayers(room) });
    io.to(room.code).emit('lobby-update', { players: publicPlayers(room) });
  });

  socket.on('start-game', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id || room.started) return;
    room.started = true;
    room.round = 0;
    room.askedTopics = [];
    for (const p of room.players.values()) p.score = 0;
    nextRound(room);
  });

  socket.on('submit-answer', ({ code, choiceIndex, elapsedMs }) => {
    const room = rooms.get(code);
    if (!room || !room.currentQuestion) return;
    if (room.answers.has(socket.id)) return;
    room.answers.set(socket.id, { choiceIndex, elapsedMs: elapsedMs ?? QUESTION_TIME_MS });

    if (room.answers.size === room.players.size) {
      revealRound(room);
    }
  });

  socket.on('disconnecting', () => {
    for (const code of socket.rooms) {
      const room = rooms.get(code);
      if (!room) continue;
      room.players.delete(socket.id);
      if (room.players.size === 0) {
        clearTimeout(room.timer);
        rooms.delete(code);
      } else {
        if (room.hostSocketId === socket.id) {
          room.hostSocketId = room.players.keys().next().value;
        }
        io.to(code).emit('lobby-update', { players: publicPlayers(room) });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Engineering Trivia running at http://localhost:${PORT}`);
});
