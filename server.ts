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

    try {
      console.log("[Live API] Connecting to Gemini Live API...");
      session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are a silent transcriber for PitchProof. Your sole purpose is to capture and transcribe raw microphone input. Never produce vocal audio, speech, or conversational remarks. Maintain absolute silence. The transcription of the founder's pitch is retrieved via the inputAudioTranscription feature.",
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("[Live API] Connected to Gemini Live session!");
            clientWs.send(JSON.stringify({ type: "status", status: "connected" }));
          },
          onclose: () => {
            console.log("[Live API] Gemini Live session closed.");
            clientWs.send(JSON.stringify({ type: "status", status: "disconnected" }));
          },
          onerror: (err) => {
            console.error("[Live API] Gemini Live session error:", err);
            clientWs.send(JSON.stringify({ type: "error", error: err.message || String(err) }));
          },
          onmessage: (message: any) => {
            // Log full message for visual debugging in the console
            console.log("[Live API] Message from Gemini:", JSON.stringify(message));
            
            // Extract input transcription
            const parts = message.serverContent?.userTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.text) {
                  console.log("[Live API] Transcription fragment received:", part.text);
                  clientWs.send(JSON.stringify({ type: "transcription", text: part.text }));
                }
              }
            }
          },
        },
      });
    } catch (err: any) {
      console.error("[Live API] Failed to connect to Gemini Live:", err);
      clientWs.send(JSON.stringify({ type: "error", error: "Failed to connect to Gemini Live API: " + err.message }));
      clientWs.close();
      return;
    }

    clientWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "audio" && msg.data) {
          if (session) {
            session.sendRealtimeInput({
              audio: {
                data: msg.data, // base64 pcm audio
                mimeType: "audio/pcm;rate=16000",
              },
            });
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
