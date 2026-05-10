import { NextRequest, NextResponse } from 'next/server';

export async function GET() {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
    console.log(backendUrl)
    const response = await fetch(`${backendUrl}/deployments`);
    
    if (!response.ok) {
      throw new Error('Failed to fetch deployments');
    }
    
    const deployments = await response.json();
    
    return NextResponse.json(deployments, { status: 200 });
  } catch (error) {
    console.error('Error fetching deployments:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch deployments' },
      { status: 500 }
    );
  }
}


export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { repositoryUrl, ref: bodyRef, timeoutMinutes, cpuLimit, memoryLimit, webhookUrl } = body;

    // Validate webhook URL if provided
    if (webhookUrl && typeof webhookUrl === 'string') {
        try {
            new URL(webhookUrl);
        } catch {
            return NextResponse.json({ error: 'Invalid webhook URL' }, { status: 400 });
        }
    }
    // Validate repository URL
    if (!repositoryUrl || typeof repositoryUrl !== 'string') {
        return NextResponse.json({ error: 'Repository URL is required' }, { status: 400 });
    }

    let githubUrl = repositoryUrl.trim().replace('.git', '');
    
    // Sanitize URL - only allow GitHub URLs
    const githubUrlPattern = /^https?:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+/;
    if (!githubUrlPattern.test(githubUrl)) {
        return NextResponse.json({ error: 'Invalid GitHub repository URL' }, { status: 400 });
    }

    // Sanitize ref (branch/tag/commit)
    let ref = '';
    if (bodyRef && typeof bodyRef === 'string') {
        ref = bodyRef.trim().replace(/[^a-zA-Z0-9._\/-]/g, '').slice(0, 255);
    }
    
    // Extract ref from URL if present
    if (!ref && repositoryUrl.includes('/tree/')) {
        const parts = repositoryUrl.split('/tree/');
        githubUrl = parts[0];
        ref = parts[1].replace(/[^a-zA-Z0-9._\/-]/g, '').slice(0, 255);
    }

    // Validate timeout
    const timeout = parseInt(timeoutMinutes) || 60;
    if (timeout < 1 || timeout > 1440) {
        return NextResponse.json({ error: 'Timeout must be between 1 and 1440 minutes' }, { status: 400 });
    }

    // Validate CPU
    const cpu = parseFloat(cpuLimit) || 1;
    if (![0.5, 1, 2, 4].includes(cpu)) {
        return NextResponse.json({ error: 'CPU must be 0.5, 1, 2, or 4' }, { status: 400 });
    }

    // Validate memory
    const validMemory = ['512M', '1G', '2G', '4G'];
    const memory = validMemory.includes(memoryLimit) ? memoryLimit : '1G';

    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
    const response = await fetch(`${backendUrl}/deployments/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            githubUrl, 
            ref,
            timeoutMinutes: timeout,
            cpuLimit: cpu,
            memoryLimit: memory,
            webhookUrl: webhookUrl || null
        }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Backend deployment failed');
    }

    const result = await response.json();

    return NextResponse.json({ 
      success: true, 
      message: 'Deployment started successfully',
      deploymentId: result.deploymentId,
    }, { status: 201 });

  } catch (error) {
    console.error('Deployment error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }

}

