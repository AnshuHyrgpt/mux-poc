// app/api/live-stream/route.ts
import axios from "axios";

// POST /api/live-stream — create a new live stream via external API
export async function POST() {
    try {
        const response = await axios.post(
            "https://devnodeapi.hyrgpt.com/v1/generate-mux-signed-url",
            { assessmentId: "694626bb769693c1c746b5ad" }
        );


        console.log("Mux live stream created:", response.data);

        return Response.json(response.data);
    } catch (err) {
        console.error("Failed to create Mux live stream:", err);
        return Response.json({ error: "Failed to create live stream" }, { status: 500 });
    }
}

// DELETE /api/live-stream?streamId=xxx — signals that the stream is complete
// Note: Mux auto-detects stream end when the RTMP connection closes.
// This endpoint is a no-op acknowledgement for the frontend.
export async function DELETE(req: Request) {
    const { searchParams } = new URL(req.url);
    const streamId = searchParams.get("streamId");

    if (!streamId) {
        return Response.json({ error: "streamId required" }, { status: 400 });
    }

    // Mux automatically finalizes the VOD asset when the RTMP stream disconnects.
    // No explicit API call needed — this just acknowledges the frontend request.
    console.log(`Stream ${streamId} marked as complete by client.`);
    return Response.json({ success: true });
}