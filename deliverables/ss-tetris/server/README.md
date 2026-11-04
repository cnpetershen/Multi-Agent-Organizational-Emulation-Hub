# Score service — 开发一个俄罗斯方块程序

Delivered for: 开发一个俄罗斯方块程序
前端Web SPA 后端用python，后端用来记录每次排名和得分

## Run

```
python server/app.py
```

Standard library only — no dependencies to install. It listens on http://127.0.0.1:8000/ by
default (`HOST` / `PORT` environment variables override that), serves the client from
`../client/`, and stores every play in
`../data/scores.db (SQLite, WAL)` so the ranking survives a restart.

## API

- `GET /api/health`
- `GET /api/scores?limit=10`
- `POST /api/scores`

```
curl -X POST http://127.0.0.1:8000/api/scores \
  -H "content-type: application/json" \
  -d '{"player": "ada", "score": 120, "lines": 4}'

curl http://127.0.0.1:8000/api/scores?limit=10
```

## Multi-user

The server handles one request per thread, so several players can play and post at the same
time. Each play is recorded; the leaderboard ranks players by their best score, earliest first
on a tie.

Entry point: `server/app.py`.
