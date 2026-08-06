import { NextResponse } from 'next/server';
import { transcribirAudio, esTranscripcionUtil } from '@/lib/whatsapp';

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'solo disponible en desarrollo' }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get('audio');
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'falta el campo "audio" (multipart)' }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || null;

  const inicio = Date.now();
  const transcripcion = await transcribirAudio(bytes, mime);
  const ms = Date.now() - inicio;

  return NextResponse.json({
    transcripcion,
    util: esTranscripcionUtil(transcripcion),
    mime,
    bytes: bytes.byteLength,
    ms,
  });
}
