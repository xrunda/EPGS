import { BadRequestException } from '@nestjs/common';

/**
 * Thrown when a `:conflictKey` path segment is not a key this API issues.
 *
 * The key is a client-supplied string that becomes the primary lookup of a
 * stored row, so it is validated structurally BEFORE any write: an unparseable
 * key must never be persisted as an anonymous row that no recomputed conflict
 * can ever match again. `parseConflictKey` also checks enum membership, which is
 * the only thing stopping a well-shaped but meaningless `...:PURPLE:PURPLE`.
 *
 * The rejected value is deliberately NOT echoed back into the message: this
 * endpoint is reachable by anyone with a session, and echoing an arbitrary path
 * segment into a response body (and from there into logs) is exactly the shape
 * of thing that turns a validation error into a reflected-content problem.
 * `docs/monitor-level-conflict-api.md` documents the expected format instead.
 */
export class LevelConflictKeyInvalidException extends BadRequestException {
  constructor() {
    super({
      code: 'LEVEL_CONFLICT_KEY_INVALID',
      message:
        'conflictKey must be "ruleGroupId:semanticGroupId:field:keywordLevel:aiLevel" with uuid group ids and configured level values.',
    });
  }
}
