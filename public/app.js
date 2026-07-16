const gatePanel = document.querySelector("#gatePanel");
const gateForm = document.querySelector("#gateForm");
const gateNote = document.querySelector("#gateNote");
const nicknameInput = document.querySelector("#nickname");
const avatarGrid = document.querySelector("#avatarGrid");
const chatPanel = document.querySelector("#chatPanel");
const chatName = document.querySelector("#chatName");
const composer = document.querySelector("#composer");
const messageText = document.querySelector("#messageText");
const messagesEl = document.querySelector("#messages");
const phonePreview = document.querySelector("#phonePreview");
const phoneMonth = document.querySelector("#phoneMonth");
const phoneDay = document.querySelector("#phoneDay");
const phoneWeekday = document.querySelector("#phoneWeekday");
const phoneDayPeriod = document.querySelector("#phoneDayPeriod");
const phoneTimeIcon = document.querySelector("#phoneTimeIcon");
const chatNote = document.querySelector("#chatNote");
const connectionStatus = document.querySelector("#connectionStatus");
const worldLabel = document.querySelector("#worldLabel");
const contactList = document.querySelector("#contactList");
const onlineRoster = document.querySelector("#onlineRoster");
const refreshContacts = document.querySelector("#refreshContacts");
const publicChannelButton = document.querySelector("#publicChannelButton");
const publicChannelHeaderButton = document.querySelector("#publicChannelHeaderButton");
const messageFieldLabel = document.querySelector(".message-field span");
const sendButton = document.querySelector(".send-button");

const storage = {
  device: "cyber-chat-device",
  nickname: "cyber-chat-nickname",
  mood: "cyber-chat-mood",
  avatar: "cyber-chat-avatar",
  adminToken: "cyber-chat-admin-token",
};

const moodFallbacks = new Map([
  ["ember", "ember"],
  ["star", "star"],
  ["fog", "star"],
  ["moon", "star"],
]);

let source;
let session;
let rendered = new Set();
let avatars = [];
let selectedAvatarId = Number(localStorage.getItem(storage.avatar) || 0) || null;
let fallbackPoll;
let contacts = [];
let currentPeer = null;
let knownPeers = new Map();
let contactsPoll;
let previewMessages = [];

function normalizeMood(mood) {
  return moodFallbacks.get(mood) || "star";
}

function createDeviceId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function deviceId() {
  let value = localStorage.getItem(storage.device);
  if (!value) {
    value = createDeviceId();
    localStorage.setItem(storage.device, value);
  }
  return value;
}

function hashCode(value, length = 3) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36).toUpperCase().padStart(length, "0").slice(0, length);
}

function regionCode() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const language = navigator.language || "";
  const knownZones = new Map([
    ["Asia/Shanghai", "CN"],
    ["Asia/Hong_Kong", "HK"],
    ["Asia/Taipei", "TW"],
    ["Asia/Tokyo", "JP"],
    ["Asia/Seoul", "KR"],
    ["America/New_York", "US-E"],
    ["America/Los_Angeles", "US-W"],
    ["Europe/London", "GB"],
    ["Europe/Paris", "EU"],
  ]);
  if (knownZones.has(timezone)) return knownZones.get(timezone);
  const localeRegion = language.match(/-([A-Z]{2})\b/i)?.[1];
  return localeRegion ? localeRegion.toUpperCase() : "RGX";
}

function networkCode() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const type = connection?.effectiveType || connection?.type || "";
  return {
    "slow-2g": "S2G",
    "2g": "2G",
    "3g": "3G",
    "4g": "4G",
    "5g": "5G",
    wifi: "WIFI",
    ethernet: "LAN",
    cellular: "CELL",
  }[String(type).toLowerCase()] || "NET";
}

function updateWorldLabel() {
  if (!worldLabel) return;
  const region = regionCode();
  const network = networkCode();
  const server = hashCode(location.host || "local", 3);
  const device = hashCode(deviceId(), 3);
  worldLabel.textContent = `世界线坐标 · NAV-${region}-${network}-S${server}-D${device}`;
  worldLabel.title = "NAV 编码由地区时区、网络类型、当前服务器地址和本机设备码生成，不包含精确位置。";
}

function setStatus(mode, text) {
  connectionStatus.className = `status-chip ${mode}`;
  connectionStatus.querySelector("b").textContent = text;
}

function formatTime(ms) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

function statusText(value) {
  return {
    pending: "申请已提交，等待管理员批准。",
    approved: "已进入频道。",
    rejected: "申请已被拒绝。请联系管理员。",
    banned: "本设备已被封禁。",
  }[value] || "未知状态。";
}

function selectedAvatar() {
  return avatars.find((avatar) => avatar.id === selectedAvatarId) || avatars[0] || null;
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

function personaCutoutUrl(url) {
  const match = String(url || "").match(/(persona-\d{2}-[a-z0-9-]+)\.jpg(?:\?.*)?$/i);
  return match ? `/assets/avatar-cutouts/${match[1]}.png` : null;
}

function isOwnMessage(message) {
  const authorId = message?.userId ?? message?.senderId;
  const sameAccount = authorId != null && session?.id != null && String(authorId) === String(session.id);
  const sameProtectedOwner = Boolean(session?.protected && message?.authorProtected);
  return sameAccount || sameProtectedOwner;
}

function privateThreadMatches(message) {
  return currentPeer && (
    (message.senderId === session?.id && message.recipientId === currentPeer.id) ||
    (message.senderId === currentPeer.id && message.recipientId === session?.id)
  );
}

function peerFromMessage(message) {
  const authorId = message.userId ?? message.senderId;
  if (!authorId || isOwnMessage(message)) return null;
  const peer = contacts.find((user) => user.id === authorId) || {
    id: authorId,
    nickname: message.name || message.senderName || "私聊",
    avatar: message.avatar || null,
    online: false,
  };
  knownPeers.set(String(peer.id), peer);
  return peer;
}

function renderContacts() {
  if (!contactList) return;
  const visibleContacts = [...contacts];
  if (currentPeer && !visibleContacts.some((user) => user.id === currentPeer.id)) {
    visibleContacts.unshift(currentPeer);
  }
  if (!visibleContacts.length) {
    contactList.innerHTML = `<p class="contact-empty">暂无可私聊用户</p>`;
    return;
  }
  contactList.innerHTML = visibleContacts.map((user) => `
    <button class="contact-button ${currentPeer?.id === user.id ? "is-active" : ""}" data-peer-id="${user.id}" type="button">
      <img src="${escapeHtml(user.avatar?.url || "")}" alt="" loading="lazy">
      <span>${escapeHtml(user.nickname)}</span>
      <b>${user.online ? "在线" : "离线"}</b>
    </button>
  `).join("");
}

function renderOnlineRoster() {
  if (!onlineRoster) return;
  const onlineUsers = [];
  if (session?.status === "approved") onlineUsers.push({ ...session, online: true, isSelf: true });
  contacts.filter((user) => user.online).forEach((user) => onlineUsers.push(user));
  if (!onlineUsers.length) {
    onlineRoster.innerHTML = `<p class="online-roster-empty">等待成员上线</p>`;
    return;
  }
  onlineRoster.innerHTML = `
    <div class="online-roster-track">
      ${onlineUsers.map((user, index) => `
        <button class="online-member ${user.isSelf ? "is-self" : ""}" ${user.isSelf ? `aria-current="true"` : `data-peer-id="${user.id}"`} type="button" title="${escapeHtml(user.isSelf ? `${user.nickname}（我）` : `私聊 ${user.nickname}`)}" style="--tilt:${index % 2 ? "3deg" : "-3deg"}">
          <img src="${escapeHtml(user.avatar?.url || "")}" alt="${escapeHtml(user.nickname)}" loading="lazy">
          <span>${escapeHtml(user.nickname)}</span><i aria-hidden="true"></i>
        </button>`).join("")}
    </div>
    <strong class="online-roster-count">ONLINE<br>${onlineUsers.length}</strong>`;
}

function updatePhoneCalendar() {
  if (!phoneMonth) return;
  const now = new Date();
  const hour = now.getHours();
  const period = hour < 5 ? ["夜晚", "night"]
    : hour < 9 ? ["早晨", "morning"]
      : hour < 12 ? ["上午", "morning"]
        : hour < 14 ? ["中午", "day"]
          : hour < 18 ? ["下午", "day"]
            : hour < 20 ? ["傍晚", "evening"] : ["夜晚", "night"];
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  phoneMonth.textContent = String(now.getMonth() + 1).padStart(2, "0");
  phoneDay.textContent = String(now.getDate()).padStart(2, "0");
  phoneWeekday.textContent = weekdays[now.getDay()];
  phoneDayPeriod.textContent = period[0];
  phoneTimeIcon.className = `phone-time-icon is-${period[1]}`;
}

async function loadContacts() {
  if (session?.status !== "approved") return;
  try {
    const data = await api(`/api/contacts?deviceId=${encodeURIComponent(deviceId())}`);
    contacts = data.users || [];
    contacts.forEach((user) => knownPeers.set(String(user.id), user));
    renderContacts();
    renderOnlineRoster();
  } catch {
    contacts = [];
    renderContacts();
    renderOnlineRoster();
  }
}

function setPublicMode() {
  currentPeer = null;
  publicChannelButton?.classList.add("is-active");
  if (messageFieldLabel) messageFieldLabel.textContent = "频道讯息";
  if (messageText) messageText.placeholder = "输入消息，Enter 发送，Shift + Enter 换行";
  if (sendButton) sendButton.textContent = "发送";
  renderContacts();
  fetchHistory();
}

function setPrivateMode(peer) {
  currentPeer = peer;
  knownPeers.set(String(peer.id), peer);
  publicChannelButton?.classList.remove("is-active");
  if (messageFieldLabel) messageFieldLabel.textContent = `私聊给 ${peer.nickname}`;
  if (messageText) messageText.placeholder = `发给 ${peer.nickname}`;
  if (sendButton) sendButton.textContent = "私聊发送";
  renderContacts();
  fetchHistory();
}

function setPrivateModeFromHistory(peer, messages = []) {
  currentPeer = peer;
  knownPeers.set(String(peer.id), peer);
  publicChannelButton?.classList.remove("is-active");
  if (messageFieldLabel) messageFieldLabel.textContent = `私聊给 ${peer.nickname}`;
  if (messageText) messageText.placeholder = `发给 ${peer.nickname}`;
  if (sendButton) sendButton.textContent = "私聊发送";
  renderContacts();
  renderHistory(messages);
  chatNote.textContent = `正在私聊：${peer.nickname}`;
  messageText.focus();
}

function renderAvatars() {
  avatarGrid.innerHTML = "";
  if (!avatars.length) {
    const empty = document.createElement("p");
    empty.className = "avatar-empty";
    empty.textContent = "头像库正在同步。";
    avatarGrid.append(empty);
    return;
  }

  if (!selectedAvatarId || !avatars.some((avatar) => avatar.id === selectedAvatarId)) {
    selectedAvatarId = avatars[0].id;
  }
  localStorage.setItem(storage.avatar, String(selectedAvatarId));

  avatars.forEach((avatar) => {
    const label = document.createElement("label");
    label.className = "avatar-choice";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "avatarId";
    input.value = String(avatar.id);
    input.checked = avatar.id === selectedAvatarId;

    const img = document.createElement("img");
    img.src = avatar.url;
    img.alt = avatar.label;
    img.loading = "lazy";

    const name = document.createElement("span");
    name.textContent = avatar.label;

    input.addEventListener("change", () => {
      selectedAvatarId = avatar.id;
      localStorage.setItem(storage.avatar, String(selectedAvatarId));
    });

    label.append(input, img, name);
    avatarGrid.append(label);
  });
}

async function loadAvatars() {
  try {
    const data = await api("/api/avatars");
    avatars = data.avatars || [];
    renderAvatars();
  } catch {
    avatars = [];
    renderAvatars();
    gateNote.textContent = "头像库同步失败，请稍后重试。";
  }
}

function showGate(text) {
  gatePanel.classList.remove("is-hidden");
  chatPanel.classList.add("is-hidden");
  gateNote.textContent = text;
}

function showChat() {
  gatePanel.classList.add("is-hidden");
  chatPanel.classList.remove("is-hidden");
  chatName.value = session?.nickname || nicknameInput.value || "";
  messageText.focus();
}

function applySession(nextSession) {
  session = nextSession;
  renderOnlineRoster();
  if (!session) {
    showGate("请输入代号并提交审核。");
    return;
  }

  nicknameInput.value = session.nickname || "";
  chatName.value = session.nickname || "";
  localStorage.setItem(storage.nickname, session.nickname || "");
  if (session.avatar?.id) {
    selectedAvatarId = session.avatar.id;
    localStorage.setItem(storage.avatar, String(selectedAvatarId));
    renderAvatars();
  }

  if (session.status === "approved") {
    setStatus("online", "已放行");
    showChat();
    loadContacts();
    fetchHistory();
    return;
  }

  setStatus(session.status === "pending" ? "pending" : "blocked", statusText(session.status));
  showGate(statusText(session.status));
}

function renderEmpty() {
  if (!messagesEl.children.length) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "频道暂时安静。第一条消息会在这里亮起。";
    messagesEl.append(item);
  }
}

function renderPhonePreview(messages = previewMessages) {
  if (!phonePreview) return;
  const items = messages.filter(Boolean).slice(-5);
  if (!items.length) {
    phonePreview.innerHTML = `<li class="phone-preview-empty">等待频道同步</li>`;
    return;
  }
  phonePreview.innerHTML = items.map((message) => {
    const authorId = message.userId ?? message.senderId;
    const mine = isOwnMessage(message);
    const name = message.name || message.senderName || "匿名访客";
    const text = message.revoked ? "已撤回" : message.text;
    const avatar = message.avatar?.url || selectedAvatar()?.url || "";
    return `
      <li class="${mine ? "mine" : ""}">
        <img src="${escapeHtml(avatar)}" alt="">
        <div>
          <strong>${escapeHtml(name)}</strong>
          <p>${escapeHtml(text)}</p>
        </div>
      </li>
    `;
  }).join("");
  phonePreview.scrollTop = phonePreview.scrollHeight;
}

function removeEmpty() {
  messagesEl.querySelector(".empty")?.remove();
}

function renderHistory(messages) {
  messagesEl.innerHTML = "";
  rendered = new Set();
  previewMessages = messages || [];
  renderPhonePreview();
  messages.forEach(renderMessage);
  renderEmpty();
}

function renderMessage(message) {
  if (!message || rendered.has(message.id)) return;
  rendered.add(message.id);
  if (!previewMessages.some((item) => item.id === message.id)) {
    previewMessages.push(message);
    renderPhonePreview();
  }
  removeEmpty();

  const item = document.createElement("li");
  item.className = `message ${normalizeMood(message.mood)}`;
  item.dataset.id = message.id;
  const authorId = message.userId ?? message.senderId;
  if (isOwnMessage(message)) item.classList.add("mine");
  if (message.revoked) item.classList.add("revoked");

  const peer = peerFromMessage(message);
  const avatarWrap = document.createElement(peer ? "button" : "div");
  avatarWrap.className = "message-avatar";
  if (peer) {
    avatarWrap.type = "button";
    avatarWrap.classList.add("is-clickable");
    avatarWrap.dataset.peerId = String(peer.id);
    avatarWrap.title = `私聊 ${peer.nickname}`;
  }
  const avatarImg = document.createElement("img");
  const avatarUrl = message.avatar?.url || selectedAvatar()?.url || "";
  const cutoutUrl = personaCutoutUrl(avatarUrl);
  avatarImg.src = cutoutUrl || avatarUrl;
  avatarImg.alt = message.avatar?.label || "头像";
  avatarImg.loading = "lazy";
  if (cutoutUrl) {
    avatarWrap.classList.add("has-cutout");
    avatarImg.classList.add("avatar-cutout");
    avatarWrap.style.setProperty("--avatar-backdrop", `url("${avatarUrl}")`);
  }
  avatarWrap.append(avatarImg);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const meta = document.createElement("div");
  meta.className = "meta";

  const name = document.createElement("strong");
  name.textContent = message.name || "匿名访客";

  const time = document.createElement("time");
  time.dateTime = new Date(message.sentAt).toISOString();
  time.textContent = formatTime(message.sentAt);

  if (peer) {
    const privateButton = document.createElement("button");
    privateButton.className = "mini-private-button";
    privateButton.type = "button";
    privateButton.dataset.peerId = String(peer.id);
    privateButton.textContent = "私聊";
    meta.append(name, privateButton, time);
  } else {
    meta.append(name, time);
  }

  const text = document.createElement("p");
  text.textContent = message.revoked ? "已撤回" : message.text;

  const emphasisMatch = !message.revoked && String(message.text || "").match(/[!?！？]/);
  if (emphasisMatch) {
    const emphasis = document.createElement("span");
    emphasis.className = "message-emphasis";
    emphasis.textContent = /[?？]/.test(emphasisMatch[0]) ? "?" : "!";
    emphasis.setAttribute("aria-label", emphasis.textContent === "?" ? "疑问" : "强调");
    bubble.classList.add("has-emphasis");
    bubble.append(meta, text, emphasis);
  } else {
    bubble.append(meta, text);
  }
  item.append(avatarWrap, bubble);
  messagesEl.append(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function applyRevoke(message) {
  const item = messagesEl.querySelector(`[data-id="${CSS.escape(message.id)}"]`);
  if (!item) return;
  item.classList.add("revoked");
  item.querySelector("p").textContent = "已撤回";
  previewMessages = previewMessages.map((item) => item.id === message.id ? { ...item, revoked: true, text: "已撤回" } : item);
  renderPhonePreview();
}

function openPrivateFromId(peerId) {
  if (!session || session.status !== "approved") return;
  const peer = contacts.find((user) => String(user.id) === String(peerId)) || knownPeers.get(String(peerId));
  if (peer) {
    setPrivateMode(peer);
    return;
  }
  api(`/api/private/history?deviceId=${encodeURIComponent(deviceId())}&peerId=${encodeURIComponent(peerId)}`)
    .then((data) => {
      if (data.peer) setPrivateModeFromHistory(data.peer, data.messages || []);
    })
    .catch(() => loadContacts().then(() => {
    const loadedPeer = contacts.find((user) => String(user.id) === String(peerId));
    if (loadedPeer) setPrivateMode(loadedPeer);
  }));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || "请求失败");
  return data;
}

async function requestSession(nickname, avatarId = null) {
  const data = await api("/api/session", {
    method: "POST",
    body: JSON.stringify({
      deviceId: deviceId(),
      nickname,
      avatarId,
      adminToken: localStorage.getItem(storage.adminToken) || null,
    }),
  });
  applySession(data.session);
  connectEvents();
}

async function fetchHistory() {
  if (session?.status !== "approved") return;
  try {
    const path = currentPeer
      ? `/api/private/history?deviceId=${encodeURIComponent(deviceId())}&peerId=${encodeURIComponent(currentPeer.id)}`
      : `/api/history?deviceId=${encodeURIComponent(deviceId())}`;
    const data = await api(path);
    renderHistory(data.messages || []);
    chatNote.textContent = currentPeer ? `正在私聊：${currentPeer.nickname}` : "频道已同步。";
  } catch (error) {
    chatNote.textContent = error.message;
  }
}

function connectEvents() {
  source?.close();
  source = new EventSource(`/events?deviceId=${encodeURIComponent(deviceId())}`);

  source.onopen = () => {
    stopFallbackPolling();
    setStatus(session?.status === "approved" ? "online" : "pending", "已连接");
  };

  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "session") applySession(payload.session);
    if (payload.type === "hello" && !currentPeer) renderHistory(payload.messages || []);
    if (payload.type === "message" && !currentPeer) renderMessage(payload.message);
    if (payload.type === "revoke") applyRevoke(payload.message);
    if (payload.type === "private-message") {
      loadContacts();
      if (privateThreadMatches(payload.message)) renderMessage(payload.message);
    }
    if (payload.type === "private-revoke" && privateThreadMatches(payload.message)) applyRevoke(payload.message);
    if (payload.type === "clear") {
      if (currentPeer) return;
      messagesEl.innerHTML = "";
      rendered = new Set();
      renderEmpty();
      chatNote.textContent = "管理员已清空当前频道显示。";
    }
  };

  source.onerror = () => {
    startFallbackPolling();
    setStatus("blocked", "重连中");
    if (session?.status === "approved") chatNote.textContent = "连接断开，正在重新定位频道。";
  };
}

function startFallbackPolling() {
  if (fallbackPoll) return;
  fallbackPoll = window.setInterval(async () => {
    const nickname = chatName.value.trim() || nicknameInput.value.trim() || session?.nickname || "";
    if (!nickname) return;
    try {
      const avatar = selectedAvatar();
      const data = await api("/api/session", {
        method: "POST",
        body: JSON.stringify({
          deviceId: deviceId(),
          nickname,
          avatarId: avatar?.id || selectedAvatarId,
          adminToken: localStorage.getItem(storage.adminToken) || null,
        }),
      });
      applySession(data.session);
    } catch {
      // This is only a fallback for tunnels that cannot keep EventSource open.
    }
  }, 3500);
}

function stopFallbackPolling() {
  if (!fallbackPoll) return;
  window.clearInterval(fallbackPoll);
  fallbackPoll = null;
}

async function sendMessage() {
  const text = messageText.value.trim();
  if (!text || session?.status !== "approved") return;

  const nickname = chatName.value.trim().slice(0, 18) || session.nickname;
  localStorage.setItem(storage.nickname, nickname);

  const mood = normalizeMood(new FormData(composer).get("mood"));
  localStorage.setItem(storage.mood, mood);

  composer.querySelector(".send-button").disabled = true;
  try {
    if (nickname !== session.nickname) {
      await requestSession(nickname);
    }
    const path = currentPeer ? "/api/private/messages" : "/api/messages";
    const body = currentPeer
      ? { deviceId: deviceId(), recipientId: currentPeer.id, text, mood }
      : { deviceId: deviceId(), text, mood };
    await api(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    messageText.value = "";
    messageText.style.height = "";
    chatNote.textContent = currentPeer ? "私聊已发送。" : "消息已发送。";
  } catch (error) {
    chatNote.textContent = error.message;
  } finally {
    composer.querySelector(".send-button").disabled = false;
    messageText.focus();
  }
}

gateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const nickname = nicknameInput.value.trim();
  if (!nickname) return;
  const avatar = selectedAvatar();
  if (!avatar) {
    gateNote.textContent = "请选择一个头像后再提交。";
    return;
  }
  gateNote.textContent = "正在提交审核。";
  requestSession(nickname, avatar.id).catch((error) => {
    gateNote.textContent = error.message;
  });
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

publicChannelButton?.addEventListener("click", setPublicMode);
publicChannelHeaderButton?.addEventListener("click", setPublicMode);

refreshContacts?.addEventListener("click", () => {
  loadContacts();
});

contactList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-peer-id]");
  if (!button) return;
  const peer = contacts.find((user) => String(user.id) === String(button.dataset.peerId)) ||
    knownPeers.get(String(button.dataset.peerId));
  if (peer) setPrivateMode(peer);
});

onlineRoster?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-peer-id]");
  if (button) openPrivateFromId(button.dataset.peerId);
});

messagesEl.addEventListener("click", (event) => {
  const privateTarget = event.target.closest("[data-peer-id]");
  if (!privateTarget || !messagesEl.contains(privateTarget)) return;
  openPrivateFromId(privateTarget.dataset.peerId);
});

messageText.addEventListener("input", () => {
  messageText.style.height = "auto";
  messageText.style.height = `${Math.min(messageText.scrollHeight, 150)}px`;
});

messageText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});


window.addEventListener("admin-protected-device", () => {
  const nickname = chatName.value.trim() || nicknameInput.value.trim();
  if (nickname) requestSession(nickname).catch(() => {});
});

const connectionInfo = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
connectionInfo?.addEventListener?.("change", updateWorldLabel);
updateWorldLabel();
updatePhoneCalendar();
window.setInterval(updatePhoneCalendar, 60_000);

nicknameInput.value = localStorage.getItem(storage.nickname) || "";
chatName.value = localStorage.getItem(storage.nickname) || "";
const savedMood = localStorage.getItem(storage.mood);
const moodInput = document.querySelector(`input[name="mood"][value="${CSS.escape(normalizeMood(savedMood))}"]`);
if (moodInput) moodInput.checked = true;
renderContacts();
renderOnlineRoster();
renderEmpty();
renderPhonePreview();

async function bootstrap() {
  await loadAvatars();
  if (nicknameInput.value.trim()) {
    requestSession(nicknameInput.value.trim()).catch(() => {
      showGate("无法连接服务器，请稍后重试。");
    });
  } else {
    showGate("输入代号并选择头像后提交审核。");
  }
}

bootstrap();

contactsPoll = window.setInterval(() => {
  if (session?.status === "approved" && !document.hidden) loadContacts();
}, 15000);
