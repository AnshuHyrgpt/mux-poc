"use client";

import { useEffect, useState } from "react";
import MuxPlayer from "@mux/mux-player-react";

interface Asset {
  id: string;
  status: string;
  playback_ids?: { id: string; policy: string }[];
  created_at: string;
}

export default function VideoList() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const fetchAssets = async (cursor?: string) => {
    try {
      if (!cursor) setLoading(true);
      else setIsLoadingMore(true);

      const url = cursor ? `/api/assets?cursor=${cursor}` : "/api/assets";
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error("Failed to fetch videos");
      }
      
      const data = await response.json();
      console.log("assets data>>>>", data);
      
      if (cursor) {
        setAssets(prev => [...prev, ...(data.assets || [])]);
      } else {
        setAssets(data.assets || []);
      }
      
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load videos");
    } finally {
      setLoading(false);
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    fetchAssets();
  }, []);

  const handleLoadMore = () => {
    if (nextCursor) {
      fetchAssets(nextCursor);
    }
  };

  if (loading && assets.length === 0) return <div className="p-4 text-center">Loading videos...</div>;
  if (error && assets.length === 0) return <div className="p-4 text-center text-red-500">{error}</div>;

  return (
    <div className="video-list-container mt-8">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Your Recordings</h2>
        <button 
          onClick={() => fetchAssets()}
          className="px-4 py-2 bg-gray-100 highlight-white/5 hover:bg-gray-200 rounded-md text-sm transition-colors"
        >
          Refresh List
        </button>
      </div>

      {assets.length === 0 ? (
        <div className="text-center p-8 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <p className="text-gray-500">No videos found. Upload your first video above!</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {assets.map((asset) => (
              <div key={asset.id} className="video-card bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow">
                <div className="aspect-video bg-black relative">
                  {asset.status === "ready" && asset.playback_ids?.[0] ? (
                    <MuxPlayer
                      streamType="on-demand"
                      playbackId={asset.playback_ids[0].id}
                      metadataVideoTitle={`Video ${asset.id}`}
                      className="w-full h-full"
                      style={{ aspectRatio: "16/9" }}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-white bg-gray-900">
                      <div className="text-center">
                        <p className="font-medium mb-1 capitalize">{asset.status.replace("_", " ")}</p>
                        <p className="text-xs opacity-75">ID: {asset.id}</p>
                      </div>
                    </div>
                  )}
                </div>
                
                <div className="p-4">
                  <div className="flex justify-between items-start mb-2">
                    <span className={`px-2 py-0.5 text-xs rounded-full capitalize ${
                      asset.status === "ready" 
                        ? "bg-green-100 text-green-800"
                        : asset.status === "errored" 
                          ? "bg-red-100 text-red-800"
                          : "bg-blue-100 text-blue-800"
                    }`}>
                      {asset.status.replace("_", " ")}
                    </span>
                    <span className="text-xs text-gray-500">
                      {new Date(Number(asset.created_at) * 1000).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 font-mono truncate">
                    ID: {asset.id}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {nextCursor && (
            <div className="mt-8 flex justify-center">
              <button
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoadingMore ? "Loading..." : "Load More Videos"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
