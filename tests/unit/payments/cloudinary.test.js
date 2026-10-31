'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { signCloudinaryParams, createCloudinaryClient } = require('../../../src/integrations/media/cloudinary/cloudinary.client');
const { createCloudinaryMediaService } = require('../../../src/integrations/media/cloudinary/cloudinary.adapter');
const { ERROR_CODES } = require('../../../src/constants');

function fakeResponse({ ok = true, status = 200, json = {} } = {}) {
  return { ok, status, json: async () => json };
}

test('signCloudinaryParams produces the documented SHA-1 signature', () => {
  const signature = signCloudinaryParams(
    { folder: 'payments', public_id: 'abc', timestamp: 1700000000 },
    'secret'
  );
  assert.equal(signature, '01ab34fc35d875a4f0f23a8a40ddf7998fda29d4');
});

test('signCloudinaryParams sorts keys lexicographically and excludes nothing explicit', () => {
  // Order of insertion must not matter.
  assert.equal(
    signCloudinaryParams({ b: '2', a: '1' }, 's'),
    signCloudinaryParams({ a: '1', b: '2' }, 's')
  );
});

test('createCloudinaryClient throws when credentials are missing', () => {
  assert.throws(() => createCloudinaryClient({ cloudName: '', apiKey: '', apiSecret: '' }));
  assert.throws(() => createCloudinaryClient({ cloudName: 'x', apiKey: 'y' }));
});

test('uploadImage posts a signed multipart form and returns the payload', async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    sent = { url, options };
    return fakeResponse({
      ok: true,
      json: { public_id: 'payments/abc', secure_url: 'https://res.cloudinary.com/x/image/upload/payments/abc.png', resource_type: 'image', format: 'png' },
    });
  };
  const client = createCloudinaryClient({ cloudName: 'c', apiKey: 'k', apiSecret: 's', fetchImpl });
  const result = await client.uploadImage({ buffer: Buffer.from('data'), publicId: 'payments/abc', folder: 'payments' });
  assert.equal(result.public_id, 'payments/abc');
  assert.ok(sent.url.includes('/image/upload'));
  assert.ok(sent.options.body instanceof FormData);
  assert.ok(sent.options.body.get('signature'));
  assert.equal(sent.options.body.get('api_key'), 'k');
});

test('uploadImage surfaces upstream errors', async () => {
  const fetchImpl = async () =>
    fakeResponse({ ok: false, status: 401, json: { error: { message: 'unauthorized' } } });
  const client = createCloudinaryClient({ cloudName: 'c', apiKey: 'k', apiSecret: 's', fetchImpl });
  await assert.rejects(() => client.uploadImage({ buffer: Buffer.from('x'), publicId: 'p', folder: 'f' }), /unauthorized/);
});

test('destroyImage resolves true for ok/not found and false otherwise', async () => {
  const okClient = createCloudinaryClient({
    cloudName: 'c', apiKey: 'k', apiSecret: 's',
    fetchImpl: async () => fakeResponse({ json: { result: 'ok' } }),
  });
  assert.equal(await okClient.destroyImage('p'), true);

  const goneClient = createCloudinaryClient({
    cloudName: 'c', apiKey: 'k', apiSecret: 's',
    fetchImpl: async () => fakeResponse({ json: { result: 'not found' } }),
  });
  assert.equal(await goneClient.destroyImage('p'), true);

  const badClient = createCloudinaryClient({
    cloudName: 'c', apiKey: 'k', apiSecret: 's',
    fetchImpl: async () => fakeResponse({ json: { result: 'error' } }),
  });
  assert.equal(await badClient.destroyImage('p'), false);
});

test('adapter uploadFile returns a safe media object only', async () => {
  let destroyed = [];
  const service = createCloudinaryMediaService({
    client: {
      uploadImage: async ({ publicId, folder }) => ({
        public_id: `${folder}/${publicId}`,
        secure_url: `https://res.cloudinary.com/x/${folder}/${publicId}`,
        resource_type: 'image',
        format: 'png',
      }),
      destroyImage: async (publicId) => destroyed.push(publicId),
    },
  });
  const media = await service.uploadFile({ buffer: Buffer.from('x'), mimeType: 'image/png', originalName: 'a.png' });
  assert.equal(media.provider, 'cloudinary');
  assert.match(media.publicId, /^payments\//);
  assert.ok(media.secureUrl);
  assert.equal(media.resourceType, 'image');
  assert.equal(media.format, 'png');
  assert.equal(Object.keys(media).length, 5, 'no extra fields leak out');

  await service.deleteFile(media);
  assert.deepEqual(destroyed, [media.publicId]);
});

test('adapter maps upstream upload failures to PAYMENT_PROOF_UPLOAD_FAILED (502)', async () => {
  const service = createCloudinaryMediaService({
    client: { uploadImage: async () => { throw new Error('boom'); }, destroyImage: async () => {} },
  });
  await assert.rejects(
    () => service.uploadFile({ buffer: Buffer.from('x'), mimeType: 'image/png', originalName: 'a.png' }),
    (err) => err.statusCode === 502 && err.code === ERROR_CODES.PAYMENT_PROOF_UPLOAD_FAILED
  );
});

test('adapter deleteFile is best-effort and never throws', async () => {
  const service = createCloudinaryMediaService({
    client: { destroyImage: async () => { throw new Error('cleanup fail'); } },
  });
  await assert.doesNotReject(() => service.deleteFile({ publicId: 'payments/x' }));
  await assert.doesNotReject(() => service.deleteFile(null));
  await assert.doesNotReject(() => service.deleteFile({}));
});

test('adapter without any client throws PAYMENT_PROOF_UPLOAD_FAILED when unconfigured', async (t) => {
  if (
    process.env.CLOUDINARY_CLOUD_NAME ||
    process.env.CLOUDINARY_API_KEY ||
    process.env.CLOUDINARY_API_SECRET
  ) {
    t.skip('cloudinary env vars are configured on this machine');
    return;
  }
  const service = createCloudinaryMediaService();
  await assert.rejects(
    () => service.uploadFile({ buffer: Buffer.from('x'), mimeType: 'image/png', originalName: 'a.png' }),
    (err) => err.code === ERROR_CODES.PAYMENT_PROOF_UPLOAD_FAILED
  );
  await assert.doesNotReject(() => service.deleteFile({ publicId: 'payments/x' }));
});
