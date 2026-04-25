export const runtime = 'edge';
import { NextResponse } from 'next/server';

const API_URL = process.env.DASHBOARD_API_URL!;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const resolvedParams = await params;
  const clientId = decodeURIComponent(resolvedParams.clientId);
  const res = await fetch(
    `${API_URL}/clients/${encodeURIComponent(clientId)}/extend`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } }
  );
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
