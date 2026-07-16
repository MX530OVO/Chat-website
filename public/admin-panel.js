const tokenKey = "cyber-chat-admin-token";
const deviceKey = "cyber-chat-device";

const adminParams = new URLSearchParams(location.search);
// Keep the owner login reachable before chat approval so the owner cannot be
// locked behind the gate they are responsible for managing.
const shouldMountAdmin = true;

if (shouldMountAdmin) {
const root = document.createElement("aside");
root.className = "floating-admin";
const shouldOpenAdmin =
  document.body.dataset.adminPanelOpen === "true" ||
  location.pathname.endsWith("/admin.html") ||
  adminParams.has("admin");
if (shouldOpenAdmin) root.classList.add("is-open");
root.innerHTML = `
  <section class="admin-glass" aria-label="管理员控制台">
    <header class="admin-glass-top">
      <div>
        <p class="eyebrow">OWNER OVERLAY</p>
        <h2>我的管理员控制台</h2>
      </div>
      <button class="ghost-button" data-admin-action="close" type="button">收起</button>
    </header>

    <form class="admin-inline-login" id="adminLoginForm">
      <label>
        <span>管理员口令</span>
        <input id="adminPassword" type="password" autocomplete="current-password" />
      </label>
      <button class="primary-button" type="submit">登录</button>
      <p class="system-note" id="adminNote">这是你的专属入口。登录后可审核用户、撤回消息和管理头像库。</p>
    </form>

    <section class="admin-overlay-board is-hidden" id="adminBoard">
      <div class="admin-toolbar">
        <button class="ghost-button" data-admin-action="refresh" type="button">刷新</button>
        <button class="danger-button" data-admin-action="clear-room" type="button">清屏</button>
        <button class="ghost-button" data-admin-action="logout" type="button">退出</button>
      </div>
      <p class="system-note" id="adminBoardNote">等待同步。</p>

      <div class="overlay-tabs" role="tablist">
        <button class="tab-button is-active" data-tab="pending" type="button">待审 <b id="pendingCount">0</b></button>
        <button class="tab-button" data-tab="users" type="button">用户 <b id="userCount">0</b></button>
        <button class="tab-button" data-tab="messages" type="button">消息 <b id="messageCount">0</b></button>
        <button class="tab-button" data-tab="private" type="button">私聊 <b id="privateMessageCount">0</b></button>
        <button class="tab-button" data-tab="avatars" type="button">头像 <b id="avatarCount">0</b></button>
      </div>

      <div class="overlay-pane is-active" id="pane-pending"></div>
      <div class="overlay-pane" id="pane-users"></div>
      <div class="overlay-pane" id="pane-messages"></div>
      <div class="overlay-pane" id="pane-private"></div>
      <div class="overlay-pane" id="pane-avatars"></div>
    </section>
  </section>
  <button class="admin-fab" data-admin-action="toggle" type="button" title="打开管理员控制台">管理</button>
`;
document.body.append(root);

const loginForm = root.querySelector("#adminLoginForm");
const adminBoard = root.querySelector("#adminBoard");
const adminNote = root.querySelector("#adminNote");
const boardNote = root.querySelector("#adminBoardNote");

let token = localStorage.getItem(tokenKey) || "";
let state = {
  pending: [],
  users: [],
  messages: [],
  privateMessages: [],
  avatars: [],
};
let selectedPrivateThread = "";

function setBoardNote(text) {
  boardNote.textContent = text;
}

function setLoggedIn(value) {
  root.classList.toggle("is-admin", value);
  loginForm.classList.toggle("is-hidden", value);
  adminBoard.classList.toggle("is-hidden", !value);
}

function headers(json = true) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${token}`,
  };
}

async function adminApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.form ? { Authorization: `Bearer ${token}` } : headers(options.json !== false)),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      token = "";
      localStorage.removeItem(tokenKey);
      setLoggedIn(false);
    }
    throw new Error(data.detail || data.error || "请求失败");
  }
  return data;
}

function timeText(ms) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function avatarImg(avatar) {
  const url = escapeHtml(avatar?.url || "");
  const label = escapeHtml(avatar?.label || "头像");
  return `<span class="ops-avatar"><img src="${url}" alt="${label}" loading="lazy"></span>`;
}

function empty(text) {
  return `<div class="ops-empty">${text}</div>`;
}

function actionButton(label, action, id, danger = false) {
  return `<button class="${danger ? "danger-button" : "ghost-button"}" data-admin-action="${action}" data-id="${id}" type="button">${label}</button>`;
}

function renderUsers(target, users, emptyText) {
  const pane = root.querySelector(target);
  if (!users.length) {
    pane.innerHTML = empty(emptyText);
    return;
  }
  pane.innerHTML = users.map((user) => `
    <article class="ops-item ${user.status} ${user.protected ? "protected" : ""}">
      ${avatarImg(user.avatar)}
      <div>
        <strong>${escapeHtml(user.nickname)}${user.protected ? " · 保护号" : ""}</strong>
        <p>${user.status} · ${user.online ? "在线" : "离线"} · ${timeText(user.updatedAt)}</p>
      </div>
      <div class="ops-actions">
        ${user.status !== "approved" ? actionButton("放行", "approve-user", user.id) : ""}
        ${user.status !== "rejected" ? actionButton("拒绝", "reject-user", user.id) : ""}
        ${actionButton(user.protected ? "取消保护" : "保护", "protect-user", user.id)}
        ${user.status !== "banned" && !user.protected ? actionButton("封禁", "ban-user", user.id, true) : ""}
      </div>
    </article>
  `).join("");
}

function renderMessages() {
  const pane = root.querySelector("#pane-messages");
  if (!state.messages.length) {
    pane.innerHTML = empty("暂无消息。");
    return;
  }
  pane.innerHTML = state.messages.map((message) => `
    <article class="ops-item ${message.revoked ? "revoked" : ""}">
      ${avatarImg(message.avatar)}
      <div>
        <strong>${escapeHtml(message.name)}</strong>
        <p>${escapeHtml(message.revoked ? "已撤回" : message.text)}</p>
        <p>${timeText(message.sentAt)}</p>
      </div>
      <div class="ops-actions">
        ${message.revoked ? "" : actionButton("撤回", "revoke-message", message.id, true)}
      </div>
    </article>
  `).join("");
}

function renderPrivateMessages() {
  const pane = root.querySelector("#pane-private");
  if (!state.privateMessages.length) {
    pane.innerHTML = empty("暂无私聊。");
    return;
  }

  const threads = new Map();
  for (const message of state.privateMessages) {
    const ids = [message.senderId, message.recipientId].sort((a, b) => a - b);
    const key = `${ids[0]}-${ids[1]}`;
    if (!threads.has(key)) {
      threads.set(key, {
        key,
        users: new Map(),
        messages: [],
      });
    }
    const thread = threads.get(key);
    thread.users.set(message.senderId, message.senderName);
    thread.users.set(message.recipientId, message.recipientName);
    thread.messages.push(message);
  }

  const threadList = Array.from(threads.values()).sort((a, b) => {
    const aLast = a.messages.at(-1)?.sentAt || 0;
    const bLast = b.messages.at(-1)?.sentAt || 0;
    return bLast - aLast;
  });

  if (!selectedPrivateThread || !threads.has(selectedPrivateThread)) {
    selectedPrivateThread = threadList[0]?.key || "";
  }

  const activeThread = threads.get(selectedPrivateThread) || threadList[0];
  const activeUsers = activeThread ? Array.from(activeThread.users.values()).join(" ↔ ") : "私聊";
  const activeMessages = activeThread?.messages || [];
  const leftSenderId = activeMessages[0]?.senderId;

  pane.innerHTML = `
    <section class="admin-private-view">
      <div class="admin-private-thread-list">
        ${threadList.map((thread) => {
          const users = Array.from(thread.users.values()).join(" ↔ ");
          const last = thread.messages.at(-1);
          return `
            <button class="admin-private-thread ${thread.key === selectedPrivateThread ? "is-active" : ""}" data-private-thread="${thread.key}" type="button">
              <strong>${escapeHtml(users)}</strong>
              <span>${escapeHtml(last?.revoked ? "已撤回" : last?.text || "")}</span>
              <small>${last ? timeText(last.sentAt) : ""} · ${thread.messages.length} 条</small>
            </button>
          `;
        }).join("")}
      </div>
      <div class="admin-private-chat" aria-label="私聊会话">
        <header>
          <p class="eyebrow">PRIVATE THREAD</p>
          <h3>${escapeHtml(activeUsers)}</h3>
        </header>
        <div class="admin-private-messages">
          ${activeMessages.map((message) => {
            const side = message.senderId === leftSenderId ? "left" : "right";
            return `
              <article class="admin-private-message ${side} ${message.revoked ? "revoked" : ""}">
                ${avatarImg(message.avatar)}
                <div class="admin-private-bubble">
                  <div class="admin-private-meta">
                    <strong>${escapeHtml(message.senderName)}</strong>
                    <time>${timeText(message.sentAt)}</time>
                  </div>
                  <p>${escapeHtml(message.revoked ? "已撤回" : message.text)}</p>
                  ${message.revoked ? "" : `<button class="danger-button mini-button" data-admin-action="revoke-private-message" data-id="${message.id}" type="button">撤回</button>`}
                </div>
              </article>
            `;
          }).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderAvatars() {
  const pane = root.querySelector("#pane-avatars");
  const list = state.avatars.length
    ? state.avatars.map((avatar) => `
      <article class="ops-item avatar-admin-item ${avatar.active ? "approved" : "banned"}">
        ${avatarImg(avatar)}
        <label>
          <span>名称</span>
          <input data-avatar-field="label" data-id="${avatar.id}" value="${escapeHtml(avatar.label)}">
        </label>
        <label>
          <span>排序</span>
          <input data-avatar-field="sortOrder" data-id="${avatar.id}" type="number" min="0" max="9999" value="${avatar.sortOrder}">
        </label>
        <div class="ops-actions">
          ${actionButton("保存", "save-avatar", avatar.id)}
          ${actionButton(avatar.active ? "停用" : "启用", "toggle-avatar", avatar.id, !avatar.active)}
        </div>
      </article>
    `).join("")
    : empty("头像库为空。");

  pane.innerHTML = `
    <form class="avatar-upload" id="avatarUploadForm">
      <label>
        <span>头像名称</span>
        <input name="label" maxlength="32" placeholder="例如：Joker" required>
      </label>
      <label>
        <span>图片文件</span>
        <input name="file" type="file" accept="image/png,image/jpeg,image/webp" required>
      </label>
      <button class="primary-button" type="submit">上传头像</button>
    </form>
    <div class="ops-list">${list}</div>
  `;
}

function renderAll() {
  root.querySelector("#pendingCount").textContent = state.pending.length;
  root.querySelector("#userCount").textContent = state.users.length;
  root.querySelector("#messageCount").textContent = state.messages.length;
  root.querySelector("#privateMessageCount").textContent = state.privateMessages.length;
  root.querySelector("#avatarCount").textContent = state.avatars.length;
  renderUsers("#pane-pending", state.pending, "暂无待审核申请。");
  renderUsers("#pane-users", state.users, "暂无用户。");
  renderMessages();
  renderPrivateMessages();
  renderAvatars();
}

async function refreshAdmin() {
  if (!token) return;
  setBoardNote("正在同步。");
  const [pending, users, messages, privateMessages, avatars] = await Promise.all([
    adminApi("/api/admin/pending"),
    adminApi("/api/admin/users"),
    adminApi("/api/admin/messages"),
    adminApi("/api/admin/private-messages"),
    adminApi("/api/admin/avatars"),
  ]);
  state = {
    pending: pending.users || [],
    users: users.users || [],
    messages: messages.messages || [],
    privateMessages: privateMessages.messages || [],
    avatars: avatars.avatars || [],
  };
  renderAll();
  setBoardNote("已同步。");
}

async function mutate(path, options = {}) {
  try {
    await adminApi(path, options);
    await refreshAdmin();
  } catch (error) {
    setBoardNote(error.message);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = root.querySelector("#adminPassword").value;
  adminNote.textContent = "正在登录。";
  try {
    const data = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, deviceId: localStorage.getItem(deviceKey) || null }),
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || "登录失败");
      return body;
    });
    token = data.token;
    localStorage.setItem(tokenKey, token);
    window.dispatchEvent(new CustomEvent("admin-protected-device"));
    setLoggedIn(true);
    await refreshAdmin();
  } catch (error) {
    adminNote.textContent = error.message;
  }
});

root.addEventListener("submit", async (event) => {
  if (event.target.id !== "avatarUploadForm") return;
  event.preventDefault();
  const form = new FormData(event.target);
  setBoardNote("正在上传头像。");
  try {
    await adminApi("/api/admin/avatars", {
      method: "POST",
      body: form,
      form: true,
    });
    event.target.reset();
    await refreshAdmin();
  } catch (error) {
    setBoardNote(error.message);
  }
});

root.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const action = button.dataset.adminAction;
  const id = button.dataset.id;

  if (button.dataset.tab) {
    root.querySelectorAll(".tab-button").forEach((item) => item.classList.toggle("is-active", item === button));
    root.querySelectorAll(".overlay-pane").forEach((pane) => pane.classList.remove("is-active"));
    root.querySelector(`#pane-${button.dataset.tab}`).classList.add("is-active");
    return;
  }

  if (button.dataset.privateThread) {
    selectedPrivateThread = button.dataset.privateThread;
    renderPrivateMessages();
    return;
  }

  if (action === "toggle") {
    root.classList.toggle("is-open");
    if (root.classList.contains("is-open") && token) refreshAdmin().catch((error) => setBoardNote(error.message));
    return;
  }
  if (action === "open-panel") {
    root.classList.add("is-open");
    if (token) refreshAdmin().catch((error) => setBoardNote(error.message));
    return;
  }
  if (action === "close") {
    root.classList.remove("is-open");
    return;
  }
  if (action === "logout") {
    token = "";
    localStorage.removeItem(tokenKey);
    setLoggedIn(false);
    return;
  }
  if (action === "refresh") {
    refreshAdmin().catch((error) => setBoardNote(error.message));
    return;
  }
  if (action === "clear-room") {
    mutate("/api/admin/room/clear", { method: "POST" });
    return;
  }
  if (action === "approve-user") mutate(`/api/admin/users/${id}/approve`, { method: "POST" });
  if (action === "reject-user") mutate(`/api/admin/users/${id}/reject`, { method: "POST" });
  if (action === "ban-user") mutate(`/api/admin/users/${id}/ban`, {
    method: "POST",
    body: JSON.stringify({ reason: "管理员封禁", includeIp: true }),
  });
  if (action === "protect-user") {
    const user = state.users.find((item) => String(item.id) === String(id));
    mutate(`/api/admin/users/${id}/protect`, {
      method: "POST",
      body: JSON.stringify({ protected: !user?.protected }),
    });
  }
  if (action === "revoke-message") mutate(`/api/admin/messages/${id}/revoke`, { method: "POST" });
  if (action === "revoke-private-message") mutate(`/api/admin/private-messages/${id}/revoke`, { method: "POST" });
  if (action === "toggle-avatar") {
    const avatar = state.avatars.find((item) => String(item.id) === String(id));
    mutate(`/api/admin/avatars/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: !avatar?.active }),
    });
  }
  if (action === "save-avatar") {
    const label = root.querySelector(`[data-avatar-field="label"][data-id="${CSS.escape(id)}"]`)?.value || "";
    const sortOrder = Number(root.querySelector(`[data-avatar-field="sortOrder"][data-id="${CSS.escape(id)}"]`)?.value || 0);
    mutate(`/api/admin/avatars/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ label, sortOrder }),
    });
  }
});

document.addEventListener("click", (event) => {
  const opener = event.target.closest('[data-admin-action="open-panel"]');
  if (!opener) return;
  // Let the relative ?admin=1 link reload the current page. This works both
  // through the local server and when index.html was opened as a file.
});

setLoggedIn(Boolean(token));
if (token && root.classList.contains("is-open")) {
  refreshAdmin().catch((error) => setBoardNote(error.message));
}
}
