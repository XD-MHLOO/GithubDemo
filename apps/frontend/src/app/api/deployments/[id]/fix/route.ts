import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
  
  const response = await fetch(`${backendUrl}/deployments/${id}/fix`, { 
    method: 'POST' 
  });
  const data = await response.json();
  return NextResponse.json(data);
}