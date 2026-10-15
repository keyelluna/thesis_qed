const test = require('node:test');
const assert = require('node:assert/strict');
const proxyaddr = require('proxy-addr');
const qs = require('qs');

// These cases exercise the published security failures, not package versions.
for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
  test(`IPv6 trust subnet ${subnet} cannot trust an arbitrary IPv4 client`, () => {
    assert.equal(proxyaddr.compile(subnet)('203.0.113.10'), false);
  });
}

for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
  test(`correct trust subnet ${subnet} retains its intended private scope`, () => {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust('10.2.3.4'), true);
    assert.equal(trust('203.0.113.10'), false);
  });
}

test('an untrusted peer cannot supply the client IP through X-Forwarded-For', () => {
  const req = {
    socket: { remoteAddress: '203.0.113.10' },
    headers: { 'x-forwarded-for': '192.0.2.20' },
  };
  assert.equal(proxyaddr(req, proxyaddr.compile('::ffff:10.0.0.0/8')), '203.0.113.10');
});

for (const key of ['a', 'a[]']) {
  test(`comma arrays enforce the configured limit for ${key}`, () => {
    assert.throws(
      () => qs.parse(`${key}=1,2,3,4`, { comma: true, arrayLimit: 3, throwOnLimitExceeded: true }),
      RangeError,
    );
  });
}

test('ordinary QED score and visibility form fields retain their parsed shape', () => {
  assert.deepEqual(
    qs.parse('studentId=42&scores[0][itemId]=7&scores[0][score]=8&visible=true'),
    { studentId: '42', scores: [{ itemId: '7', score: '8' }], visible: 'true' },
  );
});

test('bounded comma arrays remain accepted', () => {
  assert.deepEqual(qs.parse('a[]=1,2,3', { comma: true, arrayLimit: 3, throwOnLimitExceeded: true }), { a: [['1', '2', '3']] });
});
