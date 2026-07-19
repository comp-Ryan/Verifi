import express from 'express';
import next from 'next';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from "@google/genai";
import { loadEnvConfig } from '@next/env';

// Load environment variables from .env / .env.local
loadEnvConfig(process.cwd());

const port = parseInt(process.env.PORT || '3000', 10);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const expressApp = express();
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

  // Initialize Google Gen AI
  const apiKey = process.env.GEMINI_API_KEY;
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
    clientWs.send(JSON.stringify({ type: "status", status: "connecting" }));
    
    let session: any = null;

    // Helper function to establish connection with a specific model
    const connectSession = async (modelName: string) => {
      console.log(`[Live API] Connecting to Gemini Live API with model: ${modelName}...`);
      session = await ai.live.connect({
        model: modelName,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are a silent transcriber for PitchProof. Your sole purpose is to capture and transcribe raw microphone input. Never produce vocal audio, speech, or conversational remarks. Maintain absolute silence. The transcription of the founder's pitch is retrieved via the inputAudioTranscription feature.",
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log(`[Live API] Connected to Gemini Live session using model ${modelName}!`);
            clientWs.send(JSON.stringify({ type: "status", status: "connected", model: modelName }));
          },
          onclose: (event?: any) => {
            const closeCode = event?.code || "N/A";
            const closeReason = event?.reason || event?.message || "No reason provided";
            console.warn(`[Live API] Gemini Live session closed for model ${modelName}. Code: ${closeCode}, Reason: ${closeReason}`);
            clientWs.send(JSON.stringify({ 
              type: "status", 
              status: "disconnected", 
              model: modelName,
              code: closeCode,
              reason: closeReason
            }));
          },
          onerror: (err: any) => {
            console.error(`[Live API] Gemini Live session error for model ${modelName}:`, err);
            clientWs.send(JSON.stringify({ 
              type: "error", 
              model: modelName,
              error: err?.message || String(err),
              stack: err?.stack || ""
            }));
          },
          onmessage: (message: any) => {
            // Extensive logging of the exact message structure to identify if transcription format changed
            console.log("[Live API] Message from Gemini:", JSON.stringify(message));
            
            let textFound = false;

            // 1. Check standard path: serverContent -> userTurn -> parts
            const userParts = message.serverContent?.userTurn?.parts || message.userTurn?.parts;
            if (userParts && Array.isArray(userParts)) {
              for (const part of userParts) {
                if (part.text) {
                  console.log("[Live API] Found userTurn transcription part:", part.text);
                  clientWs.send(JSON.stringify({ type: "transcription", text: part.text }));
                  textFound = true;
                }
              }
            }

            // 2. Check modelTurn parts (just in case)
            if (!textFound) {
              const modelParts = message.serverContent?.modelTurn?.parts || message.modelTurn?.parts;
              if (modelParts && Array.isArray(modelParts)) {
                for (const part of modelParts) {
                  if (part.text) {
                    console.log("[Live API] Found modelTurn text part:", part.text);
                    clientWs.send(JSON.stringify({ type: "transcription", text: part.text }));
                    textFound = true;
                  }
                }
              }
            }

            // 3. Fallback: Deep search the message object for any 'text' properties to ensure nothing is missed
            if (!textFound) {
              const deepSearchTexts = (obj: any): string[] => {
                let results: string[] = [];
                if (!obj || typeof obj !== "object") return results;
                if (typeof obj.text === "string" && obj.text.trim()) {
                  // Ignore common config-level instructions or empty strings
                  const txt = obj.text.trim();
                  if (!txt.includes("You are a silent transcriber")) {
                    results.push(txt);
                  }
                }
                for (const key of Object.keys(obj)) {
                  // Skip system instruction or config keys to avoid false transcription hits
                  if (key !== "systemInstruction" && key !== "config") {
                    results = results.concat(deepSearchTexts(obj[key]));
                  }
                }
                return results;
              };

              const foundTexts = deepSearchTexts(message);
              if (foundTexts.length > 0) {
                console.log("[Live API] Deep-search discovered text fragments:", foundTexts);
                for (const txt of foundTexts) {
                  clientWs.send(JSON.stringify({ type: "transcription", text: txt }));
                }
              }
            }
          },
        },
      });
    };

    // Try starting with primary model and fall back to classic exp model if it fails immediately
    try {
      await connectSession("gemini-3.1-flash-live-preview");
    } catch (err: any) {
      console.warn("[Live API] Primary model (gemini-3.1-flash-live-preview) failed. Attempting fallback (gemini-2.0-flash-exp)...", err);
      try {
        await connectSession("gemini-2.0-flash-exp");
      } catch (fallbackErr: any) {
        console.error("[Live API] Fallback model also failed to connect:", fallbackErr);
        clientWs.send(JSON.stringify({ 
          type: "error", 
          error: `Failed to connect with both primary and fallback models. Primary error: ${err.message || err}. Fallback error: ${fallbackErr.message || fallbackErr}`
        }));
        clientWs.close();
        return;
      }
    }

    clientWs.on("error", (wsErr) => {
      console.error("[Live API] Client WebSocket error:", wsErr);
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
              clientWs.send(JSON.stringify({ type: "error", error: "Failed to stream audio to Gemini: " + sendErr.message }));
            }
          }
        }
      } catch (err) {
        console.error("[Live API] Error processing client message:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("[Live API] Client disconnected from live-ws");
      if (session) {
        try {
          session.close();
        } catch (e) {
          console.error("[Live API] Error closing Gemini session:", e);
        }
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
