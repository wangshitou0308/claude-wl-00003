#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
胶片双机换卷推演台 —— 本地后端

仅依赖 Python 标准库（http.server / sqlite3 / json ...）。
启动后访问 http://127.0.0.1:8000 ，断网即可使用。

接口：
  GET  /                       -> static/index.html
  GET  /static/<file>          -> 静态资源
  GET  /api/plans              -> 方案列表
  GET  /api/plans/<id>         -> 单个方案（含全部数据）
  POST /api/plans              -> 新建方案
  PUT  /api/plans/<id>         -> 更新方案（整体覆盖）
  DELETE /api/plans/<id>       -> 删除方案
  POST /api/plans/bulk         -> 批量导入（返回去重后的入库结果）
"""

import json
import os
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(BASE_DIR, "changeover.db")

_db_lock = threading.Lock()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS plans (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                note        TEXT NOT NULL DEFAULT '',
                settings    TEXT NOT NULL DEFAULT '{}',
                reels       TEXT NOT NULL DEFAULT '[]',
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            )
            """
        )


# ---------------------------------------------------------------- 数据工具

def row_to_plan(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "note": row["note"],
        "settings": json.loads(row["settings"] or "{}"),
        "reels": json.loads(row["reels"] or "[]"),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def plan_summary(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "note": row["note"],
        "reelCount": len(json.loads(row["reels"] or "[]")),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def validate_payload(payload):
    """轻量校验：只要能识别 name / reels / settings 即可，其余字段前端兜底。"""
    if not isinstance(payload, dict):
        return None, "请求体不是 JSON 对象"
    name = str(payload.get("name") or "未命名方案").strip()
    reels = payload.get("reels")
    if not isinstance(reels, list):
        return None, "reels 必须是数组"
    settings = payload.get("settings")
    if settings is not None and not isinstance(settings, dict):
        return None, "settings 必须是对象"
    return {
        "name": name[:120],
        "note": str(payload.get("note") or "")[:2000],
        "settings": settings or {},
        "reels": reels,
    }, None


# ---------------------------------------------------------------- HTTP 处理

STATIC_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "ChangeoverDesk/1.0"

    # ------------------------------------------------ 响应辅助
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def serve_static(self, path):
        """path 形如 '/'、'/static/app.js'。只允许访问 static/ 目录，防止穿越。"""
        if path in ("/", "/index.html"):
            rel = "index.html"
        elif path.startswith("/static/"):
            rel = path[len("/static/"):]
        else:
            self.send_error_json(404, "文件不存在")
            return
        rel = os.path.normpath(unquote(rel)).replace("\\", "/")
        if rel.startswith("..") or rel.startswith("/") or rel == ".":
            self.send_error_json(403, "非法路径")
            return
        full = os.path.join(STATIC_DIR, rel)
        if not os.path.isfile(full) or not os.path.abspath(full).startswith(STATIC_DIR):
            self.send_error_json(404, "文件不存在")
            return
        ext = os.path.splitext(full)[1].lower()
        try:
            with open(full, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error_json(404, "文件不存在")
            return
        self.send_response(200)
        self.send_header("Content-Type", STATIC_MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------ 路由
    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/" or path == "/index.html":
            self.serve_static("/")
            return
        if path.startswith("/static/"):
            self.serve_static(path)
            return
        if path == "/api/plans":
            with _db_lock, get_db() as db:
                rows = db.execute("SELECT * FROM plans ORDER BY updated_at DESC").fetchall()
            self.send_json([plan_summary(r) for r in rows])
            return
        if path.startswith("/api/plans/"):
            pid = path[len("/api/plans/"):]
            with _db_lock, get_db() as db:
                row = db.execute("SELECT * FROM plans WHERE id = ?", (pid,)).fetchone()
            if not row:
                self.send_error_json(404, "方案不存在")
                return
            self.send_json(row_to_plan(row))
            return
        self.send_error_json(404, "未知路径")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        payload = self.read_json()
        if payload is None:
            self.send_error_json(400, "JSON 解析失败")
            return
        if path == "/api/plans":
            clean, err = validate_payload(payload)
            if err:
                self.send_error_json(400, err)
                return
            pid = str(payload.get("id") or f"plan_{int(time.time()*1000)}")
            now = int(time.time() * 1000)
            with _db_lock, get_db() as db:
                exists = db.execute("SELECT 1 FROM plans WHERE id = ?", (pid,)).fetchone()
                if exists:
                    self.send_error_json(409, "方案 ID 已存在")
                    return
                db.execute(
                    "INSERT INTO plans (id, name, note, settings, reels, created_at, updated_at)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (pid, clean["name"], clean["note"],
                     json.dumps(clean["settings"], ensure_ascii=False),
                     json.dumps(clean["reels"], ensure_ascii=False), now, now),
                )
            with _db_lock, get_db() as db:
                row = db.execute("SELECT * FROM plans WHERE id = ?", (pid,)).fetchone()
            self.send_json(row_to_plan(row), 201)
            return
        if path == "/api/plans/bulk":
            items = payload.get("plans") if isinstance(payload, dict) else None
            if not isinstance(items, list):
                self.send_error_json(400, "需要 {plans: [...]}")
                return
            saved, skipped = [], 0
            now = int(time.time() * 1000)
            with _db_lock, get_db() as db:
                for item in items:
                    clean, err = validate_payload(item)
                    if err:
                        skipped += 1
                        continue
                    pid = str(item.get("id") or f"plan_{now}_{len(saved)}")
                    if db.execute("SELECT 1 FROM plans WHERE id = ?", (pid,)).fetchone():
                        skipped += 1
                        continue
                    db.execute(
                        "INSERT INTO plans (id, name, note, settings, reels, created_at, updated_at)"
                        " VALUES (?,?,?,?,?,?,?)",
                        (pid, clean["name"], clean["note"],
                         json.dumps(clean["settings"], ensure_ascii=False),
                         json.dumps(clean["reels"], ensure_ascii=False), now, now),
                    )
                    saved.append(pid)
            self.send_json({"saved": saved, "skipped": skipped})
            return
        self.send_error_json(404, "未知路径")

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if not path.startswith("/api/plans/"):
            self.send_error_json(404, "未知路径")
            return
        pid = path[len("/api/plans/"):]
        payload = self.read_json()
        if payload is None:
            self.send_error_json(400, "JSON 解析失败")
            return
        clean, err = validate_payload(payload)
        if err:
            self.send_error_json(400, err)
            return
        now = int(time.time() * 1000)
        with _db_lock, get_db() as db:
            row = db.execute("SELECT * FROM plans WHERE id = ?", (pid,)).fetchone()
            if not row:
                self.send_error_json(404, "方案不存在")
                return
            created = row["created_at"]
            db.execute(
                "UPDATE plans SET name=?, note=?, settings=?, reels=?, updated_at=? WHERE id=?",
                (clean["name"], clean["note"],
                 json.dumps(clean["settings"], ensure_ascii=False),
                 json.dumps(clean["reels"], ensure_ascii=False), now, pid),
            )
            row = db.execute("SELECT * FROM plans WHERE id = ?", (pid,)).fetchone()
        self.send_json(row_to_plan(row))

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if not path.startswith("/api/plans/"):
            self.send_error_json(404, "未知路径")
            return
        pid = path[len("/api/plans/"):]
        with _db_lock, get_db() as db:
            cur = db.execute("DELETE FROM plans WHERE id = ?", (pid,))
        if cur.rowcount == 0:
            self.send_error_json(404, "方案不存在")
            return
        self.send_json({"ok": True})

    def log_message(self, fmt, *args):
        # 简洁日志
        msg = fmt % args
        print(f"[{time.strftime('%H:%M:%S')}] {msg}")


def main():
    init_db()
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), Handler)
    print("胶片双机换卷推演台")
    print(f"  数据文件 : {DB_PATH}")
    print(f"  请在浏览器打开: http://{host}:{port}/")
    print("  按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
