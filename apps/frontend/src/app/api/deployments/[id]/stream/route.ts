import { NextRequest } from 'next/server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: deploymentId } = await params;
  
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
  
  try {
    const response = await fetch(
      `${backendUrl}/deployments/${deploymentId}/stream`,
      {
        headers: {
          'Accept': 'text/event-stream',
        },
      }
    );

    if (!response.ok) {
      return new Response('Failed to connect to stream', { status: 502 });
    }

    return new Response(response.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('SSE proxy error:', error);
    return new Response('Stream unavailable', { status: 503 });
  }
}