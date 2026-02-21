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

        return NextResponse.json({
            status: upload.status,
            assetId: upload.asset_id || null,
        });
    } catch (error) {
        console.error("Error fetching upload:", error);
        return NextResponse.json(
            { error: "Failed to fetch upload details" },
            { status: 500 }
        );
    }
}
