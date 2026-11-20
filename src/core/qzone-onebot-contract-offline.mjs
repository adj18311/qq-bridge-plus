const READ_ACTIONS = new Set([
  'get_qzone_msg_list',
  'get_qzone_msg_detail'
]);

const LIST_FIELDS = new Set(['target_uin', 'pos', 'num']);
const DETAIL_FIELDS = new Set(['tid', 'target_uin', 'pos', 'num']);
// Application-side conservative ID validation; the OneBot schema only requires a non-empty string.
const TID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function requirePlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('input must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('input must be a plain object');
  }
  return value;
}

function copyAllowedDataFields(input, allowedFields) {
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowedFields.has(key)) {
      throw new TypeError(`unknown input field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`input field ${key} must be a data property, not an accessor`);
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

function requireTargetUin(value) {
  let uin;
  if (typeof value === 'number') {
    uin = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    uin = Number(value);
    if (String(uin) !== value) {
      throw new RangeError('target_uin must round-trip without precision or formatting loss');
    }
  } else {
    throw new TypeError('target_uin must be a positive safe integer or its canonical decimal string');
  }

  if (!Number.isSafeInteger(uin) || uin <= 0) {
    throw new RangeError('target_uin must be a positive safe integer');
  }
  return uin;
}

function requirePosition(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('pos must be a non-negative safe integer');
  }
  return value;
}

function requirePageSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RangeError('num must be an integer from 1 through 100');
  }
  return value;
}

function requireTid(value) {
  if (typeof value !== 'string' || !TID_PATTERN.test(value)) {
    throw new TypeError('tid must be 1 to 128 ASCII letters, digits, underscores, or hyphens');
  }
  return value;
}

/**
 * Build an offline OneBot request for the two supported, read-only Qzone actions.
 * This validates request shape only; it does not establish identity or authorization.
 */
export function buildQzoneOnebotReadRequest(action, input) {
  if (typeof action !== 'string' || !READ_ACTIONS.has(action)) {
    throw new TypeError('action must be get_qzone_msg_list or get_qzone_msg_detail');
  }

  requirePlainRecord(input);
  const fields = copyAllowedDataFields(input, action === 'get_qzone_msg_list' ? LIST_FIELDS : DETAIL_FIELDS);

  const params = {
    target_uin: requireTargetUin(fields.target_uin),
    pos: requirePosition(fields.pos === undefined ? 0 : fields.pos),
    num: requirePageSize(fields.num === undefined ? 20 : fields.num)
  };

  if (action === 'get_qzone_msg_detail') {
    params.tid = requireTid(fields.tid);
    // Keep parameter ordering aligned with the SnowLuma action definition.
    return {
      action,
      params: {
        tid: params.tid,
        target_uin: params.target_uin,
        pos: params.pos,
        num: params.num
      }
    };
  }

  return { action, params };
}
