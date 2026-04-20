# VoiceBite 🍎

**Log everything you ate today by just describing it in plain English.**

The biggest friction point in calorie tracking is manually searching and adding every food, one by one. VoiceBite eliminates that. Dictate your meals into your phone, send it to your server, and get a fully detailed nutrition log — macros *and* micros — written to a clean JSON file.

Built to run 24/7 on a Raspberry Pi and triggered from an iPhone Shortcut via Tailscale.

---

## How It Works

```
"16oz iced latte from Starbucks, Chipotle chicken burrito bowl, 6oz salmon for dinner"
                                    ↓
                            Claude (NLP parsing)
                   [{name: "iced latte", qty: 16, unit: "fl oz"}, ...]
                                    ↓
                      Claude (nutrition estimation)
                   Estimates full nutrient profile for each food item
                                    ↓
                         Interactive preview table
                   Flag any wrong entries → re-estimate → fix
                                    ↓
                     data/users/billy/food/2026-04-12.json
```

Every entry gets ~30 nutrients: full macros, all vitamins (A, B1–B12, C, D, E, K), all minerals (iron, magnesium, zinc, selenium...). All entries are Claude estimates — works great for generic foods, restaurant items, and branded products alike.

---

## Project Structure

```
voicebite/
├── src/
│   ├── types.ts        # All shared TypeScript types — the data contract for the whole app
│   ├── enricher.ts     # Claude: raw text → parsed foods + full nutrient profiles (single API call)
│   ├── logger.ts       # Structured logging with pino (JSON to file + stdout)
│   ├── store.ts        # Read/write daily JSON log files to disk
│   ├── sessions.ts     # In-memory pending sessions (parse → preview → confirm flow)
│   ├── server.ts       # Express HTTP server for remote use (iPhone Shortcut, etc.)
│   └── cli.ts          # Interactive terminal interface
├── ecosystem.config.cjs  # PM2 process config for always-on Pi deployment
├── deploy.sh             # One-command deploy from Mac → Pi via rsync
└── .env.example          # Config template
```

**Stack:** TypeScript + Node.js, Claude (Anthropic), Express

**Dependencies:** `@anthropic-ai/sdk`, `express`, `dotenv`, `tsx` — nothing else.

---

## Data Format

One JSON file per day per user:

```json
{
  "date": "2026-04-12",
  "userId": "billy",
  "entries": [
    {
      "food_name": "scrambled eggs (2 large egg)",
      "source": "claude_estimate",
      "nutrients": {
        "calories": 204, "protein_g": 14.2, "fat_g": 15.1, "carbs_g": 2.3,
        "vitamin_b12_mcg": 1.1, "iron_mg": 1.9, "calcium_mg": 56, "..."
      }
    }
  ],
  "daily_totals": { "calories": 2150, "protein_g": 165, "..." }
}
```

Files live at `data/users/{userId}/food/YYYY-MM-DD.json`. Plain JSON, human-readable, easy to feed to an LLM for health insights queries.

---

## Setup

You need one API key:
- **Anthropic** → [console.anthropic.com](https://console.anthropic.com)

```bash
git clone <repo> && cd voicebite
npm install
cp .env.example .env   # fill in your key
```

### CLI

```bash
npm start "2 eggs scrambled, toast, Chipotle burrito bowl, 6oz salmon for dinner"
npm start -- --file ~/notes/today.txt
npm start -- --date 2026-04-10 --yes "everything I ate..."
```

### Pi (24/7 with PM2)

```bash
# First deploy from Mac:
./deploy.sh

# On the Pi, one-time boot setup:
pm2 startup   # follow the printed command
pm2 save
```

### HTTP API (for iPhone Shortcut)

```
POST /log       { text, userId, date }  →  returns { sessionId, entries, summary }
POST /confirm/:sessionId                →  writes JSON file to disk
GET  /log/:userId/:date                 →  reads a saved day log
```

Set up an iPhone Shortcut: **Dictate Text → POST /log → show summary → POST /confirm** — one tap to log your whole day.

---

## Why This Exists

Calorie tracking has one fatal flaw: friction. Searching for each food, picking the right entry, entering the serving size — it's tedious enough that most people quit.

The idea here is that most people *can* easily remember everything they ate in a day. VoiceBite turns that into a complete, micronutrient-rich log with one dictation. The longer-term goal is building a personal health insights layer — correlating food intake with mood, sleep, and energy over time — which is why every entry captures the full nutrient profile rather than just calories.
