/**
 * Upload Service Worker
 * Handles background video uploads to Mux even after the tab closes
 * Uses chunked uploads for large files (up to 2GB)
 */

const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB chunks
const DB_NAME = "mux-video-uploads";
const DB_VERSION = 1;
const STORE_NAME = "pending-uploads";

// IndexedDB helper for Service Worker context
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
  });
}

async function getRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function updateStatus(id, status) {
  const db = await openDB();
  const recording = await getRecording(id);
  if (!recording) return;
  
  recording.status = status;
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(recording);
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function deleteRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getPendingUploads() {
  const db = await openDB();
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
 * Upload a blob to Mux using chunked PUT requests
 */
async function uploadBlob(recording) {
  const { id, uploadUrl, blob } = recording;
  
  console.log(`[SW] Starting upload for ${id}, size: ${blob.size} bytes`);
  
  try {
    await updateStatus(id, "uploading");
    
    // For Mux direct uploads, we can PUT the entire blob
    // Mux handles chunking on their end
    const response = await fetch(uploadUrl, {
      method: "PUT",
      body: blob,
      headers: {
        "Content-Type": "video/webm",
      },
    });
    
    if (!response.ok) {
      throw new Error(`Upload failed with status ${response.status}`);
    }
    
    console.log(`[SW] Upload complete for ${id}`);
    
    // Remove from IndexedDB after successful upload
    await deleteRecording(id);
    
    // Notify any open clients
    self.clients.matchAll().then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: "UPLOAD_COMPLETE",
          id,
          uploadId: recording.uploadId,
        });
      });
    });
    
    return true;
  } catch (error) {
    console.error(`[SW] Upload error for ${id}:`, error);
    await updateStatus(id, "failed");
    
    // Notify clients of failure
    self.clients.matchAll().then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: "UPLOAD_FAILED",
          id,
          error: error.message,
        });
      });
    });
    
    return false;
  }
}

/**
 * Process all pending uploads
 */
async function processPendingUploads() {
  console.log("[SW] Processing pending uploads...");
  
  try {
    const pendingUploads = await getPendingUploads();
    console.log(`[SW] Found ${pendingUploads.length} pending uploads`);
    
    for (const upload of pendingUploads) {
      await uploadBlob(upload);
    }
  } catch (error) {
    console.error("[SW] Error processing pending uploads:", error);
  }
}

// Handle messages from main thread
self.addEventListener("message", async (event) => {
  const { type, data } = event.data;
  
  console.log(`[SW] Received message: ${type}`, data);
  
  switch (type) {
    case "START_UPLOAD":
      // Start upload for a specific recording
      if (data?.id) {
        const recording = await getRecording(data.id);
        if (recording) {
          uploadBlob(recording);
        }
      }
      break;
      
    case "PROCESS_PENDING":
      // Process all pending uploads
      processPendingUploads();
      break;
      
    case "SKIP_WAITING":
      // Allow immediate activation
      self.skipWaiting();
      break;
  }
});

// Handle install event
self.addEventListener("install", (event) => {
  console.log("[SW] Upload worker installed");
  self.skipWaiting();
});

// Handle activate event
self.addEventListener("activate", (event) => {
  console.log("[SW] Upload worker activated");
  
  // Claim all clients immediately
  event.waitUntil(
    self.clients.claim().then(() => {
      // Process any pending uploads on activation
      processPendingUploads();
    })
  );
});

// Handle Background Sync (for network recovery)
self.addEventListener("sync", (event) => {
  if (event.tag === "upload-video") {
    console.log("[SW] Background sync triggered");
    event.waitUntil(processPendingUploads());
  }
});

// Handle fetch events (optional: could be used for retry logic)
self.addEventListener("fetch", (event) => {
  // Pass through all requests - we're not caching anything
});
