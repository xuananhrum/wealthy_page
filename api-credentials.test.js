'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');

test('key presence is not shown as verified, and invalid key errors are explicit but secret is never returned',async()=>{
  const original=process.env.SCRAPPA_API_KEY;
  const oldFetch=global.fetch;
  process.env.SCRAPPA_API_KEY='FAKE_SUPER_SECRET_DO_NOT_LOG';
  delete require.cache[require.resolve('./server.js')];
  const {handler}=require('./server.js');
  const server=http.createServer(handler);
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  global.fetch=async()=>({ok:false,status:401});
  try{
    const host='http://127.0.0.1:'+server.address().port;
    const status=await (await oldFetch(host+'/api/status')).json();
    assert.equal(status.ready,true);
    assert.equal(status.verified,false);
    const res=await oldFetch(host+'/api/market-search?budget=3&margin=20&city=SG&bedrooms=2');
    assert.equal(res.status,503);
    const body=await res.text();
    assert.match(body,/INVALID_API_KEY/);
    assert.doesNotMatch(body,/FAKE_SUPER_SECRET/);
  }finally{
    global.fetch=oldFetch;await new Promise(ok=>server.close(ok));
    if(original===undefined)delete process.env.SCRAPPA_API_KEY;else process.env.SCRAPPA_API_KEY=original;
    delete require.cache[require.resolve('./server.js')];
  }
});
