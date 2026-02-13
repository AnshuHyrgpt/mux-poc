"use client";

import MuxUploader from "@mux/mux-uploader-react";
import { useState, useCallback, useEffect } from "react";

interface UploadResult {
  assetId: string | null;
  playbackId: string | null;
  status: string;
}

interface VideoUploaderProps {
  onUploadComplete?: (result: UploadResult) => void;
}

export default function VideoUploader({ onUploadComplete }: VideoUploaderProps) {
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "ready" | "uploading" | "processing" | "complete" | "error">("idle");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const initializeUpload = useCallback(async () => {
    try {
      setStatus("idle");
      setError(null);
      const response = await fetch("/api/upload", { method: "POST" });
      if (!response.ok) throw new Error("Failed to get upload URL");
      
      const data = await response.json();
      setUploadUrl(data.uploadUrl);
      setUploadId(data.uploadId);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize upload");
      setStatus("error");
    }
  }, []);

  const pollForAsset = useCallback(async (id: string) => {
    let attempts = 0;
    const maxAttempts = 60;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/asset/${id}`);
        const data = await response.json();

        if (data.status === "asset_created" && data.assetId) {
          setResult({
            assetId: data.assetId,
            playbackId: data.playbackId,
            status: data.assetStatus,
          });
          setStatus("complete");
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
  }, [onUploadComplete]);

  const handleUploadStart = () => {
    setStatus("uploading");
  };

  const handleSuccess = () => {
    setStatus("processing");
    if (uploadId) {
      pollForAsset(uploadId);
    }
  };

  const handleError = (event: any) => {
    setError(event.detail?.message || event.nativeEvent?.detail?.message || "Upload failed");
    setStatus("error");
  };

  // Initialize on first render
  useEffect(() => {
    if (status === "idle" && !uploadUrl) {
      initializeUpload();
    }
  }, [status, uploadUrl, initializeUpload]);

  return (
    <div className="video-uploader">
      <div className="uploader-header">
        <div className="uploader-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <h2>Upload Video</h2>
        <p>Drag and drop your video file or click to browse</p>
      </div>

      {error && (
        <div className="error-message">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
          <button onClick={initializeUpload} className="retry-btn">Retry</button>
        </div>
      )}

      {uploadUrl && status !== "complete" && (
        <MuxUploader
          endpoint={uploadUrl}
          onUploadStart={handleUploadStart}
          onSuccess={handleSuccess}
          onError={handleError}
          className="mux-uploader-custom"
        />
      )}

      {status === "processing" && (
        <div className="processing-status">
          <div className="spinner" />
          <span>Processing video...</span>
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
          <h3>Upload Complete!</h3>
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
          <button onClick={initializeUpload} className="new-upload-btn">
            Upload Another
          </button>
        </div>
      )}
    </div>
  );
}
