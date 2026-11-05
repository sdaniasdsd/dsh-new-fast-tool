import { timingSafeEqual } from 'node:crypto';

export function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
export async function bodyJson(req, maxBytes = 100000) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw new Error('请求内容过大。');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('请求不是有效 JSON。');}
}
export function allowed(req, token, origin) {
  if(req.headers.host!==new URL(origin).host)return false;
  if(req.headers.origin && req.headers.origin!==origin)return false;
  const supplied=Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /,''));
  const expected=Buffer.from(token);
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}
