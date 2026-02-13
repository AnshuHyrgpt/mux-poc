import Mux from "@mux/mux-node";
import { NextResponse } from "next/server";

const mux = new Mux({
    tokenId: process.env.MUX_TOKEN_ID,
    tokenSecret: process.env.MUX_TOKEN_SECRET,
});

export async function GET(
    request: Request,
    { params }: { params: Promise<{ uploadId: string }> }
) {
    try {
        const { uploadId } = await params;
        const upload = await mux.video.uploads.retrieve(uploadId);

        if (upload.status === "asset_created" && upload.asset_id) {
            const asset = await mux.video.assets.retrieve(upload.asset_id);

            return NextResponse.json({
                status: upload.status,
                assetId: upload.asset_id,
                playbackId: asset.playback_ids?.[0]?.id,
                assetStatus: asset.status,
                duration: asset.duration,
            });
        }

        return NextResponse.json({
            status: upload.status,
            assetId: upload.asset_id || null,
        });
    } catch (error) {
        console.error("Error fetching asset:", error);
        return NextResponse.json(
            { error: "Failed to fetch asset details" },
            { status: 500 }
        );
    }
}
