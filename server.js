const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const dns = require('dns');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');
const { Resend } = require('resend');

// تجاوز ـ DNS المحلي (127.0.0.1 فاشل في SRV) → استخدم Cloudflare/Google
try {
  dns.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);
} catch (e) { /* ignore */ }

const app = express();
// Render يضع proxy أمام التطبيق — لازم نخبر Express عشان rate-limit يقرأ IP الحقيقي
app.set('trust proxy', 1);

// CORS: نقبل origin محددة فقط في الإنتاج، وكل شيء في dev
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://layyib.onrender.com,http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => {
      // اسمح بطلبات بدون origin (mobile apps, curl, file://)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error('Origin غير مسموح'));
    },
    methods: ['GET', 'POST']
  }
});

// helmet: security headers (CSP معطّل لأن inline scripts/styles موجودة في index.html)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ═══════════════════════════════════════════
// MONGODB CONNECTION
// ═══════════════════════════════════════════
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI غير مضبوط في environment variables');
  process.exit(1);
}

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB متصل'))
  .catch(err => console.error('❌ خطأ في MongoDB:', err.message));

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  password: { type: String, required: true },          // bcrypt hash
  passwordPlain: { type: Boolean, default: false },     // true = الباسوورد لسا plain (للحسابات القديمة قبل bcrypt)
  email: { type: String, lowercase: true, trim: true, sparse: true, index: true }, // optional للقدامى، يُستخدم للاستعادة
  avatar: { type: String, default: '⚽' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const BCRYPT_ROUNDS = 10;

// Password Reset Tokens - TTL index يحذف المنتهية تلقائياً
const passwordResetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },  // SHA-256 hash للـtoken
  expiresAt: { type: Date, required: true, expires: 0 },       // TTL: MongoDB يحذفها تلقائياً عند الانتهاء
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const PasswordReset = mongoose.model('PasswordReset', passwordResetSchema);

// ═══════════════════════════════════════════
// EMAIL SERVICE (Resend)
// ═══════════════════════════════════════════
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Layyib <no-reply@layyib.com>';
const APP_URL = process.env.APP_URL || 'https://layyib.com';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

if (!resend) {
  console.warn('⚠️ RESEND_API_KEY غير مضبوط — استعادة الباسوورد لن تعمل');
} else {
  console.log('📧 Resend جاهز — الإرسال من:', EMAIL_FROM);
}

function validateEmail(email) {
  if (typeof email !== 'string') return false;
  // regex بسيط ومعقول: شيء@شيء.شيء، طول معقول
  if (email.length < 5 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendPasswordResetEmail(toEmail, displayName, resetUrl) {
  if (!resend) throw new Error('خدمة الإيميل غير مفعّلة');
  const html = `
  <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f7f7f7;border-radius:12px;color:#222">
    <div style="text-align:center;margin-bottom:24px">
      <h1 style="color:#0d7a3a;margin:0">⚽ لقيب</h1>
    </div>
    <div style="background:white;padding:24px;border-radius:8px">
      <h2 style="margin-top:0">السلام عليكم ${displayName} 👋</h2>
      <p>وصلنا طلب لاستعادة كلمة المرور لحسابك في <strong>لقيب</strong>.</p>
      <p>اضغط الزر التالي لإعادة تعيين كلمة المرور:</p>
      <div style="text-align:center;margin:32px 0">
        <a href="${resetUrl}" style="background:#0d7a3a;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">🔐 إعادة تعيين كلمة المرور</a>
      </div>
      <p style="color:#666;font-size:13px">أو انسخ هذا الرابط في المتصفح:</p>
      <p style="background:#f0f0f0;padding:8px;border-radius:4px;word-break:break-all;font-family:monospace;font-size:12px">${resetUrl}</p>
      <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
      <p style="color:#666;font-size:13px">
        ⏱️ هذا الرابط ينتهي خلال <strong>15 دقيقة</strong>.<br>
        🛡️ إذا لم تطلب هذا الإيميل، تجاهله ولا تشاركه مع أحد.
      </p>
    </div>
    <p style="text-align:center;color:#888;font-size:12px;margin-top:16px">
      © ${new Date().getFullYear()} لقيب — لعبة الأسئلة الجماعية
    </p>
  </div>`;

  const text = `السلام عليكم ${displayName}،\n\nوصلنا طلب لاستعادة كلمة المرور لحسابك في لقيب.\n\nافتح هذا الرابط لإعادة تعيين كلمة المرور:\n${resetUrl}\n\nالرابط ينتهي خلال 15 دقيقة.\nإذا لم تطلب هذا الإيميل، تجاهله.\n\n— فريق لقيب`;

  return await resend.emails.send({
    from: EMAIL_FROM,
    to: [toEmail],
    subject: 'استعادة كلمة المرور - لقيب',
    html,
    text
  });
}

// ═══════════════════════════════════════════
// RATE LIMITERS
// ═══════════════════════════════════════════
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 دقيقة
  max: 10,                    // 10 محاولات لكل IP
  message: { ok: false, error: 'محاولات كثيرة، انتظر 15 دقيقة' },
  standardHeaders: true,
  legacyHeaders: false
});

// أشد صرامة لـforgot-password (منع إغراق الإيميل)
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,                     // 3 فقط لكل IP
  message: { ok: false, error: 'طلبات كثيرة للاستعادة، انتظر 15 دقيقة' },
  standardHeaders: true,
  legacyHeaders: false
});

// ═══════════════════════════════════════════
// USER ACCOUNTS API
// ═══════════════════════════════════════════

// Register
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password, avatar, email } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'بيانات ناقصة' });
  if (typeof username !== 'string' || typeof password !== 'string') return res.json({ ok: false, error: 'بيانات غير صحيحة' });
  if (username.length < 3 || username.length > 30) return res.json({ ok: false, error: 'الاسم يجب أن يكون بين 3 و30 حرفاً' });
  if (/\s/.test(username)) return res.json({ ok: false, error: 'لا تضع مسافات في الاسم' });
  if (password.length < 4 || password.length > 100) return res.json({ ok: false, error: 'كلمة المرور قصيرة (4 أحرف على الأقل)' });

  // email optional — لو أرسل تحقّق منه
  let cleanEmail = null;
  if (email !== undefined && email !== null && email !== '') {
    if (typeof email !== 'string' || !validateEmail(email.trim())) {
      return res.json({ ok: false, error: 'الإيميل غير صحيح' });
    }
    cleanEmail = email.trim().toLowerCase();
  }

  try {
    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) return res.json({ ok: false, error: 'اسم المستخدم مأخوذ، جرّب اسماً آخر' });
    if (cleanEmail) {
      const emailExists = await User.findOne({ email: cleanEmail });
      if (emailExists) return res.json({ ok: false, error: 'هذا الإيميل مستخدم في حساب آخر' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const doc = {
      username: username.toLowerCase(),
      displayName: username,
      password: hash,
      passwordPlain: false,
      avatar: avatar || '⚽'
    };
    if (cleanEmail) doc.email = cleanEmail;
    await User.create(doc);
    res.json({ ok: true, user: { username, avatar: avatar || '⚽', email: cleanEmail } });
  } catch (e) {
    console.error('register error:', e.message);
    res.json({ ok: false, error: 'خطأ في السيرفر' });
  }
});

// Login (مع migration تلقائي للحسابات القديمة من plain-text إلى bcrypt)
app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'أدخل اسم المستخدم وكلمة المرور' });
  if (typeof username !== 'string' || typeof password !== 'string') return res.json({ ok: false, error: 'بيانات غير صحيحة' });

  try {
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.json({ ok: false, error: 'اسم المستخدم غير موجود' });

    // كشف bcrypt بالـsignature: hashes تبدأ بـ$2a$, $2b$, أو $2y$
    const isBcryptHash = typeof user.password === 'string' && /^\$2[aby]\$/.test(user.password);

    let ok = false;
    if (isBcryptHash) {
      ok = await bcrypt.compare(password, user.password);
    } else {
      // حساب قديم: قارن plain، وإذا صح حوّل لـbcrypt مرة وحدة
      ok = (user.password === password);
      if (ok) {
        user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
        user.passwordPlain = false;
        await user.save();
        console.log(`🔐 migration: ${user.username} → bcrypt`);
      }
    }
    if (!ok) return res.json({ ok: false, error: 'كلمة المرور غير صحيحة' });

    res.json({ ok: true, user: { username: user.displayName, avatar: user.avatar, email: user.email || null } });
  } catch (e) {
    console.error('login error:', e.message);
    res.json({ ok: false, error: 'خطأ في السيرفر' });
  }
});

// ═══════════════════════════════════════════
// PASSWORD RESET API
// ═══════════════════════════════════════════

// تحديث الإيميل لحساب موجود (يتطلب username + الباسوورد الحالي للتحقق من الهوية)
app.post('/api/update-email', authLimiter, async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password || !email) return res.json({ ok: false, error: 'بيانات ناقصة' });
  if (typeof username !== 'string' || typeof password !== 'string' || typeof email !== 'string') {
    return res.json({ ok: false, error: 'بيانات غير صحيحة' });
  }
  const cleanEmail = email.trim().toLowerCase();
  if (!validateEmail(cleanEmail)) return res.json({ ok: false, error: 'الإيميل غير صحيح' });

  try {
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.json({ ok: false, error: 'اسم المستخدم غير موجود' });

    // تحقّق من الباسوورد الحالي
    const isBcryptHash = typeof user.password === 'string' && /^\$2[aby]\$/.test(user.password);
    const ok = isBcryptHash
      ? await bcrypt.compare(password, user.password)
      : (user.password === password);
    if (!ok) return res.json({ ok: false, error: 'كلمة المرور غير صحيحة' });

    // تأكد ما فيه أحد ثاني عنده نفس الإيميل
    const emailExists = await User.findOne({ email: cleanEmail, _id: { $ne: user._id } });
    if (emailExists) return res.json({ ok: false, error: 'هذا الإيميل مستخدم في حساب آخر' });

    user.email = cleanEmail;
    await user.save();
    console.log(`📧 email المستخدم ${user.username} تحدّث`);
    res.json({ ok: true, email: cleanEmail });
  } catch (e) {
    console.error('update-email error:', e.message);
    res.json({ ok: false, error: 'خطأ في السيرفر' });
  }
});

// طلب استعادة: المستخدم يدخل username أو email
app.post('/api/forgot-password', resetLimiter, async (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier || typeof identifier !== 'string') {
    return res.json({ ok: false, error: 'أدخل اسم المستخدم أو الإيميل' });
  }

  // رسالة عامة لا تسرّب وجود الحساب
  const genericMsg = 'إذا كان الحساب موجوداً ولديه إيميل مسجّل، أرسلنا له رابط الاستعادة — تفقّد البريد';

  try {
    if (!resend) {
      console.warn('forgot-password: Resend غير مفعّل');
      return res.json({ ok: true, message: genericMsg });
    }

    const id = identifier.trim().toLowerCase();
    const user = await User.findOne({
      $or: [
        { username: id },
        { email: id }
      ]
    });

    // دائماً نرجّع نفس الرسالة (ما نسرّب وجود حسابات)
    if (!user || !user.email) {
      return res.json({ ok: true, message: genericMsg });
    }

    // ولّد token عشوائي آمن
    const rawToken = crypto.randomBytes(32).toString('hex');  // 64 حرف hex
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);  // 15 دقيقة

    // ألغ أي tokens سابقة غير مستخدمة لنفس المستخدم
    await PasswordReset.deleteMany({ userId: user._id, used: false });

    await PasswordReset.create({
      userId: user._id,
      tokenHash,
      expiresAt
    });

    const resetUrl = `${APP_URL}/reset.html?token=${rawToken}`;
    try {
      await sendPasswordResetEmail(user.email, user.displayName, resetUrl);
      console.log(`📧 reset email أُرسل إلى ${user.username}`);
    } catch (emailErr) {
      console.error('reset email error:', emailErr.message);
      // لا نسرّب الخطأ للعميل
    }

    res.json({ ok: true, message: genericMsg });
  } catch (e) {
    console.error('forgot-password error:', e.message);
    res.json({ ok: true, message: genericMsg });  // لا نسرّب أخطاء السيرفر
  }
});

// تنفيذ الاستعادة: token + باسوورد جديد
app.post('/api/reset-password', resetLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.json({ ok: false, error: 'بيانات ناقصة' });
  if (typeof token !== 'string' || typeof newPassword !== 'string') return res.json({ ok: false, error: 'بيانات غير صحيحة' });
  if (newPassword.length < 4 || newPassword.length > 100) return res.json({ ok: false, error: 'كلمة المرور يجب أن تكون بين 4 و100 حرف' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const reset = await PasswordReset.findOne({ tokenHash, used: false });
    if (!reset) return res.json({ ok: false, error: 'الرابط غير صالح أو مستخدم مسبقاً' });
    if (reset.expiresAt < new Date()) {
      return res.json({ ok: false, error: 'الرابط منتهي الصلاحية، اطلب رابطاً جديداً' });
    }

    const user = await User.findById(reset.userId);
    if (!user) return res.json({ ok: false, error: 'الحساب غير موجود' });

    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.passwordPlain = false;
    await user.save();

    reset.used = true;
    await reset.save();

    // ألغ أي tokens ثانية غير مستخدمة لنفس المستخدم
    await PasswordReset.deleteMany({ userId: user._id, used: false });

    console.log(`🔑 password reset لـ ${user.username}`);
    res.json({ ok: true, user: { username: user.displayName, avatar: user.avatar } });
  } catch (e) {
    console.error('reset-password error:', e.message);
    res.json({ ok: false, error: 'خطأ في السيرفر' });
  }
});

// تحقق سريع من صلاحية token (للصفحة قبل إدخال الباسوورد)
app.get('/api/reset-password/verify', async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') return res.json({ ok: false, error: 'رابط غير صالح' });
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const reset = await PasswordReset.findOne({ tokenHash, used: false });
    if (!reset || reset.expiresAt < new Date()) {
      return res.json({ ok: false, error: 'الرابط غير صالح أو منتهي' });
    }
    res.json({ ok: true });
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
