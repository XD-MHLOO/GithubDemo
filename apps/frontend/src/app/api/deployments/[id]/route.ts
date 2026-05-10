import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: deploymentId } = await params;
    
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
    const response = await fetch(`${backendUrl}/deployments/${deploymentId}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Backend error (${response.status}):`, errorText);
      return NextResponse.json(
        { error: `Backend error: ${response.statusText}` },
        { status: response.status }
      );
    }
    
    const data = await response.json();
    return NextResponse.json(data);
    
  } catch (error) {
    console.error('Error in deployment detail route:', error);
    return NextResponse.json(
      { error: 'Failed to fetch deployment details' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: deploymentId } = await params;
    
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
    const response = await fetch(`${backendUrl}/deployments/${deploymentId}`, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      return NextResponse.json(
        { error: `Backend error: ${response.statusText}` },
        { status: response.status }
      );
    }
    
    const data = await response.json();
    return NextResponse.json(data);
    
  } catch (error) {
    console.error('Error in delete route:', error);
    return NextResponse.json(
      { error: 'Failed to delete deployment' },
      { status: 500 }
    );
  }
}