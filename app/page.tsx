/* eslint-disable */
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
  Settings,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  X,
  Award
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'streaming';
  message: string;
}

// Case-insensitive wordlists for Tier 1 claim-filtering heuristics
const CLAIM_KEYWORDS = {
  superlatives: [
    "only", "first", "best", "biggest", "largest", "fastest", "leading", 
    "no one else", "never been done"
  ],
  competitorMarkers: [
    "competitor", "unlike", "compared to"
  ],
  traction: [
    "users", "customers", "revenue", "arr", "mrr", "growth", 
    "market size", "tam", "retention", "churn", "signed", 
    "partnership", "funding", "raised"
  ],
  largeNumbers: [
    "million", "billion", "thousand"
  ]
};

// Checkable claim helper function utilizing simple, robust regular expressions
const checkSentenceIsCheckable = (sentence: string): boolean => {
  const lower = sentence.toLowerCase();

  // 1. Check for digits, percentages, or dollar/money symbols
  if (/[\d$%]/.test(sentence)) {
    return true;
  }

  // Word boundary regex matching helper
  const matchesWholeWord = (text: string, words: string[]): boolean => {
    return words.some(word => {
      const escaped = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      return regex.test(text);
    });
  };

  // 2. Superlatives, Exclusivities
  if (matchesWholeWord(lower, CLAIM_KEYWORDS.superlatives)) {
    return true;
  }

  // 3. Spelled-out large numbers
  if (matchesWholeWord(lower, CLAIM_KEYWORDS.largeNumbers)) {
    return true;
  }

  // 4. Traction or market-size markers
  if (matchesWholeWord(lower, CLAIM_KEYWORDS.traction)) {
    return true;
  }

  // 5. Competitor relative positioning markers
  if (matchesWholeWord(lower, CLAIM_KEYWORDS.competitorMarkers)) {
    return true;
  }

  // 6. Capitalized multi-word proper nouns that are not sentence-initial
  const properNounRegex = /\b[A-Z][a-zA-Z0-9']*(?:\s+[A-Z][a-zA-Z0-9']*)+\b/g;
  let properNounMatch;
  while ((properNounMatch = properNounRegex.exec(sentence)) !== null) {
    if (properNounMatch.index > 0) {
      return true;
    }
  }

  return false;
};

// Abbreviations that end with "." but do not end a sentence
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'inc', 'co', 'corp', 'ltd', 'st', 'vs', 'etc',
  'e.g', 'i.e', 'u.s', 'a.m', 'p.m'
]);

// Split buffered transcript text into complete sentences without breaking on
// decimals ("3.5"), versions ("GPT-4.1"), no-space periods (URLs), or common
// abbreviations. Returns completed sentences plus the unfinished remainder.
const splitIntoSentences = (text: string): { sentences: string[]; remainder: string } => {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '?' && ch !== '!') continue;

    // Consume runs of terminal punctuation ("?!", "...") as one boundary
    let end = i;
    while (end + 1 < text.length && '.?!'.includes(text[end + 1])) end++;

    if (ch === '.') {
      const prev = text[i - 1] ?? '';
      const next = text[end + 1] ?? '';
      // Decimal or version number: digit on both sides
      if (/\d/.test(prev) && /\d/.test(next)) { i = end; continue; }
      // No space after: URL, "perplexity.ai", mid-token period
      if (next && !/\s/.test(next)) { i = end; continue; }
      // Abbreviation before the period
      const wordMatch = text.slice(start, i).match(/([A-Za-z][A-Za-z.]*)$/);
      if (wordMatch && NON_TERMINAL_ABBREVIATIONS.has(wordMatch[1].toLowerCase().replace(/\.+$/, ''))) {
        i = end; continue;
      }
    }

    sentences.push(text.slice(start, end + 1).trim());
    start = end + 1;
    i = end;
  }
  return {
    sentences: sentences.filter(s => s.length > 0),
    remainder: text.slice(start).trim(),
  };
};

type Verdict = 'pending' | 'supported' | 'contradicted' | 'mixed' | 'unverifiable' | 'error';
interface VerificationResult {
  verdict: Verdict;
  confidence: number;
  evidence: string;
  sources: { title: string; url: string }[];
}

interface FounderScore {
  overallScore: number;
  dimensions: { credibility: number; clarity: number; traction: number; marketUnderstanding: number };
  summary: string;
  evidenceTrail: { claim: string; verdict: string; impact: string }[];
  followUpQuestions: string[];
}

export default function VerifiPage() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [transcript, setTranscript] = useState<string>('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [cameraActive, setCameraActive] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionDuration, setSessionDuration] = useState(0);
  const [sentences, setSentences] = useState<{ id: string; sentence: string; isCheckable: boolean; classification: 'heuristic' | 'classifying' | 'model-checkable' | 'not-checkable' }[]>([]);

  const [verifications, setVerifications] = useState<Record<string, VerificationResult>>({});
  const [founderScore, setFounderScore] = useState<FounderScore | null>(null);
  const [isScoring, setIsScoring] = useState(false);
  const [isScoreModalOpen, setIsScoreModalOpen] = useState(false);
  const autoVerifyCountRef = useRef(0);
  const activeVerifyCountRef = useRef(0);
  const verifyQueueRef = useRef<{ id: string; sentence: string }[]>([]);
  const retriedSentencesRef = useRef<Record<string, boolean>>({});
  const MAX_AUTO_VERIFICATIONS = 12;
  const MAX_CONCURRENT_VERIFICATIONS = 1;

  // Tier 2 classification queue (cheap model, higher rate limits than grounded search)
  const classifyQueueRef = useRef<{ id: string; sentence: string }[]>([]);
  const activeClassifyCountRef = useRef(0);
  const MAX_CONCURRENT_CLASSIFICATIONS = 3;

  // Claim detail modal
  const [detailClaimId, setDetailClaimId] = useState<string | null>(null);

  // Waits for in-flight verifications before scoring
  const scoreWaitTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Live audio meter / speaking indicator
  const rmsRef = useRef(0);
  const lastSpeechTsRef = useRef(0);
  const meterTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Refs mirroring state, so callbacks captured in old closures (WS handlers,
  // timers) always see current values
  const transcriptRef = useRef('');
  const sentencesRef = useRef<typeof sentences>([]);
  const verificationsRef = useRef<Record<string, VerificationResult>>({});
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { sentencesRef.current = sentences; }, [sentences]);
  useEffect(() => { verificationsRef.current = verifications; }, [verifications]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const sentencesEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = useRef<number>(0);
  const isSessionActiveRef = useRef<boolean>(false);
  const maxRetries = 3;

  const sentenceBufferRef = useRef<string>('');
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);

  async function runVerification(id: string, sentence: string) {
    activeVerifyCountRef.current += 1;
    setVerifications(prev => ({ ...prev, [id]: { verdict: 'pending', confidence: 0, evidence: '', sources: [] } }));
    try {
      const resp = await fetch('/api/verify-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentence }),
      });
      let errorDetail = '';
      if (!resp.ok) {
        try {
          const errData = await resp.json();
          errorDetail = errData.detail || errData.error || `HTTP ${resp.status}`;
        } catch {
          errorDetail = `HTTP ${resp.status}`;
        }
        throw new Error(errorDetail);
      }
      const data = await resp.json();
      console.log('[Verifi Verify]', { id, sentence, ...data });
      setVerifications(prev => ({ ...prev, [id]: data }));
    } catch (err: any) {
      console.error('[Verifi Verify] failed:', err);
      const errMsg = err?.message || String(err);
      const isRateLimit = errMsg.includes('429') || 
                          errMsg.toLowerCase().includes('quota') || 
                          errMsg.includes('RESOURCE_EXHAUSTED');
      
      if (isRateLimit && !retriedSentencesRef.current[id]) {
        retriedSentencesRef.current[id] = true;
        setVerifications(prev => ({ 
          ...prev, 
          [id]: { verdict: 'pending', confidence: 0, evidence: 'Rate limit hit. Retrying in 45s...', sources: [] } 
        }));
        setTimeout(() => {
          runVerification(id, sentence);
        }, 45000);
      } else {
        setVerifications(prev => ({ 
          ...prev, 
          [id]: { verdict: 'error', confidence: 0, evidence: errMsg, sources: [] } 
        }));
      }
    } finally {
      activeVerifyCountRef.current -= 1;
      setTimeout(() => {
        const next = verifyQueueRef.current.shift();
        if (next) runVerification(next.id, next.sentence);
      }, 4000);
    }
  }

  async function computeFounderScore() {
    if (!transcriptRef.current.trim()) return;
    setIsScoring(true);
    setIsScoreModalOpen(true);
    try {
      const transcript = transcriptRef.current;
      const verifications = verificationsRef.current;
      const claims = sentencesRef.current.map(s => ({
        sentence: s.sentence,
        isCheckable: s.isCheckable,
        ...(verifications[s.id] && !['pending', 'error'].includes(verifications[s.id].verdict)
          ? { verdict: verifications[s.id].verdict, confidence: verifications[s.id].confidence, evidence: verifications[s.id].evidence }
          : {}),
      }));
      const resp = await fetch('/api/founder-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, claims }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      console.log('[Verifi Score]', data);
      setFounderScore(data);
    } catch (err: any) {
      console.error('[Verifi Score] failed:', err);
      addLog(`Founder Score failed: ${err?.message || String(err)}`, 'error');
    } finally {
      setIsScoring(false);
    }
  }

  // Wait for in-flight verifications/classifications to settle (max 60s),
  // then compute the Founder Score with complete verdicts.
  function scheduleFounderScore() {
    if (!transcriptRef.current.trim()) return;
    if (scoreWaitTimerRef.current) clearInterval(scoreWaitTimerRef.current);

    setIsScoring(true);
    setIsScoreModalOpen(true);

    const startedAt = Date.now();
    const check = () => {
      const hasPendingVerifications =
        activeVerifyCountRef.current > 0 ||
        verifyQueueRef.current.length > 0 ||
        Object.values(verificationsRef.current).some(v => v.verdict === 'pending');
      const hasPendingClassifications =
        activeClassifyCountRef.current > 0 ||
        classifyQueueRef.current.length > 0 ||
        sentencesRef.current.some(s => s.classification === 'classifying');
      const timedOut = Date.now() - startedAt > 60000;

      if ((!hasPendingVerifications && !hasPendingClassifications) || timedOut) {
        if (scoreWaitTimerRef.current) {
          clearInterval(scoreWaitTimerRef.current);
          scoreWaitTimerRef.current = null;
        }
        if (timedOut) addLog('Some verifications did not finish in time; scoring with available verdicts.', 'info');
        computeFounderScore();
      }
    };

    scoreWaitTimerRef.current = setInterval(check, 1000);
    check();
  }

  async function runClassification(id: string, sentence: string) {
    activeClassifyCountRef.current += 1;
    try {
      const resp = await fetch('/api/classify-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentence }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      console.log('[Verifi Classify]', { sentence, checkable: data.checkable, reason: data.reason });
      setSentences(prev => prev.map(s => s.id === id
        ? { ...s, isCheckable: !!data.checkable, classification: data.checkable ? 'model-checkable' : 'not-checkable' }
        : s));
      if (data.checkable) {
        requestVerification(id, sentence, false);
      }
    } catch (err: any) {
      // Fail open to not-checkable — classification is not critical, no retry
      console.error('[Verifi Classify] failed:', err);
      setSentences(prev => prev.map(s => s.id === id ? { ...s, classification: 'not-checkable' } : s));
    } finally {
      activeClassifyCountRef.current -= 1;
      const next = classifyQueueRef.current.shift();
      if (next) runClassification(next.id, next.sentence);
    }
  }

  function requestClassification(id: string, sentence: string) {
    if (activeClassifyCountRef.current >= MAX_CONCURRENT_CLASSIFICATIONS) {
      classifyQueueRef.current.push({ id, sentence });
    } else {
      runClassification(id, sentence);
    }
  }

  function requestVerification(id: string, sentence: string, isManual: boolean) {
    if (!isManual) {
      if (autoVerifyCountRef.current >= MAX_AUTO_VERIFICATIONS) return;
      autoVerifyCountRef.current += 1;
    }
    if (activeVerifyCountRef.current >= MAX_CONCURRENT_VERIFICATIONS) {
      verifyQueueRef.current.push({ id, sentence });
      setVerifications(prev => ({ ...prev, [id]: { verdict: 'pending', confidence: 0, evidence: '', sources: [] } }));
    } else {
      runVerification(id, sentence);
    }
  }

  // Close the claim detail modal on Escape
  useEffect(() => {
    if (!detailClaimId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetailClaimId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailClaimId]);

  // Auto-scroll transcript to bottom as new words arrive
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript]);

  // Auto-scroll segmented sentences to bottom as new claims/segments arrive
  useEffect(() => {
    if (sentencesEndRef.current) {
      sentencesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [sentences]);

  const addSentence = (rawSentence: string) => {
    const sentence = rawSentence.trim();
    // Skip stray fragments: too short or containing no letters at all
    if (sentence.length < 4 || !/[a-zA-Z]/.test(sentence)) return;

    const heuristicCheckable = checkSentenceIsCheckable(sentence);
    const wordCount = sentence.split(/\s+/).length;
    const newId = Math.random().toString(36).substring(2, 9);

    // Tier 1 hit: checkable immediately. Otherwise Tier 2: let the cheap
    // model decide, for sentences long enough to hold a real claim.
    const classification: 'heuristic' | 'classifying' | 'not-checkable' =
      heuristicCheckable ? 'heuristic' : wordCount >= 5 ? 'classifying' : 'not-checkable';

    if (heuristicCheckable) {
      requestVerification(newId, sentence, false);
    } else if (classification === 'classifying') {
      requestClassification(newId, sentence);
    }

    setSentences(prev => {
      const updated = [...prev, { id: newId, sentence, isCheckable: heuristicCheckable, classification }];
      const logArray = updated.map(item => ({
        sentence: item.sentence,
        isCheckable: item.isCheckable
      }));
      console.log("[Verifi ClaimFilter] Current Claims:", JSON.stringify(logArray));
      return updated;
    });
  };

  const processSentenceBuffer = (isFlush = false) => {
    const text = sentenceBufferRef.current.trim();
    if (!text) return;

    if (isFlush) {
      addSentence(text);
      sentenceBufferRef.current = '';
      return;
    }

    const { sentences: completed, remainder } = splitIntoSentences(text);
    if (completed.length > 0) {
      completed.forEach(s => addSentence(s));
      sentenceBufferRef.current = remainder;
    }
  };

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

  // Clean up session on component unmount
  useEffect(() => {
    return () => {
      stopSession('Component unmounted');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    console.log(`%c[Verifi][${timestamp}] ${message}`, `color: ${type === 'success' ? '#10B981' : type === 'error' ? '#EF4444' : type === 'streaming' ? '#06B6D4' : '#6B7280'}`);
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

  // Handle disconnection or transient failures with retry logic
  function handleDisconnectOrFailure(reason: string) {
    // If the session is no longer active (user clicked stop or unmounted), ignore
    if (!isSessionActiveRef.current) {
      return;
    }

    if (retryCountRef.current < maxRetries) {
      retryCountRef.current += 1;
      // Exponential backoff with a cap at 6 seconds
      const backoffDelay = Math.min(6000, 1000 * Math.pow(1.5, retryCountRef.current));
      addLog(`Connection issues detected (${reason}). Retrying (Attempt ${retryCountRef.current}/${maxRetries}) in ${(backoffDelay / 1000).toFixed(1)}s...`, 'info');
      
      // Keep UI in connecting/initializing state to avoid flickering to error or disconnected
      setConnectionStatus('connecting');

      // Safely clear the active WebSocket so we can spawn a fresh one
      if (wsRef.current) {
        try {
          wsRef.current.onopen = null;
          wsRef.current.onmessage = null;
          wsRef.current.onerror = null;
          wsRef.current.onclose = null;
          wsRef.current.close();
        } catch (wsErr) {
          console.error("[Verifi] Error closing WS during retry backoff:", wsErr);
        }
        wsRef.current = null;
      }

      // Schedule the next connection attempt
      reconnectTimeoutRef.current = setTimeout(() => {
        if (isSessionActiveRef.current) {
          connectWebSocket();
        }
      }, backoffDelay);
    } else {
      addLog(`All ${maxRetries} reconnect attempts exhausted. Tearing down session.`, 'error');
      setConnectionStatus('error');
      setErrorMsg(`Connection failed after ${maxRetries} retry attempts. (${reason})`);
      stopSession(`Reconnect attempts exhausted: ${reason}`);
    }
  }

  // Connect and bind the relay WebSocket lifecycle
  function connectWebSocket() {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        wsRef.current.close();
      } catch (wsErr) {
        console.error("[Verifi] Error clearing old WS:", wsErr);
      }
      wsRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/live-ws`;
    addLog(`Connecting relay WebSocket to ${wsUrl}... (Attempt ${retryCountRef.current + 1}/${maxRetries + 1})`, 'info');

    // Make sure we represent connecting status in UI
    setConnectionStatus('connecting');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      addLog("Relay WebSocket connection opened. Awaiting Gemini Live API handshake...", 'success');
    };

    ws.onmessage = (event) => {
      console.log("[Verifi Client WS Raw Message Received]:", event.data);
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'status') {
          if (msg.status === 'connected') {
            setConnectionStatus('connected');
            // Reset retry count upon successfully receiving 'connected' state from Gemini
            retryCountRef.current = 0;
            addLog(`Gemini Live API connected and pipeline is streaming! (Model: ${msg.model || 'unknown'})`, 'success');
          } else if (msg.status === 'disconnected') {
            const disconnectReason = msg.reason ? ` Reason: ${msg.reason} (Code: ${msg.code || 'N/A'})` : '';
            addLog(`Gemini Live API session disconnected.${disconnectReason}`, 'info');
            
            // This is a session disconnect message describing the inner state - trigger retry
            handleDisconnectOrFailure(`Gemini session disconnected: ${msg.reason || 'No reason'}`);
          } else {
            addLog(`Gemini connection state update: ${msg.status}`, 'info');
          }
        } else if (msg.type === 'transcription') {
          console.log("[Verifi Live Transcript Chunk Received]:", msg.text);
          setTranscript(prev => prev ? prev + " " + msg.text : msg.text);
          addLog(`Live transcription chunk: "${msg.text}"`, 'streaming');

          // Append chunk to the active sentence buffer
          sentenceBufferRef.current += (sentenceBufferRef.current ? " " : "") + msg.text;

          // Clear any active silence timer
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }

          // Process the buffer for complete punctuated sentences
          processSentenceBuffer(false);

          // Reset the silence gap timer (750ms silence gap)
          silenceTimerRef.current = setTimeout(() => {
            if (sentenceBufferRef.current.trim()) {
              processSentenceBuffer(true); // Force flush sentence on silence gap
            }
          }, 750);
        } else if (msg.type === 'error') {
          addLog(`Gemini Live API inner error message received: ${msg.error}`, 'error');
          
          // Classify whether the error is completely unrecoverable vs transient
          const isUnrecoverable = 
            msg.error.includes("not found for API version") || 
            msg.error.includes("not supported for bidiGenerateContent") || 
            msg.error.includes("API_KEY environment variable is required") || 
            msg.error.includes("both primary and fallback models") || 
            msg.error.includes("unauthorized") || 
            msg.error.includes("invalid api key");

          if (isUnrecoverable) {
            addLog("Error is unrecoverable. Stopping session.", 'error');
            setConnectionStatus('error');
            setErrorMsg(msg.error);
            stopSession(`Unrecoverable Gemini Live API error: ${msg.error}`, { error: msg.error });
          } else {
            // Trigger retry for other transient errors
            handleDisconnectOrFailure(`Gemini session error: ${msg.error}`);
          }
        }
      } catch (parseErr: any) {
        console.error("[Verifi message-handling error] Failed to parse or process websocket message:", parseErr, parseErr.stack);
        addLog(`Message handling error: ${parseErr.message || String(parseErr)}`, 'error');
      }
    };

    ws.onerror = (e) => {
      // Log WebSocket client connection error.
      // We don't immediately call retry here because onclose is guaranteed to trigger next.
      console.error("[Verifi] Relay WebSocket client onerror:", e);
      addLog("Relay WebSocket connection error encountered.", 'error');
    };

    ws.onclose = (event) => {
      console.warn(`[Verifi] Relay WebSocket onclose event. Code: ${event.code}, Reason: ${event.reason || 'None'}`);
      addLog(`Relay WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason || 'None'}`, 'info');
      
      // Let's retry unless it was a clean close or user stopped the session
      if (isSessionActiveRef.current) {
        handleDisconnectOrFailure(`Relay WebSocket closed (Code: ${event.code})`);
      }
    };
  }

  // Start the live audio capture and Gemini session
  async function startSession() {
    setSentences([]);
    setVerifications({});
    setFounderScore(null);
    setIsScoreModalOpen(false);
    setDetailClaimId(null);
    sentenceBufferRef.current = '';
    verifyQueueRef.current = [];
    autoVerifyCountRef.current = 0;
    retriedSentencesRef.current = {};
    classifyQueueRef.current = [];
    if (scoreWaitTimerRef.current) {
      clearInterval(scoreWaitTimerRef.current);
      scoreWaitTimerRef.current = null;
    }

    setErrorMsg(null);
    setSessionDuration(0);
    setConnectionStatus('connecting');
    addLog("Initializing real-time audio/video capture session...", 'info');

    // Mark session as active synchronously so WebSocket events know they can proceed
    isSessionActiveRef.current = true;
    setIsSessionActive(true);
    retryCountRef.current = 0;

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

      // 2. Setup Audio Capture Processor
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      // Create script processor to stream raw floats
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        try {
          const rawFloatData = e.inputBuffer.getChannelData(0);

          // Live level meter: RMS into a ref (no setState at audio rate)
          let sumSquares = 0;
          for (let i = 0; i < rawFloatData.length; i++) sumSquares += rawFloatData[i] * rawFloatData[i];
          const rms = Math.sqrt(sumSquares / rawFloatData.length);
          rmsRef.current = rms;
          if (rms > 0.02) lastSpeechTsRef.current = Date.now();

          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            const base64PCM = pcmToBase64(rawFloatData);
            wsRef.current.send(JSON.stringify({ type: 'audio', data: base64PCM }));
          }
        } catch (audioErr: any) {
          console.error("[Verifi Audio Process Error] Error capturing/encoding/sending audio:", audioErr, audioErr.stack);
          addLog(`Audio processing error: ${audioErr.message || String(audioErr)}`, 'error');
          handleDisconnectOrFailure(`Audio processing exception: ${audioErr.message || String(audioErr)}`);
        }
      };

      // Drive the on-screen meter at ~30fps from the RMS ref
      if (meterTimerRef.current) clearInterval(meterTimerRef.current);
      meterTimerRef.current = setInterval(() => {
        setAudioLevel(rmsRef.current);
        setIsSpeaking(Date.now() - lastSpeechTsRef.current < 300);
      }, 33);

      // 3. Initiate WebSocket connection
      connectWebSocket();

    } catch (err: any) {
      console.error("Session startup failure:", err, err.stack);
      setConnectionStatus('error');
      setErrorMsg(err.message || String(err));
      addLog(`Failed to start session: ${err.message || String(err)}`, 'error');
      stopSession(`Exception during session startup: ${err.message || String(err)}`, { error: err, stack: err.stack });
    }
  }

  // Stop the live session
  function stopSession(reason: string = 'User initiated stop', details?: any) {
    console.warn(`[Verifi stopSession Triggered] Reason: ${reason}`, {
      details,
      stack: new Error().stack
    });
    addLog(`Stopping live capture and closing active pipelines... Reason: ${reason}`, 'info');
    
    // Clear silence timer and flush any remaining buffer
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (sentenceBufferRef.current.trim()) {
      processSentenceBuffer(true);
    }

    // Clear any reconnect timeouts
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    retryCountRef.current = 0;

    // Stop the audio meter
    if (meterTimerRef.current) {
      clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
    rmsRef.current = 0;
    setAudioLevel(0);
    setIsSpeaking(false);

    // Stop all media tracks (camera & microphone)
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach(track => {
          console.log(`[Verifi] Stopping media track: ${track.kind} (${track.label})`);
          track.stop();
        });
      } catch (trackErr: any) {
        console.error("[Verifi] Error stopping media tracks:", trackErr);
      }
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    // Close AudioContext
    if (audioContextRef.current) {
      try {
        if (audioContextRef.current.state !== 'closed') {
          audioContextRef.current.close();
        }
      } catch (audioCtxErr: any) {
        console.error("[Verifi] Error closing AudioContext:", audioCtxErr);
      }
      audioContextRef.current = null;
    }

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch (processorErr: any) {
        console.error("[Verifi] Error disconnecting processor:", processorErr);
      }
      processorRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
          wsRef.current.close(1000, "Session stopped by request");
        }
      } catch (wsCloseErr: any) {
        console.error("[Verifi] Error closing client WebSocket:", wsCloseErr);
      }
      wsRef.current = null;
    }

    isSessionActiveRef.current = false;
    setIsSessionActive(false);
    if (connectionStatus !== 'error') {
      setConnectionStatus('disconnected');
    }
    addLog("Session closed. Final transcript retained on-screen.", 'success');
    if (sentenceBufferRef.current?.trim()) processSentenceBuffer(true);
    scheduleFounderScore();
  }

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
    setSentences([]);
    sentenceBufferRef.current = '';
    setVerifications({});
    autoVerifyCountRef.current = 0;
    verifyQueueRef.current = [];
    classifyQueueRef.current = [];
    setFounderScore(null);
    setIsScoreModalOpen(false);
    setDetailClaimId(null);
    if (scoreWaitTimerRef.current) {
      clearInterval(scoreWaitTimerRef.current);
      scoreWaitTimerRef.current = null;
    }
    console.log("[Verifi ClaimFilter] Claims cleared.");
    addLog("Transcript and claims cleared.", 'info');
  };

  return (
    <div className="h-full min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900 overflow-x-hidden selection:bg-indigo-100 selection:text-indigo-950" id="verifi-root">
      {/* Top Header Navigation */}
      <header className="h-16 border-b border-slate-200 bg-white flex items-center justify-between px-6 sm:px-8 shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          {/* Geometric Balance Rotating Icon */}
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center shadow-xs">
            <div className="w-4 h-4 border-2 border-white rounded-sm rotate-45 transition-transform duration-1000 ease-in-out hover:rotate-90"></div>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-800 flex items-center">
            Verifi 
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
          <div className={`flex-1 bg-slate-900 rounded-xl border relative overflow-hidden flex flex-col justify-between shadow-2xl p-5 min-h-[320px] aspect-video transition-all duration-300 ${
            isSpeaking
              ? 'border-indigo-500/70 ring-2 ring-indigo-500/40 shadow-[0_0_28px_rgba(99,102,241,0.35)]'
              : 'border-slate-800'
          }`}>
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

            {/* Audio Level Indicator Overlay (driven by real mic RMS) */}
            <div className="z-10 w-full flex items-end gap-1.5 h-6 mt-auto">
              {[1.4, 2.2, 1.0, 1.8, 0.8].map((mult, idx) => {
                const px = isSessionActive
                  ? Math.max(4, Math.min(24, 4 + audioLevel * 260 * mult))
                  : 4;
                return (
                  <div
                    key={idx}
                    className={`flex-1 rounded-full transition-[height] duration-75 ${isSessionActive ? 'bg-indigo-400/80' : 'bg-indigo-500/20'}`}
                    style={{ height: `${px}px` }}
                  />
                );
              })}
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
        <div className="lg:col-span-5 flex flex-col bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden h-[640px]">
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
          <div className="flex-1 p-6 relative flex flex-col justify-between overflow-hidden min-h-[220px]">
            <div className="flex-1 overflow-y-auto max-h-[180px] pb-4">
              {!transcript ? (
                <p className="text-slate-400 leading-relaxed italic text-sm text-center py-10 px-4">
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
            <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent pointer-events-none"></div>
          </div>

          {/* Sentence Claim Filter Section */}
          <div className="flex-1 flex flex-col border-t border-slate-100 min-h-[280px] overflow-hidden">
            {/* Sub-header */}
            <div className="px-6 py-3 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-500 animate-pulse" />
                Claim Filter (Tier 1)
              </h3>
              <span className="text-[10px] font-mono font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">
                {sentences.filter(s => s.isCheckable).length} checkable
              </span>
            </div>

            {/* List of Segmented Sentences */}
            <div className="flex-1 p-6 overflow-y-auto space-y-4">
              {sentences.length === 0 ? (
                <p className="text-slate-400 leading-relaxed italic text-sm text-center py-12 px-4">
                  No sentences processed yet. Speak to segment the transcript and filter claims.
                </p>
              ) : (
                <div className="space-y-3">
                  {sentences.map((item) => {
                    const rowVerification = verifications[item.id];
                    const rowClickable = !!rowVerification && rowVerification.verdict !== 'pending';
                    return (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      onClick={() => { if (rowClickable) setDetailClaimId(item.id); }}
                      className={`p-3 rounded-lg border flex flex-col sm:flex-row sm:items-start gap-3 transition-colors ${
                        rowClickable ? 'cursor-pointer' : ''
                      } ${
                        item.isCheckable
                          ? 'bg-amber-50/40 border-amber-100 hover:bg-amber-50/70'
                          : 'bg-slate-50/30 border-slate-100/70 hover:bg-slate-50/70'
                      }`}
                      id={`sentence-card-${item.id}`}
                    >
                      {/* Left Badge Indicator */}
                      <div className="shrink-0 flex flex-wrap gap-1.5 items-center sm:flex-col sm:items-start">
                        {item.classification === 'classifying' ? (
                          <span className="inline-flex items-center gap-1 text-[9px] font-medium tracking-wider uppercase px-2 py-0.5 rounded-full bg-slate-100 text-slate-400 border border-slate-200 animate-pulse">
                            ...
                          </span>
                        ) : item.isCheckable ? (
                          <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                            <Sparkles className="w-2.5 h-2.5" />
                            CHECK
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[9px] font-medium tracking-wider uppercase px-2 py-0.5 rounded-full bg-slate-100 text-slate-400 border border-slate-200">
                            —
                          </span>
                        )}

                        {/* Verification rendering */}
                        {item.isCheckable && (() => {
                          const v = verifications[item.id];
                          if (!v) {
                            return (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestVerification(item.id, item.sentence, true);
                                }}
                                className="inline-flex items-center gap-1 text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white border border-indigo-700 cursor-pointer shadow-2xs transition-colors"
                              >
                                Verify
                              </button>
                            );
                          }

                          if (v.verdict === 'pending') {
                            return (
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                verifying...
                              </span>
                            );
                          }

                          if (v.verdict === 'supported') {
                            return (
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                                SUPPORTED {Math.round(v.confidence * 100)}%
                              </span>
                            );
                          }

                          if (v.verdict === 'contradicted') {
                            return (
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-200">
                                CONTRADICTED {Math.round(v.confidence * 100)}%
                              </span>
                            );
                          }

                          if (v.verdict === 'mixed') {
                            return (
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                                MIXED {Math.round(v.confidence * 100)}%
                              </span>
                            );
                          }

                          if (v.verdict === 'unverifiable') {
                            return (
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                                UNVERIFIED {Math.round(v.confidence * 100)}%
                              </span>
                            );
                          }

                          if (v.verdict === 'error') {
                            return (
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full bg-transparent text-rose-700 border border-rose-300">
                                ERROR
                              </span>
                            );
                          }

                          return null;
                        })()}
                      </div>
                      
                      {/* Sentence text; click the row for full verification details */}
                      <div className="flex-1 flex items-start justify-between gap-2">
                        <span className="text-sm font-normal text-slate-700 leading-relaxed break-words flex-1">{item.sentence}</span>
                        {rowClickable && (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-1 -rotate-90" />
                        )}
                      </div>
                    </motion.div>
                    );
                  })}
                  <div ref={sentencesEndRef} />
                </div>
              )}

              {/* Founder Score Section */}
              {(isScoring || founderScore) && (
                <div className="mt-6 border-t border-slate-200 pt-6">
                  {isScoring && (
                    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                      <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mb-3" />
                      <p className="text-sm font-medium text-slate-600">Analyzing pitch & claims...</p>
                      <p className="text-xs text-slate-400 mt-1">Evaluating credibility, clarity, traction, and market understanding...</p>
                    </div>
                  )}

                  {founderScore && !isScoring && (
                    <div className="space-y-6" id="founder-score-panel">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800 flex items-center gap-2">
                          <Activity className="w-5 h-5 text-indigo-600" />
                          Founder Pitch Score
                        </h3>
                        <button
                          onClick={computeFounderScore}
                          className="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold rounded-lg border border-indigo-100 transition-colors cursor-pointer"
                        >
                          Score Again
                        </button>
                      </div>

                      {/* Overall Score */}
                      <div className="flex items-center gap-4 bg-indigo-50/50 p-4 rounded-xl border border-indigo-100/40">
                        <div className="relative shrink-0 flex items-center justify-center">
                          <div className="w-20 h-20 rounded-full border-4 border-indigo-600 flex flex-col items-center justify-center bg-white shadow-xs">
                            <span className="text-2xl font-black text-indigo-700">{founderScore.overallScore}</span>
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">/ 100</span>
                          </div>
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-slate-800">Pitch Quality Index</h4>
                          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                            Based on claim accuracy, clarity, traction metrics, and customer/competitor understanding.
                          </p>
                        </div>
                      </div>

                      {/* Dimensions */}
                      <div className="space-y-3.5">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Dimension Analysis</h4>
                        <div className="grid grid-cols-1 gap-3">
                          {[
                            { label: 'Credibility', val: founderScore.dimensions?.credibility, color: 'bg-emerald-500' },
                            { label: 'Clarity', val: founderScore.dimensions?.clarity, color: 'bg-blue-500' },
                            { label: 'Traction', val: founderScore.dimensions?.traction, color: 'bg-indigo-500' },
                            { label: 'Market Understanding', val: founderScore.dimensions?.marketUnderstanding, color: 'bg-amber-500' }
                          ].map((dim, idx) => (
                            <div key={idx} className="space-y-1">
                              <div className="flex justify-between text-xs font-bold">
                                <span className="text-slate-600">{dim.label}</span>
                                <span className="text-slate-800">{dim.val ?? 0}/100</span>
                              </div>
                              <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                                <div className={`h-full ${dim.color} rounded-full`} style={{ width: `${dim.val ?? 0}%` }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Summary */}
                      <div className="space-y-2">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Executive Summary</h4>
                        <p className="text-xs text-slate-600 leading-relaxed bg-white p-3.5 rounded-lg border border-slate-100">
                          {founderScore.summary}
                        </p>
                      </div>

                      {/* Evidence Trail */}
                      {founderScore.evidenceTrail && founderScore.evidenceTrail.length > 0 && (
                        <div className="space-y-2.5">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Evidence Trail</h4>
                          <div className="space-y-2">
                            {founderScore.evidenceTrail.map((trail, idx) => (
                              <div key={idx} className="text-xs border border-slate-100 bg-white p-3 rounded-lg space-y-1.5 shadow-3xs">
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                  <span className="font-semibold text-slate-700 italic border-l-2 border-slate-200 pl-2">&ldquo;{trail.claim}&rdquo;</span>
                                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
                                    trail.verdict?.toLowerCase() === 'supported' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
                                    trail.verdict?.toLowerCase() === 'contradicted' ? 'bg-rose-50 text-rose-700 border border-rose-100' :
                                    trail.verdict?.toLowerCase() === 'mixed' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                                    'bg-slate-50 text-slate-600 border border-slate-100'
                                  }`}>
                                    {trail.verdict}
                                  </span>
                                </div>
                                <p className="text-slate-500 text-[11px] leading-relaxed">
                                  <span className="font-bold text-slate-600">Impact: </span>{trail.impact}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Suggested Follow-Ups */}
                      {founderScore.followUpQuestions && founderScore.followUpQuestions.length > 0 && (
                        <div className="space-y-2.5">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Suggested Follow-Ups</h4>
                          <ol className="list-decimal list-inside space-y-2 text-xs text-slate-600 bg-slate-50 p-3.5 rounded-lg border border-slate-100">
                            {founderScore.followUpQuestions.map((q, idx) => (
                              <li key={idx} className="leading-relaxed pl-1">
                                <span className="text-slate-700 font-medium">{q}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
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
                id="copy-transcript-btn"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>

              <button
                onClick={handleReset}
                disabled={!transcript || isSessionActive}
                className="py-1.5 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-xs"
                id="reset-transcript-btn"
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
              onClick={() => stopSession('User clicked Stop Button')}
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
          <div className={`w-9 h-9 rounded-full flex items-center justify-center border shadow-2xs transition-all duration-300 ${
            isSpeaking
              ? 'bg-indigo-50 border-indigo-300 ring-2 ring-indigo-200 animate-pulse'
              : 'bg-slate-50 border-slate-200'
          }`}>
            <Mic className={`w-4 h-4 transition-colors duration-300 ${isSpeaking ? 'text-indigo-600' : 'text-slate-500'}`} />
          </div>
        </div>
      </footer>

      {/* Claim Verification Detail Modal */}
      <AnimatePresence>
        {detailClaimId && (() => {
          const item = sentences.find(s => s.id === detailClaimId);
          const v = verifications[detailClaimId];
          if (!item || !v) return null;
          const verdictChip =
            v.verdict === 'supported' ? { label: 'SUPPORTED', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' } :
            v.verdict === 'contradicted' ? { label: 'CONTRADICTED', cls: 'bg-rose-100 text-rose-800 border-rose-200' } :
            v.verdict === 'mixed' ? { label: 'MIXED', cls: 'bg-amber-100 text-amber-800 border-amber-300' } :
            v.verdict === 'error' ? { label: 'ERROR', cls: 'bg-transparent text-rose-700 border-rose-300' } :
            { label: 'UNVERIFIED', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/60 backdrop-blur-sm"
              onClick={() => setDetailClaimId(null)}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 15 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 15 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden max-h-[85vh] flex flex-col text-slate-800"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="h-16 border-b border-slate-100 flex items-center justify-between px-6 shrink-0 bg-slate-50">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center shadow-3xs">
                      <Sparkles className="w-4.5 h-4.5 text-indigo-600" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Claim Verification</h3>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Grounded via Google Search</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setDetailClaimId(null)}
                    className="p-1.5 hover:bg-slate-100 text-slate-400 hover:text-slate-600 rounded-lg transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-5">
                  {/* Claim */}
                  <blockquote className="text-sm font-medium text-slate-800 leading-relaxed border-l-4 border-indigo-200 pl-4 py-1 italic">
                    &ldquo;{item.sentence}&rdquo;
                  </blockquote>

                  {/* Verdict + confidence */}
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold tracking-wider uppercase px-3 py-1 rounded-full border ${verdictChip.cls}`}>
                      {verdictChip.label}
                    </span>
                    <span className="text-xs text-slate-500 font-semibold">
                      Confidence: {Math.round(v.confidence * 100)}%
                    </span>
                  </div>

                  {/* Reasoning */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <HelpCircle className="w-3.5 h-3.5" />
                      Why this verdict?
                    </h4>
                    <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-100">
                      {v.evidence || 'No reasoning was returned for this claim.'}
                    </p>
                  </div>

                  {/* Sources */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <ExternalLink className="w-3.5 h-3.5" />
                      Sources
                    </h4>
                    {v.sources && v.sources.length > 0 ? (
                      <div className="flex flex-col gap-1.5">
                        {v.sources.map((src, idx) => (
                          <a
                            key={idx}
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-100 text-xs text-indigo-700 hover:bg-indigo-100 transition-colors"
                          >
                            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{src.title}</span>
                          </a>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 italic">No web sources returned</p>
                    )}
                  </div>
                </div>

                {/* Footer */}
                <div className="h-16 border-t border-slate-100 flex items-center justify-end gap-3 px-6 shrink-0 bg-slate-50">
                  {['unverifiable', 'mixed', 'error'].includes(v.verdict) && (
                    <button
                      onClick={() => {
                        requestVerification(item.id, item.sentence, true);
                        setDetailClaimId(null);
                      }}
                      className="px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold rounded-lg border border-indigo-100 transition-colors cursor-pointer"
                    >
                      Verify Again
                    </button>
                  )}
                  <button
                    onClick={() => setDetailClaimId(null)}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-sm transition-all cursor-pointer"
                  >
                    Close
                  </button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Founder Score Modal overlay */}
      <AnimatePresence>
        {isScoreModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/60 backdrop-blur-sm"
            onClick={() => {
              if (!isScoring) setIsScoreModalOpen(false);
            }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden max-h-[85vh] flex flex-col text-slate-800"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="h-16 border-b border-slate-100 flex items-center justify-between px-6 shrink-0 bg-slate-50">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center shadow-3xs">
                    <Award className="w-4.5 h-4.5 text-indigo-600" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Founder Pitch Score</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Real-Time Evaluation</p>
                  </div>
                </div>
                {!isScoring && (
                  <button
                    onClick={() => setIsScoreModalOpen(false)}
                    className="p-1.5 hover:bg-slate-100 text-slate-400 hover:text-slate-600 rounded-lg transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>

              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {isScoring && (
                  <div className="flex flex-col items-center justify-center py-16 px-4 text-center space-y-4">
                    <div className="relative">
                      <div className="w-16 h-16 rounded-full border-4 border-indigo-100 border-t-indigo-600 animate-spin" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Activity className="w-6 h-6 text-indigo-600 animate-pulse" />
                      </div>
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Analyzing Pitch & Verifying Claims...</h4>
                      <p className="text-xs text-slate-500 max-w-sm mt-1.5 leading-relaxed">
                        Calculating scores for credibility, clarity, traction, and market understanding. Please hold on.
                      </p>
                    </div>
                  </div>
                )}

                {founderScore && !isScoring && (
                  <div className="space-y-6">
                    {/* Overall Score Banner */}
                    <div className="flex items-center gap-4 bg-indigo-50/50 p-5 rounded-2xl border border-indigo-100/40">
                      <div className="shrink-0 flex items-center justify-center">
                        <div className="w-20 h-20 rounded-full border-4 border-indigo-600 flex flex-col items-center justify-center bg-white shadow-xs">
                          <span className="text-3xl font-black text-indigo-700">{founderScore.overallScore}</span>
                          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest leading-none">/ 100</span>
                        </div>
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">Pitch Quality Index</h4>
                        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                          Your overall score is compiled from accuracy of claims made, speech structures, traction metric integrity, and market knowledge.
                        </p>
                      </div>
                    </div>

                    {/* Dimensions Grid */}
                    <div className="space-y-3">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Performance Metrics</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-100">
                        {[
                          { label: 'Credibility', val: founderScore.dimensions?.credibility, color: 'bg-emerald-500' },
                          { label: 'Clarity', val: founderScore.dimensions?.clarity, color: 'bg-blue-500' },
                          { label: 'Traction', val: founderScore.dimensions?.traction, color: 'bg-indigo-500' },
                          { label: 'Market Understanding', val: founderScore.dimensions?.marketUnderstanding, color: 'bg-amber-500' }
                        ].map((dim, idx) => (
                          <div key={idx} className="space-y-1.5 bg-white p-3 rounded-lg border border-slate-200/40">
                            <div className="flex justify-between text-xs font-bold">
                              <span className="text-slate-600">{dim.label}</span>
                              <span className="text-slate-800">{dim.val ?? 0}/100</span>
                            </div>
                            <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                              <motion.div 
                                initial={{ width: 0 }}
                                animate={{ width: `${dim.val ?? 0}%` }}
                                transition={{ duration: 0.8, delay: 0.1 * idx }}
                                className={`h-full ${dim.color} rounded-full`} 
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Summary */}
                    <div className="space-y-2">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Executive Summary</h4>
                      <p className="text-xs text-slate-600 leading-relaxed bg-white p-4 rounded-xl border border-slate-100">
                        {founderScore.summary}
                      </p>
                    </div>

                    {/* Evidence Trail */}
                    {founderScore.evidenceTrail && founderScore.evidenceTrail.length > 0 && (
                      <div className="space-y-2.5">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Evidence Trail</h4>
                        <div className="space-y-2.5 max-h-[220px] overflow-y-auto pr-1">
                          {founderScore.evidenceTrail.map((trail, idx) => (
                            <div key={idx} className="text-xs border border-slate-100 bg-white p-3 rounded-lg space-y-1.5 shadow-3xs hover:border-slate-200 transition-all">
                              <div className="flex items-start justify-between gap-2">
                                <span className="font-semibold text-slate-700 italic border-l-2 border-slate-200 pl-2">&ldquo;{trail.claim}&rdquo;</span>
                                <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase whitespace-nowrap shrink-0 ${
                                  trail.verdict?.toLowerCase() === 'supported' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
                                  trail.verdict?.toLowerCase() === 'contradicted' ? 'bg-rose-50 text-rose-700 border border-rose-100' :
                                  trail.verdict?.toLowerCase() === 'mixed' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                                  'bg-slate-50 text-slate-600 border border-slate-100'
                                }`}>
                                  {trail.verdict}
                                </span>
                              </div>
                              <p className="text-slate-500 text-[11px] leading-relaxed">
                                <span className="font-bold text-slate-600">Impact: </span>{trail.impact}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Suggested Follow-Ups */}
                    {founderScore.followUpQuestions && founderScore.followUpQuestions.length > 0 && (
                      <div className="space-y-2.5">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Suggested Follow-Ups</h4>
                        <ol className="list-decimal list-inside space-y-2 text-xs text-slate-600 bg-slate-50 p-4 rounded-xl border border-slate-100">
                          {founderScore.followUpQuestions.map((q, idx) => (
                            <li key={idx} className="leading-relaxed pl-1">
                              <span className="text-slate-700 font-medium">{q}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="h-16 border-t border-slate-100 flex items-center justify-end gap-3 px-6 shrink-0 bg-slate-50">
                {!isScoring && (
                  <>
                    <button
                      onClick={computeFounderScore}
                      className="px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold rounded-lg border border-indigo-100 transition-colors cursor-pointer"
                    >
                      Score Again
                    </button>
                    <button
                      onClick={() => setIsScoreModalOpen(false)}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-sm transition-all cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

