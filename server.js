const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname; // 云平台可挂持久卷后设置 DATA_DIR
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------- storage ----------------
let db = { users: [], clients: [], projects: [], logins: [] };

function loadDB() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db.users = parsed.users || [];
      db.clients = parsed.clients || [];
      db.projects = parsed.projects || [];
      db.logins = parsed.logins || [];
    } catch (e) {
      console.error('⚠️ 数据文件损坏，已尝试加载空数据:', e.message);
    }
  }
  if (db.users.length === 0) {
    const { salt, hash } = hashPassword('admin123');
    db.users.push({
      id: genId('u'),
      username: 'admin',
      passwordHash: hash,
      passwordSalt: salt,
      role: 'admin',
      createdAt: new Date().toISOString()
    });
    saveDB();
    console.log('============================================================');
    console.log('  初始管理员已创建');
    console.log('  用户名: admin    密码: admin123');
    console.log('  请登录后尽快在「管理员面板」修改密码！');
    console.log('============================================================');
  }
}

function saveDB() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// ---------------- password & token ----------------
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function genId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex') + Date.now().toString(36);
}

const sessions = new Map(); // token -> { userId }
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}
function getUserByToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  return db.users.find(u => u.id === s.userId) || null;
}

// ---------------- helpers ----------------
function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt };
}
function usernameById(id) {
  const u = db.users.find(x => x.id === id);
  return u ? u.username : '(未知)';
}
function attachOwner(rec) {
  return Object.assign({}, rec, { ownerName: usernameById(rec.ownerId) });
}
function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v));
}
function sanitizeClient(body) {
  const fields = ['name', 'company', 'contact', 'country', 'email', 'phone', 'source', 'status', 'tags', 'notes'];
  const o = {};
  for (const f of fields) o[f] = cleanStr(body[f]);
  return o;
}
function sanitizeProject(body) {
  const fields = ['name', 'clientId', 'clientName', 'stage', 'amount', 'priority', 'status', 'expectedClose', 'nextFollowUp', 'notes'];
  const o = {};
  for (const f of fields) o[f] = cleanStr(body[f]);
  o.progress = String(parseInt(body.progress, 10) || 0);
  return o;
}
function makeRecord(type, body, user) {
  const now = new Date().toISOString();
  const base = { id: genId(type), ownerId: user.id, createdAt: now, updatedAt: now };
  return Object.assign(base, type === 'clients' ? sanitizeClient(body) : sanitizeProject(body));
}
function overview() {
  const perUser = {};
  for (const u of db.users) perUser[u.id] = { username: u.username, role: u.role, clients: 0, projects: 0 };
  for (const c of db.clients) if (perUser[c.ownerId]) perUser[c.ownerId].clients++;
  for (const p of db.projects) if (perUser[p.ownerId]) perUser[p.ownerId].projects++;
  const recentLogins = db.logins.slice(-15).reverse().map(l => ({ username: l.username, at: l.at }));
  return {
    totals: { users: db.users.length, clients: db.clients.length, projects: db.projects.length },
    perUser: Object.values(perUser),
    recentLogins
  };
}

// ---------------- http helpers ----------------
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e7) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
async function getAuthUser(req) {
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  return getUserByToken(m[1]);
}

// ---------------- static ----------------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(content);
  });
}

// ---------------- router ----------------
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = parsed.pathname;
  const method = req.method;

  try {
    if (pathname.startsWith('/api/')) {
      const user = await getAuthUser(req);

      // 登录
      if (pathname === '/api/login' && method === 'POST') {
        const body = await readBody(req);
        const u = db.users.find(x => x.username === body.username);
        if (!u || !verifyPassword(body.password || '', u.passwordSalt, u.passwordHash)) {
          return sendJSON(res, 401, { error: '用户名或密码错误' });
        }
        const token = createSession(u.id);
        db.logins.push({ userId: u.id, username: u.username, at: new Date().toISOString() });
        if (db.logins.length > 500) db.logins = db.logins.slice(-500);
        saveDB();
        return sendJSON(res, 200, { token, user: publicUser(u) });
      }

      // 登出
      if (pathname === '/api/logout' && method === 'POST') {
        const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
        if (m) sessions.delete(m[1]);
        return sendJSON(res, 200, { ok: true });
      }

      // 当前用户
      if (pathname === '/api/me' && method === 'GET') {
        if (!user) return sendJSON(res, 401, { error: '未登录' });
        return sendJSON(res, 200, { user: publicUser(user) });
      }

      if (!user) return sendJSON(res, 401, { error: '未登录' });

      // ---------- 客户 ----------
      if (pathname === '/api/clients') {
        if (method === 'GET') {
          let list = user.role === 'admin' ? db.clients : db.clients.filter(c => c.ownerId === user.id);
          return sendJSON(res, 200, { items: list.map(attachOwner) });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          if (!cleanStr(body.name)) return sendJSON(res, 400, { error: '客户名称不能为空' });
          const rec = makeRecord('clients', body, user);
          db.clients.push(rec);
          saveDB();
          return sendJSON(res, 201, { item: attachOwner(rec) });
        }
      }
      let m = pathname.match(/^\/api\/clients\/(.+)$/);
      if (m) {
        const rec = db.clients.find(c => c.id === m[1]);
        if (!rec) return sendJSON(res, 404, { error: '记录不存在' });
        if (rec.ownerId !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: '无权限' });
        if (method === 'PUT') {
          const body = await readBody(req);
          if (!cleanStr(body.name)) return sendJSON(res, 400, { error: '客户名称不能为空' });
          Object.assign(rec, sanitizeClient(body), { updatedAt: new Date().toISOString() });
          saveDB();
          return sendJSON(res, 200, { item: attachOwner(rec) });
        }
        if (method === 'DELETE') {
          db.clients = db.clients.filter(c => c.id !== m[1]);
          db.projects.forEach(p => { if (p.clientId === m[1]) { p.clientId = ''; p.clientName = '(已删除客户)'; } });
          saveDB();
          return sendJSON(res, 200, { ok: true });
        }
      }

      // ---------- 项目 ----------
      if (pathname === '/api/projects') {
        if (method === 'GET') {
          let list = user.role === 'admin' ? db.projects : db.projects.filter(p => p.ownerId === user.id);
          return sendJSON(res, 200, { items: list.map(attachOwner) });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          if (!cleanStr(body.name)) return sendJSON(res, 400, { error: '项目名称不能为空' });
          const rec = makeRecord('projects', body, user);
          // 关联客户名称
          if (rec.clientId) {
            const c = db.clients.find(x => x.id === rec.clientId);
            if (c) rec.clientName = c.name;
          }
          db.projects.push(rec);
          saveDB();
          return sendJSON(res, 201, { item: attachOwner(rec) });
        }
      }
      m = pathname.match(/^\/api\/projects\/(.+)$/);
      if (m) {
        const rec = db.projects.find(p => p.id === m[1]);
        if (!rec) return sendJSON(res, 404, { error: '记录不存在' });
        if (rec.ownerId !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: '无权限' });
        if (method === 'PUT') {
          const body = await readBody(req);
          if (!cleanStr(body.name)) return sendJSON(res, 400, { error: '项目名称不能为空' });
          Object.assign(rec, sanitizeProject(body), { updatedAt: new Date().toISOString() });
          if (rec.clientId) {
            const c = db.clients.find(x => x.id === rec.clientId);
            rec.clientName = c ? c.name : rec.clientName;
          }
          saveDB();
          return sendJSON(res, 200, { item: attachOwner(rec) });
        }
        if (method === 'DELETE') {
          db.projects = db.projects.filter(p => p.id !== m[1]);
          saveDB();
          return sendJSON(res, 200, { ok: true });
        }
      }

      // ---------- 管理员 ----------
      if (user.role !== 'admin') return sendJSON(res, 403, { error: '需要管理员权限' });

      if (pathname === '/api/admin/overview' && method === 'GET') {
        return sendJSON(res, 200, overview());
      }
      if (pathname === '/api/users' && method === 'GET') {
        return sendJSON(res, 200, { items: db.users.map(publicUser) });
      }
      if (pathname === '/api/users' && method === 'POST') {
        const body = await readBody(req);
        const username = cleanStr(body.username);
        const password = cleanStr(body.password);
        const role = body.role === 'admin' ? 'admin' : 'user';
        if (!username) return sendJSON(res, 400, { error: '用户名不能为空' });
        if (password.length < 4) return sendJSON(res, 400, { error: '密码至少 4 位' });
        if (db.users.some(u => u.username === username)) return sendJSON(res, 400, { error: '用户名已存在' });
        const { salt, hash } = hashPassword(password);
        const nu = { id: genId('u'), username, passwordHash: hash, passwordSalt: salt, role, createdAt: new Date().toISOString() };
        db.users.push(nu);
        saveDB();
        return sendJSON(res, 201, { user: publicUser(nu) });
      }
      m = pathname.match(/^\/api\/users\/(.+)\/password$/);
      if (m) {
        if (method === 'PUT') {
          const body = await readBody(req);
          const password = cleanStr(body.password);
          if (password.length < 4) return sendJSON(res, 400, { error: '密码至少 4 位' });
          const u = db.users.find(x => x.id === m[1]);
          if (!u) return sendJSON(res, 404, { error: '用户不存在' });
          const { salt, hash } = hashPassword(password);
          u.passwordSalt = salt; u.passwordHash = hash;
          saveDB();
          return sendJSON(res, 200, { ok: true });
        }
      }
      m = pathname.match(/^\/api\/users\/(.+)$/);
      if (m) {
        if (method === 'DELETE') {
          const u = db.users.find(x => x.id === m[1]);
          if (!u) return sendJSON(res, 404, { error: '用户不存在' });
          if (u.id === user.id) return sendJSON(res, 400, { error: '不能删除自己的账号' });
          db.users = db.users.filter(x => x.id !== m[1]);
          db.clients = db.clients.filter(c => c.ownerId !== m[1]);
          db.projects = db.projects.filter(p => p.ownerId !== m[1]);
          // 清理该用户会话
          for (const [t, s] of sessions) if (s.userId === m[1]) sessions.delete(t);
          saveDB();
          return sendJSON(res, 200, { ok: true });
        }
      }

      return sendJSON(res, 404, { error: '接口不存在' });
    }

    // 静态资源
    return serveStatic(pathname, res);
  } catch (err) {
    console.error('请求处理出错:', err);
    sendJSON(res, 500, { error: err.message || '服务器内部错误' });
  }
});

loadDB();
server.listen(PORT, '0.0.0.0', () => {
  console.log('✅ 海外项目跟进指南 已启动: http://localhost:' + PORT);
});
