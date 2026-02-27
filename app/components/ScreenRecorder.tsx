"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecordingResult {
  streamId: string;
  playbackId: string | null;
  status: "live" | "complete";
}

interface ScreenRecorderProps {
  onUploadComplete?: (result: RecordingResult) => void;
}

type Status =
  | "idle"
  | "connecting"
  | "live"
  | "stopping"
  | "complete"
  | "error";

// Use env var so staging/prod can point to different relay servers
const RELAY_WS_URL =
  process.env.NEXT_PUBLIC_RELAY_WS_URL ?? "ws://devsocket.hyrgpt.com/relay";

// If the browser WebSocket send-buffer exceeds this, drop the chunk rather
// than let it grow unbounded (≈ 5 MB)
const WS_BUFFER_LIMIT = 5 * 1024 * 1024;

// How long to wait for the relay to respond "ready" after sending the streamKey
const RELAY_HANDSHAKE_TIMEOUT_MS = 12_000;

// Ordered list of MIME types to try — we prefer H.264 so FFmpeg can use
// "-c:v copy" if desired; fall back to VP8 (never VP9 — poor FFmpeg compat)
const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=h264,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm",
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScreenRecorder({
  onUploadComplete,
}: ScreenRecorderProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [connectionState, setConnectionState] = useState<string>("");

  // Stream credentials
  const streamIdRef = useRef<string | null>(null);
  const playbackIdRef = useRef<string | null>(null);

  // Live refs — avoids stale-closure issues in callbacks
  const statusRef = useRef<Status>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Keep statusRef in sync with state
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      cleanup();
    },
    [],
  );

  // ─── Cleanup ────────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current?.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        /* ignore */
      }
    }
    mediaRecorderRef.current = null;

    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
  }, []);

  const resetState = useCallback(() => {
    cleanup();
    setStatus("idle");
    setError(null);
    setResult(null);
    setRecordingTime(0);
    setConnectionState("");
    streamIdRef.current = null;
    playbackIdRef.current = null;
  }, [cleanup]);

  // ─── Start Recording ────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      setError(null);
      setStatus("connecting");
      setConnectionState("Capturing screen...");

      // 1. Capture screen + system audio
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: true,
      });
      localStreamRef.current = stream;

      // If the user clicks "Stop sharing" in the browser's native UI,
      // only trigger stopRecording if we are actually live — not during setup
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        if (statusRef.current === "live") {
          stopRecording();
        } else {
          cleanup();
          setStatus("idle");
        }
      });

      setConnectionState("Creating live stream...");

      // 2. Create Mux Live Stream via backend
      const res = await fetch("/api/live-stream", { method: "POST" });
      if (!res.ok)
        throw new Error(`Failed to create live stream (${res.status})`);
      const { streamId, streamKey, playbackId } = await res.json();

      streamIdRef.current = streamId;
      playbackIdRef.current = playbackId;
      console.log("[Recorder] Live stream created:", { streamId, playbackId });

      setConnectionState("Connecting to relay server...");

      // 4. Pick the best supported MIME type (H.264 preferred for FFmpeg compat)
      const mimeType =
        PREFERRED_MIME_TYPES.find((m) => MediaRecorder.isTypeSupported(m)) ??
        "video/webm";

      // 3. Open WebSocket to relay — use addEventListener so handlers
      //    don't overwrite each other across the handshake and live phases
      const ws = new WebSocket(RELAY_WS_URL);
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Relay server connection timed out.")),
          RELAY_HANDSHAKE_TIMEOUT_MS,
        );

        ws.addEventListener("open", () => {
          console.log("[Recorder] WebSocket connected — sending streamKey");
          ws.send(JSON.stringify({ streamKey, mimeType }));
        });

        ws.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("Could not connect to relay server."));
        });

        ws.addEventListener("message", (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === "ready") {
              clearTimeout(timeout);
              console.log("[Recorder] Relay ready — FFmpeg is live");
              resolve();
            }
            if (msg.type === "error") {
              clearTimeout(timeout);
              reject(new Error(msg.message ?? "Relay returned an error"));
            }
          } catch {
            /* non-JSON frames — ignore */
          }
        });
      });

      // Post-handshake relay event handlers
      ws.addEventListener("close", (ev) => {
        setConnectionState("disconnected");
        console.log(`[Recorder] WebSocket closed (${ev.code})`);
        // If the relay drops us mid-stream, surface it to the user
        if (statusRef.current === "live") {
          setError("Connection to relay server was lost.");
          setStatus("error");
          cleanup();
        }
      });

      ws.addEventListener("error", () => {
        setConnectionState("error");
        console.error("[Recorder] WebSocket error during stream");
      });

      setConnectionState("Starting MediaRecorder...");

      console.log("[Recorder] Using MIME type:", mimeType);

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        if (ws.readyState !== WebSocket.OPEN) return;

        // Drop chunks if the browser's send buffer is backing up — better to
        // lose a chunk than to OOM the tab
        if (ws.bufferedAmount > WS_BUFFER_LIMIT) {
          console.warn("[Recorder] WS buffer full — dropping chunk");
          return;
        }

        ws.send(event.data);
      };

      // Start with 1-second timeslices
      mediaRecorder.start(1000);

      // 5. Go live!
      setStatus("live");
      setConnectionState("connected");
      setRecordingTime(0);

      timerRef.current = setInterval(
        () => setRecordingTime((t) => t + 1),
        1000,
      );
      console.log("[Recorder] 🔴 Live — streaming to Mux via relay");

      onUploadComplete?.({ streamId, playbackId, status: "live" });
    } catch (err) {
      console.error("[Recorder] Error starting live stream:", err);
      cleanup();

      if (err instanceof Error) {
        setError(
          err.name === "NotAllowedError"
            ? "Screen sharing was cancelled or denied."
            : err.message || "Failed to start live stream.",
        );
      } else {
        setError("An unexpected error occurred.");
      }

      setStatus("error");
    }
  }, [onUploadComplete, cleanup]);

  // ─── Stop Recording ─────────────────────────────────────────────────────────
  const stopRecording = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    setStatus("stopping");

    // Wait for MediaRecorder to fully flush its last chunk before we close
    // the WebSocket — avoids cutting off the final seconds of the recording
    if (mediaRecorderRef.current?.state === "recording") {
      await new Promise<void>((resolve) => {
        mediaRecorderRef.current!.onstop = () => resolve();
        mediaRecorderRef.current!.stop();
      });
    }
    mediaRecorderRef.current = null;

    // Give the last ondataavailable event a tick to fire and send its chunk
    await new Promise((r) => setTimeout(r, 200));

    // Close WebSocket → relay's FFmpeg stdin EOF → RTMP stream finalizes on Mux
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      await waitForBufferDrain(wsRef.current);
      wsRef.current.close(1000, "Stream ended");
      wsRef.current = null;
    }

    // Stop screen capture tracks
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;

    // Tell backend to mark the Mux stream as complete → triggers VOD creation
    if (streamIdRef.current) {
      try {
        await fetch(`/api/live-stream?streamId=${streamIdRef.current}`, {
          method: "DELETE",
        });
        console.log(
          "[Recorder] Mux stream completed — VOD processing started.",
        );
      } catch (err) {
        console.warn("[Recorder] Could not complete stream (non-fatal):", err);
      }
    }

    const finalResult: RecordingResult = {
      streamId: streamIdRef.current!,
      playbackId: playbackIdRef.current,
      status: "complete",
    };

    setResult(finalResult);
    setStatus("complete");
    onUploadComplete?.(finalResult);
  }, [onUploadComplete]);


  // Polls ws.bufferedAmount until it hits 0 (all data sent) or times out
function waitForBufferDrain(ws: WebSocket, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            if (ws.bufferedAmount === 0 || ws.readyState !== WebSocket.OPEN) {
                resolve();
                return;
            }
            if (Date.now() - start > timeoutMs) {
                console.warn("[Recorder] Buffer drain timed out, closing anyway");
                resolve();
                return;
            }
            setTimeout(check, 50);
        };
        check();
    });
}

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const connectionBadge: Record<string, { label: string; color: string }> = {
    connected: { label: "Connected", color: "#22c55e" },
    disconnected: { label: "Disconnected", color: "#ef4444" },
    error: { label: "Error", color: "#ef4444" },
  };

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="screen-recorder">
      {/* Header */}
      <div className="recorder-header">
        <div className="recorder-icon">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </div>
        <h2>Screen Recorder</h2>
        <p>Record your screen and stream live to Mux</p>
      </div>

      {/* Error */}
      {error && (
        <div className="error-message">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
          <button onClick={resetState} className="retry-btn">
            Try Again
          </button>
        </div>
      )}

      {/* Idle */}
      {status === "idle" && (
        <div className="recorder-idle">
          <button onClick={startRecording} className="record-btn">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
            Start Recording
          </button>
          <p className="hint">
            Click to share your screen — streaming begins instantly
          </p>
          <p className="hint hint-small">
            🎥 Streams live to Mux via RTMP · VOD saved automatically when you
            stop
          </p>
        </div>
      )}

      {/* Connecting */}
      {status === "connecting" && (
        <div className="processing-status">
          <div className="spinner" />
          <span>{connectionState || "Setting up live stream…"}</span>
        </div>
      )}

      {/* Live / Recording */}
      {status === "live" && (
        <div className="recorder-active">
          <div className="recording-indicator">
            <span className="recording-dot" />
            <span className="recording-time">{formatTime(recordingTime)}</span>
          </div>

          <div className="live-badge">
            <span className="live-dot" />
            LIVE · Streaming to Mux
          </div>

          {connectionState && connectionBadge[connectionState] && (
            <div
              className="connection-state"
              style={{ color: connectionBadge[connectionState].color }}
            >
              <span
                className="state-dot"
                style={{ background: connectionBadge[connectionState].color }}
              />
              {connectionBadge[connectionState].label}
            </div>
          )}

          {playbackIdRef.current && (
            <div className="playback-info">
              <span className="label">Playback ID:</span>
              <code>{playbackIdRef.current}</code>
              <a
                href={`https://stream.mux.com/${playbackIdRef.current}.m3u8`}
                target="_blank"
                rel="noreferrer"
                className="watch-link"
              >
                Watch live ↗
              </a>
            </div>
          )}

          <button onClick={stopRecording} className="stop-btn">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            Stop Recording
          </button>
        </div>
      )}

      {/* Stopping */}
      {status === "stopping" && (
        <div className="processing-status">
          <div className="spinner" />
          <span>Finalizing stream… Mux is processing your VOD</span>
        </div>
      )}

      {/* Complete */}
      {status === "complete" && result && (
        <div className="upload-success">
          <div className="success-icon">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>

          <h3>Stream Complete!</h3>
          <p className="hint">
            Mux is processing your recording into a VOD. It will be ready in
            ~1–2 minutes.
          </p>

          <div className="result-details">
            <div className="result-item">
              <span className="label">Stream ID:</span>
              <code>{result.streamId}</code>
            </div>
            {result.playbackId && (
              <>
                <div className="result-item">
                  <span className="label">Playback ID:</span>
                  <code>{result.playbackId}</code>
                </div>
                <div className="result-item">
                  <span className="label">HLS URL:</span>
                  <a
                    href={`https://stream.mux.com/${result.playbackId}.m3u8`}
                    target="_blank"
                    rel="noreferrer"
                    className="watch-link"
                  >
                    stream.mux.com/{result.playbackId}.m3u8 ↗
                  </a>
                </div>
              </>
            )}
          </div>

          <p className="hint hint-small">
            💡 Listen for the <code>video.asset.ready</code> Mux webhook to know
            when the VOD is fully processed.
          </p>

          <button onClick={resetState} className="new-upload-btn">
            Record Another
          </button>
        </div>
      )}
    </div>
  );
}
