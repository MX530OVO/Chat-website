from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from html import escape
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import uvicorn
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
PORT = int(os.getenv("PORT", "8787"))
HOST = os.getenv("HOST", "127.0.0.1")
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", str(ROOT / "data" / "chat.sqlite3")))
AVATAR_DIR = Path(os.getenv("AVATAR_DIR", str(DATABASE_PATH.parent / "avatars")))
BUNDLED_AVATAR_DIR = PUBLIC / "assets" / "avatars"
MAX_TEXT = 420
MAX_NAME = 18
MAX_HISTORY = 300
MAX_AVATAR_BYTES = 2 * 1024 * 1024
ADMIN_TOKEN_TTL = 60 * 60 * 12
ADMIN_LOGIN_WINDOW = 60 * 5
ADMIN_LOGIN_LIMIT = 6
ALLOWED_AVATAR_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
DEFAULT_AVATARS = [
    ("Joker", "#e60012", "#050203"),
    ("Mona", "#ffd23f", "#050203"),
    ("Skull", "#ffd23f", "#16080a"),
    ("Panther", "#e60012", "#16080a"),
    ("Fox", "#e60012", "#050203"),
    ("Queen", "#ffd23f", "#16080a"),
    ("Oracle", "#e60012", "#16080a"),
    ("Noir", "#ffd23f", "#050203"),
]
PERSONA_AVATARS = [
    ("红影", "persona-01-red-rogue.jpg"),
    ("蓝猫", "persona-02-blue-cat.jpg"),
    ("黄笑", "persona-03-yellow-smirk.jpg"),
    ("粉双马尾", "persona-04-pink-twins.jpg"),
    ("青面具", "persona-05-cyan-mask.jpg"),
    ("蓝侧影", "persona-06-blue-profile.jpg"),
    ("绿眼镜", "persona-07-green-glasses.jpg"),
    ("紫梦", "persona-08-violet-dream.jpg"),
    ("茶黑影", "persona-09-tan-noir.jpg"),
    ("红跑者", "persona-10-red-runner.jpg"),
    ("蓝少年", "persona-11-blue-youth.jpg"),
]

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
APP_SECRET = os.getenv("APP_SECRET")
if os.getenv("ALLOW_DEV_DEFAULTS") == "1":
    ADMIN_PASSWORD = ADMIN_PASSWORD or "727577"
    APP_SECRET = APP_SECRET or "local-dev-secret-change-me-before-deploy"

if not ADMIN_PASSWORD or not APP_SECRET:
    raise RuntimeError(
        "ADMIN_PASSWORD and APP_SECRET must be configured. "
        "For local testing only, set ALLOW_DEV_DEFAULTS=1."
    )


app = FastAPI(title="Cyber Mystery Chat")
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=PUBLIC / "assets"), name="assets")
app.mount("/uploads/avatars", StaticFiles(directory=AVATAR_DIR), name="avatars")


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'; "
        "form-action 'self'",
    )
    return response

state_lock = asyncio.Lock()
last_sent_at: dict[str, float] = {}
admin_login_failures: dict[str, list[float]] = {}
listeners: dict[str, "Listener"] = {}


@dataclass
class Listener:
    device_id: str
    queue: asyncio.Queue[dict[str, Any]]


class SessionIn(BaseModel):
    deviceId: str = Field(min_length=16, max_length=128)
    nickname: str = Field(min_length=1, max_length=MAX_NAME)
    avatarId: int | None = None
    adminToken: str | None = Field(default=None, max_length=512)


class MessageIn(BaseModel):
    deviceId: str = Field(min_length=16, max_length=128)
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    mood: str = "star"


class PrivateMessageIn(MessageIn):
    recipientId: int


class AdminLoginIn(BaseModel):
    password: str
    deviceId: str | None = Field(default=None, min_length=16, max_length=128)


class BanIn(BaseModel):
    reason: str = ""
    includeIp: bool = True


class AvatarUpdateIn(BaseModel):
    label: str | None = Field(default=None, max_length=32)
    active: bool | None = None
    sortOrder: int | None = Field(default=None, ge=0, le=9999)


class ProtectUserIn(BaseModel):
    protected: bool


def now_ms() -> int:
    return int(time.time() * 1000)


def clean_text(value: str, limit: int) -> str:
    return " ".join((value or "").split())[:limit]


def detect_avatar_content_type(content: bytes) -> str | None:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return None


def client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


def ip_hash(ip: str) -> str:
    digest = hmac.new(APP_SECRET.encode("utf-8"), ip.encode("utf-8"), hashlib.sha256)
    return digest.hexdigest()


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATABASE_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def avatar_url(filename: str | None) -> str | None:
    if not filename:
        return None
    return f"/uploads/avatars/{filename}"


def avatar_public(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "label": row["label"],
        "url": avatar_url(row["filename"]),
        "active": bool(row["active"]),
        "sortOrder": row["sort_order"],
    }


def avatar_snapshot(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if not row:
        return None
    avatar_id = row["avatar_id"] if "avatar_id" in row.keys() else None
    label = row["avatar_label"] if "avatar_label" in row.keys() else None
    filename = row["avatar_filename"] if "avatar_filename" in row.keys() else None
    if not avatar_id and not filename:
        return default_avatar_public()
    return {
        "id": avatar_id,
        "label": label or "默认头像",
        "url": avatar_url(filename) or default_avatar_public()["url"],
    }


def default_avatar_public() -> dict[str, Any]:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM avatars WHERE active = 1 ORDER BY sort_order, id LIMIT 1"
        ).fetchone()
    if row:
        return {
            "id": row["id"],
            "label": row["label"],
            "url": avatar_url(row["filename"]),
        }
    return {"id": None, "label": "默认头像", "url": None}


def get_avatar(avatar_id: int | None, active_only: bool = False) -> sqlite3.Row | None:
    if avatar_id is None:
        return None
    sql = "SELECT * FROM avatars WHERE id = ?"
    params: tuple[Any, ...] = (avatar_id,)
    if active_only:
        sql += " AND active = 1"
    with db() as conn:
        return conn.execute(sql, params).fetchone()


def resolve_avatar_id(avatar_id: int | None) -> int:
    row = get_avatar(avatar_id, active_only=True)
    if row:
        return int(row["id"])
    default_avatar = default_avatar_public()
    if default_avatar["id"] is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "头像库未初始化")
    return int(default_avatar["id"])


def placeholder_svg(label: str, primary: str, background: str) -> str:
    safe_label = escape(label[:18])
    initial = escape(label[:1].upper())
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{safe_label}">
<rect width="256" height="256" rx="28" fill="{background}"/>
<path d="M20 188 236 34v56L42 228H20z" fill="{primary}" opacity=".82"/>
<circle cx="128" cy="108" r="58" fill="#fff8ea"/>
<path d="M50 232c13-48 49-76 78-76s65 28 78 76" fill="#fff8ea"/>
<path d="M54 78c35-31 89-44 148-22-7 32-33 58-78 72-36 11-59 4-70-50z" fill="{primary}"/>
<text x="128" y="220" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="46" fill="{background}">{initial}</text>
</svg>
"""


def ensure_default_avatars(conn: sqlite3.Connection) -> None:
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    existing = conn.execute("SELECT COUNT(*) AS count FROM avatars").fetchone()["count"]
    if existing:
        return
    timestamp = now_ms()
    for index, (label, primary, background) in enumerate(DEFAULT_AVATARS, start=1):
        filename = f"default-{index}.svg"
        target = AVATAR_DIR / filename
        if not target.exists():
            target.write_text(placeholder_svg(label, primary, background), encoding="utf-8")
        conn.execute(
            """
            INSERT INTO avatars(label, filename, content_type, file_size, active, sort_order, created_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)
            """,
            (label, filename, "image/svg+xml", target.stat().st_size, index, timestamp),
        )


def ensure_persona_avatars(conn: sqlite3.Connection) -> None:
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = now_ms()
    inserted = False
    for index, (label, filename) in enumerate(PERSONA_AVATARS, start=1):
        source = BUNDLED_AVATAR_DIR / filename
        if not source.exists():
            continue
        target = AVATAR_DIR / filename
        if not target.exists() or target.stat().st_size != source.stat().st_size:
            target.write_bytes(source.read_bytes())
        size = target.stat().st_size
        conn.execute(
            """
            INSERT INTO avatars(label, filename, content_type, file_size, active, sort_order, created_at)
            VALUES (?, ?, 'image/jpeg', ?, 1, ?, ?)
            ON CONFLICT(filename) DO UPDATE SET
              content_type = excluded.content_type,
              file_size = excluded.file_size,
              active = 1,
              sort_order = excluded.sort_order
            """,
            (label, filename, size, index, timestamp),
        )
        inserted = True
    if inserted:
        conn.execute("UPDATE avatars SET active = 0 WHERE filename LIKE 'default-%.svg'")


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              device_id TEXT NOT NULL UNIQUE,
              nickname TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'banned')),
              ip_hash TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              last_seen_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id),
              nickname TEXT NOT NULL,
              text TEXT NOT NULL,
              mood TEXT NOT NULL,
              sent_at INTEGER NOT NULL,
              revoked_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS private_messages (
              id TEXT PRIMARY KEY,
              sender_id INTEGER NOT NULL REFERENCES users(id),
              recipient_id INTEGER NOT NULL REFERENCES users(id),
              sender_nickname TEXT NOT NULL,
              recipient_nickname TEXT NOT NULL,
              text TEXT NOT NULL,
              mood TEXT NOT NULL,
              avatar_id INTEGER,
              avatar_label TEXT,
              avatar_filename TEXT,
              sent_at INTEGER NOT NULL,
              revoked_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS bans (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              device_id TEXT,
              ip_hash TEXT,
              reason TEXT,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS room_state (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS avatars (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              label TEXT NOT NULL,
              filename TEXT NOT NULL UNIQUE,
              content_type TEXT NOT NULL,
              file_size INTEGER NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL
            );
            """
        )
        user_columns = table_columns(conn, "users")
        if "avatar_id" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN avatar_id INTEGER")
        if "protected" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN protected INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE users SET status = 'approved' WHERE protected = 1 AND status = 'banned'")
        conn.execute(
            """
            DELETE FROM bans
            WHERE device_id IN (SELECT device_id FROM users WHERE protected = 1)
            """
        )

        message_columns = table_columns(conn, "messages")
        if "avatar_id" not in message_columns:
            conn.execute("ALTER TABLE messages ADD COLUMN avatar_id INTEGER")
        if "avatar_label" not in message_columns:
            conn.execute("ALTER TABLE messages ADD COLUMN avatar_label TEXT")
        if "avatar_filename" not in message_columns:
            conn.execute("ALTER TABLE messages ADD COLUMN avatar_filename TEXT")

        ensure_default_avatars(conn)
        ensure_persona_avatars(conn)
        default_avatar = conn.execute(
            "SELECT * FROM avatars WHERE active = 1 ORDER BY sort_order, id LIMIT 1"
        ).fetchone()
        if default_avatar:
            conn.execute(
                "UPDATE users SET avatar_id = COALESCE(avatar_id, ?)",
                (default_avatar["id"],),
            )
            conn.execute(
                """
                UPDATE messages
                SET avatar_id = COALESCE(avatar_id, ?),
                    avatar_label = COALESCE(avatar_label, ?),
                    avatar_filename = COALESCE(avatar_filename, ?)
                """,
                (default_avatar["id"], default_avatar["label"], default_avatar["filename"]),
            )
        conn.execute(
            "INSERT OR IGNORE INTO room_state(key, value) VALUES ('last_clear_at', '0')"
        )


@app.on_event("startup")
def on_startup() -> None:
    init_db()


def user_public(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if not row:
        return None
    avatar_id = row["avatar_id"] if "avatar_id" in row.keys() else None
    avatar = avatar_public(get_avatar(avatar_id)) if avatar_id else default_avatar_public()
    return {
        "id": row["id"],
        "deviceId": row["device_id"],
        "nickname": row["nickname"],
        "avatar": avatar,
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastSeenAt": row["last_seen_at"],
        "online": now_ms() - row["last_seen_at"] < 65_000,
        "protected": bool(row["protected"]) if "protected" in row.keys() else False,
    }


def contact_public(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if not row:
        return None
    avatar_id = row["avatar_id"] if "avatar_id" in row.keys() else None
    avatar = avatar_public(get_avatar(avatar_id)) if avatar_id else default_avatar_public()
    return {
        "id": row["id"],
        "nickname": row["nickname"],
        "avatar": avatar,
        "online": now_ms() - row["last_seen_at"] < 65_000,
        "updatedAt": row["updated_at"],
        "lastSeenAt": row["last_seen_at"],
    }


def message_public(row: sqlite3.Row) -> dict[str, Any]:
    revoked = row["revoked_at"] is not None
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "authorProtected": bool(row["author_protected"]) if "author_protected" in row.keys() else False,
        "name": row["nickname"],
        "avatar": avatar_snapshot(row),
        "text": "已撤回" if revoked else row["text"],
        "mood": row["mood"],
        "sentAt": row["sent_at"],
        "revokedAt": row["revoked_at"],
        "revoked": revoked,
    }


def private_message_public(row: sqlite3.Row) -> dict[str, Any]:
    revoked = row["revoked_at"] is not None
    return {
        "id": row["id"],
        "senderId": row["sender_id"],
        "recipientId": row["recipient_id"],
        "senderName": row["sender_nickname"],
        "recipientName": row["recipient_nickname"],
        "name": row["sender_nickname"],
        "avatar": avatar_snapshot(row),
        "text": "[revoked]" if revoked else row["text"],
        "mood": row["mood"],
        "sentAt": row["sent_at"],
        "revokedAt": row["revoked_at"],
        "revoked": revoked,
    }


def get_user_by_device(device_id: str) -> sqlite3.Row | None:
    with db() as conn:
        return conn.execute("SELECT * FROM users WHERE device_id = ?", (device_id,)).fetchone()


def get_user_by_id(user_id: int) -> sqlite3.Row | None:
    with db() as conn:
        return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def get_last_clear_at() -> int:
    with db() as conn:
        value = conn.execute(
            "SELECT value FROM room_state WHERE key = 'last_clear_at'"
        ).fetchone()
    return int(value["value"]) if value else 0


def ensure_approved(device_id: str) -> sqlite3.Row:
    row = get_user_by_device(device_id)
    if not row:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "请先申请进入频道")
    if row["status"] != "approved":
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"当前状态：{row['status']}")
    return row


def is_banned(device_id: str, hashed_ip: str) -> bool:
    with db() as conn:
        protected = conn.execute(
            "SELECT 1 FROM users WHERE device_id = ? AND protected = 1 LIMIT 1",
            (device_id,),
        ).fetchone()
        if protected:
            return False
        banned = conn.execute(
            """
            SELECT 1 FROM bans
            WHERE (device_id IS NOT NULL AND device_id = ?)
               OR (ip_hash IS NOT NULL AND ip_hash = ?)
            LIMIT 1
            """,
            (device_id, hashed_ip),
        ).fetchone()
    return bool(banned)


def sign_admin_token() -> str:
    payload = {
        "exp": int(time.time()) + ADMIN_TOKEN_TTL,
        "nonce": secrets.token_hex(10),
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    body = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    signature = hmac.new(APP_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256)
    return f"{body}.{signature.hexdigest()}"


def verify_admin_token(token: str) -> bool:
    try:
        body, signature = token.split(".", 1)
        expected = hmac.new(APP_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256)
        if not hmac.compare_digest(signature, expected.hexdigest()):
            return False
        padded = body + "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        return int(payload.get("exp", 0)) >= int(time.time())
    except Exception:
        return False


def has_admin_token(token: str | None) -> bool:
    return bool(token and verify_admin_token(token))


def check_admin_login_limit(ip: str) -> None:
    now = time.time()
    failures = [
        item for item in admin_login_failures.get(ip, [])
        if now - item < ADMIN_LOGIN_WINDOW
    ]
    admin_login_failures[ip] = failures
    if len(failures) >= ADMIN_LOGIN_LIMIT:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "管理员登录尝试过多，请稍后再试")


def record_admin_login_failure(ip: str) -> None:
    now = time.time()
    failures = [
        item for item in admin_login_failures.get(ip, [])
        if now - item < ADMIN_LOGIN_WINDOW
    ]
    failures.append(now)
    admin_login_failures[ip] = failures


def require_admin(authorization: str = Header(default="")) -> None:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not verify_admin_token(token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "管理员登录已失效")


async def publish(payload: dict[str, Any]) -> None:
    async with state_lock:
        dead: list[str] = []
        for key, listener in listeners.items():
            try:
                listener.queue.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(key)
        for key in dead:
            listeners.pop(key, None)


def sse(payload: dict[str, Any]) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


def should_deliver(device_id: str, payload: dict[str, Any]) -> bool:
    if payload.get("type") == "session":
        return payload.get("deviceId") == device_id
    if payload.get("type") in {"private-message", "private-revoke"}:
        row = get_user_by_device(device_id)
        if not row or row["status"] != "approved":
            return False
        message = payload.get("message") or {}
        return row["id"] in {message.get("senderId"), message.get("recipientId")}
    if payload.get("type") in {"message", "revoke", "clear"}:
        row = get_user_by_device(device_id)
        return bool(row and row["status"] == "approved")
    return True


def list_messages(limit: int = MAX_HISTORY, after_clear: bool = True) -> list[dict[str, Any]]:
    clear_after = get_last_clear_at() if after_clear else 0
    with db() as conn:
        rows = conn.execute(
            """
            SELECT messages.*, users.protected AS author_protected
            FROM messages
            LEFT JOIN users ON users.id = messages.user_id
            WHERE sent_at > ?
            ORDER BY sent_at DESC
            LIMIT ?
            """,
            (clear_after, limit),
        ).fetchall()
    return [message_public(row) for row in reversed(rows)]


def list_private_messages_for_user(user_id: int, peer_id: int, limit: int = MAX_HISTORY) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM private_messages
            WHERE (sender_id = ? AND recipient_id = ?)
               OR (sender_id = ? AND recipient_id = ?)
            ORDER BY sent_at DESC
            LIMIT ?
            """,
            (user_id, peer_id, peer_id, user_id, limit),
        ).fetchall()
    return [private_message_public(row) for row in reversed(rows)]


def list_private_messages(limit: int = 300) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM private_messages
            ORDER BY sent_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [private_message_public(row) for row in reversed(rows)]


def list_users(status_filter: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM users"
    params: tuple[Any, ...] = ()
    if status_filter:
        sql += " WHERE status = ?"
        params = (status_filter,)
    sql += " ORDER BY updated_at DESC"
    with db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [user_public(row) for row in rows if row]


@app.post("/api/session")
async def create_or_restore_session(payload: SessionIn, request: Request) -> JSONResponse:
    nickname = clean_text(payload.nickname, MAX_NAME) or "匿名访客"
    hashed_ip = ip_hash(client_ip(request))
    timestamp = now_ms()
    owner_device = has_admin_token(payload.adminToken)
    status_value = "approved" if owner_device else ("banned" if is_banned(payload.deviceId, hashed_ip) else "pending")

    with db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE device_id = ?",
            (payload.deviceId,),
        ).fetchone()
        if row:
            is_protected = owner_device or (bool(row["protected"]) if "protected" in row.keys() else False)
            if is_protected:
                new_status = "approved" if owner_device or row["status"] == "banned" else row["status"]
            else:
                new_status = "banned" if status_value == "banned" else row["status"]
            avatar_id = row["avatar_id"]
            if payload.avatarId is not None:
                avatar_id = resolve_avatar_id(payload.avatarId)
            conn.execute(
                """
                UPDATE users
                SET nickname = ?,
                    avatar_id = ?,
                    status = ?,
                    ip_hash = ?,
                    updated_at = ?,
                    last_seen_at = ?,
                    protected = CASE WHEN ? = 1 THEN 1 ELSE protected END
                WHERE device_id = ?
                """,
                (nickname, avatar_id, new_status, hashed_ip, timestamp, timestamp, 1 if owner_device else 0, payload.deviceId),
            )
        else:
            avatar_id = resolve_avatar_id(payload.avatarId)
            conn.execute(
                """
                INSERT INTO users(device_id, nickname, avatar_id, status, ip_hash, created_at, updated_at, last_seen_at, protected)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (payload.deviceId, nickname, avatar_id, status_value, hashed_ip, timestamp, timestamp, timestamp, 1 if owner_device else 0),
            )
        if owner_device:
            conn.execute("DELETE FROM bans WHERE device_id = ?", (payload.deviceId,))
        row = conn.execute(
            "SELECT * FROM users WHERE device_id = ?",
            (payload.deviceId,),
        ).fetchone()

    session = user_public(row)
    await publish({"type": "session", "deviceId": payload.deviceId, "session": session})
    return JSONResponse({"session": session})


@app.get("/api/history")
def history(deviceId: str = Query(min_length=16, max_length=128)) -> dict[str, Any]:
    ensure_approved(deviceId)
    return {"messages": list_messages()}


@app.get("/api/contacts")
def contacts(deviceId: str = Query(min_length=16, max_length=128)) -> dict[str, Any]:
    current = ensure_approved(deviceId)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT users.*,
                   COALESCE(MAX(messages.sent_at), 0) AS last_public_message_at
            FROM users
            LEFT JOIN messages ON messages.user_id = users.id
            WHERE users.status = 'approved' AND users.id != ?
            GROUP BY users.id
            ORDER BY last_public_message_at DESC, users.last_seen_at DESC, users.updated_at DESC
            """,
            (current["id"],),
        ).fetchall()
    return {"users": [contact_public(row) for row in rows if row]}


@app.get("/api/private/history")
def private_history(
    deviceId: str = Query(min_length=16, max_length=128),
    peerId: int = Query(gt=0),
) -> dict[str, Any]:
    current = ensure_approved(deviceId)
    peer = get_user_by_id(peerId)
    if not peer or peer["status"] != "approved":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "private peer not found")
    return {
        "peer": user_public(peer),
        "messages": list_private_messages_for_user(current["id"], peer["id"]),
    }


@app.get("/api/avatars")
def public_avatars() -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM avatars
            WHERE active = 1
            ORDER BY sort_order, id
            """
        ).fetchall()
    return {"avatars": [avatar_public(row) for row in rows]}


@app.post("/api/messages")
async def post_message(payload: MessageIn, request: Request) -> JSONResponse:
    user = ensure_approved(payload.deviceId)
    text = clean_text(payload.text, MAX_TEXT)
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "不能发送空消息")

    rate_key = f"{payload.deviceId}:{ip_hash(client_ip(request))}"
    sent_at = time.time()
    last = last_sent_at.get(rate_key, 0)
    if sent_at - last < 0.75:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "慢一点，频道正在同步")
    last_sent_at[rate_key] = sent_at

    mood = payload.mood if payload.mood in {"star", "ember"} else "star"
    message_id = secrets.token_hex(16)
    timestamp = now_ms()
    avatar = get_avatar(user["avatar_id"]) or get_avatar(resolve_avatar_id(None))
    with db() as conn:
        conn.execute(
            """
            INSERT INTO messages(id, user_id, nickname, text, mood, avatar_id, avatar_label, avatar_filename, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                user["id"],
                user["nickname"],
                text,
                mood,
                avatar["id"] if avatar else None,
                avatar["label"] if avatar else None,
                avatar["filename"] if avatar else None,
                timestamp,
            ),
        )
        row = conn.execute(
            """
            SELECT messages.*, users.protected AS author_protected
            FROM messages
            LEFT JOIN users ON users.id = messages.user_id
            WHERE messages.id = ?
            """,
            (message_id,),
        ).fetchone()

    message = message_public(row)
    await publish({"type": "message", "message": message})
    return JSONResponse({"message": message}, status_code=status.HTTP_201_CREATED)


@app.post("/api/private/messages")
async def post_private_message(payload: PrivateMessageIn, request: Request) -> JSONResponse:
    sender = ensure_approved(payload.deviceId)
    recipient = get_user_by_id(payload.recipientId)
    if not recipient or recipient["status"] != "approved":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "private peer not found")
    if recipient["id"] == sender["id"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "cannot send private message to yourself")

    text = clean_text(payload.text, MAX_TEXT)
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "涓嶈兘鍙戦€佺┖娑堟伅")

    rate_key = f"private:{payload.deviceId}:{ip_hash(client_ip(request))}"
    sent_at = time.time()
    last = last_sent_at.get(rate_key, 0)
    if sent_at - last < 0.75:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "private chat is syncing")
    last_sent_at[rate_key] = sent_at

    mood = payload.mood if payload.mood in {"star", "ember"} else "star"
    message_id = secrets.token_hex(16)
    timestamp = now_ms()
    avatar = get_avatar(sender["avatar_id"]) or get_avatar(resolve_avatar_id(None))
    with db() as conn:
        conn.execute(
            """
            INSERT INTO private_messages(
              id, sender_id, recipient_id, sender_nickname, recipient_nickname,
              text, mood, avatar_id, avatar_label, avatar_filename, sent_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                sender["id"],
                recipient["id"],
                sender["nickname"],
                recipient["nickname"],
                text,
                mood,
                avatar["id"] if avatar else None,
                avatar["label"] if avatar else None,
                avatar["filename"] if avatar else None,
                timestamp,
            ),
        )
        row = conn.execute("SELECT * FROM private_messages WHERE id = ?", (message_id,)).fetchone()

    message = private_message_public(row)
    await publish({"type": "private-message", "message": message})
    return JSONResponse({"message": message}, status_code=status.HTTP_201_CREATED)


@app.get("/events")
async def events(deviceId: str = Query(min_length=16, max_length=128)) -> StreamingResponse:
    listener_id = secrets.token_hex(12)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
    listener = Listener(device_id=deviceId, queue=queue)

    async with state_lock:
        listeners[listener_id] = listener

    async def stream():
        try:
            row = get_user_by_device(deviceId)
            yield sse({"type": "session", "deviceId": deviceId, "session": user_public(row)})
            if row and row["status"] == "approved":
                yield sse({"type": "hello", "messages": list_messages()})
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=20)
                    if should_deliver(deviceId, payload):
                        yield sse(payload)
                except asyncio.TimeoutError:
                    with db() as conn:
                        conn.execute(
                            "UPDATE users SET last_seen_at = ? WHERE device_id = ?",
                            (now_ms(), deviceId),
                        )
                    yield ": ping\n\n"
        finally:
            async with state_lock:
                listeners.pop(listener_id, None)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/admin/login")
def admin_login(payload: AdminLoginIn, request: Request) -> dict[str, str]:
    ip = client_ip(request)
    check_admin_login_limit(ip)
    if not hmac.compare_digest(payload.password, ADMIN_PASSWORD):
        record_admin_login_failure(ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "管理员口令不正确")
    admin_login_failures.pop(ip, None)
    if payload.deviceId:
        with db() as conn:
            conn.execute(
                """
                UPDATE users
                SET protected = 1,
                    status = 'approved',
                    updated_at = ?
                WHERE device_id = ?
                """,
                (now_ms(), payload.deviceId),
            )
            conn.execute("DELETE FROM bans WHERE device_id = ?", (payload.deviceId,))
    return {"token": sign_admin_token()}


@app.get("/api/admin/pending", dependencies=[Depends(require_admin)])
def admin_pending() -> dict[str, Any]:
    return {"users": list_users("pending")}


@app.get("/api/admin/users", dependencies=[Depends(require_admin)])
def admin_users() -> dict[str, Any]:
    return {"users": list_users()}


@app.get("/api/admin/messages", dependencies=[Depends(require_admin)])
def admin_messages() -> dict[str, Any]:
    return {"messages": list_messages(limit=150, after_clear=False)}


@app.get("/api/admin/private-messages", dependencies=[Depends(require_admin)])
def admin_private_messages() -> dict[str, Any]:
    return {"messages": list_private_messages(limit=300)}


@app.get("/api/admin/avatars", dependencies=[Depends(require_admin)])
def admin_avatars() -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM avatars ORDER BY sort_order, id").fetchall()
    return {"avatars": [avatar_public(row) for row in rows]}


@app.post("/api/admin/avatars", dependencies=[Depends(require_admin)])
async def admin_upload_avatar(
    label: str = Form(min_length=1, max_length=32),
    file: UploadFile = File(),
) -> dict[str, Any]:
    content_type = file.content_type or ""
    if content_type not in ALLOWED_AVATAR_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "只支持 PNG、JPG 或 WebP 头像")

    content = await file.read(MAX_AVATAR_BYTES + 1)
    if len(content) > MAX_AVATAR_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "头像不能超过 2MB")
    detected_type = detect_avatar_content_type(content)
    if detected_type != content_type:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "头像文件内容与格式不匹配")
    suffix = ALLOWED_AVATAR_TYPES[detected_type]

    clean_label = clean_text(label, 32) or "未命名头像"
    filename = f"{now_ms()}-{secrets.token_hex(8)}{suffix}"
    target = AVATAR_DIR / filename
    target.write_bytes(content)

    with db() as conn:
        max_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) AS value FROM avatars"
        ).fetchone()["value"]
        conn.execute(
            """
            INSERT INTO avatars(label, filename, content_type, file_size, active, sort_order, created_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)
            """,
            (clean_label, filename, content_type, len(content), int(max_order) + 1, now_ms()),
        )
        row = conn.execute("SELECT * FROM avatars WHERE filename = ?", (filename,)).fetchone()
    return {"avatar": avatar_public(row)}


@app.patch("/api/admin/avatars/{avatar_id}", dependencies=[Depends(require_admin)])
def admin_update_avatar(avatar_id: int, payload: AvatarUpdateIn) -> dict[str, Any]:
    row = get_avatar(avatar_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "头像不存在")

    label = row["label"] if payload.label is None else clean_text(payload.label, 32)
    active = row["active"] if payload.active is None else int(payload.active)
    sort_order = row["sort_order"] if payload.sortOrder is None else payload.sortOrder
    if not label:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "头像名称不能为空")

    with db() as conn:
        if not active:
            active_count = conn.execute(
                "SELECT COUNT(*) AS count FROM avatars WHERE active = 1"
            ).fetchone()["count"]
            if active_count <= 1 and row["active"]:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "至少保留一个启用头像")
        conn.execute(
            "UPDATE avatars SET label = ?, active = ?, sort_order = ? WHERE id = ?",
            (label, active, sort_order, avatar_id),
        )
        row = conn.execute("SELECT * FROM avatars WHERE id = ?", (avatar_id,)).fetchone()
    return {"avatar": avatar_public(row)}


@app.post("/api/admin/users/{user_id}/approve", dependencies=[Depends(require_admin)])
async def admin_approve(user_id: int) -> dict[str, Any]:
    timestamp = now_ms()
    with db() as conn:
        conn.execute(
            "UPDATE users SET status = 'approved', updated_at = ? WHERE id = ?",
            (timestamp, user_id),
        )
    row = get_user_by_id(user_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "用户不存在")
    session = user_public(row)
    await publish({"type": "session", "deviceId": row["device_id"], "session": session})
    return {"session": session}


@app.post("/api/admin/users/{user_id}/reject", dependencies=[Depends(require_admin)])
async def admin_reject(user_id: int) -> dict[str, Any]:
    timestamp = now_ms()
    with db() as conn:
        conn.execute(
            "UPDATE users SET status = 'rejected', updated_at = ? WHERE id = ?",
            (timestamp, user_id),
        )
    row = get_user_by_id(user_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "用户不存在")
    session = user_public(row)
    await publish({"type": "session", "deviceId": row["device_id"], "session": session})
    return {"session": session}


@app.post("/api/admin/users/{user_id}/ban", dependencies=[Depends(require_admin)])
async def admin_ban(user_id: int, payload: BanIn) -> dict[str, Any]:
    row = get_user_by_id(user_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "用户不存在")
    if "protected" in row.keys() and row["protected"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "这是管理员保护号，不能封禁")

    timestamp = now_ms()
    ban_ip = row["ip_hash"] if payload.includeIp else None
    with db() as conn:
        conn.execute(
            "UPDATE users SET status = 'banned', updated_at = ? WHERE id = ?",
            (timestamp, user_id),
        )
        conn.execute(
            "INSERT INTO bans(device_id, ip_hash, reason, created_at) VALUES (?, ?, ?, ?)",
            (row["device_id"], ban_ip, clean_text(payload.reason, 120), timestamp),
        )

    updated = get_user_by_id(user_id)
    session = user_public(updated)
    await publish({"type": "session", "deviceId": row["device_id"], "session": session})
    return {"session": session}


@app.post("/api/admin/users/{user_id}/protect", dependencies=[Depends(require_admin)])
async def admin_protect_user(user_id: int, payload: ProtectUserIn) -> dict[str, Any]:
    row = get_user_by_id(user_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "用户不存在")

    timestamp = now_ms()
    with db() as conn:
        conn.execute(
            """
            UPDATE users
            SET protected = ?,
                status = CASE WHEN ? = 1 AND status = 'banned' THEN 'approved' ELSE status END,
                updated_at = ?
            WHERE id = ?
            """,
            (1 if payload.protected else 0, 1 if payload.protected else 0, timestamp, user_id),
        )
        if payload.protected:
            conn.execute("DELETE FROM bans WHERE device_id = ?", (row["device_id"],))

    updated = get_user_by_id(user_id)
    session = user_public(updated)
    await publish({"type": "session", "deviceId": row["device_id"], "session": session})
    return {"session": session}


@app.post("/api/admin/messages/{message_id}/revoke", dependencies=[Depends(require_admin)])
async def admin_revoke(message_id: str) -> dict[str, Any]:
    timestamp = now_ms()
    with db() as conn:
        conn.execute(
            "UPDATE messages SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
            (timestamp, message_id),
        )
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "消息不存在")
    message = message_public(row)
    await publish({"type": "revoke", "message": message})
    return {"message": message}


@app.post("/api/admin/private-messages/{message_id}/revoke", dependencies=[Depends(require_admin)])
async def admin_revoke_private(message_id: str) -> dict[str, Any]:
    timestamp = now_ms()
    with db() as conn:
        conn.execute(
            "UPDATE private_messages SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
            (timestamp, message_id),
        )
        row = conn.execute("SELECT * FROM private_messages WHERE id = ?", (message_id,)).fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "private message not found")
    message = private_message_public(row)
    await publish({"type": "private-revoke", "message": message})
    return {"message": message}


@app.post("/api/admin/room/clear", dependencies=[Depends(require_admin)])
async def admin_clear_room() -> dict[str, int]:
    timestamp = now_ms()
    with db() as conn:
        conn.execute(
            "UPDATE room_state SET value = ? WHERE key = 'last_clear_at'",
            (str(timestamp),),
        )
    await publish({"type": "clear", "clearedAt": timestamp})
    return {"clearedAt": timestamp}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(PUBLIC / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/admin.html")
def admin_page() -> FileResponse:
    return FileResponse(PUBLIC / "admin.html", headers={"Cache-Control": "no-store"})


@app.get("/{filename:path}")
def public_file(filename: str) -> FileResponse:
    target = (PUBLIC / filename).resolve()
    public_root = PUBLIC.resolve()
    try:
        target.relative_to(public_root)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return FileResponse(target, headers={"Cache-Control": "no-store"})


def main() -> None:
    uvicorn.run("server:app", host=HOST, port=PORT, reload=False)


if __name__ == "__main__":
    main()
