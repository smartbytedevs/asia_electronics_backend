'use strict';

const { generateKeyPair, exportJWK, SignJWT } = require('jose');

/**
 * Test-only JWT fixtures. Keys are extractable so the public JWK can seed a
 * local key set; tokens are signed deterministically for the scenarios the
 * auth tests need. Never used in production code.
 */
async function createKeyPair(kid = 'test-key') {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  return { publicKey, privateKey, publicJwk };
}

async function signToken({
  privateKey,
  claims = {},
  subject = 'user-1',
  issuer = 'taqwa-frontend',
  audience = 'taqwa-backend',
  kid = 'test-key',
  issuedAt = true,
  expiresIn = '1h',
  notBefore,
} = {}) {
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid });
  if (subject) jwt = jwt.setSubject(subject);
  if (issuer) jwt = jwt.setIssuer(issuer);
  if (audience) jwt = jwt.setAudience(audience);
  if (issuedAt) jwt = jwt.setIssuedAt();
  if (expiresIn !== null) jwt = jwt.setExpirationTime(expiresIn);
  if (notBefore !== undefined) jwt = jwt.setNotBefore(notBefore);
  return jwt.sign(privateKey);
}

module.exports = { createKeyPair, signToken };
