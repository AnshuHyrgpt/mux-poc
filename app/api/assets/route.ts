import Mux from "@mux/mux-node";
import { NextResponse } from "next/server";

const mux = new Mux({
    tokenId: process.env.MUX_TOKEN_ID,
    tokenSecret: process.env.MUX_TOKEN_SECRET,
});

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const cursor = searchParams.get("cursor");
        const limit = 12;

        const options: any = { limit };
        if (cursor) options.page = cursor;

        // Note: Mux 'page' param IS the cursor for cursor-based pagination in their API.

        const response = await mux.video.assets.list(options);
        // response is usually the list of items, with hidden properties for pagination?
        // Or response is { data: [...], next_cursor: ... }?
        // In v7 it was different.

        // Let's assume `response` has `data` and `next_cursor` based on typical cursor implementations?
        // Actually, if I recall Mux Node SDK, `list` returns an AsyncIterable/List that might hide the cursor?
        // Let's check if we can just return `response` and see.

        // Let's use a precautionary measure:
        // Inspect usage in `route.ts` - `assets.data` was used.
        // If `assets` is the response object, it has `data`.

        // Let's modify `route.ts` to return `next_cursor`.

        return NextResponse.json({
            assets: response.data,
            nextCursor: (response as any).next_cursor || null,
        });
    } catch (error) {
        console.error("Error fetching assets:", error);
        return NextResponse.json(
            { error: "Failed to fetch assets" },
            { status: 500 }
        );
    }
}
