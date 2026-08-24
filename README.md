# Wordsworth - Multiplayer Word Grid Game

A real-time multiplayer word game for up to 50 players. Each player calls one letter per turn, then places the shared letters on a personal 5x5 grid to form words horizontally or vertically.

## Scoring

- 3-letter word = 3 points
- 4-letter word = 4 points
- 5-letter word = 10 points

## Tech Stack

- Backend: Node.js, Express, and Socket.IO
- Frontend: Vanilla HTML, CSS, and JavaScript
- Hosting: Render

## Local Development

```bash
npm install
npm start
# Open http://localhost:3000
```

For hot reload during development:

```bash
npm run dev
```

## Render Deployment

Create a **Web Service** in Render and connect it to the GitHub repository. Use these settings:

- Branch: `main`
- Runtime: Docker
- Root Directory: blank
- Dockerfile Path: `./Dockerfile`
- Instance Type: Free
- Auto-Deploy: On Commit
- Health Check Path: `/`

Render builds the Docker image and starts the game with `npm start`. Future pushes to `main` trigger automatic redeployments.
