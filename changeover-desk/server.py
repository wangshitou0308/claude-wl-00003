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

  GET  /api/rehearsals?planId= -> 排练记录列表（可按方案过滤）
  GET  /api/rehearsals/<id>    -> 单条排练记录（含冻结目标与全部实录）
  POST /api/rehearsals         -> 新建排练（ready，冻结方案卷序与目标时刻）
  PUT  /api/rehearsals/<id>    -> 更新排练（状态机校验；completed 拒绝改写）
  DELETE /api/rehearsals/<id>  -> 删除排练（completed 拒绝删除）

  GET  /api/inspections?planId= -> 验片单列表（可按方案过滤）
  GET  /api/inspections/<id>    -> 单张验片单（含冻结快照与逐卷问题）
  POST /api/inspections         -> 新建验片单（逐卷从 pending 起，冻结方案快照）
  PUT  /api/inspections/<id>    -> 更新验片单（逐卷状态机；已放行/已退回卷拒绝改写）
  DELETE /api/inspections/<id>  -> 删除验片单（任一卷已放行/已退回则拒绝）
"""

import json
import os
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from math import isfinite
from urllib.parse import parse_qs, unquote, urlparse

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
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS rehearsals (
                id          TEXT PRIMARY KEY,
                plan_id     TEXT NOT NULL,
                name        TEXT NOT NULL DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'ready',
                data        TEXT NOT NULL DEFAULT '{}',
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            )
            """
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_rehearsals_plan ON rehearsals(plan_id)"
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS inspections (
                id          TEXT PRIMARY KEY,
                plan_id     TEXT NOT NULL,
                name        TEXT NOT NULL DEFAULT '',
                data        TEXT NOT NULL DEFAULT '{}',
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            )
            """
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_inspections_plan ON inspections(plan_id)"
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


# ---------------------------------------------------------------- 排练记录

REHEARSAL_STATUSES = ("ready", "running", "paused", "completed")

# 状态机：ready→running⇄paused→completed；completed 为终态，不可改写
REHEARSAL_TRANSITIONS = {
    "ready": ("ready", "running"),
    "running": ("running", "paused", "completed"),
    "paused": ("paused", "running", "completed"),
    "completed": (),
}


def _as_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def validate_rehearsal(payload):
    """轻量校验：结构合法即可，业务语义由前端负责。"""
    if not isinstance(payload, dict):
        return None, "请求体不是 JSON 对象"
    plan_id = str(payload.get("planId") or "").strip()
    if not plan_id:
        return None, "缺少 planId"
    status = str(payload.get("status") or "ready")
    if status not in REHEARSAL_STATUSES:
        return None, "非法排练状态：" + status
    data = {
        "id": str(payload.get("id") or "")[:80],
        "planId": plan_id,
        "name": str(payload.get("name") or "排练")[:120],
        "status": status,
        "startReelIdx": _as_int(payload.get("startReelIdx")) or 0,
        "hotkeys": payload.get("hotkeys") if isinstance(payload.get("hotkeys"), dict) else {},
        "frozen": payload.get("frozen") if isinstance(payload.get("frozen"), dict) else {},
        "startedAt": _as_int(payload.get("startedAt")),
        "accumPausedMs": _as_int(payload.get("accumPausedMs")) or 0,
        "pausedAt": _as_int(payload.get("pausedAt")),
        "completedAt": _as_int(payload.get("completedAt")),
        "marks": payload.get("marks") if isinstance(payload.get("marks"), list) else [],
        "flags": payload.get("flags") if isinstance(payload.get("flags"), dict) else {},
    }
    return data, None


def row_to_rehearsal(row):
    data = json.loads(row["data"] or "{}")
    data["id"] = row["id"]
    data["planId"] = row["plan_id"]
    data["name"] = row["name"]
    data["status"] = row["status"]
    data["createdAt"] = row["created_at"]
    data["updatedAt"] = row["updated_at"]
    return data


def rehearsal_summary(row):
    data = json.loads(row["data"] or "{}")
    frozen = data.get("frozen") or {}
    return {
        "id": row["id"],
        "planId": row["plan_id"],
        "name": row["name"],
        "status": row["status"],
        "startReelIdx": data.get("startReelIdx") or 0,
        "reelCount": len(frozen.get("reels") or []),
        "actionCount": len(frozen.get("actions") or []),
        "markCount": len(data.get("marks") or []),
        "flags": data.get("flags") or {},
        "startedAt": data.get("startedAt"),
        "completedAt": data.get("completedAt"),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


# ---------------------------------------------------------------- 拷贝验片单

INSPECTION_REEL_STATUSES = ("pending", "checking", "action", "released", "returned")

# 逐卷状态机：
#   pending 待检查 → 只能先进入检查中 / 待处置（不得越级放行或退回）
#   checking 检查中 / action 待处置 → 可放行或退回
#   released 已放行 / returned 已退回为终态
INSPECTION_REEL_TRANSITIONS = {
    "pending":  ("pending", "checking", "action"),
    "checking": ("checking", "action", "pending", "released", "returned"),
    "action":   ("action", "checking", "pending", "released", "returned"),
    "released": ("released",),
    "returned": ("returned",),
}

FINDING_KINDS = ("splice", "perf", "scratch", "shrink", "headtail", "cue")
FINDING_SEVERITIES = ("info", "minor", "major", "critical")
DISPOSITIONS = ("clean", "resplice", "replaceLeader", "remark", "hold", "")

INSPECTION_FRAMES_PER_FOOT = {"35mm": 16, "16mm": 40, "8mm": 80, "super8": 72}
INSPECTION_CUE_TOL_FT = 1


def _plan_settings(plan):
    settings = plan.get("settings") if isinstance(plan, dict) else None
    if not isinstance(settings, dict):
        settings = {}
    return {
        "fps": float(settings.get("fps") or 24) or 24,
        "gauge": settings.get("gauge") if settings.get("gauge") in INSPECTION_FRAMES_PER_FOOT else "35mm",
        "cueRef": "head" if settings.get("cueRef") == "head" else "tail",
        "headLeaderFt": float(settings.get("headLeaderFt")) if _is_num(settings.get("headLeaderFt")) else 12,
        "tailLeaderFt": float(settings.get("tailLeaderFt")) if _is_num(settings.get("tailLeaderFt")) else 4,
    }


def _is_num(v):
    try:
        return isfinite(float(v))
    except (TypeError, ValueError):
        return False


def _norm_range(v_min, v_max, uncertain):
    """对应 engine.normRange，返回 (min,max,mid,uncertain)。"""
    lo = float(v_min) if _is_num(v_min) else 0.0
    hi = float(v_max) if _is_num(v_max) else lo
    if lo > hi:
        lo, hi = hi, lo
    return lo, hi, (lo + hi) / 2.0, bool(uncertain) or hi != lo


def freeze_plan(plan):
    """由已保存换卷方案生成权威冻结快照（与 engine.js 换算口径一致）。

    前端提交的 frozen 一律不采信，防止伪造卷数据写入快照。
    """
    settings = _plan_settings(plan)
    raw = plan.get("reels") if isinstance(plan.get("reels"), list) else []
    reels = []
    for idx, rr in enumerate(raw):
        if not isinstance(rr, dict):
            rr = {}
        fps = float(rr.get("fps")) if _is_num(rr.get("fps")) and float(rr.get("fps")) > 0 else settings["fps"]
        gauge = rr.get("gauge") if rr.get("gauge") in INSPECTION_FRAMES_PER_FOOT else settings["gauge"]
        fpf = INSPECTION_FRAMES_PER_FOOT[gauge]
        unit = rr.get("lengthUnit") if rr.get("lengthUnit") in ("ft", "m", "sec", "frames") else "ft"
        lv = float(rr.get("lengthValue")) if _is_num(rr.get("lengthValue")) else 0.0
        if unit == "frames":
            pic = max(0, round(lv))
        elif unit == "sec":
            pic = max(0, round(lv * fps))
        elif unit == "m":
            pic = max(0, round((lv / 0.3048) * fpf))
        else:
            pic = max(0, round(lv * fpf))
        head_ft = float(rr.get("headLeaderFt")) if _is_num(rr.get("headLeaderFt")) else settings["headLeaderFt"]
        tail_ft = float(rr.get("tailLeaderFt")) if _is_num(rr.get("tailLeaderFt")) else settings["tailLeaderFt"]
        head_fr = round(head_ft * fpf)
        tail_fr = round(tail_ft * fpf)
        total = head_fr + pic + tail_fr

        mlo, mhi, mmid, munc = _norm_range(rr.get("motorCue"), rr.get("motorCueMax"), rr.get("motorCueU"))
        clo, chi, cmid, cunc = _norm_range(rr.get("changeCue"), rr.get("changeCueMax"), rr.get("changeCueU"))
        if settings["cueRef"] == "head":
            mo = (mlo, mhi, mmid)
            co = (clo, chi, cmid)
        else:
            mo = (head_fr + pic - mhi, head_fr + pic - mlo, head_fr + pic - mmid)
            co = (head_fr + pic - chi, head_fr + pic - clo, head_fr + pic - cmid)
        reels.append({
            "id": str(rr.get("id") or ""),
            "title": str(rr.get("title") or ("第 %d 卷" % (idx + 1))),
            "projector": "B" if rr.get("projector") == "B" else "A",
            "order": idx, "gauge": gauge, "fps": fps, "fpf": fpf,
            "lengthUnit": unit, "lengthValue": lv,
            "headLeaderFt": head_ft, "tailLeaderFt": tail_ft, "cueRef": settings["cueRef"],
            "motorCue": rr.get("motorCue"), "motorCueMax": rr.get("motorCueMax"),
            "motorCueU": bool(rr.get("motorCueU")),
            "changeCue": rr.get("changeCue"), "changeCueMax": rr.get("changeCueMax"),
            "changeCueU": bool(rr.get("changeCueU")),
            "headFrames": head_fr, "tailFrames": tail_fr,
            "picFrames": pic, "totalFrames": total,
            "motorOffMin": mo[0], "motorOffMax": mo[1], "motorOffMid": mo[2], "motorUncertain": munc,
            "changeOffMin": co[0], "changeOffMax": co[1], "changeOffMid": co[2], "changeUncertain": cunc,
        })
    return {
        "cueRef": settings["cueRef"],
        "cueTolFt": INSPECTION_CUE_TOL_FT,
        "reels": reels,
    }


def _as_num(v):
    try:
        n = float(v)
        return n if isfinite(n) else None
    except (TypeError, ValueError):
        return None


def finding_open(f):
    """未决判定：非 info 问题必须有处置，且处置后有真实复查通过记录。

    hold（保留待定）始终未决；仅凭客户端的 recheckPassed 布尔位不算数，
    必须存在 rechecks 中最近一条 passed=true 的复查记录。
    """
    sev = f.get("severity")
    if sev == "info":
        return False
    disp = f.get("disposition") or ""
    if disp == "hold" or disp not in DISPOSITIONS or disp == "":
        return True
    return not recheck_passed(f)


def recheck_passed(f):
    """以最近一条复查记录为准：必须确有复查且通过。"""
    rechecks = f.get("rechecks")
    if not isinstance(rechecks, list) or not rechecks:
        return False
    for rc in reversed(rechecks):
        if isinstance(rc, dict):
            return bool(rc.get("passed"))
    return False


def canonical_finding(f):
    """收敛为白名单字段，避免前端写入任意结构。"""
    kind = f.get("kind") if f.get("kind") in FINDING_KINDS else "scratch"
    sev = f.get("severity") if f.get("severity") in FINDING_SEVERITIES else "minor"
    disp = f.get("disposition") or ""
    if disp not in DISPOSITIONS:
        disp = ""
    measure = f.get("measure") if isinstance(f.get("measure"), dict) else {}
    clean_measure = {}
    for mk in ("value", "to", "unit"):
        if mk in measure:
            if mk == "unit":
                clean_measure[mk] = str(measure[mk])[:12]
            else:
                mv = _as_num(measure[mk])
                if mv is not None:
                    clean_measure[mk] = mv
    rechecks = f.get("rechecks") if isinstance(f.get("rechecks"), list) else []
    clean_rechecks = []
    for rc in rechecks[-20:]:
        if not isinstance(rc, dict):
            continue
        clean_rechecks.append({
            "at": _as_int(rc.get("at")) or 0,
            "passed": bool(rc.get("passed")),
            "note": str(rc.get("note") or "")[:500],
        })
    return {
        "id": str(f.get("id") or "")[:80],
        "kind": kind,
        "severity": sev,
        "from": max(0, _as_num(f.get("from")) or 0),
        "to": max(0, _as_num(f.get("to")) or 0),
        "measure": clean_measure,
        "note": str(f.get("note") or "")[:1000],
        "disposition": disp,
        "dispositionNote": str(f.get("dispositionNote") or "")[:1000],
        "dispositionAt": _as_int(f.get("dispositionAt")),
        # 服务端权威：是否复查通过只看真实复查记录，忽略客户端布尔位
        "recheckPassed": bool(clean_rechecks) and clean_rechecks[-1]["passed"],
        "rechecks": clean_rechecks,
        "createdAt": _as_int(f.get("createdAt")) or 0,
    }


def validate_inspection(payload, require_frozen=False):
    """结构校验。

    PUT：校验提交的逐卷状态/问题，frozen 一律以已存快照为准。
    POST：只取单据头（名称、验片员、备注）；冻结快照由服务端按关联方案生成，
    逐卷从 pending、空问题开始，客户端提交的 frozen / reels 仅用于核对卷序。
    """
    if not isinstance(payload, dict):
        return None, "请求体不是 JSON 对象"
    plan_id = str(payload.get("planId") or "").strip()
    if not plan_id:
        return None, "缺少 planId"
    reels_in = payload.get("reels") if isinstance(payload.get("reels"), list) else []
    reels = []
    for r in reels_in:
        if not isinstance(r, dict):
            return None, "reels 项必须是对象"
        status = r.get("status")
        if status not in INSPECTION_REEL_STATUSES:
            return None, "非法卷状态：" + str(status)
        findings = r.get("findings") if isinstance(r.get("findings"), list) else []
        reels.append({
            "reelId": str(r.get("reelId") or "")[:80],
            "status": status,
            "findings": [canonical_finding(f) for f in findings if isinstance(f, dict)],
        })
    data = {
        "id": str(payload.get("id") or "")[:80],
        "planId": plan_id,
        "name": str(payload.get("name") or "验片单")[:120],
        "inspector": str(payload.get("inspector") or "")[:80],
        "note": str(payload.get("note") or "")[:2000],
        "frozen": {},
        "reels": reels,
    }
    return data, None


def row_to_inspection(row, plan_updated_at=None, plan_hash=None):
    data = json.loads(row["data"] or "{}")
    data["id"] = row["id"]
    data["planId"] = row["plan_id"]
    data["name"] = row["name"]
    data["createdAt"] = row["created_at"]
    data["updatedAt"] = row["updated_at"]
    if plan_updated_at is not None:
        fz = data.get("frozen") or {}
        # 内容哈希优先：方案被实际改动才过期，无意义的重复保存不触发；
        # 旧单据没有哈希时退回更新时间戳比对。
        if plan_hash is not None and fz.get("planHash") is not None:
            data["snapshotStale"] = fz.get("planHash") != plan_hash
        else:
            data["snapshotStale"] = fz.get("planUpdatedAt") is not None and \
                fz.get("planUpdatedAt") != plan_updated_at
    return data


def plan_content_hash(plan_row):
    """对换卷方案中会被验片快照引用的参数做稳定哈希。"""
    import hashlib
    settings = json.loads(plan_row["settings"] or "{}")
    reels = json.loads(plan_row["reels"] or "[]")
    keys = (
        "projector", "fps", "gauge", "lengthUnit", "lengthValue",
        "headLeaderFt", "tailLeaderFt",
        "motorCue", "motorCueMax", "motorCueU",
        "changeCue", "changeCueMax", "changeCueU",
    )
    sig = {
        "settings": {k: settings.get(k) for k in (
            "fps", "gauge", "cueRef", "headLeaderFt", "tailLeaderFt")},
        # 仅快照实际冻结的参数（卷序、片长、提示帧、护片）；卷名/备注/锁定不影响
        "reels": [
            [r.get("id")] + [r.get(k) for k in keys] for r in reels
        ],
    }
    blob = json.dumps(sig, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def inspection_summary(row, plan_updated_at=None, plan_hash=None):
    data = json.loads(row["data"] or "{}")
    frozen = data.get("frozen") or {}
    reels = data.get("reels") or []
    counts = {s: 0 for s in INSPECTION_REEL_STATUSES}
    open_findings = 0
    for r in reels:
        counts[r.get("status") or "pending"] = counts.get(r.get("status") or "pending", 0) + 1
        for f in r.get("findings") or []:
            if finding_open(f):
                open_findings += 1
    if plan_hash is not None and frozen.get("planHash") is not None:
        stale = frozen.get("planHash") != plan_hash
    else:
        stale = frozen.get("planUpdatedAt") is not None and plan_updated_at is not None and \
            frozen.get("planUpdatedAt") != plan_updated_at
    return {
        "id": row["id"],
        "planId": row["plan_id"],
        "name": row["name"],
        "inspector": data.get("inspector") or "",
        "reelCount": len(frozen.get("reels") or []),
        "counts": counts,
        "openFindings": open_findings,
        "snapshotStale": stale,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }



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
        if path == "/api/rehearsals":
            qs = parse_qs(parsed.query)
            plan_id = qs.get("planId", [None])[0]
            with _db_lock, get_db() as db:
                if plan_id:
                    rows = db.execute(
                        "SELECT * FROM rehearsals WHERE plan_id = ? ORDER BY created_at ASC",
                        (plan_id,)).fetchall()
                else:
                    rows = db.execute(
                        "SELECT * FROM rehearsals ORDER BY updated_at DESC").fetchall()
            self.send_json([rehearsal_summary(r) for r in rows])
            return
        if path == "/api/inspections":
            qs = parse_qs(parsed.query)
            plan_id = qs.get("planId", [None])[0]
            with _db_lock, get_db() as db:
                if plan_id:
                    rows = db.execute(
                        "SELECT * FROM inspections WHERE plan_id = ? ORDER BY created_at ASC",
                        (plan_id,)).fetchall()
                    plan_row = db.execute(
                        "SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
                    plan_at = plan_row["updated_at"] if plan_row else None
                    plan_h = plan_content_hash(plan_row) if plan_row else None
                else:
                    rows = db.execute(
                        "SELECT * FROM inspections ORDER BY updated_at DESC").fetchall()
                    plan_at = None
                    plan_h = None
            self.send_json([inspection_summary(r, plan_at, plan_h) for r in rows])
            return
        if path.startswith("/api/rehearsals/"):
            rid = path[len("/api/rehearsals/"):]
            with _db_lock, get_db() as db:
                row = db.execute("SELECT * FROM rehearsals WHERE id = ?", (rid,)).fetchone()
            if not row:
                self.send_error_json(404, "排练记录不存在")
                return
            self.send_json(row_to_rehearsal(row))
            return
        if path.startswith("/api/inspections/"):
            iid = path[len("/api/inspections/"):]
            with _db_lock, get_db() as db:
                row = db.execute("SELECT * FROM inspections WHERE id = ?", (iid,)).fetchone()
                plan_at = None
                plan_h = None
                if row:
                    plan_row = db.execute(
                        "SELECT * FROM plans WHERE id = ?", (row["plan_id"],)).fetchone()
                    if plan_row:
                        plan_at = plan_row["updated_at"]
                        plan_h = plan_content_hash(plan_row)
            if not row:
                self.send_error_json(404, "验片单不存在")
                return
            self.send_json(row_to_inspection(row, plan_at, plan_h))
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
        if path == "/api/rehearsals":
            clean, err = validate_rehearsal(payload)
            if err:
                self.send_error_json(400, err)
                return
            # 新建一律从 ready 开始，冻结数据以本次提交为准
            clean["status"] = "ready"
            clean["marks"] = []
            clean["flags"] = {}
            clean["startedAt"] = None
            clean["pausedAt"] = None
            clean["completedAt"] = None
            clean["accumPausedMs"] = 0
            rid = clean["id"] or f"reh_{int(time.time()*1000)}"
            clean["id"] = rid
            now = int(time.time() * 1000)
            with _db_lock, get_db() as db:
                plan = db.execute("SELECT 1 FROM plans WHERE id = ?",
                                  (clean["planId"],)).fetchone()
                if not plan:
                    self.send_error_json(404, "关联方案不存在")
                    return
                if db.execute("SELECT 1 FROM rehearsals WHERE id = ?", (rid,)).fetchone():
                    self.send_error_json(409, "排练 ID 已存在")
                    return
                db.execute(
                    "INSERT INTO rehearsals (id, plan_id, name, status, data, created_at, updated_at)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (rid, clean["planId"], clean["name"], "ready",
                     json.dumps(clean, ensure_ascii=False), now, now),
                )
                row = db.execute("SELECT * FROM rehearsals WHERE id = ?", (rid,)).fetchone()
            self.send_json(row_to_rehearsal(row), 201)
            return
        if path == "/api/inspections":
            clean, err = validate_inspection(payload)
            if err:
                self.send_error_json(400, err)
                return
            iid = clean["id"] or f"ins_{int(time.time()*1000)}"
            clean["id"] = iid
            now = int(time.time() * 1000)
            with _db_lock, get_db() as db:
                plan_row = db.execute("SELECT * FROM plans WHERE id = ?",
                                      (clean["planId"],)).fetchone()
                if not plan_row:
                    self.send_error_json(404, "关联方案不存在")
                    return
                if db.execute("SELECT 1 FROM inspections WHERE id = ?", (iid,)).fetchone():
                    self.send_error_json(409, "验片单 ID 已存在")
                    return
                # 冻结快照一律由服务端按「已保存」关联方案生成，拒绝客户端伪造卷数据
                plan_obj = row_to_plan(plan_row)
                frozen = freeze_plan(plan_obj)
                canonical_ids = [fr["id"] for fr in frozen["reels"]]
                submitted = [(r.get("reelId"), r.get("status"), len(r.get("findings") or []))
                             for r in (clean.get("reels") or [])]
                if submitted:
                    # 严格核对：客户端若提交卷列表，其 ID 与卷序必须与方案一致，
                    # 且新单不得夹带任何检查结果。
                    if [s[0] for s in submitted] != canonical_ids:
                        self.send_error_json(409, "冻结卷数据与关联方案不一致（快照由方案生成）")
                        return
                    if any(s[1] != "pending" or s[2] for s in submitted):
                        self.send_error_json(409, "新验片单的卷必须为待检查且无检查结果")
                        return
                frozen["planId"] = clean["planId"]
                frozen["planName"] = plan_obj["name"]
                frozen["planHash"] = plan_content_hash(plan_row)
                frozen["planUpdatedAt"] = plan_row["updated_at"]
                frozen["frozenAt"] = now
                clean["frozen"] = frozen
                # 逐卷一律从 pending、空问题开始
                clean["reels"] = [
                    {"reelId": rid, "status": "pending", "findings": []}
                    for rid in canonical_ids
                ]
                db.execute(
                    "INSERT INTO inspections (id, plan_id, name, data, created_at, updated_at)"
                    " VALUES (?,?,?,?,?,?)",
                    (iid, clean["planId"], clean["name"],
                     json.dumps(clean, ensure_ascii=False), now, now),
                )
                row = db.execute("SELECT * FROM inspections WHERE id = ?", (iid,)).fetchone()
            self.send_json(row_to_inspection(
                row, plan_row["updated_at"], plan_content_hash(plan_row)), 201)
            return
        self.send_error_json(404, "未知路径")

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/rehearsals/"):
            self.update_rehearsal(path[len("/api/rehearsals/"):])
            return
        if path.startswith("/api/inspections/"):
            self.update_inspection(path[len("/api/inspections/"):])
            return
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

    def update_rehearsal(self, rid):
        payload = self.read_json()
        if payload is None:
            self.send_error_json(400, "JSON 解析失败")
            return
        clean, err = validate_rehearsal(payload)
        if err:
            self.send_error_json(400, err)
            return
        now = int(time.time() * 1000)
        with _db_lock, get_db() as db:
            row = db.execute("SELECT * FROM rehearsals WHERE id = ?", (rid,)).fetchone()
            if not row:
                self.send_error_json(404, "排练记录不存在")
                return
            cur_status = row["status"]
            cur = json.loads(row["data"] or "{}")
            if cur_status == "completed":
                self.send_error_json(409, "排练已完成，记录不可改写")
                return
            new_status = clean["status"]
            if new_status not in REHEARSAL_TRANSITIONS[cur_status]:
                self.send_error_json(
                    409, "不允许的状态流转：%s → %s" % (cur_status, new_status))
                return
            # 冻结的卷序 / 目标时刻与起始卷只在 ready 阶段、且请求显式携带时可改
            if cur_status != "ready" or "frozen" not in payload:
                clean["frozen"] = cur.get("frozen", {})
            if cur_status != "ready" or "startReelIdx" not in payload:
                clean["startReelIdx"] = cur.get("startReelIdx", 0)
            clean["id"] = rid
            clean["planId"] = row["plan_id"]
            if new_status == "running" and cur_status == "ready" and not clean["startedAt"]:
                clean["startedAt"] = now
            if new_status == "paused" and not clean["pausedAt"]:
                clean["pausedAt"] = now
            if new_status != "paused":
                clean["pausedAt"] = None
            if new_status == "completed" and not clean["completedAt"]:
                clean["completedAt"] = now
            db.execute(
                "UPDATE rehearsals SET name=?, status=?, data=?, updated_at=? WHERE id=?",
                (clean["name"], new_status,
                 json.dumps(clean, ensure_ascii=False), now, rid),
            )
            row = db.execute("SELECT * FROM rehearsals WHERE id = ?", (rid,)).fetchone()
        self.send_json(row_to_rehearsal(row))

    def update_inspection(self, iid):
        payload = self.read_json()
        if payload is None:
            self.send_error_json(400, "JSON 解析失败")
            return
        clean, err = validate_inspection(payload, require_frozen=False)
        if err:
            self.send_error_json(400, err)
            return
        now = int(time.time() * 1000)
        with _db_lock, get_db() as db:
            row = db.execute("SELECT * FROM inspections WHERE id = ?", (iid,)).fetchone()
            if not row:
                self.send_error_json(404, "验片单不存在")
                return
            cur = json.loads(row["data"] or "{}")
            frozen = cur.get("frozen") or {}
            frozen_reels = frozen.get("reels") or []

            # 冻结快照与卷序不可被改写；以快照卷为准逐卷对齐提交数据
            if len(clean["reels"]) != len(frozen_reels):
                self.send_error_json(409, "提交卷数与冻结快照不一致（快照不可修改）")
                return
            for i, fr in enumerate(frozen_reels):
                if clean["reels"][i]["reelId"] != fr.get("id"):
                    self.send_error_json(409, "卷序与冻结快照不一致（快照不可修改）")
                    return

            cur_reels = cur.get("reels") or []
            by_id = {r.get("reelId"): r for r in cur_reels if isinstance(r, dict)}
            new_reels = []
            for nr in clean["reels"]:
                old = by_id.get(nr["reelId"]) or {"status": "pending", "findings": []}
                old_status = old.get("status") if old.get("status") in INSPECTION_REEL_STATUSES else "pending"
                new_status = nr["status"]
                # 已放行 / 已退回为终态：记录不可改写
                if old_status in ("released", "returned"):
                    if new_status != old_status or nr["findings"] != old.get("findings"):
                        self.send_error_json(
                            409, "卷「%s」已%s，记录不可改写" %
                            (next((x.get("title") for x in frozen_reels if x.get("id") == nr["reelId"]), nr["reelId"]),
                             "放行" if old_status == "released" else "退回"))
                        return
                else:
                    if new_status not in INSPECTION_REEL_TRANSITIONS[old_status]:
                        self.send_error_json(
                            409, "不允许的卷状态流转：%s → %s" % (old_status, new_status))
                        return
                # 放行闸：仍有未决项时不能放行（服务端复核）
                if new_status == "released" and old_status != "released":
                    blockers = [f for f in nr["findings"] if finding_open(f)]
                    if blockers:
                        self.send_error_json(
                            409, "仍有 %d 项未决（需处置并复查通过，或保留待定），不能放行" % len(blockers))
                        return
                new_reels.append({
                    "reelId": nr["reelId"],
                    "status": new_status,
                    "findings": nr["findings"],
                })

            merged = {
                "id": iid,
                "planId": row["plan_id"],
                "name": clean["name"],
                "inspector": clean["inspector"],
                "note": clean["note"],
                "frozen": frozen,
                "reels": new_reels,
            }
            # 全部卷到终态后，单据头部信息也封存
            existing_all_terminal = cur_reels and all(
                r.get("status") in ("released", "returned") for r in cur_reels)
            if existing_all_terminal:
                merged["name"] = cur.get("name", clean["name"])
                merged["inspector"] = cur.get("inspector", "")
                merged["note"] = cur.get("note", "")
            db.execute(
                "UPDATE inspections SET name=?, data=?, updated_at=? WHERE id=?",
                (merged["name"], json.dumps(merged, ensure_ascii=False), now, iid),
            )
            row = db.execute("SELECT * FROM inspections WHERE id = ?", (iid,)).fetchone()
            plan_row = db.execute(
                "SELECT * FROM plans WHERE id = ?", (row["plan_id"],)).fetchone()
        self.send_json(row_to_inspection(
            row,
            plan_row["updated_at"] if plan_row else None,
            plan_content_hash(plan_row) if plan_row else None))

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/inspections/"):
            iid = path[len("/api/inspections/"):]
            with _db_lock, get_db() as db:
                row = db.execute("SELECT data FROM inspections WHERE id = ?", (iid,)).fetchone()
                if not row:
                    self.send_error_json(404, "验片单不存在")
                    return
                data = json.loads(row["data"] or "{}")
                terminal = [r for r in (data.get("reels") or [])
                            if r.get("status") in ("released", "returned")]
                if terminal:
                    self.send_error_json(409, "已有 %d 卷放行或退回，验片单不可删除" % len(terminal))
                    return
                db.execute("DELETE FROM inspections WHERE id = ?", (iid,))
            self.send_json({"ok": True})
            return
        if path.startswith("/api/rehearsals/"):
            rid = path[len("/api/rehearsals/"):]
            with _db_lock, get_db() as db:
                row = db.execute("SELECT status FROM rehearsals WHERE id = ?", (rid,)).fetchone()
                if not row:
                    self.send_error_json(404, "排练记录不存在")
                    return
                if row["status"] == "completed":
                    self.send_error_json(409, "排练已完成，记录不可删除")
                    return
                db.execute("DELETE FROM rehearsals WHERE id = ?", (rid,))
            self.send_json({"ok": True})
            return
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
