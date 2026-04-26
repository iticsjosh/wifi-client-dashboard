export const runtime = 'edge';
import { NextResponse } from 'next/server';

function apiUrl(): string {
  const url = process.env.DASHBOARD_API_URL;
  if (!url) throw new Error('DASHBOARD_API_URL is not set. Add it in Cloudflare → Worker → Settings → Variables & Secrets.');
  return url;
}

export async function GET() {
  const res = await fetch(`${apiUrl()}/clients`, { cache: 'no-store' });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
