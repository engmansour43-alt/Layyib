const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const dns = require('dns');

// تجاوز ـ DNS المحلي (127.0.0.1 فاشل في SRV) → استخدم Cloudflare/Google
try {
  dns.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);
} catch (e) { /* ignore */ }

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ═══════════════════════════════════════════
// MONGODB CONNECTION
// ═══════════════════════════════════════════
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://Mansour:92845844Mm@cluster0.2o9o2de.mongodb.net/layyib?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB متصل'))
  .catch(err => console.error('❌ خطأ في MongoDB:', err.message));

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  password: { type: String, required: true },
  avatar: { type: String, default: '⚽' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// ═══════════════════════════════════════════
// USER ACCOUNTS API
// ═══════════════════════════════════════════

// Register
app.post('/api/register', async (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'بيانات ناقصة' });
  if (username.length < 3) return res.json({ ok: false, error: 'الاسم قصير جداً (3 أحرف على الأقل)' });
  if (/\s/.test(username)) return res.json({ ok: false, error: 'لا تضع مسافات في الاسم' });
  if (password.length < 4) return res.json({ ok: false, error: 'كلمة المرور قصيرة (4 أحرف على الأقل)' });

  try {
    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) return res.json({ ok: false, error: 'اسم المستخدم مأخوذ، جرّب اسماً آخر' });

    await User.create({ username: username.toLowerCase(), displayName: username, password, avatar: avatar || '⚽' });
    res.json({ ok: true, user: { username, avatar: avatar || '⚽' } });
  } catch (e) {
    res.json({ ok: false, error: 'خطأ في السيرفر' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'أدخل اسم المستخدم وكلمة المرور' });

  try {
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.json({ ok: false, error: 'اسم المستخدم غير موجود' });
    if (user.password !== password) return res.json({ ok: false, error: 'كلمة المرور غير صحيحة' });

    res.json({ ok: true, user: { username: user.displayName, avatar: user.avatar } });
  } catch (e) {
    res.json({ ok: false, error: 'خطأ في السيرفر' });
  }
});

// ═══════════════════════════════════════════
// ROOMS
// ═══════════════════════════════════════════
const rooms = {};
const TOTAL = 10;
const ADVANCE_DELAY_OK = 1500;
const ADVANCE_DELAY_BAD = 2500;

// ═══════════════════════════════════════════
// MATCHMAKING QUEUE
// ═══════════════════════════════════════════
// Entries: { pid, sid, name, avatar, diff, cat, questions, joinedAt }
let matchmakingQueue = [];
const RELAX_AFTER_MS = 15000;   // After 15s of waiting, match with anyone
const QUEUE_TICK_MS = 2000;

function genCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 6).toUpperCase(); }
  while (rooms[code]);
  return code;
}

// Resolve player id: prefer client-provided persistent pid, fall back to socket.id
function pidOf(socket, payloadPid) {
  return (payloadPid && typeof payloadPid === 'string') ? payloadPid : socket.id;
}

function queueRemove(pid) {
  matchmakingQueue = matchmakingQueue.filter(e => e.pid !== pid);
}

function findMatchFor(entry) {
  // Strict: same diff + same cat
  const strict = matchmakingQueue.find(o => o.pid !== entry.pid && o.diff === entry.diff && o.cat === entry.cat);
  if (strict) return { partner: strict, relaxed: false };
  // Relaxed: waiting > RELAX_AFTER_MS — pair with anyone
  const now = Date.now();
  if (now - entry.joinedAt >= RELAX_AFTER_MS) {
    const any = matchmakingQueue.find(o => o.pid !== entry.pid);
    if (any) return { partner: any, relaxed: true };
  }
  return null;
}

function createMatchRoom(a, b) {
  // a = host (first to queue). Use a's questions/diff/cat for the room.
  const code = genCode();
  rooms[code] = {
    host: a.pid,
    status: 'playing',
    difficulty: a.diff,
    questions: a.questions,
    currentQ: 0,
    questionStartedAt: Date.now(),
    advanceTimer: null,
    matched: true,
    players: {
      [a.pid]: { sid: a.sid, name: a.name, avatar: a.avatar || '⚽', score: 0, correct: 0, answers: {}, online: true },
      [b.pid]: { sid: b.sid, name: b.name, avatar: b.avatar || '⚽', score: 0, correct: 0, answers: {}, online: true }
    }
  };
  // Bind both sockets to the room
  const sockA = io.sockets.sockets.get(a.sid);
  const sockB = io.sockets.sockets.get(b.sid);
  if (sockA) { sockA.data.pid = a.pid; sockA.data.roomCode = code; sockA.join(code); }
  if (sockB) { sockB.data.pid = b.pid; sockB.data.roomCode = code; sockB.join(code); }

  // Notify both — they jump straight into the game
  io.to(code).emit('match_found', { code, room: sanitizeRoom(rooms[code]) });
  io.to(code).emit('game_started', sanitizeRoom(rooms[code]));
  console.log(`🎯 جولة مباراة: ${a.name} vs ${b.name} (${code})`);
}

// Periodic queue scan: try to relax-match anyone who's been waiting
setInterval(() => {
  if (matchmakingQueue.length < 2) return;
  // Iterate over a snapshot since we may remove entries
  const snapshot = [...matchmakingQueue];
  for (const entry of snapshot) {
    // Re-check entry still in queue
    if (!matchmakingQueue.some(e => e.pid === entry.pid)) continue;
    const m = findMatchFor(entry);
    if (m) {
      queueRemove(entry.pid);
      queueRemove(m.partner.pid);
      // entry queued earlier? Use whichever joined first as host (for question source)
      const [host, guest] = entry.joinedAt <= m.partner.joinedAt ? [entry, m.partner] : [m.partner, entry];
      createMatchRoom(host, guest);
    }
  }
}, QUEUE_TICK_MS);

io.on('connection', (socket) => {
  console.log('🟢 لاعب اتصل:', socket.id);

  socket.on('create_room', ({ pid, name, avatar, difficulty, questions }) => {
    const myPid = pidOf(socket, pid);
    // تنظيف: إذا كان اللاعب في غرفة سابقة (بالذات منتهية)، أخرجه تلقائياً
    if (socket.data.roomCode && rooms[socket.data.roomCode]) {
      handleLeave(socket, socket.data.roomCode);
    }
    const code = genCode();
    rooms[code] = {
      host: myPid,
      status: 'waiting',
      difficulty,
      questions,
      currentQ: -1,
      questionStartedAt: 0,
      advanceTimer: null,
      players: {
        [myPid]: { sid: socket.id, name, avatar: avatar || '⚽', score: 0, correct: 0, answers: {}, online: true }
      }
    };
    socket.data.pid = myPid;
    socket.data.roomCode = code;
    socket.join(code);
    socket.emit('room_created', { code });
    io.to(code).emit('room_updated', sanitizeRoom(rooms[code]));
    console.log(`🏠 غرفة جديدة: ${code} | المضيف: ${name} (${myPid})`);
  });

  socket.on('join_room', ({ pid, code, name, avatar }) => {
    const myPid = pidOf(socket, pid);
    const room = rooms[code];
    if (!room) { socket.emit('join_error', 'الغرفة غير موجودة'); return; }

    // Rejoin: if this pid is already in the room, treat as reconnect.
    if (room.players[myPid]) {
      const player = room.players[myPid];
      player.sid = socket.id;
      player.online = true;
      // Allow rejoin even during 'playing' state (handles refresh / reconnect)
      socket.data.pid = myPid;
      socket.data.roomCode = code;
      socket.join(code);
      socket.emit('room_joined', { code, room: sanitizeRoom(room) });
      // If game already in progress, send them straight to current question
      if (room.status === 'playing') {
        socket.emit('game_started', sanitizeRoom(room));
        socket.emit('question_changed', { qIdx: room.currentQ });
      }
      io.to(code).emit('room_updated', sanitizeRoom(room));
      console.log(`🔄 ${name} أعاد الاتصال للغرفة ${code}`);
      return;
    }

    if (room.status === 'finished') { socket.emit('join_error', 'اللعبة انتهت بالفعل'); return; }
    if (room.status === 'playing') { socket.emit('join_error', 'اللعبة بدأت بالفعل'); return; }
    if (Object.keys(room.players).length >= 8) { socket.emit('join_error', 'الغرفة ممتلئة (8 لاعبين كحد أقصى)'); return; }

    room.players[myPid] = { sid: socket.id, name, avatar: avatar || '⚽', score: 0, correct: 0, answers: {}, online: true };
    socket.data.pid = myPid;
    socket.data.roomCode = code;
    socket.join(code);
    socket.emit('room_joined', { code, room: sanitizeRoom(room) });
    io.to(code).emit('room_updated', sanitizeRoom(room));
    console.log(`👤 ${name} انضم للغرفة ${code} (${myPid})`);
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const myPid = socket.data.pid;
    if (room.host !== myPid) return;
    if (Object.keys(room.players).length < 1) { socket.emit('join_error', 'انتظر انضمام لاعبين'); return; }
    room.status = 'playing';
    room.currentQ = 0;
    room.questionStartedAt = Date.now();
    io.to(code).emit('game_started', sanitizeRoom(room));
    console.log(`🚀 بدأت اللعبة في الغرفة ${code}`);
  });

  socket.on('answer', ({ code, qIdx, optIdx, ok, score, correct }) => {
    const room = rooms[code];
    if (!room || room.status !== 'playing') return;
    // Only accept answers for the CURRENT question
    if (qIdx !== room.currentQ) return;
    const myPid = socket.data.pid;
    const player = room.players[myPid];
    if (!player || player.answers[qIdx] !== undefined) return;
    player.score = score;
    player.correct = correct;
    player.answers[qIdx] = { opt: optIdx, ok };
    io.to(code).emit('players_updated', getPlayersList(room));

    const activePlayers = Object.values(room.players).filter(p => p.online);
    if (activePlayers.length === 0) return;
    const allAnswered = activePlayers.every(p => p.answers[qIdx] !== undefined);
    if (allAnswered && !room.advanceTimer) {
      const delay = ok ? ADVANCE_DELAY_OK : ADVANCE_DELAY_BAD;
      room.advanceTimer = setTimeout(() => {
        room.advanceTimer = null;
        advanceQuestion(code, qIdx);
      }, delay);
    }
  });

  socket.on('advance_question', ({ code, qIdx }) => {
    const room = rooms[code];
    if (!room) return;
    const myPid = socket.data.pid;
    if (room.host !== myPid) return;
    // Idempotent: only advance if the qIdx matches current
    if (qIdx !== room.currentQ) return;
    if (room.advanceTimer) { clearTimeout(room.advanceTimer); room.advanceTimer = null; }
    advanceQuestion(code, qIdx);
  });

  socket.on('leave_room', ({ code }) => { handleLeave(socket, code); });

  // ── Matchmaking ──
  socket.on('find_match', ({ pid, name, avatar, diff, cat, questions }) => {
    const myPid = pidOf(socket, pid);
    if (!Array.isArray(questions) || questions.length < TOTAL) {
      socket.emit('match_error', 'فشل في تجهيز الأسئلة');
      return;
    }
    // إذا كان في غرفة منتهية، أخرجه تلقائياً؛ وإذا في غرفة نشطة، ارفض
    if (socket.data.roomCode && rooms[socket.data.roomCode]) {
      const r = rooms[socket.data.roomCode];
      if (r.status === 'finished') {
        handleLeave(socket, socket.data.roomCode);
      } else {
        socket.emit('match_error', 'أنت بالفعل في غرفة');
        return;
      }
    }
    // Remove any stale entry
    queueRemove(myPid);
    const entry = {
      pid: myPid, sid: socket.id, name: name || 'لاعب', avatar: avatar || '⚽',
      diff: diff || 'medium', cat: cat || 'all', questions, joinedAt: Date.now()
    };
    socket.data.pid = myPid;
    // Try to match immediately
    const m = findMatchFor(entry);
    if (m) {
      queueRemove(m.partner.pid);
      const [host, guest] = entry.joinedAt <= m.partner.joinedAt ? [entry, m.partner] : [m.partner, entry];
      createMatchRoom(host, guest);
      return;
    }
    matchmakingQueue.push(entry);
    socket.emit('match_searching', { position: matchmakingQueue.length });
    console.log(`🔍 ${entry.name} يبحث عن خصم (${entry.diff}/${entry.cat}) — طابور: ${matchmakingQueue.length}`);
  });

  socket.on('cancel_match', ({ pid }) => {
    const myPid = pidOf(socket, pid);
    queueRemove(myPid);
    socket.emit('match_cancelled');
  });

  socket.on('disconnect', () => {
    console.log('🔴 لاعب قطع الاتصال:', socket.id);
    const code = socket.data.roomCode;
    if (code) handleLeave(socket, code, true);
    // Also remove from matchmaking queue if present
    const myPid = socket.data.pid;
    if (myPid) queueRemove(myPid);
  });
});

function advanceQuestion(code, qIdx) {
  const room = rooms[code];
  if (!room || room.status !== 'playing') return;
  // Idempotency guard: only advance from the *current* question
  if (qIdx !== room.currentQ) return;
  const next = qIdx + 1;
  if (next >= TOTAL) {
    room.status = 'finished';
    io.to(code).emit('game_finished', getPlayersList(room));
    console.log(`🏆 انتهت اللعبة في الغرفة ${code}`);
    setTimeout(() => { delete rooms[code]; }, 5 * 60 * 1000);
  } else {
    room.currentQ = next;
    room.questionStartedAt = Date.now();
    io.to(code).emit('question_changed', { qIdx: next });
  }
}

function handleLeave(socket, code, disconnected = false) {
  const room = rooms[code];
  if (!room) return;
  const myPid = socket.data.pid;
  if (myPid && room.players[myPid]) room.players[myPid].online = false;
  socket.leave(code);

  // If the host disconnects mid-waiting, close the room.
  // But during play, give them a chance to reconnect — keep room alive.
  if (myPid && room.host === myPid && room.status === 'waiting') {
    io.to(code).emit('room_closed', 'المضيف غادر الغرفة');
    delete rooms[code];
    return;
  }

  const onlinePlayers = Object.values(room.players).filter(p => p.online);
  if (onlinePlayers.length === 0) {
    // No one's left — clean up after a short grace period (allow reconnect)
    setTimeout(() => {
      const r = rooms[code];
      if (!r) return;
      const stillEmpty = Object.values(r.players).every(p => !p.online);
      if (stillEmpty) {
        console.log(`🗑️  حذف غرفة فارغة: ${code}`);
        delete rooms[code];
      }
    }, 60 * 1000);
  }

  if (!disconnected && myPid) delete room.players[myPid];
  io.to(code).emit('room_updated', sanitizeRoom(room));
}

function sanitizeRoom(room) {
  return {
    host: room.host, status: room.status, difficulty: room.difficulty,
    currentQ: room.currentQ, questions: room.questions, players: getPlayersList(room)
  };
}

function getPlayersList(room) {
  const list = {};
  for (const [id, p] of Object.entries(room.players)) {
    list[id] = { name: p.name, avatar: p.avatar, score: p.score, correct: p.correct, online: p.online, answers: p.answers };
  }
  return list;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: Object.keys(rooms).length, db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════
// KEEP-ALIVE (منع خمول Render المجاني)
// ═══════════════════════════════════════════
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  const KEEP_ALIVE_MS = 10 * 60 * 1000; // كل 10 دقايق
  setInterval(() => {
    const url = `${SELF_URL.replace(/\/$/, '')}/health`;
    fetch(url).then(r => r.json())
      .then(() => console.log(`💓 keep-alive ping → ${url}`))
      .catch(err => console.warn('⚠️ keep-alive failed:', err.message));
  }, KEEP_ALIVE_MS);
  console.log(`💓 Keep-alive مفعّل (${SELF_URL})`);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🎮 لعّييب - خادم اللعب الأونلاين`);
  console.log(`🌐 الخادم يعمل على: http://localhost:${PORT}\n`);
});
