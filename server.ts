import express from 'express';
import next from 'next';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from "@google/genai";
import { loadEnvConfig } from '@next/env';
import fs from 'fs';
import path from 'path';

// Load environment variables from .env / .env.local
loadEnvConfig(process.cwd());

// Top-level process safety net to prevent server crashes
process.on('uncaughtException', (err) => {
  console.error("[Process safety net] Uncaught Exception caught:", err, err?.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("[Process safety net] Unhandled Rejection at:", promise, "reason:", reason);
});

const port = parseInt(process.env.PORT || '3000', 10);
const dev = process.env.NODE_ENV !== 'production';

// If running in development mode, delete any existing production `.next` build directory
// to prevent development/production manifest mismatches (e.g., SegmentViewNode or 833.js errors).
// We check if a 'next build' process is currently running to avoid deleting files mid-build (race conditions).
if (dev) {
  const nextDir = path.join(process.cwd(), '.next');
  if (fs.existsSync(nextDir)) {
    console.log("[Dev Server] Removing production build directory (.next) to prevent development/production manifest mismatch...");
    try {
      fs.rmSync(nextDir, { recursive: true, force: true });
    } catch (err) {
      console.error("[Dev Server] Error removing .next directory:", err);
    }
  }
}

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const expressApp = express();
  expressApp.use(express.json({ limit: '1mb' }));

  expressApp.post('/api/verify-claim', async (req: any, res: any) => {
    try {
      const sentence = req.body?.sentence;
      if (!sentence || typeof sentence !== 'string' || !sentence.trim()) {
        return res.status(400).json({ error: 'Missing sentence' });
      }
      console.log('[Verify] Checking claim:', sentence);

      // googleSearch grounding CANNOT be combined with responseMimeType/
      // responseSchema JSON mode — the API rejects it. Ask for JSON in the
      // prompt and parse defensively instead.
      const result = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: [{
          role: 'user',
          parts: [{
            text:
`You are a fact-checker for startup pitch claims. Use Google Search to verify this claim:

"${sentence.trim()}"

Respond with ONLY a JSON object, no markdown fences, no other text:
{"verdict":"supported"|"contradicted"|"mixed"|"unverifiable","confidence":<0 to 1>,"evidence":"<2-3 sentence explanation of the reasoning: what was searched, what was found, and why this verdict>"}

Rules: "supported" only if search results affirm the whole claim.
"contradicted" only if results conflict with it. "mixed" when the sentence
contains multiple factual assertions and search confirms some but
contradicts or fails to support others — the evidence text MUST state which
part is right and which part is wrong. "unverifiable" if subjective,
personal, or search finds nothing relevant — the evidence text MUST explain
WHY it could not be verified (e.g. private company metric, subjective
claim, no relevant search results). A company's own private metrics (their
user counts, revenue) are usually "unverifiable" unless public sources
confirm or contradict them.`
          }]
        }],
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const rawText = result.text ?? '';
      let parsed: any = null;
      try {
        const cleaned = rawText.replace(/```json|```/g, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end > start) parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch (parseErr) {
        console.error('[Verify] JSON parse failed:', parseErr);
      }
      if (!parsed || !['supported', 'contradicted', 'mixed', 'unverifiable'].includes(parsed.verdict)) {
        parsed = { verdict: 'unverifiable', confidence: 0, evidence: 'Verification response could not be parsed.' };
      }

      // Sources come ONLY from grounding metadata, never from model text
      const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources = chunks
        .map((c: any) => ({ title: c.web?.title ?? 'Source', url: c.web?.uri ?? '' }))
        .filter((s: any) => s.url)
        .slice(0, 5);

      return res.json({
        verdict: parsed.verdict,
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
        evidence: String(parsed.evidence ?? ''),
        sources,
      });
    } catch (err: any) {
      console.error('[Verify] Endpoint error:', err);
      const errMsg = err?.message || String(err);
      const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED');
      return res.status(isRateLimit ? 429 : 500).json({ error: 'Verification failed', detail: errMsg });
    }
  });

  expressApp.post('/api/classify-claim', async (req: any, res: any) => {
    try {
      const sentence = req.body?.sentence;
      if (!sentence || typeof sentence !== 'string' || !sentence.trim()) {
        return res.status(400).json({ error: 'Missing sentence' });
      }
      // Cheap, fast model — no search tool, so structured JSON is allowed
      const result = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: [{
          role: 'user',
          parts: [{
            text:
`A founder is pitching their startup. Decide if this sentence contains a
factual claim worth fact-checking with a web search:

"${sentence.trim()}"

checkable = true if it asserts something verifiable about the world:
statistics, market sizes, competitor facts, company facts, funding,
traction numbers, "first/only/biggest" style claims, named partnerships,
public figures or events.
checkable = false for: opinions, vision/mission statements, generic tech
descriptions ("we use AI"), personal anecdotes, filler, greetings,
questions, or the founder's own private unpublished metrics that no
search could confirm.`
          }]
        }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              checkable: { type: 'boolean' },
              reason: { type: 'string' },
            },
            required: ['checkable', 'reason'],
          },
        },
      });
      const parsed = JSON.parse(result.text ?? '{}');
      return res.json({ checkable: !!parsed.checkable, reason: String(parsed.reason ?? '') });
    } catch (err: any) {
      console.error('[Classify] Endpoint error:', err);
      const errMsg = err?.message || String(err);
      const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED');
      return res.status(isRateLimit ? 429 : 500).json({ error: 'Classification failed', detail: errMsg });
    }
  });

  expressApp.post('/api/founder-score', async (req: any, res: any) => {
    try {
      const { transcript, claims } = req.body ?? {};
      if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
        return res.status(400).json({ error: 'Missing transcript' });
      }
      const claimsSummary = Array.isArray(claims) ? claims.map((c: any) =>
        `- "${c.sentence}" [checkable: ${c.isCheckable}${c.verdict ? `, verdict: ${c.verdict}, confidence: ${c.confidence}, evidence: ${c.evidence}` : ''}]`
      ).join('\n') : 'None';

      // No search tool in this call, so structured JSON output IS allowed here.
      const result = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: [{
          role: 'user',
          parts: [{
            text:
`You are an investor-grade pitch evaluator. Score this founder's pitch.

TRANSCRIPT:
${transcript.trim()}

CLAIMS AND VERIFICATION VERDICTS:
${claimsSummary}

Scoring rules: contradicted claims damage credibility heavily. Supported
specific claims raise it. Unverifiable big claims are mild negatives.
Mixed verdicts count as partially credible and should generate a follow-up
question targeting the incorrect part.
Judge clarity from the transcript structure, traction from concrete
supported metrics, and market understanding from specificity about
customers and competition. All dimension scores and overallScore are
0-100.`
          }]
        }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              overallScore: { type: 'number' },
              dimensions: {
                type: 'object',
                properties: {
                  credibility: { type: 'number' },
                  clarity: { type: 'number' },
                  traction: { type: 'number' },
                  marketUnderstanding: { type: 'number' },
                },
                required: ['credibility', 'clarity', 'traction', 'marketUnderstanding'],
              },
              summary: { type: 'string' },
              evidenceTrail: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    claim: { type: 'string' },
                    verdict: { type: 'string' },
                    impact: { type: 'string' },
                  },
                  required: ['claim', 'verdict', 'impact'],
                },
              },
              followUpQuestions: { type: 'array', items: { type: 'string' } },
            },
            required: ['overallScore', 'dimensions', 'summary', 'evidenceTrail', 'followUpQuestions'],
          },
        },
      });

      const parsed = JSON.parse(result.text ?? '{}');
      return res.json(parsed);
    } catch (err: any) {
      console.error('[Score] Endpoint error:', err);
      if (String(err?.message || err).includes('429') || String(err?.message || err).includes('RESOURCE_EXHAUSTED')) {
        return res.status(429).json({ error: 'Rate limited', detail: err?.message || String(err) });
      }
      return res.status(500).json({ error: 'Scoring failed', detail: err?.message || String(err) });
    }
  });

  const server = createServer(expressApp);
  const wss = new WebSocketServer({ noServer: true });

  // Handle all standard Next.js requests
  expressApp.all(/.*/, (req, res) => {
    return handle(req, res);
  });

  // Handle WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url || '', `http://${req.headers.host}`);
    if (pathname === '/api/live-ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // Initialize Google Gen AI. GEMINI_API_KEY_PAID (a user-named secret) wins
  // over GEMINI_API_KEY, which AI Studio auto-injects and may point at a
  // free-tier project.
  const apiKey = process.env.GEMINI_API_KEY_PAID || process.env.GEMINI_API_KEY;
  console.log('[Live API] Using key source:', process.env.GEMINI_API_KEY_PAID ? 'GEMINI_API_KEY_PAID' : 'GEMINI_API_KEY', '(length:', (apiKey || '').length + ')');
  if (!apiKey) {
    console.error("[Live API Error] GEMINI_API_KEY is not defined in the environment.");
  }

  const ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  // Handle WebSocket connections
  wss.on('connection', async (clientWs) => {
    console.log("[Live API] Client connected to live-ws");
    
    // Helper to safely send messages over client WebSocket without throwing
    const safeSend = (payload: any) => {
      try {
        if (clientWs && clientWs.readyState === 1) { // 1 is WebSocket.OPEN
          clientWs.send(JSON.stringify(payload));
        } else {
          console.warn("[Live API] Could not send message, client WebSocket is not in OPEN state:", clientWs?.readyState);
        }
      } catch (err) {
        console.error("[Live API] Error in safeSend:", err);
      }
    };

    safeSend({ type: "status", status: "connecting" });
    
    let session: any = null;

    // Safe depth-limited, circular-safe deep search for 'text' properties to prevent stack overflows/circular reference crashes
    const safeDeepSearch = (obj: any, depth: number = 0, visited = new Set<any>()): string[] => {
      let results: string[] = [];
      if (!obj || typeof obj !== "object" || depth > 8 || visited.has(obj)) {
        return results;
      }
      visited.add(obj);

      try {
        if (typeof obj.text === "string" && obj.text.trim()) {
          const txt = obj.text.trim();
          if (!txt.includes("You are a silent transcriber")) {
            results.push(txt);
          }
        }
        
        for (const key of Object.keys(obj)) {
          if (key !== "systemInstruction" && key !== "config") {
            results = results.concat(safeDeepSearch(obj[key], depth + 1, visited));
          }
        }
      } catch (e) {
        console.error("[Live API] Error in safeDeepSearch helper:", e);
      }
      return results;
    };

    // Helper function to establish connection with a specific model
    const connectSession = async (modelName: string) => {
      console.log(`[Live API] Connecting to Gemini Live API with model: ${modelName}...`);
      session = await ai.live.connect({
        model: modelName,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are a silent transcriber for Verifi. Your sole purpose is to capture and transcribe raw microphone input. Never produce vocal audio, speech, or conversational remarks. Maintain absolute silence. The transcription of the founder's pitch is retrieved via the inputAudioTranscription feature.",
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            try {
              console.log(`[Live API] Connected to Gemini Live session using model ${modelName}!`);
              safeSend({ type: "status", status: "connected", model: modelName });
            } catch (err) {
              console.error("[Live API] Error in onopen callback:", err);
            }
          },
          onclose: (event?: any) => {
            try {
              const closeCode = event?.code || "N/A";
              const closeReason = event?.reason || event?.message || "No reason provided";
              console.warn(`[Live API] Gemini Live session closed for model ${modelName}. Code: ${closeCode}, Reason: ${closeReason}`);
              safeSend({ 
                type: "status", 
                status: "disconnected", 
                model: modelName,
                code: closeCode,
                reason: closeReason
              });
            } catch (err) {
              console.error("[Live API] Error in onclose callback:", err);
            }
          },
          onerror: (err: any) => {
            try {
              console.error(`[Live API] Gemini Live session error for model ${modelName}:`, err);
              safeSend({ 
                type: "error", 
                model: modelName,
                error: err?.message || String(err),
                stack: err?.stack || ""
              });
            } catch (cbErr) {
              console.error("[Live API] Error in onerror callback:", cbErr);
            }
          },
          onmessage: (message: any) => {
            try {
              // Extensive logging of the exact message structure as requested
              console.log("[Live API] Message from Gemini:", JSON.stringify(message));
              
              const userText = message.serverContent?.inputTranscription?.text;
              if (userText && typeof userText === "string" && userText.trim()) {
                console.log("[Live API] Found user input transcription:", userText);
                safeSend({ type: "transcription", text: userText });
              }
            } catch (msgErr: any) {
              console.error("[Live API] Error in onmessage callback:", msgErr, msgErr.stack);
            }
          },
        },
      });
    };

    // Try starting with primary model
    try {
      await connectSession("gemini-3.1-flash-live-preview");
    } catch (err: any) {
      console.error("[Live API] Failed to connect to Gemini Live session using gemini-3.1-flash-live-preview:", err);
      safeSend({ 
        type: "error", 
        error: `Failed to connect with primary model gemini-3.1-flash-live-preview. Error: ${err.message || err}`
      });
      try {
        clientWs.close();
      } catch (wsCloseErr) {
        console.error("[Live API] Error closing client ws after failed connection:", wsCloseErr);
      }
      return;
    }

    clientWs.on("error", (wsErr) => {
      try {
        console.error("[Live API] Client WebSocket error:", wsErr);
      } catch (e) {
        console.error("[Live API] Error in clientWs error handler:", e);
      }
    });

    clientWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "audio" && msg.data) {
          if (session) {
            try {
              session.sendRealtimeInput({
                audio: {
                  data: msg.data, // base64 pcm audio
                  mimeType: "audio/pcm;rate=16000",
                },
              });
            } catch (sendErr: any) {
              console.error("[Live API] Failed to deliver audio frame to Gemini session:", sendErr);
              safeSend({ type: "error", error: "Failed to stream audio to Gemini: " + sendErr.message });
            }
          }
        }
      } catch (err) {
        console.error("[Live API] Error processing client message:", err);
      }
    });

    clientWs.on("close", () => {
      try {
        console.log("[Live API] Client disconnected from live-ws");
        if (session) {
          try {
            session.close();
          } catch (e) {
            console.error("[Live API] Error closing Gemini session:", e);
          }
        }
      } catch (err) {
        console.error("[Live API] Error in clientWs close handler:", err);
      }
    });
  });

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
}).catch((err) => {
  console.error("Error starting custom server:", err);
  process.exit(1);
});
