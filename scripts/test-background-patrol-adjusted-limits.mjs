import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_PATROL_BUCKETS } from '../src/core/background-patrol-state.mjs';
import { TIEBA_PATROL_DAILY_CAP } from '../src/core/tieba-patrol-ledger.mjs';
import {
  XHH_OP_READ_DAILY_LIMIT,
  XHH_OP_POST_DAILY_LIMIT,
  XHH_OP_COMMENT_DAILY_LIMIT,
} from '../src/core/xiaoheihe-operation-controller.mjs';

test('巡逻各账本使用上调 1.2 倍并向下取整的统一日额度', () => {
  assert.equal(TIEBA_PATROL_DAILY_CAP, 6);
  assert.equal(BACKGROUND_PATROL_BUCKETS.tieba.read.dailyCap, 6);
  assert.equal(XHH_OP_READ_DAILY_LIMIT, 14);
  assert.equal(XHH_OP_POST_DAILY_LIMIT, 2);
  assert.equal(XHH_OP_COMMENT_DAILY_LIMIT, 12);
  assert.equal(BACKGROUND_PATROL_BUCKETS.xiaoheihe.read.dailyCap, 14);
  assert.equal(BACKGROUND_PATROL_BUCKETS.xiaoheihe.post.dailyCap, 2);
  assert.equal(BACKGROUND_PATROL_BUCKETS.xiaoheihe.comment.dailyCap, 12);
});
