export const runtime = 'edge';
import { NextRequest, NextResponse } from 'next/server';

function apiUrl(): string {
  const url = process.env.DASHBOARD_API_URL;
  if (!url) throw new Error('DASHBOARD_API_URL is not set. Add it in Cloudflare → Worker → Settings → Variables & Secrets.');
  return url;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const res = await fetch(`${apiUrl()}/clients/bulk-extend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
