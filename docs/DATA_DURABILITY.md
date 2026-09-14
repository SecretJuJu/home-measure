# Keeping field data through a release

A measurement lives on the device that took it. Until someone signs in, IndexedDB is the only copy,
and a person who measured an apartment last week may open the app a month later on a build several
releases newer. So the rule this document defends is narrow and absolute:

**A release must open every record any earlier release wrote, and must never drop one.**

## Where data sits

| Store | Holds | Lifetime |
| --- | --- | --- |
| IndexedDB `home-measure` (Dexie) | properties, rooms, checklist items, measurements, photo metadata, photo blobs, the pending mutation queue | until the browser profile is cleared |
| D1 `home-measure` | the same records once a signed-in device syncs them | until deleted through the API |
| R2 `home-measure-photos` | uploaded photo bytes | until deleted through the API |

The queue is the part people forget. Operations recorded while signed out sit in `operations` with
the exact body that was built at the time, and they are replayed verbatim after sign-in. A payload
written by an old build therefore has to stay valid against a newer server.

## Rules for changing a stored shape

1. **Add fields as optional.** `notch` on a room and `size` on a utility are both optional, so a
   record written before they existed still parses, and a body queued before they existed is still
   accepted by the server.
2. **Never repurpose a name.** Changing what a field means is invisible to a validator and corrupts
   silently. Add a new field and leave the old one alone.
3. **Never rename or drop a Dexie store or index in place.** Add a new `version(n).stores({...})`
   with an `upgrade` when the shape genuinely has to move; Dexie keeps the rows.
4. **Never delete a table to reshape it on the server** unless the rows truly cannot be carried
   over, and say so in the migration. `0004_password_accounts.sql` drops Google accounts because
   they have no password to migrate; it keeps everything that can be kept.
5. **Bump `layoutVersion` only when a change cannot be expressed as an optional field.** When that
   happens, add the upgrade step to `roomLayoutUpgrades` in the same commit. `parseRoomLayout` walks
   the steps in order, so an old layout is converted on read rather than rejected.
6. **Read stored layouts through `parseRoomLayout`,** never by casting. It migrates first and
   validates after.
7. **Ship the Worker and the web assets together.** They deploy as one Cloudflare Worker, so a
   browser holding an older bundle only ever sends older shapes — which rules 1 and 2 keep valid.

## What the tests hold down

`apps/web/src/local/durability.test.ts` writes a database in the older shape, reopens it with the
current code, and asserts the records and their `dirty` flags survive. It also parses a layout that
predates the current fields, and checks that a queued mutation for a signed-out device stays in the
queue instead of being discarded.

`packages/domain/src/index.test.ts` covers the schema itself: what is accepted, what is rejected,
and the wall lengths a notch implies.

## Signed out is not a failure

When the server answers `401`, the queue keeps its operations and the sync state becomes
`signed-out`, shown as `기기에 저장됨`. Nothing is retried in a loop and nothing is thrown away; the
next successful sign-in flushes the queue in order. Only a real transport or server error becomes
`동기화 실패`.
