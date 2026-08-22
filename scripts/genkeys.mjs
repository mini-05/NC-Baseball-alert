/**
 * VAPID 키쌍을 생성한다. (Node 18+ 의 WebCrypto 사용, 외부 패키지 불필요)
 *
 *   npm run genkeys
 *
 * 공개키는 wrangler.toml 의 VAPID_PUBLIC_KEY 에 넣고,
 * 개인키는 `wrangler secret put VAPID_PRIVATE_KEY` 로 등록한다. (파일에 커밋하지 말 것)
 */

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

console.log('\nVAPID 키쌍이 생성됐습니다.\n');
console.log('① wrangler.toml 의 [vars] 에 넣으세요:');
console.log(`   VAPID_PUBLIC_KEY = "${publicKey}"\n`);
console.log('② 개인키는 시크릿으로 등록하세요 (커밋 금지):');
console.log('   npx wrangler secret put VAPID_PRIVATE_KEY');
console.log(`   → 붙여넣을 값: ${jwk.d}\n`);
