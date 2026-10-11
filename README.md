<p align="center">
  <img src="assets/hackathon-logo.avif" alt="Stanford x DeepMind Hackathon" width="200" />
</p>

<h1 align="center">Verifi</h1>

<p align="center">Live fact-checking for founder pitches.</p>

<p align="center">
  <img alt="GDG Stanford x DeepMind Hackathon" src="https://img.shields.io/badge/hackathon-GDG%20Stanford%20x%20DeepMind%20(7%2F19%2F2026)-4285F4?style=flat-square&logo=google&logoColor=white">
</p>
<p align="center">
  <a href="https://ai.google.dev/gemini-api/docs/live"><img alt="Gemini Live API" src="https://img.shields.io/badge/Gemini-Live%20API-8E75B2?style=flat-square&logo=googlegemini&logoColor=white"></a>
  <a href="https://ai.google.dev/gemini-api/docs/google-search"><img alt="Google Search grounding" src="https://img.shields.io/badge/Google%20Search-grounding-4285F4?style=flat-square&logo=google&logoColor=white"></a>
  <img alt="Next.js 15" src="https://img.shields.io/badge/Next.js-15-000000?style=flat-square&logo=nextdotjs">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white">
  <img alt="Express 5" src="https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express">
  <img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white">
</p>

A live diligence assistant for founder pitches. Built for the Stanford x DeepMind hackathon. Verifi listens to a pitch in real time, transcribes it, flags factual claims worth checking, verifies them against the web, and produces an investor-style score when the session ends.

![Verifi live session — video feed, live transcript, and claim filter with verification badges](assets/screenshot.png)

## How it works

1. **Capture** — the browser grabs mic (and optionally camera) audio and streams 16kHz PCM frames over a WebSocket to the server.
2. **Transcription** — the server relays audio to the Gemini Live API (`gemini-3.1-flash-live-preview`), which acts as a silent transcriber and streams text back.
3. **Claim filtering** — each completed sentence is screened in two tiers: cheap regex/keyword heuristics catch obvious claims (numbers, superlatives, traction metrics, competitor mentions); anything ambiguous gets a fast model classification pass (`gemini-3.1-flash-lite`).
4. **Verification** — checkable claims are fact-checked with `gemini-3.5-flash` using Google Search grounding, returning a verdict (supported / contradicted / mixed / unverifiable), a confidence score, reasoning, and cited sources.
5. **Founder Score** — once the session stops, the full transcript plus all claim verdicts are scored across credibility, clarity, traction, and market understanding, with an executive summary, an evidence trail, and suggested follow-up questions.

### Data flow

```mermaid
flowchart LR
  MIC[Mic / camera] --> B[Browser<br/>16 kHz PCM]
  B -- WebSocket<br/>/api/live-ws --> S[Express server]
  S --> GL[Gemini Live<br/>transcription]
  GL --> F[Claim filter:<br/>regex, then<br/>flash-lite]
  F --> V[Verify with<br/>Search grounding]
  V --> UI[Live transcript<br/>+ claim badges]
  UI --> SC[Founder Score<br/>at session end]
  classDef ai fill:#8E75B2,color:#fff,stroke:#8E75B2
  classDef code fill:#1f2937,color:#fff,stroke:#1f2937
  class GL,V,SC ai
  class B,S,F,UI code
```

The filter is half code, half model: obvious claims are caught by regex, and only the unclear ones go to `gemini-3.1-flash-lite`.

### Verdict rules

```mermaid
flowchart TD
  C[Claim sentence] --> Q{Checkable?}
  Q -- no --> SK[Not checked]
  Q -- yes --> G[Search the web]
  G --> R{What did search find?}
  R -- affirms the whole claim --> SU[supported]
  R -- conflicts with it --> CO[contradicted]
  R -- some parts right,<br/>some wrong --> MI[mixed]
  R -- nothing relevant, private<br/>metric, or subjective --> UN[unverifiable]
  classDef good fill:#15803d,color:#fff,stroke:#15803d
  classDef bad fill:#b91c1c,color:#fff,stroke:#b91c1c
  classDef warn fill:#b45309,color:#fff,stroke:#b45309
  classDef grey fill:#6b7280,color:#fff,stroke:#6b7280
  class SU good
  class CO bad
  class MI warn
  class UN,SK grey
```

### A pitch session

```mermaid
sequenceDiagram
  actor F as Founder
  actor I as Investor
  participant B as Browser
  participant S as Server
  participant G as Gemini
  I->>B: Start Pitch Session
  F->>B: Pitches out loud
  B->>S: Audio frames (WebSocket)
  S->>G: Relay to Live API
  G-->>S: Transcript text
  S->>G: Verify each checkable claim
  G-->>B: Verdict, confidence, sources
  I->>B: Stop
  B->>S: Score the session
  S-->>I: Founder Score, evidence,<br/>follow-up questions
```

## Tech stack

- Next.js 15 + React 19, Tailwind CSS 4, Framer Motion, lucide-react
- Custom Express server (`server.ts`) hosting both the Next.js app and a raw WebSocket endpoint (`/api/live-ws`)
- `@google/genai` — Gemini Live API (transcription), Gemini with Google Search grounding (verification), Gemini structured output (classification + scoring)

## Run locally

**Prerequisites:** Node.js

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` to your Gemini API key.
3. Start the app:
   ```
   npm run dev
   ```
4. Open `http://localhost:3000`, grant microphone (and optionally camera) access, and click **Start Pitch Session**.

## Environment variables

| Variable | Description |
| --- | --- |
| `GEMINI_API_KEY` | Required. Used for Gemini Live transcription, claim verification, classification, and scoring. |
| `GEMINI_API_KEY_PAID` | Optional. If set, takes priority over `GEMINI_API_KEY` — useful for pointing at a paid-tier project instead of a free-tier key. |
| `APP_URL` | The URL the app is hosted at (used for self-referential links). |

## Project structure

```
app/            Next.js app router pages (main UI in app/page.tsx)
server.ts       Custom Express + WebSocket server, Gemini API routes
hooks/          Shared React hooks
lib/            Shared utilities
assets/         Static assets
```
