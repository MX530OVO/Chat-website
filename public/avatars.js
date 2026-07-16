const grid = document.querySelector("#avatarSelectGrid");
const preview = document.querySelector("#selectedPreview");
const saveButton = document.querySelector("#saveAvatar");
const note = document.querySelector("#avatarNote");

const storage = {
  device: "cyber-chat-device",
  nickname: "cyber-chat-nickname",
  avatar: "cyber-chat-avatar",
};

let avatars = [];
let selectedAvatarId = Number(localStorage.getItem(storage.avatar) || 0) || null;

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

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || "请求失败");
  return data;
}

function currentAvatar() {
  return avatars.find((avatar) => avatar.id === selectedAvatarId) || avatars[0] || null;
}

function avatarImage(avatar) {
  const img = document.createElement("img");
  img.src = avatar.url;
  img.alt = avatar.label || "头像";
  img.loading = "lazy";
  img.addEventListener("error", () => {
    img.classList.add("is-broken");
    note.textContent = "有头像图片加载失败，请刷新页面重试。";
  });
  return img;
}

function renderPreview() {
  const avatar = currentAvatar();
  preview.innerHTML = "";

  const label = document.createElement("span");
  label.textContent = "当前选择";
  const title = document.createElement("strong");
  title.textContent = avatar ? avatar.label : "没有可用头像";

  preview.append(label);
  if (avatar) preview.append(avatarImage(avatar));
  preview.append(title);
}

function renderGrid() {
  grid.innerHTML = "";

  if (!avatars.length) {
    const empty = document.createElement("p");
    empty.className = "avatar-empty";
    empty.textContent = "头像库暂时为空。";
    grid.append(empty);
    renderPreview();
    return;
  }

  if (!selectedAvatarId || !avatars.some((avatar) => avatar.id === selectedAvatarId)) {
    selectedAvatarId = avatars[0].id;
  }

  avatars.forEach((avatar) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "avatar-card";
    if (avatar.id === selectedAvatarId) card.classList.add("is-selected");

    const name = document.createElement("span");
    name.textContent = avatar.label || "头像";
    card.append(avatarImage(avatar), name);
    card.addEventListener("click", () => {
      selectedAvatarId = avatar.id;
      localStorage.setItem(storage.avatar, String(selectedAvatarId));
      renderGrid();
      note.textContent = "已选择，点击保存后同步到聊天身份。";
    });
    grid.append(card);
  });

  renderPreview();
}

async function loadAvatars() {
  note.textContent = "正在同步头像库……";
  const data = await api(`/api/avatars?t=${Date.now()}`);
  avatars = data.avatars || [];
  renderGrid();
  note.textContent = avatars.length ? "请选择一个头像。" : "头像库暂时为空。";
}

saveButton.addEventListener("click", async () => {
  const avatar = currentAvatar();
  if (!avatar) return;

  localStorage.setItem(storage.avatar, String(avatar.id));
  const nickname = localStorage.getItem(storage.nickname) || "";
  if (!nickname.trim()) {
    note.textContent = "头像已保存。回到聊天页提交代号后生效。";
    return;
  }

  try {
    await api("/api/session", {
      method: "POST",
      body: JSON.stringify({
        deviceId: deviceId(),
        nickname: nickname.trim(),
        avatarId: avatar.id,
      }),
    });
    note.textContent = "头像已保存并同步到你的聊天身份。";
  } catch (error) {
    note.textContent = error.message;
  }
});

loadAvatars().catch((error) => {
  preview.innerHTML = "<span>当前选择</span><strong>头像库加载失败</strong>";
  note.textContent = `${error.message}，请刷新页面重试。`;
});
