import assert from 'node:assert/strict';
import test from 'node:test';
import { issueSessionToken, verifySessionToken } from '../src/token.js';

const config = {
  tokenSecret: 'a-secret-longer-than-thirty-two-characters',
  tokenTtlSeconds: 120,
  tokenIssuer: 'issuer',
  tokenAudience: 'audience',
};

test('token round-trips bound identity claims', () => {
  const issued = issueSessionToken({ sessionId: 'session', userId: 'user' }, config, 1000);
  const claims = verifySessionToken(issued.token, config, 1010);
  assert.equal(claims.sid, 'session');
  assert.equal(claims.sub, 'user');
  assert.equal(claims.exp, 1120);
});

test('token rejects tampering and expiry', () => {
  const issued = issueSessionToken({ sessionId: 'session', userId: 'user' }, config, 1000);
  assert.throws(() => verifySessionToken(`${issued.token}x`, config, 1010), /invalid_token/);
  assert.throws(() => verifySessionToken(issued.token, config, 1120), /expired_token/);
});
