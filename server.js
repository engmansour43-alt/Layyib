const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

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

function genCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 6).toUpperCase(); }
  while (rooms[code]);
  return code;
}

io.on('connection', (socket) => {
  console.log('🟢 لاعب اتصل:', socket.id);

  socket.on('create_room', ({ name, avatar, difficulty, questions }) => {
    const code = genCode();
    rooms[code] = {
      host: socket.id,
      status: 'waiting',
      difficulty,
      questions,
      currentQ: -1,
      questionStartedAt: 0,
      players: {
        [socket.id]: { name, avatar: avatar || '⚽', score: 0, correct: 0, answers: {}, online: true }
      }
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { code });
    io.to(code).emit('room_updated', sanitizeRoom(rooms[code]));
    console.log(`🏠 غرفة جديدة: ${code} | المضيف: ${name}`);
  });

  socket.on('join_room', ({ code, name, avatar }) => {
    const room = rooms[code];
    if (!room) { socket.emit('join_error', 'الغرفة غير موجودة'); return; }
    if (room.status === 'finished') { socket.emit('join_error', 'اللعبة انتهت بالفعل'); return; }
    if (room.status === 'playing') { socket.emit('join_error', 'اللعبة بدأت بالفعل'); return; }
    if (Object.keys(room.players).length >= 8) { socket.emit('join_error', 'الغرفة ممتلئة (8 لاعبين كحد أقصى)'); return; }

    room.players[socket.id] = { name, avatar: avatar || '⚽', score: 0, correct: 0, answers: {}, online: true };
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_joined', { code, room: sanitizeRoom(room) });
    io.to(code).emit('room_updated', sanitizeRoom(room));
    console.log(`👤 ${name} انضم للغرفة ${code}`);
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
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
    const player = room.players[socket.id];
    if (!player || player.answers[qIdx] !== undefined) return;
    player.score = score;
    player.correct = correct;
    player.answers[qIdx] = { opt: optIdx, ok };
    io.to(code).emit('players_updated', getPlayersList(room));
    const activePlayers = Object.values(room.players).filter(p => p.online);
    const allAnswered = activePlayers.every(p => p.answers[qIdx] !== undefined);
    if (allAnswered) {
      const delay = ok ? 1500 : 2500;
      setTimeout(() => advanceQuestion(code, qIdx), delay);
    }
  });

  socket.on('advance_question', ({ code, qIdx }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    advanceQuestion(code, qIdx);
  });

  socket.on('leave_room', ({ code }) => { handleLeave(socket, code); });

  socket.on('disconnect', () => {
    console.log('🔴 لاعب قطع الاتصال:', socket.id);
    const code = socket.data.roomCode;
    if (code) handleLeave(socket, code, true);
  });
});

function advanceQuestion(code, qIdx) {
  const room = rooms[code];
  if (!room || room.status !== 'playing') return;
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
  if (room.players[socket.id]) room.players[socket.id].online = false;
  socket.leave(code);
  if (room.host === socket.id && room.status !== 'finished') {
    io.to(code).emit('room_closed', 'المضيف غادر الغرفة');
    delete rooms[code];
    return;
  }
  const onlinePlayers = Object.values(room.players).filter(p => p.online);
  if (onlinePlayers.length === 0) { delete rooms[code]; return; }
  if (!disconnected) delete room.players[socket.id];
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

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🎮 لعّييب - خادم اللعب الأونلاين`);
  console.log(`🌐 الخادم يعمل على: http://localhost:${PORT}\n`);
});
