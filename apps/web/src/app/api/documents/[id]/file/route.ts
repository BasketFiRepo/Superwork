import { NextResponse } from 'next/server'
import { attachFile, fileFor, MAX_ATTACHMENT_BYTES } from '@superwork/core'
import { storageKeyFor, storageProvider } from '@superwork/integrations'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * The file behind a document (ADR 0085).
 *
 * **GET asks `can()` every time.** There is no signed URL and no token — `signedUrl` came off the
 * `StorageProvider` contract for exactly this reason. A link that works on possession can be
 * forwarded, logged by a proxy, or opened out of a browser history after the person's clearance
 * changed. The bytes are behind the same question the document is behind, asked on every request.
 *
 * The response is served as an attachment with a nosniff header, never inline. A PDF or an image
 * rendered in the origin is one XSS bug away from being script on the product's own domain, and
 * the content came from outside.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const file = await withActor(session, (ctx, actor) => fileFor(ctx, actor, id))
    const body = await storageProvider().get(file.key)
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'content-type': file.contentType,
        'content-length': String(file.bytes),
        'content-disposition': `attachment; filename="${file.fileName.replace(/"/g, '')}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Choose a file to attach.' }, { status: 400 })
    }
    // Read the size before the bytes: a stream can lie about its length, but `File` has already
    // buffered here, so this is the cheap guard before the repository's own.
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: `That file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB.` },
        { status: 400 },
      )
    }
    const body = Buffer.from(await file.arrayBuffer())
    const attached = await withActor(session, (ctx, actor) =>
      attachFile(
        ctx,
        actor,
        { documentId: id, fileName: file.name, contentType: file.type, body },
        storageProvider(),
        storageKeyFor,
      ),
    )
    return NextResponse.json({ file: attached })
  } catch (error) {
    return errorResponse(error)
  }
}
