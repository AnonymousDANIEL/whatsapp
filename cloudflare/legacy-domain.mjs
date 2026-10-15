// Migration for the existing whatsapp.facecustomer.workers.dev URL.
// Keep the canonical origin fixed; never trust a client-provided Host, Origin or redirect.
const origin = 'https://mywasap.com';
const callbackPath = /^\/api\/(?:payments\/callback|banks\/feed)\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const feedReadPath = /^\/api\/banks\/feed\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\/(?:queue|receipts\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})$/i;

/** @param {Request} request @param {typeof fetch} fetchUpstream */
export async function handleRequest(request, fetchUpstream = fetch) {
  const source = new URL(request.url), target = new URL(origin);
  target.pathname = source.pathname;
  target.search = source.search;
  const headers = {'Cache-Control':'no-store','Strict-Transport-Security':'max-age=31536000; includeSubDomains','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
  // Existing payment orders and authorized bank connectors can still settle.
  // The API independently verifies signatures, exact amounts and idempotency.
  if (request.method === 'POST' && callbackPath.test(source.pathname) || request.method === 'GET' && feedReadPath.test(source.pathname) && /^[\da-f]{64}$/i.test(request.headers.get('x-bank-signature') || '')) {
    const allowed = new Headers();
    for (const name of ['content-type','x-bank-timestamp','x-bank-signature']) {
      const value = request.headers.get(name);
      if (value !== null) allowed.set(name, value);
    }
    try {
      const response = await fetchUpstream(target.href, {method:request.method,headers:allowed,body:request.body,redirect:'manual',signal:AbortSignal.timeout(20000)});
      const output = new Headers(headers);
      for (const name of ['content-type','retry-after']) {
        const value = response.headers.get(name);
        if (value !== null) output.set(name, value);
      }
      return new Response(response.body,{status:response.status,headers:output});
    } catch { return new Response('Callback temporarily unavailable',{status:503,headers:{...headers,'Retry-After':'30'}}); }
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new Response(null,{status:308,headers:{...headers,Location:target.href}});
  }
  // Never forward browser credentials from the old origin or rewrite an untrusted Origin.
  return new Response('Please use ' + origin,{status:421,headers});
}

/** @type {ExportedHandler} */
const worker = {fetch(request) { return handleRequest(request); }};
export default worker;
