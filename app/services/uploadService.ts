/**
 * Upload Service - IndexedDB wrapper for storing video recordings
 * Enables background uploads via Service Worker even after tab close
 */

const DB_NAME = "mux-video-uploads";
const DB_VERSION = 1;
const STORE_NAME = "pending-uploads";

export interface PendingUpload {
    id: string;
    uploadId: string;
    uploadUrl: string;
    blob: Blob;
    status: "pending" | "uploading" | "complete" | "failed";
    createdAt: number;
    retryCount: number;
}

class UploadService {
    private db: IDBDatabase | null = null;
    private dbPromise: Promise<IDBDatabase> | null = null;

    /**
     * Initialize IndexedDB connection
     */
    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;

        if (this.dbPromise) return this.dbPromise;

        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                console.error("IndexedDB error:", request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve(request.result);
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;

                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
                    store.createIndex("status", "status", { unique: false });
                    store.createIndex("createdAt", "createdAt", { unique: false });
                }
            };
        });

        return this.dbPromise;
    }

    /**
     * Save a recording to IndexedDB for background upload
     */
    async saveRecording(
        blob: Blob,
        uploadId: string,
        uploadUrl: string
    ): Promise<string> {
        const db = await this.getDB();
        const id = `upload-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        const upload: PendingUpload = {
            id,
            uploadId,
            uploadUrl,
            blob,
            status: "pending",
            createdAt: Date.now(),
            retryCount: 0,
        };

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.add(upload);

            request.onsuccess = () => resolve(id);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all pending uploads
     */
    async getPendingUploads(): Promise<PendingUpload[]> {
        const db = await this.getDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index("status");
            const request = index.getAll(IDBKeyRange.only("pending"));

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all uploads (any status)
     */
    async getAllUploads(): Promise<PendingUpload[]> {
        const db = await this.getDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get a specific recording by ID
     */
    async getRecording(id: string): Promise<PendingUpload | null> {
        const db = await this.getDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(id);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Update upload status
     */
    async updateStatus(
        id: string,
        status: PendingUpload["status"],
        incrementRetry = false
    ): Promise<void> {
        const db = await this.getDB();
        const recording = await this.getRecording(id);

        if (!recording) return;

        const updated: PendingUpload = {
            ...recording,
            status,
            retryCount: incrementRetry ? recording.retryCount + 1 : recording.retryCount,
        };

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(updated);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Mark upload as complete and remove from storage
     */
    async markUploadComplete(id: string): Promise<void> {
        const db = await this.getDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(id);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Clean up old uploads (older than 24 hours)
     */
    async cleanupOldUploads(): Promise<void> {
        const db = await this.getDB();
        const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index("createdAt");
            const range = IDBKeyRange.upperBound(cutoff);
            const request = index.openCursor(range);

            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                }
            };

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }
}

// Singleton instance
export const uploadService = new UploadService();
