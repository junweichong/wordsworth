# Wordsworth — Multiplayer Word Grid Game

A real-time multiplayer word game for up to 50 players. Each player calls one letter per turn (in random order). Players arrange letters on their personal 5×5 grid to form words horizontally or vertically.

## Scoring
- 3-letter word = 3 points
- 4-letter word = 4 points  
- 5-letter word = 10 points

## Tech Stack
- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JS (no build step needed)
- **Hosting**: Fly.io (free tier)
- **CI/CD**: GitHub Actions

---

## Deployment Guide

### Prerequisites (do this on a laptop/desktop)
- [Node.js 18+](https://nodejs.org)
- [Git](https://git-scm.com)
- [Fly.io CLI](https://fly.io/docs/hands-on/install-flyctl/)
- A GitHub account
- A Fly.io account (free at fly.io)

---

### Step 1 — Test locally first
```bash
npm install
npm start
# Open http://localhost:3000
```

---

### Step 2 — Create GitHub repository
1. Go to github.com → click **New repository**
2. Name it `wordsworth-game` (or anything you like)
3. Set it to **Public** (required for free Actions minutes)
4. Do NOT initialise with README (you already have files)
5. Click **Create repository**

Then push your code:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/wordsworth-game.git
git push -u origin main
```

---

### Step 3 — Set up Fly.io

Install the CLI and log in:
```bash
curl -L https://fly.io/install.sh | sh
flyctl auth login
```

Launch the app (run this once from your project folder):
```bash
flyctl launch
```

When prompted:
- **App name**: choose something unique e.g. `wordsworth-yourname`
- **Region**: pick `sin` (Singapore) or whichever is closest to your players
- **Would you like to set up a Postgresql database?** → No
- **Would you like to deploy now?** → No (we'll deploy via GitHub Actions)

This creates/updates your `fly.toml`. Update the `app` name in `fly.toml` to match.

Get your Fly API token:
```bash
flyctl tokens create deploy -x 999999h
```
Copy the token output.

---

### Step 4 — Add token to GitHub

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `FLY_API_TOKEN`
4. Value: paste the token from Step 3
5. Click **Add secret**

---

### Step 5 — Deploy

Push any change to the `main` branch and GitHub Actions will auto-deploy:
```bash
git add .
git commit -m "Deploy"
git push
```

Watch the deploy at: **github.com/YOUR_USERNAME/wordsworth-game/actions**

Your game will be live at: **https://wordsworth-yourname.fly.dev**

---

### Updating the app name

Edit `fly.toml` line 4:
```toml
app = "wordsworth-yourname"   # must be globally unique on Fly.io
```

Commit and push — GitHub Actions redeploys automatically.

---

## Local Development
```bash
npm install
npm run dev   # uses nodemon for hot-reload
```
