---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-23-teammate-removal-tombstone

English | [中文](2026-10-23-teammate-removal-tombstone.zh.md)

## Summary

The team/member event's member.phase union gains the variant "removed" at the unchanged payload version 2. Team Leads can remove a settled teammate: the live child is drained, a tombstone row is appended to the Lead log, the row keeps reserving its name, and it stops counting against the member limit and disappears from roster and projection views.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-23-teammate-removal-tombstone
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "557da760280933209dbef3953b195b89443b5d0c51cc8e0739f62d0f9d587a87"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept old logs unchanged: provisioning, active, and failed stay valid and the projection transition rules still accept every historical sequence. Old readers have no "removed" writer and never recorded one; when an old reader opens a log that carries a tombstone, the agent-team projection validates the phase enum strictly, reports the first invalid record in its failure field, and keeps members and tasks at the last valid state without mutating, recovering, or truncating the log, so the required unsupported value is refused contained before execution. The event version stays 2 because the payload is a whole-snapshot alternative whose only change is this widened enum; the client projection cache version bump only re-derives cached wire views and does not change the durable event contract.

<a id="verification"></a>
## Verification

pnpm run gen-persistence-catalog regenerated docs/persistence-schema.json and the inventory; pnpm run persistence-changes -- --check accepts the recorded history. Vitest coverage in packages/experimental/agent-team exercises the removed edge end to end: removal commits the tombstone as a version-2 team/member event, the projection accepts active/failed to removed and filters tombstones from the wire view, the name stays reserved, and the member-limit slot is freed. The keyless snapshot replay suites still pass on committed generations that contain no tombstones.

<a id="dev-note"></a>
## Dev Note

None.
