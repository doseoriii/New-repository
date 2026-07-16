// ===================== 全局状态 =====================
let token = localStorage.getItem('token') || '';
let currentUser = null;
const state = { tab: 'clients', clients: [], projects: [], users: [], overview: null, pages: { clients: 1, projects: 1, adminUsers: 1, adminLogins: 1 } };

const CLIENT_STATUS = ['潜在客户', '接洽中', '样品阶段', '已成交', '已流失'];
const PROJECT_STAGE = ['线索', '需求确认', '方案设计', '报价', '商务谈判', '合同签署', '执行中', '已完成'];
const PROJECT_STATUS = ['进行中', '风险预警', '暂停', '已取消', '已完成'];
const PRIORITY = ['高', '中', '低'];
const PAGE_SIZE = 10;

// ===================== 工具 =====================
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
async function api(path, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json' });
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, opts);
  if (res.status === 401) { logout(); throw new Error('登录已失效，请重新登录'); }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + (type || '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}
// 导出数据：用 fetch 带鉴权拿 CSV，再以 Blob 触发下载（Excel/WPS 可直接打开）
async function exportData(type) {
  try {
    const res = await fetch('/api/export?type=' + type, { headers: { 'Authorization': 'Bearer ' + token } });
    if (res.status === 401) { logout(); throw new Error('登录已失效，请重新登录'); }
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (type === 'projects' ? '项目跟进导出' : '客户追踪导出') + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('已开始下载', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
function statusTag(v) { return v ? `<span class="tag-status s-${escapeHtml(v)}">${escapeHtml(v)}</span>` : '<span class="tag-status">—</span>'; }

// 分页工具：计算当前页并返回切片 + 页码信息
function getPage(list, key, pageSize = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  let page = state.pages[key] || 1;
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;
  state.pages[key] = page;
  const start = (page - 1) * pageSize;
  return { page, totalPages, items: list.slice(start, start + pageSize) };
}
function paginationHtml(key, page, totalPages) {
  if (totalPages <= 1) return '';
  return `
    <div class="pagination">
      <button class="btn btn-sm" data-page-prev="${key}" ${page === 1 ? 'disabled' : ''}>上一页</button>
      <span class="page-info">第 ${page} / ${totalPages} 页</span>
      <button class="btn btn-sm" data-page-next="${key}" ${page === totalPages ? 'disabled' : ''}>下一页</button>
    </div>`;
}

// ===================== 登录 =====================
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('login-username').value.trim(),
        password: document.getElementById('login-password').value
      })
    });
    token = data.token;
    localStorage.setItem('token', token);
    currentUser = data.user;
    document.getElementById('login-password').value = '';
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
});
document.getElementById('logout-btn').addEventListener('click', logout);
function logout() {
  if (token) { fetch('/api/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } }).catch(() => {}); }
  token = ''; localStorage.removeItem('token'); currentUser = null;
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('login-view').classList.remove('hidden');
}

// ===================== 应用骨架 =====================
function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  const roleBadge = currentUser.role === 'admin'
    ? '<span class="badge badge-admin">总管理员</span>'
    : '<span class="badge badge-user">成员</span>';
  document.getElementById('user-info').innerHTML =
    `你好，${escapeHtml(currentUser.username)} ${roleBadge}`;
  renderTabs();
  switchTab(state.tab);
}

function renderTabs() {
  const tabs = [{ id: 'clients', label: '👥 客户追踪' }, { id: 'projects', label: '📁 项目跟进' }];
  if (currentUser.role === 'admin') tabs.push({ id: 'admin', label: '🛡️ 管理员面板' });
  const bar = document.getElementById('tabbar');
  bar.innerHTML = tabs.map(t =>
    `<button class="tab ${t.id === state.tab ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');
  bar.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const content = document.getElementById('content');
  if (tab === 'clients') { loadClients(); }
  else if (tab === 'projects') { loadProjects(); }
  else if (tab === 'admin') { loadAdmin(); }
}

// ===================== 客户模块 =====================
async function loadClients() {
  const content = document.getElementById('content');
  content.innerHTML = `<div class="empty">加载中…</div>`;
  const [cData, pData] = await Promise.all([api('/api/clients'), api('/api/projects')]);
  state.clients = cData.items;
  state.projects = pData.items;
  renderClients();
}
function relatedProjectsOf(client) {
  if (!client) return [];
  return (state.projects || []).filter(p =>
    p.clientId === client.id || (!p.clientId && p.clientName && p.clientName === client.name)
  );
}

function renderClients() {
  const content = document.getElementById('content');
  const isAdmin = currentUser.role === 'admin';
  const kw = (document.getElementById('search')?.value || '').toLowerCase();
  const stFilter = document.getElementById('statusFilter')?.value || '';
  let list = state.clients.filter(c => {
    const matchKw = !kw || [c.name, c.company, c.contact, c.country, c.email].join(' ').toLowerCase().includes(kw);
    const matchSt = !stFilter || c.status === stFilter;
    return matchKw && matchSt;
  });
  const { page, totalPages, items } = getPage(list, 'clients');

  content.innerHTML = `
    <div class="module-head">
      <div class="module-title">客户追踪</div>
      <div class="toolbar">
        <input id="search" placeholder="搜索名称/公司/国家…" value="${escapeHtml(kw)}">
        <select id="statusFilter">
          <option value="">全部状态</option>
          ${CLIENT_STATUS.map(s => `<option value="${s}" ${stFilter === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="btn btn-primary" id="add-btn">+ 新增客户</button>
        <button class="btn" id="export-clients-btn">⬇ 导出</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>客户名称</th><th>公司</th><th>联系人</th><th>国家/地区</th>
          <th>跟进状态</th><th>最近联系</th>${isAdmin ? '<th>登记人</th>' : ''}<th>项目数</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${items.length ? items.map(c => {
            const rel = relatedProjectsOf(c);
            return `
            <tr>
              <td data-label="客户名称">${escapeHtml(c.name)}</td>
              <td data-label="公司">${escapeHtml(c.company)}</td>
              <td data-label="联系人">${escapeHtml(c.contact)}</td>
              <td data-label="国家/地区">${escapeHtml(c.country)}</td>
              <td data-label="跟进状态">${statusTag(c.status)}</td>
              <td data-label="最近联系">${escapeHtml(c.lastContactDate || '—')}</td>
              ${isAdmin ? `<td data-label="登记人">${escapeHtml(c.ownerName)}</td>` : ''}
              <td data-label="项目数"><span class="badge ${rel.length ? 'badge-primary' : 'badge-ghost'}" title="${rel.map(p => p.name).join('、')}">${rel.length}</span></td>
              <td data-label="操作"><div class="actions">
                <button class="btn btn-sm" data-edit="${c.id}">编辑</button>
                <button class="btn btn-sm btn-danger" data-del="${c.id}">删除</button>
              </div></td>
            </tr>`;
          }).join('') : `<tr><td colspan="${isAdmin ? 9 : 8}" class="empty">暂无客户，点击「新增客户」开始登记</td></tr>`}
        </tbody>
      </table>
      ${paginationHtml('clients', page, totalPages)}
    </div>`;
  document.getElementById('search').addEventListener('input', () => { state.pages.clients = 1; renderClients(); });
  document.getElementById('statusFilter').addEventListener('change', () => { state.pages.clients = 1; renderClients(); });
  document.getElementById('add-btn').addEventListener('click', () => openClientModal(null));
  document.getElementById('export-clients-btn').addEventListener('click', () => exportData('clients'));
  content.querySelector('[data-page-prev="clients"]')?.addEventListener('click', () => { state.pages.clients--; renderClients(); });
  content.querySelector('[data-page-next="clients"]')?.addEventListener('click', () => { state.pages.clients++; renderClients(); });
  content.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    openClientModal(state.clients.find(c => c.id === b.dataset.edit));
  }));
  content.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('确定删除该客户？关联的项目将解除客户关联。')) return;
    try { await api('/api/clients/' + b.dataset.del, { method: 'DELETE' }); toast('已删除', 'ok'); loadClients(); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

function openClientModal(rec) {
  const isEdit = !!rec;
  const v = rec || {};
  const rel = relatedProjectsOf(v);
  const relatedHtml = rel.length
    ? `<div class="client-projects"><div class="section-title">目前项目（${rel.length}）</div><div class="project-list">${rel.map(p => `<div class="project-chip"><span class="project-name">${escapeHtml(p.name)}</span><span class="tag-status s-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span><span class="project-stage">${escapeHtml(p.stage)}</span></div>`).join('')}</div></div>`
    : `<div class="client-projects"><div class="section-title">目前项目</div><div class="empty">暂无关联项目</div></div>`;
  openModal(isEdit ? '编辑客户' : '新增客户', `
    <div class="form-grid">
      <div class="full"><label>客户名称 *</label><input id="f-name" value="${escapeHtml(v.name)}" placeholder="如：ABC Trading Co."></div>
      <div><label>公司名称</label><input id="f-company" value="${escapeHtml(v.company)}"></div>
      <div><label>联系人</label><input id="f-contact" value="${escapeHtml(v.contact)}"></div>
      <div><label>国家/地区</label><input id="f-country" value="${escapeHtml(v.country)}" placeholder="如：越南"></div>
      <div><label>跟进状态</label>
        <select id="f-status">${CLIENT_STATUS.map(s => `<option ${v.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div><label>邮箱</label><input id="f-email" value="${escapeHtml(v.email)}"></div>
      <div><label>电话</label><input id="f-phone" value="${escapeHtml(v.phone)}"></div>
      <div><label>客户来源</label><input id="f-source" value="${escapeHtml(v.source)}" placeholder="如：展会/转介绍"></div>
      <div><label>最近联系日期</label><input id="f-lastContactDate" type="date" value="${escapeHtml(v.lastContactDate)}"></div>
      <div class="full"><label>备注</label><textarea id="f-notes">${escapeHtml(v.notes)}</textarea></div>
    </div>
    ${isEdit ? relatedHtml : ''}
  `, async () => {
    const body = {
      name: document.getElementById('f-name').value,
      company: document.getElementById('f-company').value,
      contact: document.getElementById('f-contact').value,
      country: document.getElementById('f-country').value,
      status: document.getElementById('f-status').value,
      email: document.getElementById('f-email').value,
      phone: document.getElementById('f-phone').value,
      source: document.getElementById('f-source').value,
      lastContactDate: document.getElementById('f-lastContactDate').value,
      notes: document.getElementById('f-notes').value
    };
    if (!body.name.trim()) { toast('客户名称不能为空', 'err'); return false; }
    try {
      if (isEdit) await api('/api/clients/' + rec.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/clients', { method: 'POST', body: JSON.stringify(body) });
      toast('已保存', 'ok'); closeModal(); loadClients();
    } catch (e) { toast(e.message, 'err'); return false; }
    return true;
  });
}

// ===================== 项目模块 =====================
async function loadProjects() {
  const content = document.getElementById('content');
  content.innerHTML = `<div class="empty">加载中…</div>`;
  const [pData, cData] = await Promise.all([api('/api/projects'), api('/api/clients')]);
  state.projects = pData.items;
  state.clients = cData.items;
  renderProjects();
}
function renderProjects() {
  const content = document.getElementById('content');
  const isAdmin = currentUser.role === 'admin';
  const kw = (document.getElementById('search')?.value || '').toLowerCase();
  const stFilter = document.getElementById('statusFilter')?.value || '';
  let list = state.projects.filter(p => {
    const matchKw = !kw || [p.name, p.clientName, p.stage, p.status].join(' ').toLowerCase().includes(kw);
    const matchSt = !stFilter || p.status === stFilter;
    return matchKw && matchSt;
  });
  const { page, totalPages, items } = getPage(list, 'projects');

  content.innerHTML = `
    <div class="module-head">
      <div class="module-title">项目跟进</div>
      <div class="toolbar">
        <input id="search" placeholder="搜索项目/客户…" value="${escapeHtml(kw)}">
        <select id="statusFilter">
          <option value="">全部状态</option>
          ${PROJECT_STATUS.map(s => `<option value="${s}" ${stFilter === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="btn btn-primary" id="add-btn">+ 新增项目</button>
        <button class="btn" id="export-projects-btn">⬇ 导出</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>项目名称</th><th>关联客户</th><th>阶段</th><th>金额</th>
          <th>进度</th><th>优先级</th><th>状态</th><th>预计成交</th>
          ${isAdmin ? '<th>登记人</th>' : ''}<th>操作</th>
        </tr></thead>
        <tbody>
          ${items.length ? items.map(p => `
            <tr>
              <td data-label="项目名称">${escapeHtml(p.name)}</td>
              <td data-label="关联客户">${escapeHtml(p.clientName)}</td>
              <td data-label="阶段">${escapeHtml(p.stage)}</td>
              <td data-label="金额">${escapeHtml(p.amount)}</td>
              <td data-label="进度"><span class="progress-bar"><span class="progress-fill" style="width:${Math.min(100, parseInt(p.progress) || 0)}%"></span></span><span class="progress-text">${escapeHtml(p.progress)}%</span></td>
              <td data-label="优先级" class="p-${escapeHtml(p.priority)}">${escapeHtml(p.priority)}</td>
              <td data-label="状态">${statusTag(p.status)}</td>
              <td data-label="预计成交">${escapeHtml(p.expectedClose)}</td>
              ${isAdmin ? `<td data-label="登记人">${escapeHtml(p.ownerName)}</td>` : ''}
              <td data-label="操作"><div class="actions">
                <button class="btn btn-sm" data-edit="${p.id}">编辑</button>
                <button class="btn btn-sm btn-danger" data-del="${p.id}">删除</button>
              </div></td>
            </tr>`).join('') : `<tr><td colspan="${isAdmin ? 10 : 9}" class="empty">暂无项目，点击「新增项目」开始登记</td></tr>`}
        </tbody>
      </table>
      ${paginationHtml('projects', page, totalPages)}
    </div>`;
  document.getElementById('search').addEventListener('input', () => { state.pages.projects = 1; renderProjects(); });
  document.getElementById('statusFilter').addEventListener('change', () => { state.pages.projects = 1; renderProjects(); });
  document.getElementById('add-btn').addEventListener('click', () => openProjectModal(null));
  document.getElementById('export-projects-btn').addEventListener('click', () => exportData('projects'));
  content.querySelector('[data-page-prev="projects"]')?.addEventListener('click', () => { state.pages.projects--; renderProjects(); });
  content.querySelector('[data-page-next="projects"]')?.addEventListener('click', () => { state.pages.projects++; renderProjects(); });
  content.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    openProjectModal(state.projects.find(p => p.id === b.dataset.edit));
  }));
  content.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('确定删除该项目？')) return;
    try { await api('/api/projects/' + b.dataset.del, { method: 'DELETE' }); toast('已删除', 'ok'); loadProjects(); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

function openProjectModal(rec) {
  const isEdit = !!rec;
  const v = rec || {};
  const clientOpts = state.clients.map(c => `<option value="${c.id}" ${v.clientId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  openModal(isEdit ? '编辑项目' : '新增项目', `
    <div class="form-grid">
      <div class="full"><label>项目名称 *</label><input id="f-name" value="${escapeHtml(v.name)}"></div>
      <div><label>关联客户</label><select id="f-clientId"><option value="">（无）</option>${clientOpts}</select></div>
      <div><label>项目阶段</label>
        <select id="f-stage">${PROJECT_STAGE.map(s => `<option ${v.stage === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div><label>金额</label><input id="f-amount" value="${escapeHtml(v.amount)}" placeholder="如：$50,000"></div>
      <div><label>优先级</label>
        <select id="f-priority">${PRIORITY.map(s => `<option ${v.priority === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div><label>跟进进度 (%)</label><input id="f-progress" type="number" min="0" max="100" value="${escapeHtml(v.progress)}"></div>
      <div><label>当前状态</label>
        <select id="f-status">${PROJECT_STATUS.map(s => `<option ${v.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div><label>预计成交日期</label><input id="f-expectedClose" type="date" value="${escapeHtml(v.expectedClose)}"></div>
      <div><label>下次跟进日期</label><input id="f-nextFollowUp" type="date" value="${escapeHtml(v.nextFollowUp)}"></div>
      <div class="full"><label>备注</label><textarea id="f-notes">${escapeHtml(v.notes)}</textarea></div>
    </div>
  `, async () => {
    const body = {
      name: document.getElementById('f-name').value,
      clientId: document.getElementById('f-clientId').value,
      stage: document.getElementById('f-stage').value,
      amount: document.getElementById('f-amount').value,
      priority: document.getElementById('f-priority').value,
      progress: document.getElementById('f-progress').value,
      status: document.getElementById('f-status').value,
      expectedClose: document.getElementById('f-expectedClose').value,
      nextFollowUp: document.getElementById('f-nextFollowUp').value,
      notes: document.getElementById('f-notes').value
    };
    if (!body.name.trim()) { toast('项目名称不能为空', 'err'); return false; }
    try {
      if (isEdit) await api('/api/projects/' + rec.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
      toast('已保存', 'ok'); closeModal(); loadProjects();
    } catch (e) { toast(e.message, 'err'); return false; }
    return true;
  });
}

// ===================== 管理员面板 =====================
async function loadAdmin() {
  const content = document.getElementById('content');
  content.innerHTML = `<div class="empty">加载中…</div>`;
  const [ov, users] = await Promise.all([api('/api/admin/overview'), api('/api/users')]);
  state.overview = ov; state.users = users.items;
  renderAdmin();
}
function renderAdmin() {
  const content = document.getElementById('content');
  const ov = state.overview;
  const usersPage = getPage(state.users, 'adminUsers');
  const loginsPage = getPage(ov.recentLogins, 'adminLogins');

  content.innerHTML = `
    <div class="module-head"><div class="module-title">管理员面板</div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-num">${ov.totals.users}</div><div class="stat-label">成员总数</div></div>
      <div class="stat-card"><div class="stat-num">${ov.totals.clients}</div><div class="stat-label">客户总数</div></div>
      <div class="stat-card"><div class="stat-num">${ov.totals.projects}</div><div class="stat-label">项目总数</div></div>
    </div>

    <div class="section-title">成员数据概览</div>
    <div class="table-wrap" style="margin-bottom:22px">
      <table><thead><tr><th>用户名</th><th>角色</th><th>客户数</th><th>项目数</th></tr></thead>
      <tbody>${ov.perUser.map(u => `<tr>
        <td data-label="用户名">${escapeHtml(u.username)}</td>
        <td data-label="角色">${u.role === 'admin' ? '<span class="badge badge-admin">总管理员</span>' : '<span class="badge badge-user">成员</span>'}</td>
        <td data-label="客户数">${u.clients}</td><td data-label="项目数">${u.projects}</td>
      </tr>`).join('')}</tbody></table>
    </div>

    <div class="section-title">成员管理</div>
    <div class="toolbar" style="margin-bottom:12px">
      <button class="btn btn-primary" id="add-user-btn">+ 新增成员</button>
    </div>
    <div class="table-wrap" style="margin-bottom:22px">
      <table><thead><tr><th>用户名</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${usersPage.items.length ? usersPage.items.map(u => `<tr>
        <td data-label="用户名">${escapeHtml(u.username)}</td>
        <td data-label="角色">${u.role === 'admin' ? '<span class="badge badge-admin">总管理员</span>' : '<span class="badge badge-user">成员</span>'}</td>
        <td data-label="创建时间">${escapeHtml((u.createdAt || '').slice(0, 10))}</td>
        <td data-label="操作"><div class="actions">
          <button class="btn btn-sm" data-pw="${u.id}">改密码</button>
          ${u.id !== currentUser.id ? `<button class="btn btn-sm btn-danger" data-deluser="${u.id}">删除</button>` : ''}
        </div></td>
      </tr>`).join('') : `<tr><td colspan="4" class="empty">暂无成员</td></tr>`}</tbody></table>
      ${paginationHtml('adminUsers', usersPage.page, usersPage.totalPages)}
    </div>

    <div class="section-title">最近登录记录</div>
    <div class="table-wrap">
      <table><thead><tr><th>用户名</th><th>登录时间</th></tr></thead>
      <tbody>${loginsPage.items.length ? loginsPage.items.map(l => `<tr>
        <td data-label="用户名">${escapeHtml(l.username)}</td><td data-label="登录时间">${escapeHtml(l.at)}</td>
      </tr>`).join('') : `<tr><td colspan="2" class="empty">暂无登录记录</td></tr>`}</tbody></table>
      ${paginationHtml('adminLogins', loginsPage.page, loginsPage.totalPages)}
    </div>`;

  document.getElementById('add-user-btn').addEventListener('click', openAddUserModal);
  content.querySelector('[data-page-prev="adminUsers"]')?.addEventListener('click', () => { state.pages.adminUsers--; renderAdmin(); });
  content.querySelector('[data-page-next="adminUsers"]')?.addEventListener('click', () => { state.pages.adminUsers++; renderAdmin(); });
  content.querySelector('[data-page-prev="adminLogins"]')?.addEventListener('click', () => { state.pages.adminLogins--; renderAdmin(); });
  content.querySelector('[data-page-next="adminLogins"]')?.addEventListener('click', () => { state.pages.adminLogins++; renderAdmin(); });
  content.querySelectorAll('[data-pw]').forEach(b => b.addEventListener('click', () => openPasswordModal(b.dataset.pw)));
  content.querySelectorAll('[data-deluser]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('确定删除该成员？其登记的所有客户与项目也会一并删除。')) return;
    try { await api('/api/users/' + b.dataset.deluser, { method: 'DELETE' }); toast('已删除成员', 'ok'); loadAdmin(); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

function openAddUserModal() {
  openModal('新增成员', `
    <div class="form-grid">
      <div class="full"><label>用户名 *</label><input id="u-name" placeholder="登录账号"></div>
      <div><label>密码 *（至少 4 位）</label><input id="u-pw" type="text" placeholder="初始密码"></div>
      <div><label>角色</label>
        <select id="u-role"><option value="user">普通成员</option><option value="admin">总管理员</option></select>
      </div>
    </div>
  `, async () => {
    const body = {
      username: document.getElementById('u-name').value,
      password: document.getElementById('u-pw').value,
      role: document.getElementById('u-role').value
    };
    if (!body.username.trim()) { toast('用户名不能为空', 'err'); return false; }
    if (body.password.length < 4) { toast('密码至少 4 位', 'err'); return false; }
    try { await api('/api/users', { method: 'POST', body: JSON.stringify(body) }); toast('成员已创建', 'ok'); closeModal(); loadAdmin(); }
    catch (e) { toast(e.message, 'err'); return false; }
    return true;
  });
}
function openPasswordModal(userId) {
  openModal('修改密码', `
    <div class="form-grid">
      <div class="full"><label>新密码 *（至少 4 位）</label><input id="p-pw" type="text" placeholder="请输入新密码"></div>
    </div>
  `, async () => {
    const pw = document.getElementById('p-pw').value;
    if (pw.length < 4) { toast('密码至少 4 位', 'err'); return false; }
    try { await api('/api/users/' + userId + '/password', { method: 'PUT', body: JSON.stringify({ password: pw }) }); toast('密码已更新', 'ok'); closeModal(); }
    catch (e) { toast(e.message, 'err'); return false; }
    return true;
  });
}

// ===================== 弹窗基础 =====================
function openModal(title, bodyHtml, onSave) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-mask" id="mask">
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        ${bodyHtml}
        <div class="modal-actions">
          <button class="btn btn-ghost" id="m-cancel">取消</button>
          <button class="btn btn-primary" id="m-save">保存</button>
        </div>
      </div>
    </div>`;
  document.getElementById('mask').addEventListener('click', (e) => { if (e.target.id === 'mask') closeModal(); });
  document.getElementById('m-cancel').addEventListener('click', closeModal);
  document.getElementById('m-save').addEventListener('click', async () => {
    const ok = await onSave();
    if (ok === false) return;
    closeModal();
  });
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

// ===================== 启动 =====================
(async function init() {
  if (!token) return;
  try {
    const data = await api('/api/me');
    currentUser = data.user;
    showApp();
  } catch (e) { logout(); }
})();
