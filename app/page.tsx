'use client';

import React, { useState, useRef, useEffect } from 'react';
import { 
  Mic, 
  MicOff, 
  Video, 
  VideoOff, 
  Play, 
  Square, 
  Activity, 
  Terminal, 
  Copy, 
  Check, 
  RotateCcw, 
  Sparkles, 
  FileText,
  Volume2,
  AlertCircle,
  HelpCircle,
  Clock,
  Settings
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'streaming';
  message: string;
}

export default function PitchProofPage() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [transcript, setTranscript] = useState<string>('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [cameraActive, setCameraActive] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionDuration, setSessionDuration] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-scroll transcript to bottom as new words arrive
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript]);

  // Session Duration Timer
  useEffect(() => {
    if (connectionStatus === 'connected') {
      timerRef.current = setInterval(() => {
        setSessionDuration(prev => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [connectionStatus]);

  // Helper to format session duration
  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const mins = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
  };

  // Utility to add logs both to screen state and console
  const addLog = (message: string, type: 'info' | 'success' | 'error' | 'streaming' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    const newLog: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp,
      type,
      message
    };
    setLogs(prev => [newLog, ...prev].slice(0, 50)); // Keep last 50 logs
    
    // Console logging format for user audit as explicitly requested
    console.log(`%c[PitchProof][${timestamp}] ${message}`, `color: ${type === 'success' ? '#10B981' : type === 'error' ? '#EF4444' : type === 'streaming' ? '#06B6D4' : '#6B7280'}`);
  };

  // Convert 32-bit floats to 16-bit signed PCM little-endian, then encode to base64
  const pcmToBase64 = (float32Array: Float32Array): string => {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(i * 2, val, true); // true = little-endian
    }
    
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  // Start the live audio capture and Gemini session
  const startSession = async () => {
    setErrorMsg(null);
    setSessionDuration(0);
    setConnectionStatus('connecting');
    addLog("Initializing real-time audio/video capture session...", 'info');

    try {
      // 1. Request microphone & camera
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: cameraActive ? { width: 640, height: 480 } : false,
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        });
        addLog("Camera and Microphone access granted successfully.", 'success');
      } catch (mediaErr) {
        addLog("Camera + Mic request failed. Attempting Microphone-only access...", 'info');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        });
        setCameraActive(false);
        addLog("Microphone-only access granted.", 'success');
      }

      streamRef.current = stream;

      // Bind stream to video element for visual preview
      if (videoRef.current && cameraActive) {
        videoRef.current.srcObject = stream;
      }

      // 2. Establish WebSocket to our server
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/live-ws`;
      addLog(`Connecting relay WebSocket to ${wsUrl}...`, 'info');
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        addLog("Relay WebSocket connection opened. Awaiting Gemini Live API shake-hand...", 'success');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          if (msg.type === 'status') {
            if (msg.status === 'connected') {
              setConnectionStatus('connected');
              addLog("Gemini Live API connected and pipeline is streaming!", 'success');
            } else if (msg.status === 'disconnected') {
              setConnectionStatus('disconnected');
              addLog("Gemini Live API session disconnected.", 'info');
            } else {
              addLog(`Gemini connection state update: ${msg.status}`, 'info');
            }
          } else if (msg.type === 'transcription') {
            // Append incoming live words continuously
            setTranscript(prev => prev ? prev + " " + msg.text : msg.text);
            addLog(`Live transcription chunk: "${msg.text}"`, 'streaming');
          } else if (msg.type === 'error') {
            setConnectionStatus('error');
            setErrorMsg(msg.error);
            addLog(`Gemini Live API error: ${msg.error}`, 'error');
            stopSession();
          }
        } catch (parseErr) {
          console.error("Failed to parse websocket message:", parseErr);
        }
      };

      ws.onerror = (e) => {
        setConnectionStatus('error');
        addLog("WebSocket client error encountered.", 'error');
      };

      ws.onclose = () => {
        addLog("Relay WebSocket connection closed.", 'info');
      };

      // 3. Setup Audio Capture Processor
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      // Create script processor to stream raw floats
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN && wsRef.current?.readyState === WebSocket.OPEN) {
          const rawFloatData = e.inputBuffer.getChannelData(0);
          const base64PCM = pcmToBase64(rawFloatData);
          ws.send(JSON.stringify({ type: 'audio', data: base64PCM }));
        }
      };

      setIsSessionActive(true);

    } catch (err: any) {
      console.error("Session startup failure:", err);
      setConnectionStatus('error');
      setErrorMsg(err.message || String(err));
      addLog(`Failed to start session: ${err.message || String(err)}`, 'error');
      stopSession();
    }
  };

  // Stop the live session
  const stopSession = () => {
    addLog("Stopping live capture and closing active pipelines...", 'info');
    
    // Stop all media tracks (camera & microphone)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    // Close AudioContext
    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
      audioContextRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    setIsSessionActive(false);
    if (connectionStatus !== 'error') {
      setConnectionStatus('disconnected');
    }
    addLog("Session closed. Final transcript retained on-screen.", 'success');
  };

  // Toggle Camera
  const toggleCamera = () => {
    if (isSessionActive) {
      addLog("Please stop the active session to toggle camera device settings.", 'info');
      return;
    }
    setCameraActive(!cameraActive);
    addLog(`Camera device ${!cameraActive ? 'enabled' : 'disabled'}.`, 'info');
  };

  // Copy transcript to clipboard
  const handleCopy = () => {
    if (!transcript) return;
    navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Reset Transcript
  const handleReset = () => {
    if (isSessionActive) {
      addLog("Please stop the session before resetting the transcript.", 'info');
      return;
    }
    setTranscript('');
    addLog("Transcript cleared.", 'info');
  };

  return (
    <div className="h-full min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900 overflow-x-hidden selection:bg-indigo-100 selection:text-indigo-950" id="pitchproof-root">
      {/* Top Header Navigation */}
      <header className="h-16 border-b border-slate-200 bg-white flex items-center justify-between px-6 sm:px-8 shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          {/* Geometric Balance Rotating Icon */}
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center shadow-xs">
            <div className="w-4 h-4 border-2 border-white rounded-sm rotate-45 transition-transform duration-1000 ease-in-out hover:rotate-90"></div>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-800 flex items-center">
            PitchProof 
            <span className="text-[10px] font-bold tracking-widest text-slate-400 bg-slate-100 border border-slate-200 uppercase px-2 py-0.5 rounded ml-3">
              V1.0 LIVE
            </span>
          </h1>
        </div>

        <div className="flex items-center gap-4 sm:gap-6">
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
              connectionStatus === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)] animate-pulse' :
              connectionStatus === 'connecting' ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)] animate-bounce' :
              connectionStatus === 'error' ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]' : 'bg-slate-300'
            }`}></div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hidden sm:inline">
              {connectionStatus === 'connected' ? 'Streaming Active' :
               connectionStatus === 'connecting' ? 'Connecting API...' :
               connectionStatus === 'error' ? 'API Error' : 'System Ready'}
            </span>
          </div>
          
          <div className="h-6 w-px bg-slate-200 hidden sm:block"></div>
          
          <div className="text-xs font-mono text-slate-400 flex items-center gap-1">
            <Clock className="w-3.5 h-3.5 text-slate-300" />
            {formatDuration(sessionDuration)}
          </div>
        </div>
      </header>

      {/* Main Interface Grid */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 p-4 sm:p-6 max-w-7xl w-full mx-auto">
        
        {/* Left Section: Video/Audio Preview & Telemetry Logs */}
        <div className="lg:col-span-7 flex flex-col gap-5">
          
          {/* Live Feed Preview Arena */}
          <div className="flex-1 bg-slate-900 rounded-xl border border-slate-800 relative overflow-hidden flex flex-col justify-between shadow-2xl p-5 min-h-[320px] aspect-video">
            {/* Camera Simulation Radial Gradient Overlay */}
            <div className="absolute inset-0 opacity-50 bg-[radial-gradient(circle_at_center,_transparent_0%,_black_100%)] pointer-events-none"></div>
            
            {/* Top HUD Row */}
            <div className="z-10 flex items-center justify-between w-full">
              <div className="bg-slate-950/80 backdrop-blur-md text-[10px] font-mono tracking-widest text-slate-400 px-2.5 py-1 rounded border border-slate-800/60 uppercase flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${isSessionActive ? 'bg-red-500 animate-ping' : 'bg-slate-500'}`} />
                {isSessionActive ? 'Live Source Active' : 'Feed Closed'}
              </div>

              <button 
                onClick={toggleCamera} 
                disabled={isSessionActive}
                className={`z-10 text-[10px] uppercase tracking-widest font-bold px-3 py-1.5 rounded-lg border transition-all ${
                  isSessionActive 
                    ? 'opacity-40 cursor-not-allowed bg-slate-900/50 text-slate-500 border-slate-800' 
                    : cameraActive 
                      ? 'bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-400 border-indigo-500/20' 
                      : 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/20'
                }`}
              >
                {cameraActive ? 'Camera Feed ON' : 'Camera Feed OFF'}
              </button>
            </div>

            {/* Video preview arena */}
            <div className="absolute inset-0 w-full h-full">
              {cameraActive ? (
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className="w-full h-full object-cover opacity-80"
                />
              ) : null}
            </div>

            {/* Center Status Indicators */}
            {!cameraActive && (
              <div className="z-10 text-center my-auto">
                <div className="w-16 h-16 bg-slate-800/80 rounded-full flex items-center justify-center mb-3 mx-auto border border-slate-700/60">
                  <VideoOff className="w-7 h-7 text-slate-400" />
                </div>
                <p className="text-slate-200 font-medium tracking-wide text-sm">Microphone: Default Input</p>
                <p className="text-slate-500 text-xs mt-1">Video source is disabled for this session</p>
              </div>
            )}

            {cameraActive && !isSessionActive && (
              <div className="z-10 text-center my-auto bg-slate-950/60 backdrop-blur-xs py-4 px-6 rounded-xl border border-slate-800/50 max-w-xs mx-auto">
                <p className="text-slate-300 text-xs font-semibold uppercase tracking-wider">Awaiting Start Signal</p>
                <p className="text-slate-500 text-[11px] mt-1">Press the Start Button below to begin recording</p>
              </div>
            )}

            {/* Audio Level Indicator Overlay (Simulated/Geometric Accents) */}
            <div className="z-10 w-full flex items-end gap-1.5 h-6 mt-auto">
              <div className={`flex-1 rounded-full transition-all duration-300 bg-indigo-500/20 ${isSessionActive ? 'h-3 bg-indigo-400/80' : 'h-1'}`} />
              <div className={`flex-1 rounded-full transition-all duration-300 bg-indigo-500/20 ${isSessionActive ? 'h-5 bg-indigo-400/80 delay-75 animate-pulse' : 'h-1'}`} />
              <div className={`flex-1 rounded-full transition-all duration-300 bg-indigo-500/20 ${isSessionActive ? 'h-2 bg-indigo-400/80 delay-100' : 'h-1'}`} />
              <div className={`flex-1 rounded-full transition-all duration-300 bg-indigo-500/20 ${isSessionActive ? 'h-4 bg-indigo-400/80 delay-150 animate-pulse' : 'h-1'}`} />
              <div className={`flex-1 rounded-full transition-all duration-300 bg-indigo-500/20 ${isSessionActive ? 'h-1.5 bg-indigo-400/80' : 'h-1'}`} />
            </div>
          </div>
          
          {/* Console Logs / Telemetry Panel */}
          <div className="h-44 bg-slate-900 rounded-xl border border-slate-800 p-4 font-mono text-[11px] leading-relaxed flex flex-col shadow-lg">
            <div className="text-slate-400 text-[10px] font-bold uppercase tracking-wider mb-2 pb-1.5 border-b border-slate-800 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                Pipeline Telemetry
              </span>
              <span className="text-[9px] text-slate-500">Rate: 16kHz PCM</span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 text-slate-300">
              {logs.length === 0 ? (
                <div className="text-slate-500 italic text-center py-6">
                  Awaiting pipe connectivity logs...
                </div>
              ) : (
                logs.map(log => (
                  <div key={log.id} className="flex gap-2">
                    <span className="text-slate-500">[{log.timestamp}]</span>
                    <span className={`font-semibold ${
                      log.type === 'success' ? 'text-emerald-400' :
                      log.type === 'error' ? 'text-red-400' :
                      log.type === 'streaming' ? 'text-cyan-400' : 'text-indigo-400'
                    }`}>
                      {log.type === 'success' ? 'SUCCESS:' :
                       log.type === 'error' ? 'ERROR:' :
                       log.type === 'streaming' ? 'STREAM:' : 'SYSTEM:'}
                    </span>
                    <span className="text-slate-300">{log.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right Section: Live Transcription Card */}
        <div className="lg:col-span-5 flex flex-col bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden min-h-[480px]">
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
              <FileText className="w-4 h-4 text-slate-400" />
              Live Transcript
            </h2>
            <div className="flex gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-slate-200"></div>
              <div className="w-1.5 h-1.5 rounded-full bg-slate-200"></div>
              <div className="w-1.5 h-1.5 rounded-full bg-slate-200"></div>
            </div>
          </div>

          {/* Transcript Content display */}
          <div className="flex-1 p-6 relative flex flex-col justify-between overflow-hidden">
            <div className="flex-1 overflow-y-auto max-h-[380px] pb-12">
              {!transcript ? (
                <p className="text-slate-400 leading-relaxed italic text-sm text-center py-20 px-4">
                  Waiting for session to begin... Live transcription will appear here in real-time as the founder speaks.
                </p>
              ) : (
                <div className="text-slate-800 text-base leading-relaxed tracking-wide font-normal whitespace-pre-wrap">
                  &ldquo;{transcript}&rdquo;
                  {isSessionActive && (
                    <span className="inline-flex ml-1 items-center gap-0.5">
                      <span className="w-1.5 h-3.5 bg-indigo-600 rounded-xs animate-pulse" />
                    </span>
                  )}
                  <div ref={transcriptEndRef} />
                </div>
              )}
            </div>

            {/* Bottom Gradient Fade */}
            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white to-transparent pointer-events-none"></div>
          </div>

          {/* Actions Pane */}
          <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-tight">
              <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
              Gemini Live Protocol
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCopy}
                disabled={!transcript}
                className="py-1.5 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-xs"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>

              <button
                onClick={handleReset}
                disabled={!transcript || isSessionActive}
                className="py-1.5 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-xs"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* Sticky Bottom Control Bar */}
      <footer className="bg-white border-t border-slate-200 py-5 px-6 sm:px-8 flex flex-col md:flex-row items-center justify-between gap-4 shrink-0 sticky bottom-0 z-20 shadow-lg shadow-slate-200/50">
        <div className="flex flex-col text-center md:text-left">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Session Status</span>
          <span className="text-sm font-bold text-slate-700 mt-0.5">
            {connectionStatus === 'connected' ? 'Session Streaming' : 
             connectionStatus === 'connecting' ? 'Pipeline Initializing...' : 
             connectionStatus === 'error' ? 'Failed connection' : 'Ready to record'}
          </span>
        </div>

        {errorMsg && (
          <div className="bg-red-50 text-red-700 text-xs py-1.5 px-3 rounded-lg border border-red-100 max-w-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
            <span className="truncate">{errorMsg}</span>
          </div>
        )}

        {/* Central Geometric Control Trigger */}
        <div className="flex items-center gap-3">
          {!isSessionActive ? (
            <button
              onClick={startSession}
              className="px-10 py-3.5 bg-indigo-600 text-white font-bold text-xs uppercase tracking-widest rounded-full shadow-lg shadow-indigo-200 hover:bg-indigo-700 hover:shadow-indigo-300 active:scale-95 flex items-center gap-3 transition-all"
            >
              <div className="w-2.5 h-2.5 rounded-full bg-white animate-pulse"></div>
              Start Pitch Session
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="px-10 py-3.5 bg-red-600 text-white font-bold text-xs uppercase tracking-widest rounded-full shadow-lg shadow-red-200 hover:bg-red-700 hover:shadow-red-300 active:scale-95 flex items-center gap-3 transition-all"
            >
              <div className="w-2.5 h-2.5 rounded-xs bg-white animate-spin"></div>
              Stop Session
            </button>
          )}
        </div>

        <div className="flex gap-4 items-center">
          <div className="flex flex-col items-end text-right hidden sm:flex">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Input Device</span>
            <span className="text-xs font-bold text-slate-600 mt-0.5">Default Studio Microphone</span>
          </div>
          <div className="w-9 h-9 bg-slate-50 rounded-full flex items-center justify-center text-slate-400 border border-slate-200 shadow-2xs">
            <Mic className="w-4 h-4 text-slate-500" />
          </div>
        </div>
      </footer>
    </div>
  );
}

