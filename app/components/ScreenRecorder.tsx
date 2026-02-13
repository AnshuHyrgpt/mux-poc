"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { uploadService } from "../services/uploadService";
import { useServiceWorker } from "../hooks/useServiceWorker";
import { createUpload } from "@mux/upchunk";


interface RecordingResult {
  assetId: string | null;
  playbackId: string | null;
  status: string;
}

interface ScreenRecorderProps {
  onUploadComplete?: (result: RecordingResult) => void;
}

export default function ScreenRecorder({ onUploadComplete }: ScreenRecorderProps) {
  const [status, setStatus] = useState<"idle" | "recording" | "preview" | "uploading" | "processing" | "complete" | "error">("idle");
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [pendingUploadId, setPendingUploadId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isLiveUploading, setIsLiveUploading] = useState(false);
  const [networkStatus, setNetworkStatus] = useState<"stable" | "weak" | "failed">("stable");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const uploadTriggeredRef = useRef<boolean>(false);
  
  // Live upload refs
  const uploadUrlRef = useRef<string | null>(null);
  const uploadedBytesRef = useRef<number>(0);
  const uploadBufferRef = useRef<Blob[]>([]);
  const uploadQueueRef = useRef<{ blob: Blob; isLast: boolean }[]>([]);
  const isUploadingChunkRef = useRef<boolean>(false);
  const failedLiveUploadRef = useRef<boolean>(false);
  const liveUploadIdRef = useRef<string | null>(null);

  // Service Worker integration
  const { isReady: swReady, startUpload, processPendingUploads, requestBackgroundSync } = useServiceWorker({
    onUploadComplete: (uploadId) => {
      console.log("Upload completed via Service Worker:", uploadId);
      // If we're still on the page, poll for asset
      if (pendingUploadId) {
        pollForAsset(uploadId);
      }
    },
    onUploadFailed: (id, errorMsg) => {
      console.error("Upload failed via Service Worker:", id, errorMsg);
      setError(`Background upload failed: ${errorMsg}`);
      setStatus("error");
    },
  });

  // Save recording to IndexedDB for background upload
  const saveRecordingForBackgroundUpload = useCallback(async (blob: Blob): Promise<string | null> => {
    try {
      // Get upload URL from API
      const uploadResponse = await fetch("/api/upload", { method: "POST" });
      if (!uploadResponse.ok) {
        console.error("Failed to get upload URL");
        return null;
      }
      
      const { uploadUrl, uploadId } = await uploadResponse.json();


      console.log("uploadId😎😎😎:::::",uploadId)
      
      // Save to IndexedDB
      const id = await uploadService.saveRecording(blob, uploadId, uploadUrl);
      console.log("Recording saved to IndexedDB:", id);
      
      setPendingUploadId(id);
      return id;
    } catch (err) {
      console.error("Error saving recording for background upload:", err);
      return null;
    }
  }, []);

  // Handle page close/navigation - save to IndexedDB and trigger Service Worker
  useEffect(() => {
    const handleBeforeUnload = async (event: BeforeUnloadEvent) => {
      // If there's a recorded blob that hasn't been uploaded
      if (recordedBlob && (status === "preview" || status === "recording") && !uploadTriggeredRef.current) {
        uploadTriggeredRef.current = true;
        
        // Save to IndexedDB (this is synchronous enough to work in beforeunload)
        const savedId = await saveRecordingForBackgroundUpload(recordedBlob);
        
        if (savedId && swReady) {
          // Tell Service Worker to start uploading
          startUpload(savedId);
          // Also request background sync for network recovery
          requestBackgroundSync();
        }
        
        // Show browser's default "Leave page?" dialog
        event.preventDefault();
        event.returnValue = "Your recording will be uploaded in the background. Are you sure you want to leave?";
        return event.returnValue;
      }
    };

    const handleVisibilityChange = async () => {
      // If tab becomes hidden and there's an unuploaded recording, save and start background upload
      if (document.visibilityState === "hidden" && recordedBlob && 
          (status === "preview" || status === "recording") && !uploadTriggeredRef.current) {
        uploadTriggeredRef.current = true;
        
        const savedId = await saveRecordingForBackgroundUpload(recordedBlob);
        if (savedId && swReady) {
          startUpload(savedId);
          requestBackgroundSync();
        }
      }
    };

    const handlePageHide = async () => {
      if (recordedBlob && (status === "preview" || status === "recording") && !uploadTriggeredRef.current) {
        uploadTriggeredRef.current = true;
        
        const savedId = await saveRecordingForBackgroundUpload(recordedBlob);
        if (savedId && swReady) {
          startUpload(savedId);
        }
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [recordedBlob, status, swReady, saveRecordingForBackgroundUpload, startUpload, requestBackgroundSync]);

  // Check for pending uploads on mount (recovery from previous session)
  useEffect(() => {
    const checkPendingUploads = async () => {
      try {
        const pending = await uploadService.getPendingUploads();
        if (pending.length > 0) {
          console.log(`Found ${pending.length} pending uploads from previous session`);
          // Trigger Service Worker to process them
          if (swReady) {
            processPendingUploads();
          }
        }
        
        // Cleanup old uploads
        await uploadService.cleanupOldUploads();
      } catch (err) {
        console.error("Error checking pending uploads:", err);
      }
    };

    checkPendingUploads();
  }, [swReady, processPendingUploads]);

  // Reset upload triggered flag when recording is discarded or completed
  useEffect(() => {
    if (status === "idle" || status === "complete") {
      uploadTriggeredRef.current = false;
      setPendingUploadId(null);
      setIsLiveUploading(false);
      setNetworkStatus("stable");
      uploadUrlRef.current = null;
      uploadedBytesRef.current = 0;
      uploadBufferRef.current = [];
      uploadQueueRef.current = [];
      isUploadingChunkRef.current = false;
      failedLiveUploadRef.current = false;
      liveUploadIdRef.current = null;
    }
  }, [status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, [previewUrl]);

  const processUploadQueue = async () => {
    if (isUploadingChunkRef.current || !uploadUrlRef.current || failedLiveUploadRef.current) return;

    try {
      isUploadingChunkRef.current = true;

      while (uploadQueueRef.current.length > 0) {
        if (failedLiveUploadRef.current) break;

        const { blob, isLast } = uploadQueueRef.current[0];
        const start = uploadedBytesRef.current;
        
        // Handle empty chunks
        if (blob.size === 0) {
          if (isLast) {
            console.log("Finalizing live upload with empty chunk...");
            
            let attempts = 0;
            const maxAttempts = 3;
            let success = false;

            while (attempts < maxAttempts && !success) {
              try {
                const response = await fetch(uploadUrlRef.current, {
                  method: "PUT",
                  headers: {
                    "Content-Range": `bytes */${start}`,
                  },
                  body: blob,
                });
                
                if (response.ok || response.status < 300) {
                  success = true;
                  setNetworkStatus("stable");
                } else {
                  throw new Error(`Finalize failed with status ${response.status}`);
                }
              } catch (err) {
                attempts++;
                setNetworkStatus("weak");
                console.warn(`Finalize attempt ${attempts} failed:`, err);
                if (attempts < maxAttempts) await new Promise(r => setTimeout(r, 1000));
                else throw err;
              }
            }
             
             console.log(`Finalized upload. Total bytes: ${start}`);
             uploadQueueRef.current.shift();
             break; // Done
          } else {
            // Skip empty intermediate chunks
            uploadQueueRef.current.shift();
            continue;
          }
        }

        // Normal chunk with data
        const end = start + blob.size - 1;
        const total = isLast ? start + blob.size : "*";

        console.log(`Uploading chunk: ${start}-${end}/${total} (Attempt 1)`);
        
        let attempts = 0;
        const maxAttempts = 3;
        let success = false;

        while (attempts < maxAttempts && !success) {
          try {
            const response = await fetch(uploadUrlRef.current, {
              method: "PUT",
              headers: {
                "Content-Range": `bytes ${start}-${end}/${total}`,
              },
              body: blob,
            });

            if (response.ok) {
              success = true;
              setNetworkStatus("stable");
            } else if (response.status === 308) {
              // 308 is expected for non-final chunks
              success = true;
              setNetworkStatus("stable");
            } else {
              throw new Error(`Upload failed with status ${response.status}`);
            }
          } catch (err) {
            attempts++;
            setNetworkStatus("weak");
            console.warn(`Chunk upload attempt ${attempts} failed:`, err);
            if (attempts < maxAttempts) await new Promise(r => setTimeout(r, 1000));
            else throw err;
          }
        }

        uploadedBytesRef.current += blob.size;
        setUploadProgress(Math.min(99, Math.floor((uploadedBytesRef.current / (uploadedBytesRef.current + 1000000)) * 100)));
        
        console.log(`Uploaded chunk successfully: ${start}-${end}/${total}`);
        
        // Remove processed chunk
        uploadQueueRef.current.shift();
      }
    } catch (err) {
      console.error("Live upload queue failed after retries:", err);
      failedLiveUploadRef.current = true;
      setNetworkStatus("failed");
      setIsLiveUploading(false);
    } finally {
      isUploadingChunkRef.current = false;
      // Re-trigger if new items were added to queue during processing
      if (uploadQueueRef.current.length > 0 && !failedLiveUploadRef.current) {
        processUploadQueue();
      }
    }
  };

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { 
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        },
        audio: true,
      });

      streamRef.current = stream;
      chunksRef.current = [];
      uploadBufferRef.current = [];
      uploadQueueRef.current = [];
      uploadedBytesRef.current = 0;
      failedLiveUploadRef.current = false;
      setNetworkStatus("stable");
      
      // Get upload URL immediately
      try {
        const uploadResponse = await fetch("/api/upload", { method: "POST" });
        if (uploadResponse.ok) {
          const { uploadUrl, uploadId } = await uploadResponse.json();
          uploadUrlRef.current = uploadUrl;
          liveUploadIdRef.current = uploadId;
          setIsLiveUploading(true);
        } else {
          console.warn("Failed to get live upload URL, falling back to post-recording upload");
        }
      } catch (e) {
        console.warn("Error fetching upload URL:", e);
      }

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm",
      });

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          
          if (uploadUrlRef.current && !failedLiveUploadRef.current) {
            uploadBufferRef.current.push(event.data);
            
            // Calculate buffer size
            const currentBufferSize = uploadBufferRef.current.reduce((acc, chunk) => acc + chunk.size, 0);
            const CHUNK_MODULO = 256 * 1024; // 256KB
            
            // Upload if we have enough data (at least 256KB)
            // Mux GCS direct uploads require chunks to be multiples of 256KB (except the last one)
            if (currentBufferSize >= CHUNK_MODULO) {
              const fullBlob = new Blob(uploadBufferRef.current);
              
              // Calculate uploadable size (largest multiple of 256KB)
              const uploadableSize = Math.floor(fullBlob.size / CHUNK_MODULO) * CHUNK_MODULO;
              
              if (uploadableSize > 0) {
                const chunkToUpload = fullBlob.slice(0, uploadableSize);
                const remainder = fullBlob.slice(uploadableSize);
                
                // Update buffer with remainder
                uploadBufferRef.current = [remainder];
                
                uploadQueueRef.current.push({ blob: chunkToUpload, isLast: false });
                processUploadQueue();
              }
            }
          }
        }
      };

      // Handler for stop
      const handleStop = async () => {
        console.log("Recording stopped. Finalizing...");
        // Stop all tracks immediately
        stream.getTracks().forEach(track => track.stop());
        
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        setRecordedBlob(blob);
        
        // Finalize live upload if active
        if (uploadUrlRef.current && !failedLiveUploadRef.current && liveUploadIdRef.current) {
          console.log("Adding final chunk to queue...");
          // Send remaining buffer as final chunk
          const remainingBlob = new Blob(uploadBufferRef.current);
          uploadQueueRef.current.push({ blob: remainingBlob, isLast: true });
          
          // Trigger processing of the final chunk
          processUploadQueue();
          
          // Wait for queue to process (up to 30 seconds)
          let waitAttempts = 0;
          while ((isUploadingChunkRef.current || uploadQueueRef.current.length > 0) && waitAttempts < 60) {
            await new Promise(r => setTimeout(r, 500));
            waitAttempts++;
          }
          
          // If queue is empty and no failure occurred
          if (!failedLiveUploadRef.current && uploadQueueRef.current.length === 0) {
            // Success flow
            console.log("Live upload completed successfully after waiting for queue");
            setStatus("processing");
            pollForAsset(liveUploadIdRef.current);
            return;
          } else {
            console.warn("Live upload finalization failed or timed out. Falling back to background upload.", {
              failed: failedLiveUploadRef.current,
              queueLength: uploadQueueRef.current.length,
              waitAttempts
            });
          }
        }

        // Fallback flow (standard)
        console.log("Switching to preview/manual upload flow");
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        setStatus("preview");
        setIsLiveUploading(false);
      };

      mediaRecorder.onstop = handleStop;

      // Handle stream ending (user stops sharing)
      stream.getVideoTracks()[0].onended = () => {
        if (mediaRecorderRef.current?.state === "recording") {
          stopRecording();
        }
      };

      // Start with 1s timeslices to get frequent chunks
      mediaRecorder.start(1000);
      setStatus("recording");
      setRecordingTime(0);

      timerRef.current = setInterval(() => {
        setRecordingTime(t => t + 1);
      }, 1000);

    } catch (err) {
      console.error("Error starting recording:", err);
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Screen sharing was cancelled or denied");
      } else {
        setError("Failed to start screen recording");
      }
      setStatus("error");
    }
  }, [previewUrl]);

  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const discardRecording = useCallback(async () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    
    // Also remove from IndexedDB if saved
    if (pendingUploadId) {
      try {
        await uploadService.markUploadComplete(pendingUploadId);
      } catch (err) {
        console.error("Error removing pending upload:", err);
      }
    }
    
    setRecordedBlob(null);
    setPreviewUrl(null);
    setStatus("idle");
    setRecordingTime(0);
    setResult(null);
    setPendingUploadId(null);
    setIsLiveUploading(false);
  }, [previewUrl, pendingUploadId]);

  const pollForAsset = useCallback(async (uploadId: string) => {
    let attempts = 0;
    const maxAttempts = 60;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/asset/${uploadId}`);
        const data = await response.json();

        if (data.status === "asset_created" && data.assetId) {
          setResult({
            assetId: data.assetId,
            playbackId: data.playbackId,
            status: data.assetStatus,
          });
          setStatus("complete");
          
          // Remove from IndexedDB
          if (pendingUploadId) {
            await uploadService.markUploadComplete(pendingUploadId);
          }
          
          onUploadComplete?.({
            assetId: data.assetId,
            playbackId: data.playbackId,
            status: data.assetStatus,
          });
          return;
        }

        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(poll, 2000);
        } else {
          setError("Timeout waiting for asset to be ready");
          setStatus("error");
        }
      } catch {
        setError("Failed to check asset status");
        setStatus("error");
      }
    };

    poll();
  }, [onUploadComplete, pendingUploadId]);

  const uploadRecording = useCallback(async () => {
    if (!recordedBlob) return;

    try {
      setError(null);
      setStatus("uploading");
      setUploadProgress(0);
      uploadTriggeredRef.current = true;

      // Save to IndexedDB first (for recovery if upload fails)
      const savedId = await saveRecordingForBackgroundUpload(recordedBlob);
      
      if (!savedId) {
        throw new Error("Failed to save recording");
      }

      // Get the saved recording to get the uploadUrl
      const savedRecording = await uploadService.getRecording(savedId);
      if (!savedRecording) {
        throw new Error("Recording not found in IndexedDB");
      }

      // Convert Blob to File for Upchunk
      const recordedFile = new File([recordedBlob], `recording-${Date.now()}.webm`, {
        type: "video/webm",
      });

      // Upload using Upchunk
      const upload = createUpload({
        endpoint: savedRecording.uploadUrl,
        file: recordedFile,
        chunkSize: 5120,
      });
      

      upload.on("error", (err) => {
        console.error("Upchunk error:", err.detail);
        setError(err.detail instanceof Error ? err.detail.message : "Upload failed");
        setStatus("error");
      });

      upload.on("progress", (progress) => {
        setUploadProgress(Math.floor(progress.detail));
      });

      upload.on("success", () => {
        console.log("Upload complete!");
        setStatus("processing");
        pollForAsset(savedRecording.uploadId);
      });

    } catch (err) {
      console.error("Error starting upload:", err);
      setError(err instanceof Error ? err.message : "Upload failed to start");
      setStatus("error");
    }
  }, [recordedBlob, saveRecordingForBackgroundUpload, pollForAsset]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="screen-recorder">
      <div className="recorder-header">
        <div className="recorder-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </div>
        <h2>Screen Recorder</h2>
        <p>Record your screen and upload directly to Mux</p>
        {swReady && (
          <span className="sw-status" title="Background upload enabled">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="10" />
            </svg>
          </span>
        )}
      </div>

      {error && (
        <div className="error-message">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
          <button onClick={discardRecording} className="retry-btn">Try Again</button>
        </div>
      )}

      {status === "idle" && (
        <div className="recorder-idle">
          <button onClick={startRecording} className="record-btn">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
            Start Recording
          </button>
          <p className="hint">Click to share your screen and start recording</p>
          <p className="hint hint-small">
            {swReady 
              ? "✓ Background upload enabled - recordings are saved even if you close the tab"
              : "Loading background upload support..."}
          </p>
        </div>
      )}

      {status === "recording" && (
        <div className="recorder-active">
          <div className="recording-indicator">
            <span className="recording-dot" />
            <span className="recording-time">{formatTime(recordingTime)}</span>
          </div>
          {isLiveUploading && (
             <div className="live-upload-indicator">
                <span className="upload-dot" />
                Live Uploading to Mux
             </div>
          )}
          
          {networkStatus === "weak" && (
            <div className="network-warning weak">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>Weak network detected. Retrying upload...</span>
            </div>
          )}

          {networkStatus === "failed" && (
            <div className="network-warning failed">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <span>Live upload failed due to network issues.</span>
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

      {status === "preview" && previewUrl && (
        <div className="recorder-preview">
          <video src={previewUrl} controls className="preview-video" />
          <div className="preview-actions">
            <button onClick={discardRecording} className="discard-btn">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Discard
            </button>
            <button onClick={uploadRecording} className="upload-btn">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Retry Upload
            </button>
          </div>
          <p className="hint hint-small">
             Live upload failed. You can retry uploading manually.
          </p>
        </div>
      )}

      {(status === "uploading" || status === "processing") && (
        <div className="processing-status">
          <div className="spinner" />
          <span>
            {status === "uploading" 
              ? `Uploading recording... ${uploadProgress}%` 
              : "Processing video..."}
          </span>
        </div>
      )}

      {status === "complete" && result && (
        <div className="upload-success">
          <div className="success-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <h3>Recording Uploaded!</h3>
          <div className="result-details">
            <div className="result-item">
              <span className="label">Asset ID:</span>
              <code>{result.assetId}</code>
            </div>
            {result.playbackId && (
              <div className="result-item">
                <span className="label">Playback ID:</span>
                <code>{result.playbackId}</code>
              </div>
            )}
            <div className="result-item">
              <span className="label">Status:</span>
              <span className="status-badge">{result.status}</span>
            </div>
          </div>
          <button onClick={discardRecording} className="new-upload-btn">
            Record Another
          </button>
        </div>
      )}
    </div>
  );
}
