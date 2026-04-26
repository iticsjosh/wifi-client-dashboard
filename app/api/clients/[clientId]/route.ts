export const runtime = 'edge';
import { NextResponse } from 'next/server';

function apiUrl(): string {
  const url = process.env.DASHBOARD_API_URL;
  if (!url) throw new Error('DASHBOARD_API_URL is not set. Add it in Cloudflare → Worker → Settings → Variables & Secrets.');
  return url;
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const resolvedParams = await params;
  const clientId = decodeURIComponent(resolvedParams.clientId);
  const res = await fetch(
    `${apiUrl()}/clients/${encodeURIComponent(clientId)}`,
    { method: 'DELETE' }
  );
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
