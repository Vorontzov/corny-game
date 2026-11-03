import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomUUID, sign, timingSafeEqual, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SKU = 'christmas-super-pack-v1';
const PRICE_CENTS = 150;
const digest = s => createHash('sha256').update(s).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), {status});
function publicReceipt(row, privateKey) {
  if (!row?.paid) return null;
  const payload = Buffer.from(JSON.stringify({
    version: 1, sku: SKU, buyer: row.buyer, order: row.order_id,
    world: row.grant_world || null, delivered: Boolean(row.delivered)
  })).toString('base64url');
  const signature = sign('sha256', Buffer.from(payload), {key:privateKey,dsaEncoding:'ieee-p1363'});
  return {payload, signature:signature.toString('base64url')};
}

export function verifyWebhook(raw, header, secret, now = Date.now()/1000) {
  const fields = String(header || '').split(',').map(field => field.split('='));
  const stamp = fields.find(([key])=>key==='t')?.[1];
  if (!/^\d+$/.test(stamp || '') || Math.abs(now-Number(stamp))>300) return false;
  const expected = createHmac('sha256',secret).update(stamp+'.').update(raw).digest();
  return fields.some(([key,value])=>key==='v1' && /^[\da-f]{64}$/i.test(value) &&
    timingSafeEqual(expected,Buffer.from(value,'hex')));
}

export function createShop({db, privateKey, stripe, gameURL, live=true}) {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS purchases (
      buyer TEXT PRIMARY KEY, attempt TEXT NOT NULL, stripe_id TEXT UNIQUE,
      paid INTEGER NOT NULL DEFAULT 0, order_id TEXT NOT NULL UNIQUE,
      grant_world TEXT, delivered INTEGER NOT NULL DEFAULT 0);`);
  const get = buyer => db.prepare('SELECT * FROM purchases WHERE buyer = ?').get(buyer);
  const receipt = buyer => publicReceipt(get(buyer), privateKey);

  function acceptSession(session) {
    const buyer = session.client_reference_id;
    const row = get(buyer || '');
    if (!row || row.attempt!==session.metadata?.attempt || session.metadata.sku!==SKU ||
      (row.stripe_id && row.stripe_id!==session.id) || session.status!=='complete' ||
      session.payment_status!=='paid' || session.mode!=='payment' || session.currency!=='usd' ||
      session.amount_total!==PRICE_CENTS || session.livemode!==live) return false;
    db.prepare('UPDATE purchases SET paid=1,stripe_id=? WHERE buyer=? AND attempt=?').run(session.id,buyer,row.attempt);
    return true;
  }
  async function refresh(buyer) {
    const row = get(buyer);
    if (row?.stripe_id && !row.paid) {
      const session = await stripe('GET','checkout/sessions/'+encodeURIComponent(row.stripe_id));
      acceptSession(session);
    }
    return {receipt:receipt(buyer)};
  }
  async function checkout(buyer) {
    db.prepare('INSERT OR IGNORE INTO purchases (buyer,attempt,order_id) VALUES (?,?,?)').run(buyer,randomUUID(),randomUUID());
    let row = get(buyer);
    if(row.paid) return {receipt:receipt(buyer)};
    if(row.stripe_id) {
      const session = await stripe('GET','checkout/sessions/'+encodeURIComponent(row.stripe_id));
      if(acceptSession(session) || get(buyer).paid) return {receipt:receipt(buyer)};
      if(session.status==='open' && session.url) return {checkout:session.url};
      if(session.status!=='expired') throw failure(409,'Your payment is still being checked. Please check again shortly.');
      db.prepare('UPDATE purchases SET attempt=?,stripe_id=NULL WHERE buyer=? AND attempt=? AND paid=0').run(randomUUID(),buyer,row.attempt);
      row=get(buyer);
    }
    const done=new URL(gameURL);done.searchParams.set('corny-pack','return');
    const cancel=new URL(gameURL);cancel.searchParams.set('corny-pack','cancel');
    const params=new URLSearchParams({
      mode:'payment','payment_method_types[0]':'card',
      'line_items[0][quantity]':'1','line_items[0][price_data][currency]':'usd',
      'line_items[0][price_data][unit_amount]':String(PRICE_CENTS),
      'line_items[0][price_data][product_data][name]':'Corny Game · Christmas Super-Pack',
      'line_items[0][price_data][product_data][description]':'Santa and Gingerbread skins, 2 gold blocks and 10 emeralds.',
      'adaptive_pricing[enabled]':'false',client_reference_id:buyer,
      'metadata[sku]':SKU,'metadata[attempt]':row.attempt,
      success_url:done.href,cancel_url:cancel.href
    });
    const session=await stripe('POST','checkout/sessions',params,'corny-pack-'+row.attempt);
    db.prepare('UPDATE purchases SET stripe_id=? WHERE buyer=? AND attempt=?').run(session.id,buyer,row.attempt);
    return get(buyer).paid?{receipt:receipt(buyer)}:{checkout:session.url};
  }
  function grant(buyer, world, ack=false) {
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(world)) throw failure(400,'Choose a saved world.');
    if(!get(buyer)?.paid) throw failure(403,'The pack has not been purchased.');
    if(!ack) db.prepare('UPDATE purchases SET grant_world=? WHERE buyer=? AND grant_world IS NULL').run(world,buyer);
    if(get(buyer).grant_world!==world) throw failure(409,'Your items belong to the first world you selected.');
    if(ack) db.prepare('UPDATE purchases SET delivered=1 WHERE buyer=? AND grant_world=?').run(buyer,world);
    return {receipt:receipt(buyer)};
  }
  return {checkout,refresh,grant,acceptSession};
}

async function body(req) {
  const chunks=[];let length=0;
  for await (const chunk of req) {
    length+=chunk.length;
    if(length>1024*1024) throw failure(413,'Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function serve(env=process.env) {
  const game=new URL(env.CORNY_GAME_URL || 'https://vorontzov.github.io/corny-game/');
  const live=env.CORNY_STORE_TEST!=='1';
  const secret=env.STRIPE_SECRET_KEY || '';
  if(!(live?secret.startsWith('sk_live_'):secret.startsWith('sk_test_')) ||
    !env.STRIPE_WEBHOOK_SECRET || !env.CORNY_RECEIPT_KEY_FILE || !env.CORNY_STORE_DB) {
    throw Error('Set the Stripe key, webhook signing secret, receipt key file and durable SQLite path before starting checkout.');
  }
  if(game.protocol!=='https:') throw Error('Set the public HTTPS game URL.');
  const privateKey=createPrivateKey(readFileSync(env.CORNY_RECEIPT_KEY_FILE));
  if(privateKey.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw Error('Expected a P-256 receipt signing key.');
  const db=new DatabaseSync(env.CORNY_STORE_DB);
  const stripe=async(method,path,params,key)=>{
    const headers={Authorization:'Bearer '+secret};
    if(params) headers['Content-Type']='application/x-www-form-urlencoded';
    if(key) headers['Idempotency-Key']=key;
    const r=await fetch('https://api.stripe.com/v1/'+path,{method,headers,body:params,signal:AbortSignal.timeout(15000)});
    if(!r.ok) throw failure(502,'Checkout is temporarily unavailable. Please try again.');
    return r.json();
  };
  const store=createShop({db,privateKey,stripe,gameURL:game.href,live});
  const attempts=new Map();
  const throttle=(ip)=>{
    const now=Date.now(),entry=attempts.get(ip);
    if(entry && entry.until>now && entry.count>=12) throw failure(429,'Please try checkout again later.');
    if(!entry || entry.until<=now)attempts.set(ip,{count:1,until:now+600000});else entry.count++;
    if(attempts.size>2000)for(const [k,v] of attempts)if(v.until<=now)attempts.delete(k);
  };
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/v1/stripe-webhook' && req.method==='POST'){
        const raw=await body(req);
        if(!verifyWebhook(raw,req.headers['stripe-signature'],env.STRIPE_WEBHOOK_SECRET)) throw failure(400,'Invalid signature.');
        const event=JSON.parse(raw);
        if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) store.acceptSession(event.data.object);
        res.end('{"received":true}');return;
      }
      if(req.headers.origin!==game.origin) throw failure(403,'Open the Corny Game shop to continue.');
      res.setHeader('Access-Control-Allow-Origin',game.origin);res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
      if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
      if(req.method!=='POST') throw failure(405,'Unsupported method.');
      const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      if(!token) throw failure(401,'A valid store recovery key is required.');
      const buyer=digest(token);
      let reply;
      if(path==='/v1/checkout'){throttle(req.socket.remoteAddress);reply=await store.checkout(buyer);}
      else if(path==='/v1/status')reply=await store.refresh(buyer);
      else if(path==='/v1/grant'||path==='/v1/ack'){
        const input=JSON.parse((await body(req)).toString('utf8'));
        reply=store.grant(buyer,String(input.worldId || ''),path==='/v1/ack');
      } else throw failure(404,'Unknown shop route.');
      res.end(JSON.stringify(reply));
    } catch(e) {
      res.writeHead(e.status || 500);res.end(JSON.stringify({error:e.status?e.message:'Unable to complete the request.'}));
    }
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv[2]==='--generate-receipt-key'){
    const target=process.argv[3];
    if(!target) throw Error('Choose a private key file outside the repository.');
    const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    writeFileSync(target,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
    console.log(Buffer.from(JSON.stringify(createPublicKey(privateKey).export({format:'jwk'}))).toString('base64url'));
  } else serve().listen(Number(process.env.PORT)||8788,process.env.HOST || '127.0.0.1');
}
