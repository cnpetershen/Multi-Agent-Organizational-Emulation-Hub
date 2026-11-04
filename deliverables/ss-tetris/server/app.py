#!/usr/bin/env python3
"""Score service for 开发一个俄罗斯方块程序.

Purpose
    开发一个俄罗斯方块程序
前端Web SPA 后端用python，后端用来记录每次排名和得分

Every finished game is POSTed to /api/scores and kept in SQLite, so one process serves every
player on the network (multi-user) and the leaderboard survives a restart. Standard library only:
nothing to pip install.

Run
    python server/app.py
    # API + client on http://127.0.0.1:8000

Endpoints
    GET  /api/health           -> {"ok": true, "plays": n, "players": n}
    GET  /api/scores?limit=10  -> {"scores": [...], "plays": n, "players": n}
    POST /api/scores           <- {"player": "ada", "score": 120, "lines": 4}
                               -> {"ok": true, "rank": 1, "best": 120, "plays": n, "players": n}
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
CLIENT_DIR = ROOT / "client"
DB_PATH = Path(os.environ.get("SCORES_DB", str(ROOT / "data" / "scores.db")))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))

WRITE_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player TEXT NOT NULL,
    score INTEGER NOT NULL,
    lines INTEGER NOT NULL DEFAULT 0,
    played_at TEXT NOT NULL
)
"""


def connect() -> "sqlite3.Connection":
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(SCHEMA)
    return conn


def totals(conn: "sqlite3.Connection") -> dict:
    plays = conn.execute("SELECT COUNT(*) AS n FROM plays").fetchone()["n"]
    players = conn.execute("SELECT COUNT(DISTINCT player) AS n FROM plays").fetchone()["n"]
    return {"plays": plays, "players": players}


def leaderboard(conn: "sqlite3.Connection", limit: int) -> list:
    """Every player's best play, best first: the ranking the requirement asked to record."""
    rows = conn.execute(
        "SELECT p.player AS player, p.score AS score, p.lines AS lines,"
        " MIN(p.played_at) AS playedAt"
        " FROM plays p"
        " JOIN (SELECT player, MAX(score) AS best FROM plays GROUP BY player) b"
        "   ON b.player = p.player AND b.best = p.score"
        " GROUP BY p.player"
        " ORDER BY p.score DESC, MIN(p.played_at) ASC"
        " LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def record(player: str, score: int, lines: int) -> dict:
    played_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with WRITE_LOCK:
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO plays (player, score, lines, played_at) VALUES (?, ?, ?, ?)",
                (player, score, lines, played_at),
            )
            conn.commit()
            best = conn.execute(
                "SELECT MAX(score) AS best FROM plays WHERE player = ?", (player,)
            ).fetchone()["best"]
            better = conn.execute(
                "SELECT COUNT(*) AS n FROM (SELECT player, MAX(score) AS best FROM plays"
                " GROUP BY player) WHERE best > ?",
                (best,),
            ).fetchone()["n"]
            summary = totals(conn)
        finally:
            conn.close()
    return {"rank": better + 1, "best": best, "plays": summary["plays"], "players": summary["players"]}


class Handler(SimpleHTTPRequestHandler):
    """One thread per request, so several players can post at the same time."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(CLIENT_DIR), **kwargs)

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            conn = connect()
            try:
                return self.send_json({"ok": True, **totals(conn)})
            finally:
                conn.close()
        if path == "/api/scores":
            query = parse_qs(urlparse(self.path).query)
            try:
                limit = max(1, min(100, int(query.get("limit", ["10"])[0])))
            except ValueError:
                limit = 10
            conn = connect()
            try:
                return self.send_json({"scores": leaderboard(conn, limit), **totals(conn)})
            finally:
                conn.close()
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/scores":
            return self.send_json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return self.send_json({"error": "invalid json"}, 400)
        if not isinstance(body, dict):
            return self.send_json({"error": "expected a json object"}, 400)
        player = str(body.get("player") or "").strip()[:24] or "Player"
        try:
            score = int(body.get("score") or 0)
            lines = int(body.get("lines") or 0)
        except (TypeError, ValueError):
            return self.send_json({"error": "score and lines must be integers"}, 400)
        if score < 0 or lines < 0:
            return self.send_json({"error": "score and lines must not be negative"}, 400)
        return self.send_json({"ok": True, **record(player, score, lines)}, 201)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[score-service] %s\n" % (fmt % args))


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("score service for 开发一个俄罗斯方块程序")
    print("client:  http://%s:%d/" % (HOST, PORT))
    print("api:     http://%s:%d/api/scores" % (HOST, PORT))
    print("storage: %s" % DB_PATH)
    print("press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
