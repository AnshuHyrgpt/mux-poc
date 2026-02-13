/**
 * useServiceWorker Hook
 * Manages Service Worker registration and communication for background uploads
 */

import { useEffect, useCallback, useRef, useState } from "react";

interface ServiceWorkerMessage {
    type: string;
    id?: string;
    uploadId?: string;
    error?: string;
}

interface UseServiceWorkerOptions {
    onUploadComplete?: (uploadId: string) => void;
    onUploadFailed?: (id: string, error: string) => void;
}

export function useServiceWorker(options: UseServiceWorkerOptions = {}) {
    const [isReady, setIsReady] = useState(false);
    const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
    const workerRef = useRef<ServiceWorker | null>(null);

    // Register the Service Worker
    useEffect(() => {
        if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
            console.warn("Service Workers not supported");
            return;
        }

        const registerWorker = async () => {
            try {
                const reg = await navigator.serviceWorker.register("/upload-worker.js", {
                    scope: "/",
                });

                console.log("Upload worker registered:", reg.scope);
                setRegistration(reg);

                // Get the active worker
                const worker = reg.active || reg.waiting || reg.installing;
                if (worker) {
                    workerRef.current = worker;
                    setIsReady(true);
                }

                // Wait for the worker to become active
                reg.addEventListener("updatefound", () => {
                    const newWorker = reg.installing;
                    if (newWorker) {
                        newWorker.addEventListener("statechange", () => {
                            if (newWorker.state === "activated") {
                                workerRef.current = newWorker;
                                setIsReady(true);
                            }
                        });
                    }
                });

                // If already active, set ready
                if (reg.active) {
                    workerRef.current = reg.active;
                    setIsReady(true);
                }
            } catch (error) {
                console.error("Service Worker registration failed:", error);
            }
        };

        registerWorker();
    }, []);

    // Listen for messages from the Service Worker
    useEffect(() => {
        if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
            return;
        }

        const handleMessage = (event: MessageEvent<ServiceWorkerMessage>) => {
            const { type, id, uploadId, error } = event.data;

            switch (type) {
                case "UPLOAD_COMPLETE":
                    console.log("Upload complete:", uploadId);
                    if (uploadId) {
                        options.onUploadComplete?.(uploadId);
                    }
                    break;

                case "UPLOAD_FAILED":
                    console.error("Upload failed:", id, error);
                    if (id && error) {
                        options.onUploadFailed?.(id, error);
                    }
                    break;
            }
        };

        navigator.serviceWorker.addEventListener("message", handleMessage);

        return () => {
            navigator.serviceWorker.removeEventListener("message", handleMessage);
        };
    }, [options.onUploadComplete, options.onUploadFailed]);

    // Send a message to the Service Worker
    const postMessage = useCallback(
        (message: { type: string; data?: Record<string, unknown> }) => {
            if (!isReady) {
                console.warn("Service Worker not ready, queueing message");
                return false;
            }

            const worker =
                workerRef.current || registration?.active || navigator.serviceWorker.controller;

            if (worker) {
                worker.postMessage(message);
                return true;
            }

            console.warn("No active Service Worker found");
            return false;
        },
        [isReady, registration]
    );

    // Start upload for a specific recording ID
    const startUpload = useCallback(
        (id: string) => {
            return postMessage({ type: "START_UPLOAD", data: { id } });
        },
        [postMessage]
    );

    // Process all pending uploads
    const processPendingUploads = useCallback(() => {
        return postMessage({ type: "PROCESS_PENDING" });
    }, [postMessage]);

    // Request Background Sync (for when network is restored)
    const requestBackgroundSync = useCallback(async () => {
        if (!registration) return false;

        try {
            // Check if Background Sync is supported
            if ("sync" in registration) {
                await (registration as ServiceWorkerRegistration & { sync: { register: (tag: string) => Promise<void> } }).sync.register("upload-video");
                console.log("Background sync registered");
                return true;
            }
        } catch (error) {
            console.error("Background sync registration failed:", error);
        }

        return false;
    }, [registration]);

    return {
        isReady,
        postMessage,
        startUpload,
        processPendingUploads,
        requestBackgroundSync,
    };
}
