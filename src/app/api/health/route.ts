import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const timestamp = new Date().toISOString();

  try {
    await prisma.$queryRawUnsafe('SELECT 1');

    return NextResponse.json(
      {
        status: 'ok',
        service: 'unik-system',
        database: 'connected',
        timestamp,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Health check database query failed:', error);

    return NextResponse.json(
      {
        status: 'error',
        service: 'unik-system',
        database: 'disconnected',
        timestamp,
      },
      { status: 503 }
    );
  }
}
