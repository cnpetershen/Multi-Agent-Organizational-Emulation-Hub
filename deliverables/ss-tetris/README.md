# 开发一个俄罗斯方块程序
Requirement: 开发一个俄罗斯方块程序
前端Web SPA 后端用python，后端用来记录每次排名和得分
This delivery was produced by one workflow: the capability steps each handed back the part
they own, and together they are one runnable product.
## Run
```
python run.py
```
That starts the backend (`server/app.py`) and opens http://127.0.0.1:8000/ — it serves the
client, records every finished game and ranks the players. `run.py` falls back to serving
`client/` statically when the delivery has no backend.
## Tree
```
README.md            this file (the wiring + how to run)
run.py               one command that starts the product
client/index.html    the SPA the player opens
server/app.py       the service: records plays, serves the leaderboard
data/scores.db      created on first play
```
## API
- `GET /api/health`
- `GET /api/scores?limit=10`
- `POST /api/scores`
`POST /api/scores` takes `{"player": "ada", "score": 120, "lines": 4}` and answers with the
player's rank; `GET /api/scores?limit=10` is the leaderboard. The service is threaded, so
several players can play and post at the same time.
## Notes
- Every file here was delivered by the step whose capability owns it; nothing was written by
  hand outside the organization.
- The client works without the service (it reports the service is offline); the scoreboard
  itself needs the service running.