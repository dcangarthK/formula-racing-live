import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function signature(input, secret) {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

export function issueSessionToken({ sessionId, userId }, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = {
    iss: config.tokenIssuer,
    aud: config.tokenAudience,
    sid: sessionId,
    sub: userId,
    iat: nowSeconds,
    exp: nowSeconds + config.tokenTtlSeconds,
    jti: randomUUID(),
  };
  const body = `${header}.${encode(payload)}`;
  return { token: `${body}.${signature(body, config.tokenSecret)}`, payload };
}

export function verifySessionToken(token, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') throw new Error('missing_token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid_token');
  const [headerPart, payloadPart, suppliedSignature] = parts;
  const expected = signature(`${headerPart}.${payloadPart}`, config.tokenSecret);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new Error('invalid_token');
  }
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid_token');
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT'
    || payload.iss !== config.tokenIssuer || payload.aud !== config.tokenAudience
    || typeof payload.sid !== 'string' || typeof payload.sub !== 'string'
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    throw new Error('invalid_token');
  }
  if (payload.iat > nowSeconds + 30 || payload.exp <= nowSeconds) throw new Error('expired_token');
  return payload;
}
