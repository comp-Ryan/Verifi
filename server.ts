import express from 'express';
import next from 'next';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from "@google/genai";
import { loadEnvConfig } from '@next/env';

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
          systemInstruction: "You are a silent transcriber for PitchProof. Your sole purpose is to capture and transcribe raw microphone input. Never produce vocal audio, speech, or conversational remarks. Maintain absolute silence. The transcription of the founder's pitch is retrieved via the inputAudioTranscription feature.",
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
              
              let textFound = false;

              // 1. Check exact inputAudioTranscription path (main user speech transcription path)
              const inputParts = message.serverContent?.inputTranscription?.parts || message.inputTranscription?.parts;
              if (inputParts && Array.isArray(inputParts)) {
                for (const part of inputParts) {
                  if (part.text) {
                    console.log("[Live API] Found inputTranscription part:", part.text);
                    safeSend({ type: "transcription", text: part.text });
                    textFound = true;
                  }
                }
              }

              // 2. Check standard path: serverContent -> userTurn -> parts
              if (!textFound) {
                const userParts = message.serverContent?.userTurn?.parts || message.userTurn?.parts;
                if (userParts && Array.isArray(userParts)) {
                  for (const part of userParts) {
                    if (part.text) {
                      console.log("[Live API] Found userTurn transcription part:", part.text);
                      safeSend({ type: "transcription", text: part.text });
                      textFound = true;
                    }
                  }
                }
              }

              // 3. Check modelTurn parts
              if (!textFound) {
                const modelParts = message.serverContent?.modelTurn?.parts || message.modelTurn?.parts;
                if (modelParts && Array.isArray(modelParts)) {
                  for (const part of modelParts) {
                    if (part.text) {
                      console.log("[Live API] Found modelTurn text part:", part.text);
                      safeSend({ type: "transcription", text: part.text });
                      textFound = true;
                    }
                  }
                }
              }

              // 4. Fallback: Safe depth-limited, circular-safe deep search
              if (!textFound) {
                const foundTexts = safeDeepSearch(message);
                if (foundTexts.length > 0) {
                  console.log("[Live API] Safe deep-search discovered text fragments:", foundTexts);
                  for (const txt of foundTexts) {
                    safeSend({ type: "transcription", text: txt });
                  }
                }
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
