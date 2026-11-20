import { simulateOfflineComments } from './qzone-comment-simulation-offline.mjs';
import { projectQzoneOnebotMsgDetail } from './qzone-onebot-comment-projection-offline.mjs';

// Takes a pre-existing fixture value, not a caller-supplied transport callback.
// The marker is an additional guard, not proof of the identity of a caller.
export async function simulateOfflineOnebotComments(store, request, target, metadata, scope, envelope) {
  if (!store || typeof store.read !== 'function' || !envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new TypeError('invalid offline dependencies');
  if (store.read().offlineTestFixture !== true) return { allowed: false, outcome: 'unknown', comments: [] };
  const descriptor = request && Object.getOwnPropertyDescriptor(request, 'now');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Number.isSafeInteger(descriptor.value)) {
    return { allowed: false, outcome: 'unknown', comments: [] };
  }
  const now = descriptor.value;
  return simulateOfflineComments(store, request, target, metadata, scope, async (selected) => {
    if (store.read().offlineTestFixture !== true) throw new Error('fixture unavailable');
    return projectQzoneOnebotMsgDetail(selected.author, selected.id, envelope, now);
  });
}
