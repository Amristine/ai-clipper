import { NextRequest, NextResponse } from "next/server";
import { getNativeExportProgress } from "../progress-store";
export const runtime = "nodejs";
export async function GET(req:NextRequest){
 const jobId=req.nextUrl.searchParams.get("jobId")||"";
 const progress=getNativeExportProgress(jobId);
 if(!progress)return NextResponse.json({progress:0,phase:"Waiting for FFmpeg status"});
 return NextResponse.json(progress,{headers:{"Cache-Control":"no-store"}});
}
