export async function GET() {
  return Response.json({ ok: true });
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}
