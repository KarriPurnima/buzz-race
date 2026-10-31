# ⚡ Buzz Race

Real-time multiplayer trivia. No login, no install. Host creates a room, friends join with a 4-letter code.
The server owns timers, question order and scores; phones just send taps and render what the server says.

## Run locally
    npm install
    npm start        # http://localhost:3000
Open it in two browser tabs to try it (each tab is its own player).

## Deploy (free, ~3 minutes, gives you the public link)
Render (easiest):
1. Push this folder to a new GitHub repo.
2. render.com -> New -> Blueprint (or Web Service) -> pick the repo. render.yaml is already set up
   (build `npm install`, start `npm start`, health check `/healthz`).
3. When it finishes you get https://buzz-race-xxxx.onrender.com . Share that link.

Railway, Fly.io, Koyeb or any Node host also work: they need `npm install`, `npm start`, WebSocket support and the PORT env var.

Notes
- Run ONE instance only (rooms live in server memory).
- Render's free tier sleeps after ~15 min idle; open the link once before game night to wake it (~30-60s).
- HTTPS/WSS is automatic on these hosts; the client picks ws/wss itself.

## Rules as implemented
- 10 rounds, 15 s each (server clock). A round ends early once every connected player has answered.
- Correct = 1000 - 50 pts per second taken (min 250). Wrong or no answer = 0.
- One Double Points per player per game, tapped before answering. Wrong answer with it active = 0 (it is spent).
- 4 s reveal + leaderboard, then auto-advance. Final podium, rankings, host-only Play Again (back to lobby).
- Refresh = rejoin (same tab token, or same nickname if the old connection is gone). Leaving mid-game greys you out.
- Host gone for 5 s -> host role passes to the next connected player.
