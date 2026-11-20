import { buildQzoneOnebotReadRequest } from './qzone-onebot-contract-offline.mjs';
import { buildQzoneOnebotWriteRequest } from './qzone-onebot-write-contract.mjs';

const qq = Object.freeze({ oneOf: [
  { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  { type: 'string', pattern: '^[1-9][0-9]*$' }
] });
const id = Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' });
const text = Object.freeze({ type: 'string', minLength: 1, maxLength: 100000 });
const page = Object.freeze({ pos: { type: 'integer', minimum: 0 }, num: { type: 'integer', minimum: 1, maximum: 100 } });

function schema(properties, required) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
}

const definitions = {
  read_posts: schema({ target_uin: qq, ...page }, ['target_uin']),
  read_comments: schema({ tid: id, target_uin: qq, ...page }, ['tid', 'target_uin']),
  publish: schema({
    content: text,
    ugc_right: { type: 'integer', enum: [1, 4, 16, 64, 128] },
    target_uins: { type: 'array', minItems: 1, maxItems: 1000, items: qq }
  }, ['content', 'ugc_right']),
  comment: schema({ tid: id, target_uin: qq, content: text }, ['tid', 'target_uin', 'content']),
  reply: schema({
    tid: id, target_uin: qq, content: text, comment_id: id, comment_uin: qq,
    reply_uin: qq, reply_name: text
  }, ['tid', 'target_uin', 'content', 'comment_id', 'comment_uin']),
  like: schema({ tid: id, target_uin: qq, abstime: { type: 'integer', minimum: 0 } }, ['tid', 'target_uin'])
};

definitions.publish.allOf = [
  {
    if: { properties: { ugc_right: { enum: [16, 128] } }, required: ['ugc_right'] },
    then: { required: ['target_uins'] },
    else: { not: { required: ['target_uins'] } }
  }
];
definitions.reply.allOf = [
  { if: { required: ['reply_uin'] }, then: { required: ['reply_name'] } },
  { if: { required: ['reply_name'] }, then: { required: ['reply_uin'] } }
];

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

for (const definition of Object.values(definitions)) deepFreeze(definition);

export const QZONE_MCP_TOOLS = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([name, inputSchema]) => [name, Object.freeze({
    name,
    description: `Business input contract for the offline ${name} Qzone tool; no authorization is implied.`,
    inputSchema
  })])
));

const validateByTool = {
  read_posts(input) { buildQzoneOnebotReadRequest('get_qzone_msg_list', input); },
  read_comments(input) { buildQzoneOnebotReadRequest('get_qzone_msg_detail', input); },
  publish(input) { buildQzoneOnebotWriteRequest('publish', input); },
  comment(input) { buildQzoneOnebotWriteRequest('comment', input); },
  reply(input) { buildQzoneOnebotWriteRequest('reply', input); },
  like(input) { buildQzoneOnebotWriteRequest('like', input); }
};

export const QZONE_MCP_VALIDATORS = Object.freeze(Object.fromEntries(
  Object.entries(validateByTool).map(([name, validate]) => [name, (input) => {
    try {
      validate(input);
      return true;
    } catch {
      return false;
    }
  }])
));

export function validateQzoneMcpInput(name, input) {
  return Object.hasOwn(QZONE_MCP_VALIDATORS, name) && QZONE_MCP_VALIDATORS[name](input);
}
