# ADR 0085 — A file somebody attached

**Status:** accepted · **Date:** 2026-08-24

## Context

`StorageProvider` has been declared in `contracts.ts` since Phase 2:

```ts
export interface StorageProvider extends Provider {
  put(key, body, contentType): Promise<{ key: string; bytes: number }>
  get(key): Promise<Buffer>
  signedUrl(key, expiresInSeconds): Promise<string>   // "Signed, time-limited, never a public bucket."
  remove(key): Promise<void>
}
```

**There was no implementation at all.** No mock, no `storageProvider()` resolver, no caller.
`documents.storage_key` and `documents.mime_type` had been empty just as long, and `ingest.ts`
carried a comment reading *"Binary parsing lives behind the StorageProvider"* — pointing at
something that did not exist.

So you could not attach a file to anything in Superwork. Every document is markdown somebody
pasted in, and the contract nobody signs is not in the system that indexes it.

This is ADR 0084's twin, one step earlier. There the abstraction had a mock and no consumer; here
it had neither — which is why those two columns were easy to read as *an integration nobody built*
rather than as the smaller thing they were.

## Decision

**A file is behind exactly the question the document is behind.** `attachFile` needs
`document:update` on the document, and `fileFor` goes through `getDocument`, so a document above
somebody's ceiling refuses the file for the same reason and in the same words.

A file inherits the document's clearance rather than carrying one of its own. Two sensitivities on
one thing is two answers to "who may read this", and the wrong one wins whenever somebody forgets
to update both.

### Possession is never permission

**`signedUrl` is removed from the contract.**

A signed URL grants access to whoever holds it. That is a capability this product's permission
model deliberately does not have: a link that works on possession can be forwarded, logged by a
proxy, or opened out of a browser history after the person's clearance changed. Every one of those
is an access nobody decided to give.

Files are streamed through a route that asks `can()` on **every** request instead. It was never
implemented, so nothing is lost by saying so — and a real provider that needs to offload bytes can
add it back, behind a permission check, with an expiry measured in seconds.

The response is served as an attachment with `nosniff`, never inline. A PDF or an image rendered in
this origin is one parser bug away from being script on the product's own domain, and the content
came from outside.

### An allowlist, not a filter

`ATTACHABLE_TYPES` names seven types. An allowlist refuses what it does not know; a blocklist
admits it. The difference matters most for what a browser will happily execute — `text/html`,
`image/svg+xml` — which is the same rule the product already keeps about never rendering untrusted
HTML, applied one layer earlier. A test asserts those are absent, so the list cannot quietly grow
one.

Twenty megabytes: larger than any contract, smaller than anything that belongs in a bucket.

### Deleting a document takes the bytes with it

§25.13 says deleting a document deletes its chunks, embeddings and memories. A file behind it is
the same rule — leaving the bytes after the row is gone is a deletion that removed only the index
to the thing somebody asked to be rid of. `purgeDocument` now reads the key before the row goes and
removes the object.

**Except when another document shares it.** The key is a content hash, so the same file attached
twice is one object; removing it with the first document would quietly break the second. The purge
counts first. An orphaned object is a smaller failure than a document whose file silently vanished,
and this is the direction to fail in.

The audit record already counted the chunks, citations and memories that went as evidence the
derived data followed. It now names the file too.

### The key is not a secret

`storageKeyFor(organizationId, body)` is a content hash under the organization. It cannot be
guessed from a document id and cannot be walked — but it is not treated as a credential either,
because there is no route that takes a key. Only one that takes a document id and asks `can()`.

## Consequences

- The original behind a document can be kept, downloaded and deleted, with no credential anywhere.
- `documents.storage_key` and `documents.mime_type` gain writers; `file_bytes` and `file_name` are
  added so a reader knows what they are fetching and a purge knows what it removed.
- §25.13's guarantee now reaches the bytes.
- `StorageProvider` has an implementation for the first time, which is what makes the contract
  exercisable at all.
- Detector: **60 → 58**.

## Lesson

ADR 0084 found an abstraction with a mock and no consumer, and the reason was that the mock could
not produce what the consumer would have eaten. This one had **no implementation whatsoever**, and
had sat that way longer.

The pattern in both: an interface is the cheapest thing to write and the easiest to mistake for the
work. A contract with no implementation is not a design decision that has been made — it is one
that has been *deferred*, and the deferral looks identical to a decision in every file that reads
the type.
