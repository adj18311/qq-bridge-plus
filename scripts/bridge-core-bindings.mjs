// VM harnesses remove ESM imports before evaluating the bridge. Re-export the real
// core modules once so every harness injects the same production implementations.
export * from '../src/core/json-store.mjs';
export * from '../src/core/qq-text.mjs';
export * from '../src/core/reply-timing.mjs';
export * from '../src/core/group-wait-policy.mjs';
export * from '../src/core/group-wake-batch.mjs';
export * from '../src/core/model-policy.mjs';
export * from '../src/core/image-format.mjs';
export * from '../src/core/persona-text.mjs';
export * from '../src/core/console-input.mjs';
export * from '../src/core/role-store.mjs';
export * from '../src/core/runtime-config.mjs';
export * from '../src/core/session-store.mjs';
export * from '../src/core/wake-timers.mjs';
export * from '../src/core/wake-policy.mjs';
export * from '../src/core/watchdog-policy.mjs';
export * from '../src/core/dsh-connection-watch.mjs';
export * from '../src/core/send-gaps.mjs';
export * from '../src/core/tool-log-format.mjs';
export * from '../src/core/memory-text.mjs';
export * from '../src/core/runtime-records.mjs';
export * from '../src/console/role-routes.mjs';
