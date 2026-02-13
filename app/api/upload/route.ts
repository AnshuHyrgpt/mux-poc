import axios from "axios";
import { NextResponse } from "next/server";

export async function POST() {
    try {

        const response = await axios.post("https://devnodeapi.hyrgpt.com/v1/generate-mux-signed-url", {
            assessmentId: "694626bb769693c1c746b5ad"
        });

        return NextResponse.json(response.data);
    } catch (error) {
        console.error("Error creating upload URL:", error);
        return NextResponse.json(
            { error: "Failed to create upload URL" },
            { status: 500 }
        );
    }
}
