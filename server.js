const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ 缺少环境变量 MONGO_URI，应用无法启动。请在环境变量中设置 MongoDB 连接字符串。');
  process.exit(1);
}

const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------- mongo ----------------
let client, db, usersCol, clientsCol, projectsCol, loginsCol;

async function connectDB() {
  client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  db = client.db('overseas_tracker');
  usersCol = db.collection('users');
  clientsCol = db.collection('clients');
  projectsCol = db.collection('projects');
  loginsCol = db.collection('logins');
  await usersCol.createIndex({ username: 1 }, { unique: true }).catch(() => {});

  // 初始管理员
  const existing = await usersCol.findOne({ username: 'admin' });
  if (!existing) {
    const { salt, hash } = hashPassword('admin123');
    await usersCol.insertOne({
      id: genId('u'),
      username: 'admin',
      passwordHash: hash,
      passwordSalt: salt,
      role: 'admin',
      createdAt: new Date().toISOString()
    });
    console.log('============================================================');
    console.log('  初始管理员已创建');
    console.log('  用户名: admin    密码: admin123');
    console.log('  请登录后尽快在「管理员面板」修改密码！');
    console.log('============================================================');
  }
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
async function getUserByToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  return await usersCol.findOne({ id: s.userId });
}

// ---------------- helpers ----------------
function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt };
}
async function allUsersMap() {
  const users = await usersCol.find({}, { projection: { id: 1, username: 1 } }).toArray();
  const map = {};
  for (const u of users) map[u.id] = u.username;
  return map;
}
function attachOwner(rec, userMap) {
  return Object.assign({}, rec, { ownerName: userMap[rec.ownerId] || '(未知)' });
}
function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v));
}
function sanitizeClient(body) {
  const fields = ['name', 'company', 'contact', 'country', 'email', 'phone', 'source', 'status', 'lastContactDate', 'notes'];
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
async function overview() {
  const users = await usersCol.find({}).toArray();
  const clients = await clientsCol.find({}).toArray();
  const projects = await projectsCol.find({}).toArray();
  const perUser = {};
  for (const u of users) perUser[u.id] = { username: u.username, role: u.role, clients: 0, projects: 0 };
  for (const c of clients) if (perUser[c.ownerId]) perUser[c.ownerId].clients++;
  for (const p of projects) if (perUser[p.ownerId]) perUser[p.ownerId].projects++;
  const recentLogins = (await loginsCol.find({}).sort({ at: -1 }).limit(15).toArray()).map(l => ({ username: l.username, at: l.at }));
  return {
    totals: { users: users.length, clients: clients.length, projects: projects.length },
    perUser: Object.values(perUser),
    recentLogins
  };
}
async function trimLogins() {
  const cnt = await loginsCol.countDocuments();
  if (cnt > 500) {
    const oldest = await loginsCol.find({}, { projection: { _id: 1 } }).sort({ at: 1 }).limit(cnt - 500).toArray();
    const ids = oldest.map(d => d._id);
    await loginsCol.deleteMany({ _id: { $in: ids } });
  }
}

// ---------------- http helpers ----------------
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    req.setEncoding('utf8');
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e7) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
// CSV 单元格转义（处理逗号、引号、换行）
function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
async function getAuthUser(req) {
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  return await getUserByToken(m[1]);
}

// ---------------- static ----------------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
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
        const u = await usersCol.findOne({ username: body.username });
        if (!u || !verifyPassword(body.password || '', u.passwordSalt, u.passwordHash)) {
          return sendJSON(res, 401, { error: '用户名或密码错误' });
        }
        const token = createSession(u.id);
        await loginsCol.insertOne({ userId: u.id, username: u.username, at: new Date().toISOString() });
        await trimLogins();
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
        const userMap = await allUsersMap();
        if (method === 'GET') {
          const list = user.role === 'admin'
            ? await clientsCol.find({}).toArray()
            : await clientsCol.find({ ownerId: user.id }).toArray();
          return sendJSON(res, 200, { items: list.map(c => attachOwner(c, userMap)) });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          if (!cleanStr(body.name)) return sendJSON(res, 400, { error: '客户名称不能为空' });
          const rec = makeRecord('clients', body, user);
          await clientsCol.insertOne(rec);
          return sendJSON(res, 201, { item: attachOwner(rec, userMap) });
        }
      }
      let m = pathname.match(/^\/api\/clients\/(.+)$/);
      if (m) {
        const rec = await clientsCol.findOne({ id: m[1] });
        if (!rec) return sendJSON(res, 404, { error: '记录不存在' });
        if (rec.ownerId !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: '无权限' });
        if (method === 'PUT') {
          const body = await readBody(req);
          if (!cleanStr(body.name)) return sendJSON(res, 400, { error: '客户名称不能为空' });
          const userMap = await allUsersMap();
          const update = Object.assign(sanitizeClient(body), { updatedAt: new Date().toISOString() });
          await clientsCol.updateOne({ id: m[1] }, { $set: update });
          const updated = await clientsCol.findOne({ id: m[1] });
          return sendJSON(res, 200, { item: attachOwner(updated, userMap) });
        }
        if (method === 'DELETE') {
          await clientsCol.deleteOne({ id: m[1] });
          await projectsCol.updateMany({ clientId: m[1] }, { $set: { clientId: '', clientName: '(已删除客户)' } });
          return sendJSON(res, 200, { ok: true });
        }
      }

      // ---------- 项目 ----------
      if (pathname === '/api/projects') {
        const userMap = await allUsersMap();
        if (method === 'GET') {
          const list = user.role === 'admin'
            ? await projectsCol.find({}).toArray()
            : await projectsCol.find({ ownerId: user.id }).toArray();
          return sendJSON(res, 200, { items: list.map(p => attachOwner(p, userMap)) });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          if (!cleanStr(body.name)) return sendJSON(res, 400, { error: '项目名称不能为空' });
          const rec = makeRecord('projects', body, user);
          if (rec.clientId) {
            const c = await clientsCol.findOne({ id: rec.clientId });
            if (c) rec.clientName = c.name;
          }
          await projectsCol.insertOne(rec);
          return sendJSON(res, 201, { item: attachOwner(rec, userMap) });
        }
      }
      m = pathname.match(/^\/api\/projects\/(.+)$/);
      if (m) {
        const rec = await projectsCol.findOne({ id: m[1] });
        if (!rec) return sendJSON(res, 404, { error: '记录不存在' });
        if (rec.ownerId !== user.id && user.role !== 'admin') return sendJSON(res, 403, { error: '无权限' });
        if (method === 'PUT') {
          const body = await readBody(req);
          if (!cleanStr(body.name)) return sendJSON(res, 400, { error: '项目名称不能为空' });
          const userMap = await allUsersMap();
          const update = Object.assign(sanitizeProject(body), { updatedAt: new Date().toISOString() });
          if (update.clientId) {
            const c = await clientsCol.findOne({ id: update.clientId });
            update.clientName = c ? c.name : update.clientName;
          }
          await projectsCol.updateOne({ id: m[1] }, { $set: update });
          const updated = await projectsCol.findOne({ id: m[1] });
          return sendJSON(res, 200, { item: attachOwner(updated, userMap) });
        }
        if (method === 'DELETE') {
          await projectsCol.deleteOne({ id: m[1] });
          return sendJSON(res, 200, { ok: true });
        }
      }

      // ---------- 导出（CSV，Excel/WPS 可直接打开，中文带 BOM 不乱码）----------
      if (pathname === '/api/export' && method === 'GET') {
        const type = parsed.searchParams.get('type') || 'clients';
        const userMap = await allUsersMap();
        let headers, rows, filename;
        if (type === 'projects') {
          const list = user.role === 'admin'
            ? await projectsCol.find({}).toArray()
            : await projectsCol.find({ ownerId: user.id }).toArray();
          headers = ['项目名称', '客户', '阶段', '金额', '进度', '优先级', '状态', '预计关闭日期', '负责人', '备注'];
          rows = list.map(p => [
            p.name, p.clientName, p.stage, p.amount, p.progress, p.priority, p.status,
            p.expectedClose, userMap[p.ownerId] || '', p.notes
          ]);
          filename = '项目跟进导出';
        } else {
          const list = user.role === 'admin'
            ? await clientsCol.find({}).toArray()
            : await clientsCol.find({ ownerId: user.id }).toArray();
          const projCounts = {};
          (await projectsCol.find({}).toArray()).forEach(p => { if (p.clientId) projCounts[p.clientId] = (projCounts[p.clientId] || 0) + 1; });
          headers = ['客户名称', '公司', '联系人', '国家', '邮箱', '电话', '来源', '状态', '最近联系日期', '项目数', '负责人', '备注'];
          rows = list.map(c => [
            c.name, c.company, c.contact, c.country, c.email, c.phone, c.source, c.status,
            c.lastContactDate || '', projCounts[c.id] || 0,
            userMap[c.ownerId] || '', c.notes
          ]);
          filename = '客户追踪导出';
        }
        const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + encodeURIComponent(filename) + '.csv"'
        });
        res.end('﻿' + csv);
        return;
      }

      // ---------- 管理员 ----------
      if (user.role !== 'admin') return sendJSON(res, 403, { error: '需要管理员权限' });

      if (pathname === '/api/admin/overview' && method === 'GET') {
        return sendJSON(res, 200, await overview());
      }
      if (pathname === '/api/users' && method === 'GET') {
        const users = await usersCol.find({}).toArray();
        return sendJSON(res, 200, { items: users.map(publicUser) });
      }
      if (pathname === '/api/users' && method === 'POST') {
        const body = await readBody(req);
        const username = cleanStr(body.username);
        const password = cleanStr(body.password);
        const role = body.role === 'admin' ? 'admin' : 'user';
        if (!username) return sendJSON(res, 400, { error: '用户名不能为空' });
        if (password.length < 4) return sendJSON(res, 400, { error: '密码至少 4 位' });
        if (await usersCol.findOne({ username })) return sendJSON(res, 400, { error: '用户名已存在' });
        const { salt, hash } = hashPassword(password);
        const nu = { id: genId('u'), username, passwordHash: hash, passwordSalt: salt, role, createdAt: new Date().toISOString() };
        await usersCol.insertOne(nu);
        return sendJSON(res, 201, { user: publicUser(nu) });
      }
      m = pathname.match(/^\/api\/users\/(.+)\/password$/);
      if (m) {
        if (method === 'PUT') {
          const body = await readBody(req);
          const password = cleanStr(body.password);
          if (password.length < 4) return sendJSON(res, 400, { error: '密码至少 4 位' });
          const u = await usersCol.findOne({ id: m[1] });
          if (!u) return sendJSON(res, 404, { error: '用户不存在' });
          const { salt, hash } = hashPassword(password);
          await usersCol.updateOne({ id: m[1] }, { $set: { passwordSalt: salt, passwordHash: hash } });
          return sendJSON(res, 200, { ok: true });
        }
      }
      m = pathname.match(/^\/api\/users\/(.+)$/);
      if (m) {
        if (method === 'DELETE') {
          const u = await usersCol.findOne({ id: m[1] });
          if (!u) return sendJSON(res, 404, { error: '用户不存在' });
          if (u.id === user.id) return sendJSON(res, 400, { error: '不能删除自己的账号' });
          await usersCol.deleteOne({ id: m[1] });
          await clientsCol.deleteMany({ ownerId: m[1] });
          await projectsCol.deleteMany({ ownerId: m[1] });
          for (const [t, s] of sessions) if (s.userId === m[1]) sessions.delete(t);
          return sendJSON(res, 200, { ok: true });
        }
      }

      return sendJSON(res, 404, { error: '接口不存在' });
    }

    return serveStatic(pathname, res);
  } catch (err) {
    console.error('请求处理出错:', err);
    sendJSON(res, 500, { error: err.message || '服务器内部错误' });
  }
});

connectDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('✅ 海外项目跟进指南 已启动（MongoDB 版）: http://localhost:' + PORT);
  });
}).catch(err => {
  console.error('❌ 数据库连接失败，应用已退出:', err.message);
  process.exit(1);
});
